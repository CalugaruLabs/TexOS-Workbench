import type {
  PersonalAgentHello,
  PersonalAgentMethod,
  PersonalAgentSnapshot,
  PersonalAgentHistoryParams,
} from "@t3tools/contracts";
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
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

export interface PersonalAgentClientState {
  hello: PersonalAgentHello | null;
  snapshot: PersonalAgentSnapshot | null;
  connected: boolean;
  busy: boolean;
  problem: string | null;
}
type SnapshotEvents = Pick<EventSource, "onopen" | "onerror" | "onmessage" | "close">;
export interface PersonalAgentTransport {
  command(
    method: PersonalAgentMethod,
    params: Record<string, unknown>,
    id: string,
  ): Promise<unknown>;
  events(): SnapshotEvents;
  uuid(): string;
}
export const personalAgentTransport: PersonalAgentTransport = {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - Browser command transport is deliberately independent of an Effect runtime.
  uuid: () => crypto.randomUUID(),
  events: () =>
    new EventSource(resolvePrimaryEnvironmentHttpUrl("/api/texos/agents/events"), {
      withCredentials: true,
    }),
  async command(method, params, id) {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/texos/agents"), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, method, params }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok)
      throw new Error("Native admission is unavailable. Refresh state before submitting again.");
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 2 ||
      !("id" in value) ||
      value.id !== id ||
      !("ok" in value)
    )
      throw new Error("Invalid native response.");
    if (!value.ok) {
      const error = "error" in value ? value.error : null;
      throw new Error(
        error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
          ? error.message
          : "Native TexOS refused this action.",
      );
    }
    if (!("result" in value)) throw new Error("Missing native result.");
    return value.result;
  },
};

