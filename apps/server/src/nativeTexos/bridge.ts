// @effect-diagnostics nodeBuiltinImport:off - Private inherited Node descriptors and opaque UUIDs; no provider subprocess.
import * as NodeTimers from "node:timers";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as NodeStream from "node:stream";

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

/** A single host generation. EOF is permanent; it never reconnects or resends. */
export class NativeBridge {
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
    for (const entry of this.pending.values()) {
      NodeTimers.clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
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
  private receive(chunk: Buffer) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) {
        if (this.buffer.length > MAX_FRAME) this.fail(new Error("Native frame exceeds limit."));
        return;
      }
      if (newline > MAX_FRAME || newline === 0) {
        this.fail(new Error("Invalid native frame size."));
        return;
      }
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!frame || frame.version !== 1) throw new Error("Unsupported native bridge version.");
        if (frame.kind === "response") {
          if (!uuid.test(frame.id) || typeof frame.ok !== "boolean")
            throw new Error("Invalid native response.");
          const entry = this.pending.get(frame.id);
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
