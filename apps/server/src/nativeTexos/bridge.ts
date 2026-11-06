import type {
  PersonalAgentCommand,
  PersonalAgentEvent,
  PersonalAgentHello,
  PersonalAgentResponse,
  PersonalAgentSnapshot,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - Private inherited Node descriptors and opaque UUIDs; no provider subprocess.
import * as NodeTimers from "node:timers";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as NodeStream from "node:stream";
import { PrivateExecutionChannel, type PrivateExecutionEndpoint } from "./executionChannel.ts";
import {
  EXECUTION_NAMESPACE,
  EXECUTION_FRAME_BYTES,
  decodeExecutionHostRequest,
  type ExecutionChannelBinding,
} from "./executionProtocol.ts";
import {
  decodePersonalAgentCommand,
  isPersonalAgentHello,
  isPersonalAgentSnapshot,
  isPersonalAgentHistoryPage,
  isPersonalAgentRunDetail,
  isPersonalAgentExecutionMethod,
  personalAgentExecutionAvailable,
  personalAgentCanonicalFreshness,
  withoutPersonalAgentCanonicalTasks,
  type PersonalAgentCanonicalCursor,
} from "@t3tools/shared/personalAgents";

export type NativeProvider = "codex" | "claudeCode";
export type NativeEvent = {
  version: 1;
  kind: "event";
  handle: string;
  turnID: string;
  sequence: number;
  provider: NativeProvider;
  phase: "accepted" | "text" | "completed" | "failed" | "stopping" | "interrupted" | "uncertain";
  text?: string;
  problem?: string;
  remoteCancellationConfirmed?: boolean;
  localCleanupConfirmed?: boolean;
};
export type NativeResponse = {
  version: 1;
  kind: "response";
  id: string;
  ok: boolean;
  handle?: string;
  turnID?: string;
  provider?: NativeProvider;
  providers?: NativeProvider[];
  phase?: string;
  text?: string;
  sequence?: number;
  problem?: string;
};
type Request = {
  method: "hello" | "conversation.create" | "message.send" | "turn.stop" | "events.subscribe";
  handle?: string;
  provider?: NativeProvider;
  text?: string;
  turnID?: string;
  afterSequence?: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const provider = (value: unknown): value is NativeProvider =>
  value === "codex" || value === "claudeCode";
export const MAX_FRAME = 65536;
export const MAX_NATIVE_FRAME = 1024 * 1024;

/** A single host generation. EOF is permanent; it never reconnects or resends. */
export class NativeBridge {
  private executionChannel: PrivateExecutionChannel | undefined;
  private executionEndpointFactory: (() => PrivateExecutionEndpoint) | undefined;
  private agentPending = new Map<
    string,
    {
      resolve: (frame: PersonalAgentResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof NodeTimers.setTimeout>;
    }
  >();
  private expiredAgentRequests = new Set<string>();
  private agentListeners = new Set<(event: PersonalAgentEvent) => void>();
  private agentHello: Promise<PersonalAgentHello> | undefined;
  private agentRuntimeID: string | undefined;
  private agentMode: PersonalAgentHello["mode"] | undefined;
  private agentAuthority: string | undefined;
  private agentSequence = -1;
  private agentRevoked = false;
  private agentExecutionBlocked = false;
  private agentRevision = 0;
  private agentCanonicalCursor: PersonalAgentCanonicalCursor | undefined;
  private agentCanonicalAwaitingRead = false;
  private agentSnapshotReadOrdinal = 0;
  private agentProjectionEpoch = 0;
  private pending = new Map<
    string,
    {
      resolve: (frame: NativeResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof NodeTimers.setTimeout>;
    }
  >();
  private listeners = new Set<(event: NativeEvent) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  private handles = new Map<string, NativeProvider>();
  private usedHandles = new Set<string>();
  private sequences = new Map<string, number>();
  private buffer = Buffer.alloc(0);
  private failure: Error | undefined;
  private hello: Promise<NativeResponse> | undefined;
  private input: NodeStream.Readable;
  private output: NodeStream.Writable;
  private timeoutMs: number;
  constructor(input: NodeStream.Readable, output: NodeStream.Writable, timeoutMs = 15000) {
    this.input = input;
    this.output = output;
    this.timeoutMs = timeoutMs;
    input.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)));
    input.on("end", () =>
      this.fail(new Error("Native bridge disconnected; send outcome may be uncertain.")),
    );
    input.on("error", () => this.fail(new Error("Native bridge read failed.")));
    output.on("error", () =>
      this.fail(new Error("Native bridge write failed; send outcome may be uncertain.")),
    );
    input.on("close", () =>
      this.fail(new Error("Native bridge read channel closed; execution state may be uncertain.")),
    );
    output.on("close", () =>
      this.fail(new Error("Native bridge write channel closed; execution state may be uncertain.")),
    );
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.executionChannel?.close();
    for (const entry of this.pending.values()) {
      NodeTimers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const entry of this.agentPending.values()) {
      NodeTimers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.agentPending.clear();
    this.buffer = Buffer.alloc(0);
    // These streams are owned by this bridge. In production autoClose also closes fd3/fd4,
    // letting native observe EOF and settle/cancel its owned turn. Injected unit streams
    // close only themselves; never close a process-global descriptor separately.
    this.input.destroy();
    this.output.destroy();
    for (const listener of this.closeListeners) listener(error);
  }
  close() {
    this.fail(new Error("Native bridge closed."));
  }
  /**
   * Arms execution control for the first `execution.hello` on this private pipe, which then
   * supplies the binding. Only TexOS can write to the pipe, so the binding stays native-owned.
   */
  enableExecutionControl(factory: () => PrivateExecutionEndpoint) {
    if (this.failure || this.executionChannel || this.executionEndpointFactory)
      throw new Error("Execution control cannot be rebound.");
    this.executionEndpointFactory = factory;
  }
  /** Native-owned pipe bootstrap must supply this binding; renderer/environment assertions cannot. */
  installExecutionControl(binding: ExecutionChannelBinding, endpoint: PrivateExecutionEndpoint) {
    if (this.failure || this.executionChannel)
      throw new Error("Execution control cannot be rebound.");
    this.executionChannel = new PrivateExecutionChannel(
      binding,
      endpoint,
      (frame) => {
        const bytes = Buffer.from(JSON.stringify(frame) + "\n");
        if (
          this.failure ||
          bytes.length > EXECUTION_FRAME_BYTES ||
          this.output.writableLength + bytes.length > MAX_NATIVE_FRAME
        ) {
          throw new Error("Execution control write unavailable.");
        }
        this.output.write(bytes);
      },
      () => this.fail(new Error("Execution control disconnected; inspect original command.")),
    );
  }
  private protocolFailure(message: string): never {
    const error = new Error(message);
    this.fail(error);
    throw error;
  }
  onEvent(listener: (event: NativeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  onDisconnect(listener: (error: Error) => void) {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }
  onAgentEvent(listener: (event: PersonalAgentEvent) => void) {
    this.agentListeners.add(listener);
    return () => {
      this.agentListeners.delete(listener);
    };
  }
  private receiveAgent(frame: Record<string, unknown>) {
    if (frame.kind === "response") {
      if (typeof frame.id !== "string" || !uuid.test(frame.id) || typeof frame.ok !== "boolean")
        throw new Error("Invalid personal agent response.");
      const entry = this.agentPending.get(frame.id);
      if (!entry && this.expiredAgentRequests.delete(frame.id)) return;
      if (!entry) throw new Error("Unmatched personal agent response.");
      if (
        !frame.ok &&
        (!frame.error ||
          typeof frame.error !== "object" ||
          !("code" in frame.error) ||
          typeof frame.error.code !== "string" ||
          !("message" in frame.error) ||
          typeof frame.error.message !== "string")
      )
        throw new Error("Invalid personal agent refusal.");
      this.agentPending.delete(frame.id);
      NodeTimers.clearTimeout(entry.timer);
      entry.resolve(frame as unknown as PersonalAgentResponse);
      return;
    }
    if (
      frame.kind !== "event" ||
      frame.event !== "snapshot" ||
      typeof frame.authorityID !== "string" ||
      !frame.authorityID ||
      !Number.isSafeInteger(frame.sequence) ||
      Number(frame.sequence) < 0 ||
      !isPersonalAgentSnapshot(frame.snapshot)
    )
      throw new Error("Invalid personal agent event.");
    if (
      (this.agentAuthority && this.agentAuthority !== frame.authorityID) ||
      (this.agentRuntimeID && this.agentRuntimeID !== frame.snapshot.runtimeID) ||
      (this.agentMode && this.agentMode !== frame.snapshot.mode)
    )
      throw new Error("Personal agent authority changed.");
    this.agentAuthority = frame.authorityID;
    this.agentRuntimeID = frame.snapshot.runtimeID;
    this.agentMode = frame.snapshot.mode;
    if (Number(frame.sequence) <= this.agentSequence) return;
    this.agentSequence = Number(frame.sequence);
    this.agentRevoked ||= frame.snapshot.revoked;
    this.agentExecutionBlocked ||= !personalAgentExecutionAvailable(frame.snapshot);
    this.agentRevision = Math.max(this.agentRevision, frame.snapshot.revision);
    const snapshot = this.presentCanonicalTasks(frame.snapshot, false);
    const event = { ...frame, snapshot } as unknown as PersonalAgentEvent;
    for (const listener of this.agentListeners) listener(event);
  }

  private presentCanonicalTasks(snapshot: PersonalAgentSnapshot, freshRead: boolean) {
    const decision = personalAgentCanonicalFreshness(
      snapshot.canonicalTasks,
      this.agentCanonicalCursor,
      freshRead,
    );
    if (
      !freshRead &&
      (decision === "readRequired" ||
        (decision === "absent" && this.agentCanonicalCursor !== undefined) ||
        snapshot.revoked)
    )
      this.agentProjectionEpoch += 1;
    if (
      decision === "readRequired" ||
      (decision === "absent" && this.agentCanonicalCursor !== undefined && !freshRead)
    )
      this.agentCanonicalAwaitingRead = true;
    if (
      snapshot.revoked ||
      this.agentRevoked ||
      decision === "stale" ||
      decision === "readRequired" ||
      (this.agentCanonicalAwaitingRead && !freshRead)
    )
      return withoutPersonalAgentCanonicalTasks(snapshot);
    if (freshRead) this.agentCanonicalAwaitingRead = false;
    if (freshRead && decision === "absent") this.agentCanonicalCursor = undefined;
    if (decision === "accept" && snapshot.canonicalTasks)
      this.agentCanonicalCursor = {
        generation: snapshot.canonicalTasks.projectionGeneration,
        revision: snapshot.canonicalTasks.revision,
      };
    return snapshot;
  }
  private receive(chunk: Buffer) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > MAX_NATIVE_FRAME)
          this.fail(new Error("Native frame exceeds limit."));
        return;
      }
      if (newline > MAX_NATIVE_FRAME || newline === 0) {
        this.fail(new Error("Invalid native frame size."));
        return;
      }
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (frame?.namespace === EXECUTION_NAMESPACE) {
          if (newline > EXECUTION_FRAME_BYTES) throw new Error("Execution frame exceeds limit.");
          if (!this.executionChannel && this.executionEndpointFactory) {
            const request = decodeExecutionHostRequest(frame);
            if (request.method === "execution.hello") {
              const factory = this.executionEndpointFactory;
              this.executionEndpointFactory = undefined;
              this.installExecutionControl(
                {
                  authorityID: request.authorityID,
                  hostID: request.hostID,
                  hostGeneration: request.hostGeneration,
                },
                factory(),
              );
            }
          }
          if (this.executionChannel) this.executionChannel.receive(frame);
          else {
            const request = decodeExecutionHostRequest(frame);
            this.output.write(
              JSON.stringify({
                version: 2,
                namespace: EXECUTION_NAMESPACE,
                kind: "response",
                id: request.id,
                authorityID: request.authorityID,
                hostID: request.hostID,
                hostGeneration: request.hostGeneration,
                ...(request.method === "execution.hello"
                  ? { ok: true, result: { capabilities: [] } }
                  : { ok: false, error: { code: "executionUnavailable" } }),
              }) + "\n",
            );
          }
          continue;
        }
        if (frame?.namespace !== undefined) throw new Error("Unsupported native namespace.");
        if (frame?.version === 2) {
          this.receiveAgent(frame);
          continue;
        }
        if (!frame || frame.version !== 1) throw new Error("Unsupported native bridge version.");
        if (newline > MAX_FRAME) throw new Error("Native v1 frame exceeds limit.");
        if (frame.kind === "response") {
          if (!uuid.test(frame.id) || typeof frame.ok !== "boolean")
            throw new Error("Invalid native response.");
          const entry = this.pending.get(frame.id);
          const agentEntry = this.agentPending.get(frame.id);
          if (!entry && agentEntry && !frame.ok) {
            this.agentPending.delete(frame.id);
            NodeTimers.clearTimeout(agentEntry.timer);
            agentEntry.resolve({
              version: 2,
              kind: "response",
              id: frame.id,
              ok: false,
              error: {
                code: "unsupported",
                message: "Personal agents are unavailable on this native build.",
              },
            });
            continue;
          }
          if (!entry) throw new Error("Unmatched native response.");
          this.pending.delete(frame.id);
          NodeTimers.clearTimeout(entry.timer);
          entry.resolve(frame);
        } else if (frame.kind === "event") {
          if (
            !uuid.test(frame.handle) ||
            !uuid.test(frame.turnID) ||
            !provider(frame.provider) ||
            this.handles.get(frame.handle) !== frame.provider ||
            !Number.isSafeInteger(frame.sequence) ||
            frame.sequence < 0 ||
            frame.sequence <= (this.sequences.get(frame.handle) ?? -1) ||
            ![
              "accepted",
              "text",
              "completed",
              "failed",
              "stopping",
              "interrupted",
              "uncertain",
            ].includes(frame.phase) ||
            (frame.text !== undefined && typeof frame.text !== "string") ||
            (frame.problem !== undefined && typeof frame.problem !== "string") ||
            [frame.remoteCancellationConfirmed, frame.localCleanupConfirmed].some(
              (v) => v !== undefined && typeof v !== "boolean",
            )
          )
            throw new Error("Invalid or replayed native event.");
          this.sequences.set(frame.handle, frame.sequence);
          for (const listener of this.listeners) listener(frame);
        } else throw new Error("Invalid native frame kind.");
      } catch {
        this.fail(new Error("Invalid native bridge frame; execution state may be uncertain."));
        return;
      }
    }
  }
  private requestAgents(command: PersonalAgentCommand): Promise<PersonalAgentResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (
      this.agentPending.size >= 16 ||
      this.expiredAgentRequests.size >= 256 ||
      this.agentPending.has(command.id) ||
      this.expiredAgentRequests.has(command.id)
    )
      return Promise.reject(new Error("Personal agent command already pending or uncertain."));
    const bytes = Buffer.from(JSON.stringify({ version: 2, ...command }) + "\n");
    if (bytes.length - 1 > MAX_FRAME)
      return Promise.reject(new Error("Personal agent request exceeds limit."));
    return new Promise((resolve, reject) => {
      // @effect-diagnostics-next-line globalTimers:off - Private-pipe admission deadline; expiry never retries execution or shuts down the shared native host.
      const timer = NodeTimers.setTimeout(() => {
        this.agentPending.delete(command.id);
        this.expiredAgentRequests.add(command.id);
        reject(
          new Error(
            "Native admission timed out; outcome is uncertain. Refresh state before new work.",
          ),
        );
      }, 5000);
      this.agentPending.set(command.id, { resolve, reject, timer });
      try {
        this.output.write(bytes, (error) => {
          if (error) this.fail(new Error("Native bridge write failed."));
        });
      } catch {
        this.fail(new Error("Native bridge write failed; outcome is uncertain."));
      }
    });
  }
  async agentsReady(): Promise<PersonalAgentHello> {
    await this.ready();
    return (this.agentHello ??= this.requestAgents({
      id: NodeCrypto.randomUUID(),
      method: "agents.hello",
      params: {},
    })
      .then((frame) => {
        if (!frame.ok) throw new Error(frame.error.message);
        if (!isPersonalAgentHello(frame.result))
          throw new Error("Personal agents are unavailable on this native build.");
        if (
          (this.agentRuntimeID && frame.result.runtimeID !== this.agentRuntimeID) ||
          (this.agentMode && frame.result.mode !== this.agentMode)
        )
          this.protocolFailure("Personal agent runtime binding changed.");
        this.agentRuntimeID = frame.result.runtimeID;
        this.agentMode = frame.result.mode;
        this.agentExecutionBlocked ||= !personalAgentExecutionAvailable(frame.result);
        return frame.result;
      })
      .catch((error: unknown) => {
        this.agentHello = undefined;
        throw error;
      }));
  }
  async callAgents(value: unknown): Promise<PersonalAgentResponse> {
    const command = decodePersonalAgentCommand(value);
    await this.agentsReady();
    if (this.agentExecutionBlocked && isPersonalAgentExecutionMethod(command.method))
      return {
        version: 2,
        kind: "response",
        id: command.id,
        ok: false,
        error: {
          code: "executionUnavailable",
          message:
            "Agent execution is not enabled on this connection. Saved agents and history remain available.",
        },
      };
    const readOrdinal =
      command.method === "agents.snapshot" ? ++this.agentSnapshotReadOrdinal : undefined;
    const projectionEpoch = this.agentProjectionEpoch;
    let response = await this.requestAgents(command);
    if (response.ok && command.method === "agents.hello") {
      if (this.failure) throw this.failure;
      if (
        response.id !== command.id ||
        !isPersonalAgentHello(response.result) ||
        response.result.runtimeID !== this.agentRuntimeID ||
        response.result.mode !== this.agentMode
      )
        this.protocolFailure("Invalid personal agent hello response binding.");
    } else if (
      response.ok &&
      (command.method === "agents.history" || command.method === "agents.run")
    ) {
      const result = response.result;
      const valid =
        command.method === "agents.history"
          ? isPersonalAgentHistoryPage(result, command.params)
          : isPersonalAgentRunDetail(result, command.params.runID);
      if (this.failure) throw this.failure;
      if (
        !valid ||
        !result ||
        typeof result !== "object" ||
        !("runtimeID" in result) ||
        result.runtimeID !== this.agentRuntimeID ||
        !("revision" in result)
      )
        this.protocolFailure("Invalid personal agent read response.");
      // A newer event can overtake a valid read; withhold it without closing shared work.
      if (this.agentRevoked || Number(result.revision) < this.agentRevision)
        throw new Error("Stale or revoked personal agent read response. Refresh state.");
      if (result && typeof result === "object" && "revision" in result)
        this.agentRevision = Math.max(this.agentRevision, Number(result.revision));
    } else if (response.ok && command.method !== "agents.artifact") {
      const result = response.result;
      const snapshot =
        command.method === "agents.snapshot"
          ? result
          : result && typeof result === "object" && "snapshot" in result
            ? result.snapshot
            : undefined;
      if (
        !isPersonalAgentSnapshot(snapshot) ||
        snapshot.runtimeID !== this.agentRuntimeID ||
        snapshot.mode !== this.agentMode
      )
        this.protocolFailure("Invalid personal agent snapshot response.");
      if (isPersonalAgentSnapshot(snapshot)) {
        this.agentRevoked ||= snapshot.revoked;
        this.agentExecutionBlocked ||= !personalAgentExecutionAvailable(snapshot);
        this.agentRevision = Math.max(this.agentRevision, snapshot.revision);
        const staleRead =
          projectionEpoch !== this.agentProjectionEpoch ||
          (readOrdinal !== undefined && readOrdinal !== this.agentSnapshotReadOrdinal);
        const composed = staleRead
          ? withoutPersonalAgentCanonicalTasks(snapshot)
          : this.presentCanonicalTasks(snapshot, readOrdinal !== undefined);
        response = {
          ...response,
          result:
            command.method === "agents.snapshot"
              ? composed
              : { ...(result as Record<string, unknown>), snapshot: composed },
        };
      }
    } else if (response.ok && command.method === "agents.artifact") {
      const result = response.result;
      if (
        !result ||
        typeof result !== "object" ||
        !("id" in result) ||
        result.id !== command.params.artifactID ||
        !("name" in result) ||
        typeof result.name !== "string" ||
        !("mimeType" in result) ||
        typeof result.mimeType !== "string" ||
        !("base64" in result) ||
        typeof result.base64 !== "string" ||
        result.base64.length > 699052 ||
        !("sha256" in result) ||
        typeof result.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(result.sha256)
      )
        this.protocolFailure("Invalid personal agent artifact response.");
    }
    return response;
  }
  private request(request: Request): Promise<NativeResponse> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.size >= 16) return Promise.reject(new Error("Native bridge request limit."));
    const id = NodeCrypto.randomUUID();
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, kind: "request", id, ...request }) + "\n",
    );
    if (bytes.length - 1 > MAX_FRAME) return Promise.reject(new Error("Native request too large."));
    return new Promise((resolve, reject) => {
      // @effect-diagnostics-next-line globalTimers:off - Independent private-pipe deadline outside an Effect fiber; this bridge owns every timer and clears it on reply or permanent failure.
      const timer = NodeTimers.setTimeout(
        () => this.fail(new Error("Native bridge timeout; do not resend automatically.")),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.output.write(bytes, (error) => {
          if (error) this.fail(new Error("Native bridge write failed."));
        });
      } catch {
        this.fail(new Error("Native bridge write failed; send outcome may be uncertain."));
      }
    });
  }
  ready() {
    return (this.hello ??= this.request({ method: "hello" }).then((frame) => {
      if (!frame.ok) {
        // A native policy refusal is not a broken transport. A later explicit caller
        // may request hello again; this never retries a send automatically.
        this.hello = undefined;
        throw new Error(frame.problem ?? "Native bridge hello refused.");
      }
      if (
        !Array.isArray(frame.providers) ||
        frame.providers.length === 0 ||
        !frame.providers.every(provider) ||
        new Set(frame.providers).size !== frame.providers.length
      ) {
        this.protocolFailure("Native bridge hello incompatible.");
      }
      return frame;
    }));
  }
  async call(request: Request) {
    const hello = await this.ready();
    if (request.method === "hello") return hello;
    if (request.provider && !hello.providers!.includes(request.provider))
      throw new Error("Native provider unavailable.");
    if (
      request.method !== "conversation.create" &&
      (!request.handle || !this.handles.has(request.handle))
    )
      throw new Error("Unknown native handle.");
    if (
      request.text !== undefined &&
      (!request.text.trim() || Buffer.byteLength(request.text) > 8192)
    )
      throw new Error("Native user text exceeds limit.");
    if (request.method === "conversation.create" && this.handles.size >= 64)
      throw new Error("Native preview conversation limit reached; restart the preview explicitly.");
    if (request.method === "message.send") {
      if (this.usedHandles.has(request.handle!))
        throw new Error("One fresh turn per native handle. Start a new preview conversation.");
      this.usedHandles.add(request.handle!);
    }
    const response = await this.request(request);
    if (!response.ok) throw new Error(response.problem ?? "Native TexOS refused the request.");
    if (
      response.turnID !== undefined &&
      (!uuid.test(response.turnID) ||
        (request.turnID !== undefined && response.turnID !== request.turnID))
    )
      this.protocolFailure("Native response turn binding mismatch.");
    const expectedProvider = request.provider ?? this.handles.get(request.handle ?? "");
    if (
      response.provider !== undefined &&
      (!provider(response.provider) || response.provider !== expectedProvider)
    )
      this.protocolFailure("Native response provider binding mismatch.");
    if (request.method === "conversation.create") {
      if (
        !response.handle ||
        !uuid.test(response.handle) ||
        !provider(response.provider) ||
        response.provider !== request.provider ||
        this.handles.has(response.handle)
      )
        this.protocolFailure("Native create did not return a fresh bound handle.");
      this.handles.set(response.handle, response.provider);
    } else if (response.handle !== undefined && response.handle !== request.handle)
      this.protocolFailure("Native response handle mismatch.");
    if (request.method === "message.send" && (!response.turnID || !uuid.test(response.turnID)))
      this.protocolFailure("Native send did not return an accepted turn.");
    return response;
  }
}

let shared: NativeBridge | undefined;
export function inheritedNativeBridge() {
  if (
    process.env.T3CODE_TEXOS_NATIVE_BRIDGE !== "1" ||
    process.env.T3CODE_TEXOS_BRIDGE_READ_FD !== "3" ||
    process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD !== "4"
  )
    throw new Error("Native TexOS bridge requires inherited fd3/fd4; SDK fallback is disabled.");
  return (shared ??= new NativeBridge(
    NodeFS.createReadStream("", { fd: 3, autoClose: true }),
    NodeFS.createWriteStream("", { fd: 4, autoClose: true }),
  ));
}
