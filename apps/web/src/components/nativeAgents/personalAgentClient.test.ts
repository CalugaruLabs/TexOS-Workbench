import { describe, expect, it } from "vite-plus/test";
import canonicalSnapshot from "../../../../../packages/contracts/test-fixtures/personal-agent-canonical-tasks.json" with { type: "json" };
import {
  PersonalAgentClient,
  verifyPersonalArtifact,
  type PersonalAgentTransport,
} from "./personalAgentClient";

const hello = {
  protocolVersion: 2,
  personalOnly: true,
  runtimeID: "r",
  mode: "fake",
  capabilities: ["agents.v2"],
};
const snapshot = (revision = 1) => ({
  revision,
  runtimeID: "r",
  mode: "fake",
  revoked: false,
  agents: [],
  runs: [],
  messages: [],
  attention: [],
  artifacts: [],
});
function fixture(negotiatedHello: unknown = hello) {
  const commands: Array<{ method: string; params: Record<string, unknown>; id: string }> = [];
  let counter = 0;
  let current: unknown = snapshot();
  let refusal: Error | null = null;
  let readResult: unknown;
  let holdSnapshots = false;
  let snapshotRefusal: Error | null = null;
  const pendingSnapshots: Array<{ resolve: (value: unknown) => void; captured: unknown }> = [];
  const source: ReturnType<PersonalAgentTransport["events"]> = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close() {},
  };
  const client = new PersonalAgentClient({
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    events: () => source,
    async command(method, params, id) {
      commands.push({ method, params, id });
      if (refusal && method === "agents.submit") throw refusal;
      if (method === "agents.history" || method === "agents.run") return readResult;
      if (method === "agents.snapshot" && snapshotRefusal) throw snapshotRefusal;
      if (method === "agents.snapshot" && holdSnapshots)
        return new Promise((resolve) =>
          pendingSnapshots.push({ resolve, captured: structuredClone(current) }),
        );
      return method === "agents.hello"
        ? negotiatedHello
        : method === "agents.snapshot"
          ? current
          : { runID: "run", snapshot: current };
    },
  });
  return {
    client,
    commands,
    source,
    setSnapshot(value: unknown) {
      current = value;
    },
    refuse(error: Error) {
      refusal = error;
    },
    setReadResult(value: unknown) {
      readResult = value;
    },
    holdSnapshots(value = true) {
      holdSnapshots = value;
    },
    refuseSnapshots(value: Error | null) {
      snapshotRefusal = value;
    },
    pendingSnapshotCount() {
      return pendingSnapshots.length;
    },
    resolveSnapshot(index: number) {
      const request = pendingSnapshots[index];
      if (!request) throw new Error("Missing synthetic read");
      request.resolve(request.captured);
    },
    emit(value: unknown) {
      (source.onmessage as ((event: MessageEvent) => void) | null)?.(
        new MessageEvent("message", { data: JSON.stringify(value) }),
      );
    },
    reopen() {
      (source.onopen as (() => void) | null)?.();
    },
  };
}
describe("personal agent presentation client", () => {
  it("does not let a read started before an uncertain command clear recovery", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    f.holdSnapshots();
    const earlierRead = f.client.refresh();
    f.refuse(new Error("Synthetic command outcome uncertain"));
    await expect(
      f.client.command("agents.submit", { agentID: "builder", text: "Synthetic work" }),
    ).rejects.toThrow("Synthetic command outcome uncertain");
    f.resolveSnapshot(0);
    await earlierRead;
    expect(f.client.getSnapshot().connected).toBe(false);
    expect(f.client.getSnapshot().problem).toBe("Synthetic command outcome uncertain");
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    f.emit(structuredClone(canonicalSnapshot));
    expect(f.client.getSnapshot().connected).toBe(false);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    f.holdSnapshots(false);
    const fresh = structuredClone(canonicalSnapshot);
    fresh.canonicalTasks.revision = 2;
    fresh.canonicalTasks.items[0]!.title = "Confirmed after recovery";
    f.setSnapshot(fresh);
    await f.client.refresh();
    expect(f.client.getSnapshot().connected).toBe(true);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title).toBe(
      "Confirmed after recovery",
    );
    expect(f.commands.filter((command) => command.method === "agents.submit")).toHaveLength(1);
    f.client.disconnect();
  });
  it.each([false, true])(
    "does not let an in-flight read clear a newer source fence (redacted events: %s)",
    async (redacted) => {
      const f = fixture();
      f.setSnapshot(structuredClone(canonicalSnapshot));
      await f.client.connect();
      f.holdSnapshots();
      const second = structuredClone(canonicalSnapshot);
      second.canonicalTasks.projectionGeneration = "projection-B";
      second.canonicalTasks.items[0]!.title = "Intermediate source";
      const third = structuredClone(canonicalSnapshot);
      third.canonicalTasks.projectionGeneration = "projection-C";
      third.canonicalTasks.items[0]!.title = "Latest source";
      const { canonicalTasks: _omitted, ...withoutTasks } = canonicalSnapshot;
      f.setSnapshot(second);
      f.emit(redacted ? withoutTasks : second);
      f.setSnapshot(third);
      f.emit(redacted ? withoutTasks : third);
      f.resolveSnapshot(0);
      await expect.poll(() => f.pendingSnapshotCount()).toBe(2);
      expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
      f.resolveSnapshot(1);
      await expect
        .poll(() => f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title)
        .toBe("Latest source");
      expect(f.commands.filter((command) => command.method === "agents.snapshot")).toHaveLength(3);
      expect(f.commands.some((command) => command.method === "agents.submit")).toBe(false);
      f.client.disconnect();
    },
  );
  it("keeps refresh recovery latched until a successful read instead of restoring details from queued events", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    f.refuseSnapshots(new Error("Synthetic read failure"));
    await f.client.refresh();
    expect(f.client.getSnapshot().connected).toBe(false);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.revision = 2;
    next.canonicalTasks.items[0]!.title = "After recovery";
    f.emit(next);
    expect(f.client.getSnapshot().connected).toBe(false);
    expect(f.client.getSnapshot().problem).toBe("Synthetic read failure");
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    f.refuseSnapshots(null);
    f.setSnapshot(next);
    await f.client.refresh();
    expect(f.client.getSnapshot().connected).toBe(true);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title).toBe("After recovery");
    expect(f.commands.some((command) => command.method === "agents.submit")).toBe(false);
    f.client.disconnect();
  });
  it("updates native task content with unchanged helper revision and never regresses it", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.revision = 2;
    next.canonicalTasks.items[0]!.title = "New native title";
    f.emit(next);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title).toBe(
      "New native title",
    );
    expect(f.client.getSnapshot().snapshot?.revision).toBe(1);
    f.emit(canonicalSnapshot);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    expect(f.commands.some((command) => command.method === "agents.submit")).toBe(false);
    f.client.disconnect();
  });
  it("orders overlapping snapshot reads without republishing a superseded title", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    f.holdSnapshots();
    const older = f.client.refresh();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.revision = 2;
    next.canonicalTasks.items[0]!.title = "Current native title";
    f.setSnapshot(next);
    const newer = f.client.refresh();
    f.resolveSnapshot(1);
    await newer;
    f.resolveSnapshot(0);
    await older;
    expect(f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title).toBe(
      "Current native title",
    );
    expect(
      f.commands.every((command) => ["agents.hello", "agents.snapshot"].includes(command.method)),
    ).toBe(true);
    f.client.disconnect();
  });
  it("withholds an unknown generation and fences its old events until a fresh read", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.projectionGeneration = "projection-B";
    next.canonicalTasks.items[0]!.title = "Replacement source";
    f.setSnapshot(next);
    f.holdSnapshots();
    f.emit(next);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    f.emit(canonicalSnapshot);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    f.resolveSnapshot(0);
    await expect
      .poll(() => f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title)
      .toBe("Replacement source");
    expect(f.commands.filter((command) => command.method === "agents.snapshot")).toHaveLength(2);
    f.client.disconnect();
  });
  it("retires callbacks and reads when a connection reuses its helper and EventSource identities", async () => {
    const f = fixture();
    f.setSnapshot(structuredClone(canonicalSnapshot));
    await f.client.connect();
    const oldMessage = f.source.onmessage;
    const oldError = f.source.onerror;
    const oldOpen = f.source.onopen;
    f.holdSnapshots();
    const oldRead = f.client.refresh();
    (oldError as (() => void) | null)?.();
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.projectionGeneration = "reconnected-source";
    next.canonicalTasks.items[0]!.title = "Fresh connection";
    f.setSnapshot(next);
    f.holdSnapshots(false);
    await f.client.refresh();
    f.resolveSnapshot(0);
    await oldRead;
    (oldMessage as ((event: MessageEvent) => void) | null)?.(
      new MessageEvent("message", { data: JSON.stringify(canonicalSnapshot) }),
    );
    (oldError as (() => void) | null)?.();
    (oldOpen as (() => void) | null)?.();
    expect(f.client.getSnapshot().connected).toBe(true);
    expect(f.client.getSnapshot().snapshot?.canonicalTasks?.items[0]?.title).toBe(
      "Fresh connection",
    );
    expect(f.commands.some((command) => command.method === "agents.submit")).toBe(false);
    f.client.disconnect();
  });
  it("clears optional native presentation and does not return raw stale command snapshots", async () => {
    const f = fixture();
    const next = structuredClone(canonicalSnapshot);
    next.canonicalTasks.revision = 2;
    f.setSnapshot(next);
    await f.client.connect();
    f.setSnapshot(canonicalSnapshot);
    const result = await f.client.command("agents.update", { agentID: "builder", name: "Changed" });
    expect(result).toMatchObject({ snapshot: { runtimeID: "r" } });
    expect(
      (result as { snapshot: { canonicalTasks?: unknown } }).snapshot.canonicalTasks,
    ).toBeUndefined();
    f.setSnapshot(snapshot());
    await f.client.refresh();
    expect(f.client.getSnapshot().snapshot?.canonicalTasks).toBeUndefined();
    expect(f.client.getSnapshot().snapshot?.runs).toEqual([]);
    f.client.disconnect();
  });
  it("keeps observation reads and metadata available while refusing every execution control locally", async () => {
    const f = fixture({ ...hello, mode: "observeOnly", executionAvailable: false });
    f.setSnapshot({ ...snapshot(), mode: "observeOnly", executionAvailable: false });
    await f.client.connect();
    expect(f.client.getSnapshot().connected).toBe(true);
    await f.client.command("agents.create", {
      name: "Saved role",
      provider: "codex",
      instructions: "",
    });
    f.setReadResult({
      runtimeID: "r",
      revision: 1,
      collection: "messages",
      items: [],
      nextBefore: null,
    });
    await expect(f.client.history({ collection: "messages" })).resolves.toMatchObject({
      items: [],
    });
    const before = f.commands.length;
    for (const method of [
      "agents.submit",
      "agents.stop",
      "agents.reconcile",
      "agents.answer",
      "agents.respond",
    ] as const) {
      await expect(f.client.command(method, {})).rejects.toThrow("not enabled");
    }
    expect(f.commands).toHaveLength(before);
    expect(f.client.getSnapshot().connected).toBe(true);
    expect(f.client.getSnapshot().snapshot?.mode).toBe("observeOnly");
    f.client.disconnect();
  });
  it("reads history and old run detail without replacing the current snapshot", async () => {
    const f = fixture();
    await f.client.connect();
    const current = f.client.getSnapshot().snapshot;
    const page = {
      runtimeID: "r",
      revision: 1,
      collection: "messages",
      items: [],
      nextBefore: null,
    };
    f.setReadResult(page);
    await expect(
      f.client.history({ collection: "messages", conversationID: "c", before: 100 }),
    ).resolves.toEqual(page);
    const run = {
      id: "old",
      agentID: "a",
      taskID: "t",
      conversationID: "c",
      status: "completed",
      text: "retained",
      createdAt: "now",
      updatedAt: "now",
    };
    const detail = {
      runtimeID: "r",
      revision: 1,
      run,
      attention: [],
      artifacts: [],
      totalAttention: 0,
      totalArtifacts: 0,
    };
    f.setReadResult(detail);
    await expect(f.client.run("old")).resolves.toEqual(detail);
    expect(f.client.getSnapshot().snapshot).toBe(current);
    expect(f.commands.filter((item) => item.method === "agents.submit")).toHaveLength(0);
    f.client.disconnect();
  });
  it("rejects malformed, foreign-runtime and stale read responses without changing durable state", async () => {
    for (const result of [
      { snapshot: snapshot() },
      { runtimeID: "foreign", revision: 2, collection: "runs", items: [], nextBefore: null },
      { runtimeID: "r", revision: 0, collection: "runs", items: [], nextBefore: null },
      { runtimeID: "r", revision: 2, collection: "messages", items: [], nextBefore: null },
    ]) {
      const f = fixture();
      await f.client.connect();
      f.setReadResult(result);
      await expect(f.client.history({ collection: "runs" })).rejects.toThrow();
      expect(f.client.getSnapshot().connected).toBe(false);
      expect(f.client.getSnapshot().snapshot?.runtimeID).toBe("r");
      f.client.disconnect();
    }
  });
  it("does not send malformed history parameters or read after revocation", async () => {
    const f = fixture();
    await f.client.connect();
    await expect(f.client.history({ collection: "runs", limit: 51 })).rejects.toThrow();
    expect(f.commands.some((item) => item.method === "agents.history")).toBe(false);
    f.emit({ ...snapshot(2), revoked: true });
    await expect(f.client.run("old")).rejects.toThrow("Reconnect");
    expect(f.commands.some((item) => item.method === "agents.run")).toBe(false);
    f.client.disconnect();
  });
  it("withholds in-flight reads after disconnect or a revocation event", async () => {
    for (const revoke of [false, true]) {
      const f = fixture();
      await f.client.connect();
      let complete!: (value: unknown) => void;
      f.setReadResult(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const pending = f.client.history({ collection: "runs" });
      if (revoke) f.emit({ ...snapshot(2), revoked: true });
      else f.client.disconnect();
      complete({ runtimeID: "r", revision: 2, collection: "runs", items: [], nextBefore: null });
      await expect(pending).rejects.toThrow("Workspace");
      f.client.disconnect();
    }
  });
  it("negotiates capability, reads durable snapshot, and retains native IDs across turns", async () => {
    const f = fixture();
    await f.client.connect();
    expect(f.commands.map((c) => c.method)).toEqual(["agents.hello", "agents.snapshot"]);
    const state = {
      ...snapshot(2),
      agents: [
        {
          id: "agent-native",
          name: "Builder",
          provider: "codex",
          instructions: "",
          conversationID: "conversation-native",
          createdAt: "2026-10-30T00:00:00Z",
        },
      ],
    };
    f.emit(state);
    expect(f.client.getSnapshot().snapshot?.agents[0]?.id).toBe("agent-native");
    await f.client.command("agents.submit", { agentID: "agent-native", text: "first" });
    await f.client.command("agents.submit", { agentID: "agent-native", text: "follow-up" });
    const submissions = f.commands.filter((c) => c.method === "agents.submit");
    expect(submissions.map((c) => c.params.agentID)).toEqual(["agent-native", "agent-native"]);
    expect(new Set(submissions.map((c) => c.id)).size).toBe(2);
    f.client.disconnect();
  });
  it("never resubmits uncertain work and reloads snapshot after reconnect", async () => {
    const f = fixture();
    await f.client.connect();
    f.refuse(new Error("Outcome uncertain"));
    await expect(f.client.command("agents.submit", { agentID: "a", text: "Work" })).rejects.toThrow(
      "uncertain",
    );
    f.emit(snapshot(2));
    expect(f.client.getSnapshot().connected).toBe(false);
    await expect(
      f.client.command("agents.submit", { agentID: "a", text: "Do not replay" }),
    ).rejects.toThrow("Reconnect");
    const fresh = {
      ...snapshot(4),
      runs: [
        {
          id: "accepted-run",
          agentID: "a",
          taskID: "t",
          conversationID: "c",
          status: "running",
          text: "Work",
          createdAt: "now",
          updatedAt: "now",
        },
      ],
    };
    f.setSnapshot(fresh);
    await f.client.refresh();
    expect(f.client.getSnapshot().snapshot?.runs[0]?.id).toBe("accepted-run");
    expect(f.commands.filter((c) => c.method === "agents.submit")).toHaveLength(1);
    f.emit(snapshot(1));
    expect(f.client.getSnapshot().snapshot?.revision).toBe(4);
    f.client.disconnect();
  });
  it("fails closed on runtime mismatch and revoked snapshots", async () => {
    const f = fixture();
    await f.client.connect();
    f.emit({ ...snapshot(2), revoked: true });
    await expect(f.client.command("agents.submit", { agentID: "a", text: "x" })).rejects.toThrow();
    f.emit({ ...snapshot(3), runtimeID: "another-space" });
    expect(f.client.getSnapshot().connected).toBe(false);
    expect(f.client.getSnapshot().snapshot?.runtimeID).toBe("r");
    expect(f.commands.filter((c) => c.method === "agents.submit")).toHaveLength(0);
    f.client.disconnect();
  });
  it("verifies artifact identity, size, and SHA before preview", async () => {
    const bytes = new TextEncoder().encode("hello");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const artifact = {
      id: "artifact",
      name: "result.txt",
      mimeType: "text/plain",
      base64: btoa("hello"),
      sha256,
    };
    await expect(verifyPersonalArtifact(artifact, "artifact")).resolves.toMatchObject({
      content: "hello",
    });
    await expect(
      verifyPersonalArtifact({ ...artifact, sha256: "0".repeat(64) }, "artifact"),
    ).rejects.toThrow("integrity");
    await expect(verifyPersonalArtifact(artifact, "foreign-artifact")).rejects.toThrow();
  });
  it("answers the pending question ID in place without creating another provider turn", async () => {
    const f = fixture();
    await f.client.connect();
    const attention = {
      id: "pending-question",
      runID: "original-run",
      tool: "request_user_input",
      description: "Direction",
      createdAt: "now",
      kind: "question",
      isBlocking: true,
      answerable: true,
      questions: [{ id: "direction", header: "Direction", question: "What should happen next?" }],
    };
    f.emit({ ...snapshot(2), attention: [attention] });
    f.setSnapshot(snapshot(3));
    await f.client.command("agents.respond", {
      attentionID: "pending-question",
      answers: { direction: ["Continue the pilot"] },
    });
    expect(f.commands.filter((c) => c.method === "agents.respond")).toMatchObject([
      {
        params: { attentionID: "pending-question", answers: { direction: ["Continue the pilot"] } },
      },
    ]);
    expect(f.commands.some((c) => c.method === "agents.submit")).toBe(false);
    expect(f.client.getSnapshot().snapshot?.attention).toEqual([]);
    f.client.disconnect();
  });
});
