import { describe, expect, it } from "vite-plus/test";
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
function fixture() {
  const commands: Array<{ method: string; params: Record<string, unknown>; id: string }> = [];
  let counter = 0;
  let current: unknown = snapshot();
  let refusal: Error | null = null;
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
      return method === "agents.hello"
        ? hello
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