export class PersonalAgentClient {
  private state: PersonalAgentClientState = {
    hello: null,
    snapshot: null,
    connected: false,
    busy: false,
    problem: null,
  };
  private listeners = new Set<() => void>();
  private source: SnapshotEvents | null = null;
  private generation = 0;
  private requiresFreshRead = false;
  private readRevision = 0;
  private canonicalCursor: PersonalAgentCanonicalCursor | undefined;
  private canonicalAwaitingRead = false;
  private snapshotReadOrdinal = 0;
  private projectionRefreshPending = false;
  private projectionRefreshAgain = false;
  private projectionEpoch = 0;
  constructor(private readonly transport: PersonalAgentTransport = personalAgentTransport) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(next: Partial<PersonalAgentClientState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private clearCanonicalTasks() {
    if (this.state.snapshot?.canonicalTasks)
      this.patch({ snapshot: withoutPersonalAgentCanonicalTasks(this.state.snapshot) });
  }
  private accept(
    value: unknown,
    freshRead = false,
  ): { snapshot: PersonalAgentSnapshot; readRequired: boolean } {
    if (
      !isPersonalAgentSnapshot(value) ||
      value.runtimeID !== this.state.hello?.runtimeID ||
      value.mode !== this.state.hello.mode
    )
      throw new Error("Personal agent snapshot does not match this workspace.");
    if (this.state.snapshot && value.revision < this.state.snapshot.revision)
      return { snapshot: withoutPersonalAgentCanonicalTasks(value), readRequired: false };
    const decision = personalAgentCanonicalFreshness(
      value.canonicalTasks,
      this.canonicalCursor,
      freshRead,
    );
    const readRequired =
      decision === "readRequired" ||
      (decision === "absent" && this.canonicalCursor !== undefined && !freshRead);
    if (!freshRead && (readRequired || value.revoked)) this.projectionEpoch += 1;
    if (readRequired) this.canonicalAwaitingRead = true;
    let snapshot = value;
    if (
      value.revoked ||
      decision === "stale" ||
      decision === "readRequired" ||
      (this.canonicalAwaitingRead && !freshRead)
    )
      snapshot = withoutPersonalAgentCanonicalTasks(value);
    else {
      if (freshRead) this.canonicalAwaitingRead = false;
      if (freshRead && decision === "absent") this.canonicalCursor = undefined;
      if (decision === "accept" && value.canonicalTasks)
        this.canonicalCursor = {
          generation: value.canonicalTasks.projectionGeneration,
          revision: value.canonicalTasks.revision,
        };
    }
    this.readRevision = Math.max(this.readRevision, value.revision);
    this.patch({ snapshot });
    return { snapshot, readRequired };
  }
  private refreshProjection() {
    if (this.projectionRefreshPending) {
      this.projectionRefreshAgain = true;
      return;
    }
    const generation = this.generation;
    this.projectionRefreshPending = true;
    void this.readSnapshot().finally(() => {
      if (generation !== this.generation) return;
      this.projectionRefreshPending = false;
      if (this.projectionRefreshAgain) {
        this.projectionRefreshAgain = false;
        this.refreshProjection();
      }
    });
  }
  async connect() {
    this.disconnect();
    const generation = this.generation;
    try {
      const hello = await this.transport.command("agents.hello", {}, this.transport.uuid());
      if (generation !== this.generation) return;
      if (!isPersonalAgentHello(hello))
        throw new Error("This native build does not support personal agents.");
      this.readRevision = 0;
      this.patch({ hello, snapshot: null, problem: null });
      await this.readSnapshot();
      if (generation !== this.generation) return;
      const source = this.transport.events();
      this.source = source;
      source.onopen = () => {
        if (generation === this.generation) void this.refresh();
      };
      source.onerror = () => {
        if (generation === this.generation) {
          // EventSource can reconnect with the same durable helper ID. Retire this
          // subscription and every captured callback; Refresh creates a new lifetime.
          this.disconnect();
          this.patch({
            connected: false,
            problem:
              "Connection interrupted. Work may continue in TexOS. Refresh state to reconnect.",
          });
        }
      };
      source.onmessage = (event) => {
        if (generation !== this.generation) return;
        try {
          const accepted = this.accept(JSON.parse(event.data));
          if (accepted.readRequired) this.refreshProjection();
          if (!this.requiresFreshRead) this.patch({ connected: true, problem: null });
        } catch {
          this.disconnect();
          this.patch({
            connected: false,
            problem: "Could not validate agent updates. Refresh state.",
          });
        }
      };
    } catch (error) {
      if (generation === this.generation)
        this.patch({
          connected: false,
          problem: error instanceof Error ? error.message : "Personal agents are unavailable.",
        });
    }
  }
  disconnect() {
    this.generation += 1;
    this.source?.close();
    this.source = null;
    this.canonicalCursor = undefined;
    this.canonicalAwaitingRead = false;
    this.projectionRefreshPending = false;
    this.projectionRefreshAgain = false;
    this.projectionEpoch += 1;
    this.snapshotReadOrdinal += 1;
    this.clearCanonicalTasks();
    this.patch({ connected: false, busy: false });
  }
  async refresh() {
    if (!this.source) return this.connect();
    return this.readSnapshot();
  }
  private async readSnapshot() {
    const generation = this.generation;
    const ordinal = ++this.snapshotReadOrdinal;
    const projectionEpoch = this.projectionEpoch;
    try {
      const snapshot = await this.transport.command("agents.snapshot", {}, this.transport.uuid());
      if (
        generation !== this.generation ||
        ordinal !== this.snapshotReadOrdinal ||
        projectionEpoch !== this.projectionEpoch
      )
        return;
      this.accept(snapshot, true);
      this.requiresFreshRead = false;
      this.patch({ connected: true, problem: null });
    } catch (error) {
      if (
        generation === this.generation &&
        ordinal === this.snapshotReadOrdinal &&
        projectionEpoch === this.projectionEpoch
      ) {
        this.requiresFreshRead = true;
        this.canonicalAwaitingRead = true;
        this.projectionEpoch += 1;
        this.clearCanonicalTasks();
        this.patch({
          connected: false,
          problem: error instanceof Error ? error.message : "Could not refresh agent state.",
        });
      }
    }
  }
  async command(method: PersonalAgentMethod, params: Record<string, unknown>) {
    if (!this.state.connected || this.state.busy || this.state.snapshot?.revoked)
      throw new Error("Reconnect to this workspace before changing agent work.");
    if (
      isPersonalAgentExecutionMethod(method) &&
      (!this.state.hello ||
        !this.state.snapshot ||
        !personalAgentExecutionAvailable(this.state.hello) ||
        !personalAgentExecutionAvailable(this.state.snapshot))
    )
      throw new Error(
        "Agent execution is not enabled on this connection. Saved agents and history remain available.",
      );
    const generation = this.generation;
    const projectionEpoch = this.projectionEpoch;
    const command = decodePersonalAgentCommand({ id: this.transport.uuid(), method, params });
    this.patch({ busy: true, problem: null });
    try {
      let result = await this.transport.command(method, params, command.id);
      if (generation !== this.generation)
        throw new Error("Workspace changed while the command was pending.");
      if (!this.state.connected || this.state.snapshot?.revoked)
        throw new Error("Workspace access changed while the command was pending.");
      if (method === "agents.history" || method === "agents.run") {
        const valid =
          method === "agents.history"
            ? isPersonalAgentHistoryPage(result, params)
            : isPersonalAgentRunDetail(result, params.runID);
        if (
          !valid ||
          !result ||
          typeof result !== "object" ||
          !("runtimeID" in result) ||
          result.runtimeID !== this.state.hello?.runtimeID ||
          !("revision" in result) ||
          Number(result.revision) < this.readRevision
        )
          throw new Error("Invalid or stale personal agent read response.");
        if (result && typeof result === "object" && "revision" in result)
          this.readRevision = Math.max(this.readRevision, Number(result.revision));
      } else if (method !== "agents.artifact") {
        if (!result || typeof result !== "object" || !("snapshot" in result))
          throw new Error("Missing updated agent state.");
        if (projectionEpoch !== this.projectionEpoch) {
          if (!isPersonalAgentSnapshot(result.snapshot))
            throw new Error("Invalid updated agent state.");
          result = { ...result, snapshot: withoutPersonalAgentCanonicalTasks(result.snapshot) };
        } else {
          const accepted = this.accept(result.snapshot);
          if (accepted.readRequired) this.refreshProjection();
          result = { ...result, snapshot: accepted.snapshot };
        }
      }
      return result;
    } catch (error) {
      if (generation === this.generation) {
        this.requiresFreshRead = true;
        this.canonicalAwaitingRead = true;
        this.projectionEpoch += 1;
        this.clearCanonicalTasks();
        this.patch({
          connected: false,
          problem:
            error instanceof Error
              ? error.message
              : "Outcome is uncertain. Refresh state before new work.",
        });
      }
      throw error;
    } finally {
      if (generation === this.generation) this.patch({ busy: false });
    }
  }
  async history(params: PersonalAgentHistoryParams) {
    const input = { ...params };
    const result = await this.command("agents.history", input);
    if (!isPersonalAgentHistoryPage(result, input)) throw new Error("Invalid history page.");
    return result;
  }
  async run(runID: string) {
    const result = await this.command("agents.run", { runID });
    if (!isPersonalAgentRunDetail(result, runID)) throw new Error("Invalid run detail.");
    return result;
  }
}

export type PersonalArtifactPreview = {
  id: string;
  name: string;
  mimeType: "text/html" | "text/plain" | "image/png";
  content: string;
};
export async function verifyPersonalArtifact(
  value: unknown,
  artifactID: string,
): Promise<PersonalArtifactPreview> {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    value.id !== artifactID ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("mimeType" in value) ||
    typeof value.mimeType !== "string" ||
    !("base64" in value) ||
    typeof value.base64 !== "string" ||
    value.base64.length > 699052 ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string"
  )
    throw new Error("Invalid artifact response.");
  const bytes = Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0));
  if (bytes.length > 512 * 1024) throw new Error("Artifact exceeds preview size.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  if (sha !== value.sha256.toLowerCase()) throw new Error("Artifact integrity check failed.");
  if (value.mimeType === "image/png")
    return {
      id: artifactID,
      name: value.name,
      mimeType: "image/png",
      content: `data:image/png;base64,${value.base64}`,
    };
  if (!["text/html", "text/plain", "text/markdown", "application/json"].includes(value.mimeType))
    throw new Error("This artifact type has no safe preview yet.");
  return {
    id: artifactID,
    name: value.name,
    mimeType: value.mimeType === "text/html" ? "text/html" : "text/plain",
    content: new TextDecoder().decode(bytes),
  };
}
export function safePersonalArtifactHTML(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script,iframe,frame,object,embed,base,link,meta,form")
    .forEach((element) => element.remove());
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        ["href", "xlink:href", "action", "formaction", "srcdoc", "srcset"].includes(name) ||
        (name === "src" &&
          !(
            element.tagName === "IMG" &&
            /^data:image\/(png|jpeg|gif|webp);base64,/i.test(attribute.value)
          ))
      )
        element.removeAttribute(attribute.name);
    }
  }
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; navigate-to 'none'";
  document.head.prepend(policy);
  return "<!doctype html>" + document.documentElement.outerHTML;
}
