import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { NativeBridge, MAX_FRAME, MAX_NATIVE_FRAME } from "./bridge.ts";

const { PassThrough } = await vi.importActual<typeof import("node:stream")>("node:stream");
const { once } = await vi.importActual<typeof import("node:events")>("node:events");
let fixtureUUID = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String(++fixtureUUID).padStart(12, "0")}`;

const clients: NativeBridge[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
function peer(timeoutMs = 1000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  let answer: (request: Record<string, unknown>) => void = () => {};
  output.on("data", (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    answer(request);
  });
  const client = new NativeBridge(input, output, timeoutMs);
  clients.push(client);
  const respond = (request: Record<string, unknown>, body: object) =>
    input.write(JSON.stringify({ version: 1, kind: "response", id: request.id, ...body }) + "\n");
  return {
    client,
    input,
    output,
    requests,
    respond,
    setAnswer: (next: typeof answer) => {
      answer = next;
    },
  };
}

describe("native private bridge", () => {
  it("does not advertise or execute host control without an installed private handler", async () => {
    const p = peer();
    const frame = {
      version: 2,
      namespace: "texos.execution",
      kind: "request",
      id: randomUUID(),
      authorityID: "synthetic-authority",
      hostID: "synthetic-host",
      hostGeneration: "generation-1",
      method: "execution.hello",
      params: { capabilities: ["texos.execution.authorize.v2"] },
    };
    const first = once(p.output, "data");
    p.input.write(JSON.stringify(frame) + "\n");
    const [wire] = await first;
    expect(JSON.parse(wire.toString())).toMatchObject({
      namespace: "texos.execution",
      ok: true,
      result: { capabilities: [] },
    });
    const second = once(p.output, "data");
    p.input.write(
      JSON.stringify({
        ...frame,
        id: randomUUID(),
        method: "execution.status",
        params: { commandID: randomUUID(), envelopeDigest: "a".repeat(64) },
      }) + "\n",
    );
    const [refused] = await second;
    expect(JSON.parse(refused.toString())).toMatchObject({
      ok: false,
      error: { code: "executionUnavailable" },
    });
  });

  it("an armed bridge binds execution control to the first private hello only", async () => {
    const p = peer();
    const handled: Array<{ readonly method: string; readonly authorized: boolean }> = [];
    p.client.enableExecutionControl(() => ({
      handle: async (request, authorize) => {
        handled.push({ method: request.method, authorized: authorize !== undefined });
        return { capabilities: ["texos.execution.managed-cli.v1"] } as never;
      },
      disconnect: async () => {},
    }));
    const frame = {
      version: 2,
      namespace: "texos.execution",
      kind: "request",
      authorityID: "synthetic-authority",
      hostID: "synthetic-host",
      hostGeneration: "generation-1",
    };
    const refused = once(p.output, "data");
    p.input.write(
      JSON.stringify({
        ...frame,
        id: randomUUID(),
        method: "execution.status",
        params: { commandID: randomUUID(), envelopeDigest: "a".repeat(64) },
      }) + "\n",
    );
    expect(JSON.parse((await refused)[0].toString())).toMatchObject({
      ok: false,
      error: { code: "executionUnavailable" },
    });
    expect(handled).toEqual([]);

    const hello = once(p.output, "data");
    p.input.write(
      JSON.stringify({
        ...frame,
        id: randomUUID(),
        method: "execution.hello",
        params: { capabilities: ["texos.execution.authorize.v2"] },
      }) + "\n",
    );
    expect(JSON.parse((await hello)[0].toString())).toMatchObject({
      ok: true,
      hostGeneration: "generation-1",
      result: { capabilities: ["texos.execution.managed-cli.v1"] },
    });
    expect(handled).toEqual([{ method: "execution.hello", authorized: true }]);
    expect(() => p.client.enableExecutionControl(() => ({}) as never)).toThrow(
      "Execution control cannot be rebound.",
    );

    const closed = once(p.output, "close");
    p.input.write(
      JSON.stringify({
        ...frame,
        hostGeneration: "generation-2",
        id: randomUUID(),
        method: "execution.hello",
        params: { capabilities: ["texos.execution.authorize.v2"] },
      }) + "\n",
    );
    await closed;
    expect(handled).toHaveLength(1);
  });

  it("requires versioned hello before create and emits only canonical framed fields", async () => {
    const p = peer();
    const handle = randomUUID();
    p.setAnswer((r) =>
      p.respond(
        r,
        r.method === "hello"
          ? { ok: true, providers: ["codex"] }
          : { ok: true, handle, provider: "codex" },
      ),
    );
    await p.client.call({ method: "conversation.create", provider: "codex" });
    expect(p.requests.map((r) => r.method)).toEqual(["hello", "conversation.create"]);
    expect(p.requests[0]).toMatchObject({ version: 1, kind: "request" });
    expect(Object.keys(p.requests[1]!).sort()).toEqual([
      "id",
      "kind",
      "method",
      "provider",
      "version",
    ]);
    await expect(
      p.client.call({ method: "message.send", handle: randomUUID(), text: "private" }),
    ).rejects.toThrow("Unknown native handle");
    expect(p.requests).toHaveLength(2);
  });
  it("fails closed on incompatible hello without any provider request", async () => {
    const p = peer();
    p.setAnswer((r) =>
      p.input.write(
        JSON.stringify({ version: 2, kind: "response", id: r.id, ok: true, providers: ["codex"] }) +
          "\n",
      ),
    );
    await expect(
      p.client.call({ method: "conversation.create", provider: "codex" }),
    ).rejects.toThrow();
    expect(p.requests.map((r) => r.method)).toEqual(["hello"]);
  });
  it("does not resend uncertain sends after EOF", async () => {
    const p = peer();
    const handle = randomUUID();
    p.setAnswer((r) => {
      if (r.method === "hello") p.respond(r, { ok: true, providers: ["codex"] });
      else if (r.method === "conversation.create")
        p.respond(r, { ok: true, handle, provider: "codex" });
      else p.input.end();
    });
    await p.client.call({ method: "conversation.create", provider: "codex" });
    await expect(
      p.client.call({ method: "message.send", handle, text: "hello" }),
    ).rejects.toThrow();
    await expect(
      p.client.call({ method: "message.send", handle, text: "hello" }),
    ).rejects.toThrow();
    expect(p.requests.filter((r) => r.method === "message.send")).toHaveLength(1);
  });
  it("validates UTF-8 byte limits, split frames, bound providers and event sequence", async () => {
    const p = peer();
    const handle = randomUUID();
    const turnID = randomUUID();
    p.setAnswer((r) =>
      p.respond(
        r,
        r.method === "hello"
          ? { ok: true, providers: ["codex"] }
          : { ok: true, handle, provider: "codex" },
      ),
    );
    await p.client.call({ method: "conversation.create", provider: "codex" });
    await expect(
      p.client.call({ method: "message.send", handle, text: "🙂".repeat(2049) }),
    ).rejects.toThrow("limit");
    const events: unknown[] = [];
    p.client.onEvent((e) => events.push(e));
    const frame = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "event",
        handle,
        turnID,
        sequence: 1,
        provider: "codex",
        phase: "text",
        text: "🙂",
      }) + "\n",
    );
    p.input.write(frame.subarray(0, frame.length - 3));
    p.input.write(frame.subarray(frame.length - 3));
    expect(events).toHaveLength(1);
    p.input.write(frame);
    await expect(p.client.call({ method: "events.subscribe", handle })).rejects.toThrow();
    expect(events).toHaveLength(1);
  });
  it("allows exactly one send per fresh handle even with a new request UUID", async () => {
    const p = peer();
    const handle = randomUUID();
    p.setAnswer((r) =>
      p.respond(
        r,
        r.method === "hello"
          ? { ok: true, providers: ["codex"] }
          : r.method === "message.send"
            ? { ok: true, handle, turnID: randomUUID() }
            : { ok: true, handle, provider: "codex" },
      ),
    );
    await p.client.call({ method: "conversation.create", provider: "codex" });
    await p.client.call({ method: "message.send", handle, text: "first" });
    await expect(p.client.call({ method: "message.send", handle, text: "second" })).rejects.toThrow(
      "One fresh turn",
    );
    expect(p.requests.filter((r) => r.method === "message.send")).toHaveLength(1);
  });
  it("rejects oversized and malformed UTF-8 frames", async () => {
    for (const data of [Buffer.alloc(MAX_NATIVE_FRAME + 1, 65), Buffer.from([0xff, 10])]) {
      const p = peer();
      const pending = p.client.ready();
      p.input.write(data);
      await expect(pending).rejects.toThrow();
    }
  });
});

const agentSnapshot = (revision = 1) => ({
  revision,
  runtimeID: "personal-runtime",
  mode: "fake",
  revoked: false,
  agents: [],
  runs: [],
  messages: [],
  attention: [],
  artifacts: [],
});
const agentHello = {
  protocolVersion: 2,
  personalOnly: true,
  runtimeID: "personal-runtime",
  mode: "fake",
  capabilities: ["agents.v2", "queue", "permissions", "events"],
};
describe("native personal agents v2", () => {
  it("passes observation reads and metadata but blocks execution before forwarding to native", async () => {
    const p = peer();
    const observed = { ...agentSnapshot(), mode: "observeOnly", executionAvailable: false };
    p.setAnswer((request) => {
      if (request.version === 1) {
        p.respond(request, { ok: true, providers: ["codex"] });
        return;
      }
      const result =
        request.method === "agents.hello"
          ? { ...agentHello, mode: "observeOnly", executionAvailable: false }
          : request.method === "agents.snapshot"
            ? observed
            : request.method === "agents.history"
              ? {
                  runtimeID: observed.runtimeID,
                  revision: 1,
                  collection: "runs",
                  items: [],
                  nextBefore: null,
                }
              : { snapshot: observed };
      p.input.write(
        JSON.stringify({ version: 2, kind: "response", id: request.id, ok: true, result }) + "\n",
      );
    });
    await expect(
      p.client.callAgents({ id: randomUUID(), method: "agents.snapshot", params: {} }),
    ).resolves.toMatchObject({ ok: true, result: observed });
    await expect(
      p.client.callAgents({
        id: randomUUID(),
        method: "agents.create",
        params: { name: "Saved role", provider: "codex", instructions: "" },
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      p.client.callAgents({
        id: randomUUID(),
        method: "agents.history",
        params: { collection: "runs" },
      }),
    ).resolves.toMatchObject({ ok: true });
    const before = p.requests.length;
    const controls = [
      { method: "agents.submit", params: { agentID: "a", text: "Must not run" } },
      { method: "agents.stop", params: { runID: "r" } },
      { method: "agents.reconcile", params: { runID: "r" } },
      { method: "agents.answer", params: { attentionID: "a", allow: true } },
      { method: "agents.respond", params: { attentionID: "a", answers: { q: ["No"] } } },
    ];
    for (const command of controls) {
      await expect(p.client.callAgents({ id: randomUUID(), ...command })).resolves.toMatchObject({
        ok: false,
        error: { code: "executionUnavailable" },
      });
    }
    expect(p.requests).toHaveLength(before);
    await expect(
      p.client.callAgents({ id: randomUUID(), method: "agents.snapshot", params: {} }),
    ).resolves.toMatchObject({ ok: true, result: observed });
  });
  it("forwards caller hello UUIDs to the runtime identity registry independently of negotiation", async () => {
    const p = peer();
    const identities = new Map<string, string>();
    p.setAnswer((request) => {
      if (request.version === 1) {
        p.respond(request, { ok: true, providers: ["codex"] });
        return;
      }
      const id = String(request.id);
      const fingerprint = JSON.stringify({ method: request.method, params: request.params });
      const prior = identities.get(id);
      if (prior !== undefined && prior !== fingerprint) {
        p.input.write(
          JSON.stringify({
            version: 2,
            kind: "response",
            id,
            ok: false,
            error: { code: "conflict", message: "UUID content changed." },
          }) + "\n",
        );
        return;
      }
      identities.set(id, fingerprint);
      p.input.write(
        JSON.stringify({
          version: 2,
          kind: "response",
          id,
          ok: true,
          result:
            request.method === "agents.hello"
              ? agentHello
              : {
                  runtimeID: "personal-runtime",
                  revision: 1,
                  collection: "runs",
                  items: [],
                  nextBefore: null,
                },
        }) + "\n",
      );
    });
    const helloID = randomUUID();
    const helloCommand = { id: helloID, method: "agents.hello", params: {} };
    await expect(p.client.callAgents(helloCommand)).resolves.toMatchObject({
      id: helloID,
      ok: true,
    });
    expect(p.requests.filter((request) => request.method === "agents.hello")).toHaveLength(2);
    expect(p.requests[1]?.id).not.toBe(helloID);
    expect(p.requests[2]?.id).toBe(helloID);
    await expect(
      p.client.callAgents({
        id: helloID,
        method: "agents.history",
        params: { collection: "runs" },
      }),
    ).resolves.toMatchObject({ id: helloID, ok: false, error: { code: "conflict" } });
    await expect(p.client.callAgents(helloCommand)).resolves.toMatchObject({
      id: helloID,
      ok: true,
    });
    const historyID = randomUUID();
    await expect(
      p.client.callAgents({
        id: historyID,
        method: "agents.history",
        params: { collection: "runs" },
      }),
    ).resolves.toMatchObject({ id: historyID, ok: true });
    await expect(p.client.callAgents({ ...helloCommand, id: historyID })).resolves.toMatchObject({
      id: historyID,
      ok: false,
      error: { code: "conflict" },
    });
  });
  it("rejects caller hello replies with changed runtime, mode or response identity", async () => {
    for (const change of ["runtime", "mode", "id"]) {
      const p = peer();
      let negotiated = false;
      p.setAnswer((request) => {
        if (request.version === 1) {
          p.respond(request, { ok: true, providers: ["codex"] });
          return;
        }
        const result = negotiated
          ? {
              ...agentHello,
              ...(change === "runtime" ? { runtimeID: "other" } : {}),
              ...(change === "mode" ? { mode: "live" } : {}),
            }
          : agentHello;
        const id = negotiated && change === "id" ? randomUUID() : request.id;
        negotiated = true;
        p.input.write(
          JSON.stringify({ version: 2, kind: "response", id, ok: true, result }) + "\n",
        );
      });
      await expect(
        p.client.callAgents({ id: randomUUID(), method: "agents.hello", params: {} }),
      ).rejects.toThrow();
    }
  });
  it("validates history and run detail as reads bound to the negotiated runtime", async () => {
    const p = peer();
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
    p.setAnswer((request) => {
      if (request.version === 1) {
        p.respond(request, { ok: true, providers: ["codex"] });
        return;
      }
      const result =
        request.method === "agents.hello"
          ? agentHello
          : request.method === "agents.history"
            ? {
                runtimeID: "personal-runtime",
                revision: 1,
                collection: "runs",
                items: [run],
                nextBefore: null,
              }
            : {
                runtimeID: "personal-runtime",
                revision: 1,
                run,
                attention: [],
                artifacts: [],
                totalAttention: 0,
                totalArtifacts: 0,
              };
      p.input.write(
        JSON.stringify({ version: 2, kind: "response", id: request.id, ok: true, result }) + "\n",
      );
    });
    await expect(
      p.client.callAgents({
        id: randomUUID(),
        method: "agents.history",
        params: { collection: "runs" },
      }),
    ).resolves.toMatchObject({ ok: true, result: { items: [{ id: "old" }] } });
    await expect(
      p.client.callAgents({ id: randomUUID(), method: "agents.run", params: { runID: "old" } }),
    ).resolves.toMatchObject({ ok: true, result: { run: { id: "old" } } });
    expect(p.requests.every((request) => !("authorityID" in request))).toBe(true);
  });
  it("fails closed on malformed or foreign-runtime read results", async () => {
    for (const result of [
      { snapshot: agentSnapshot() },
      { runtimeID: "foreign", revision: 1, collection: "runs", items: [], nextBefore: null },
      { runtimeID: "personal-runtime", revision: 1, collection: "runs", items: [], nextBefore: -1 },
    ]) {
      const p = peer();
      p.setAnswer((request) => {
        if (request.version === 1) {
          p.respond(request, { ok: true, providers: ["codex"] });
          return;
        }
        p.input.write(
          JSON.stringify({
            version: 2,
            kind: "response",
            id: request.id,
            ok: true,
            result: request.method === "agents.hello" ? agentHello : result,
          }) + "\n",
        );
      });
      await expect(
        p.client.callAgents({
          id: randomUUID(),
          method: "agents.history",
          params: { collection: "runs" },
        }),
      ).rejects.toThrow("read response");
    }
  });
  it("withholds read results overtaken by current revision or revocation events", async () => {
    for (const revoked of [false, true]) {
      const p = peer();
      p.setAnswer((request) => {
        if (request.version === 1) {
          p.respond(request, { ok: true, providers: ["codex"] });
          return;
        }
        if (request.method === "agents.history") {
          p.input.write(
            JSON.stringify({
              version: 2,
              kind: "event",
              authorityID: "space-a",
              sequence: 2,
              event: "snapshot",
              snapshot: { ...agentSnapshot(2), revoked },
            }) + "\n",
          );
        }
        p.input.write(
          JSON.stringify({
            version: 2,
            kind: "response",
            id: request.id,
            ok: true,
            result:
              request.method === "agents.hello"
                ? agentHello
                : {
                    runtimeID: "personal-runtime",
                    revision: 1,
                    collection: "runs",
                    items: [],
                    nextBefore: null,
                  },
          }) + "\n",
        );
      });
      await expect(
        p.client.callAgents({
          id: randomUUID(),
          method: "agents.history",
          params: { collection: "runs" },
        }),
      ).rejects.toThrow("read response");
      await expect(p.client.ready()).resolves.toMatchObject({ providers: ["codex"] });
      expect(p.input.destroyed || p.output.destroyed).toBe(false);
    }
  });
  it("keeps v1 hello unchanged and separately negotiates v2 without caller authority", async () => {
    const p = peer();
    p.setAnswer((request) => {
      if (request.version === 1)
        p.respond(request, { ok: true, providers: ["codex", "claudeCode"] });
      else
        p.input.write(
          JSON.stringify({
            version: 2,
            kind: "response",
            id: request.id,
            ok: true,
            result: request.method === "agents.hello" ? agentHello : agentSnapshot(),
          }) + "\n",
        );
    });
    await expect(
      p.client.callAgents({ id: randomUUID(), method: "agents.snapshot", params: {} }),
    ).resolves.toMatchObject({ ok: true, result: { runtimeID: "personal-runtime" } });
    expect(p.requests.map((r) => r.method)).toEqual(["hello", "agents.hello", "agents.snapshot"]);
    expect(Object.keys(p.requests[0]!).sort()).toEqual(["id", "kind", "method", "version"]);
    expect(p.requests[2]).not.toHaveProperty("authorityID");
    await expect(
      p.client.callAgents({
        id: randomUUID(),
        method: "agents.submit",
        authorityID: "another",
        params: { agentID: "a", text: "x" },
      }),
    ).rejects.toThrow();
    expect(p.requests).toHaveLength(3);
  });
  it("a legacy native refusal hides personal agents without closing v1", async () => {
    const p = peer();
    p.setAnswer((request) =>
      p.respond(
        request,
        request.version === 1
          ? { ok: true, providers: ["codex"] }
          : { ok: false, problem: "unsupported version" },
      ),
    );
    await expect(p.client.agentsReady()).rejects.toThrow("unavailable");
    await expect(p.client.ready()).resolves.toMatchObject({ providers: ["codex"] });
    expect(p.input.destroyed || p.output.destroyed).toBe(false);
  });
  it("accepts large bounded snapshots, deduplicates events, and rejects a changed authority", async () => {
    const p = peer();
    const snapshot = {
      ...agentSnapshot(),
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        conversationID: "c",
        role: "assistant",
        text: "a".repeat(4096),
        createdAt: "2026-10-30T00:00:00Z",
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(MAX_FRAME);
    p.setAnswer((request) => {
      if (request.version === 1) p.respond(request, { ok: true, providers: ["codex"] });
      else
        p.input.write(
          JSON.stringify({
            version: 2,
            kind: "response",
            id: request.id,
            ok: true,
            result: request.method === "agents.hello" ? agentHello : snapshot,
          }) + "\n",
        );
    });
    await p.client.callAgents({ id: randomUUID(), method: "agents.snapshot", params: {} });
    const events: unknown[] = [];
    p.client.onAgentEvent((event) => events.push(event));
    const event = {
      version: 2,
      kind: "event",
      authorityID: "space-a",
      event: "snapshot",
      sequence: 1,
      snapshot,
    };
    p.input.write(JSON.stringify(event) + "\n");
    p.input.write(JSON.stringify(event) + "\n");
    expect(events).toHaveLength(1);
    p.input.write(JSON.stringify({ ...event, sequence: 2, authorityID: "space-b" }) + "\n");
    await expect(
      p.client.callAgents({ id: randomUUID(), method: "agents.snapshot", params: {} }),
    ).rejects.toThrow();
    expect(events).toHaveLength(1);
  });
});

describe("owned native bridge channel lifecycle", () => {
  it("timeout closes both owned streams and notifies disconnect once; later calls send nothing", async () => {
    const p = peer(20);
    const closed = Promise.all([once(p.input, "close"), once(p.output, "close")]);
    let disconnected = 0;
    p.client.onDisconnect(() => {
      disconnected += 1;
    });
    await expect(p.client.ready()).rejects.toThrow("timeout");
    await closed;
    expect(p.input.destroyed && p.output.destroyed).toBe(true);
    await expect(
      p.client.call({ method: "conversation.create", provider: "codex" }),
    ).rejects.toThrow();
    p.client.close();
    expect(disconnected).toBe(1);
    expect(p.requests.map((r) => r.method)).toEqual(["hello"]);
  });

  it("malformed protocol closes the channels, including the native-facing write side", async () => {
    const p = peer();
    const closed = Promise.all([once(p.input, "close"), once(p.output, "close")]);
    p.setAnswer(() => {
      p.input.write("invalid-json\n");
    });
    await expect(p.client.ready()).rejects.toThrow("Invalid native bridge frame");
    await closed;
    expect(p.input.destroyed && p.output.destroyed).toBe(true);
    await expect(p.client.ready()).rejects.toThrow();
    expect(p.requests).toHaveLength(1);
  });

  it.each(["turnID", "handle", "create"])(
    "successful response with invalid %s permanently closes without resending",
    async (malformed) => {
      const p = peer();
      const handle = randomUUID();
      p.setAnswer((r) => {
        if (r.method === "hello") p.respond(r, { ok: true, providers: ["codex"] });
        else if (r.method === "conversation.create")
          p.respond(r, {
            ok: true,
            handle: malformed === "create" ? "bad-handle" : handle,
            provider: "codex",
          });
        else
          p.respond(r, {
            ok: true,
            handle: malformed === "handle" ? randomUUID() : handle,
            turnID: malformed === "turnID" ? "bad-turn" : randomUUID(),
          });
      });
      const closed = Promise.all([once(p.input, "close"), once(p.output, "close")]);
      if (malformed === "create")
        await expect(
          p.client.call({ method: "conversation.create", provider: "codex" }),
        ).rejects.toThrow("fresh bound handle");
      else {
        await p.client.call({ method: "conversation.create", provider: "codex" });
        await expect(
          p.client.call({ method: "message.send", handle, text: "synthetic" }),
        ).rejects.toThrow();
      }
      await closed;
      expect(p.input.destroyed && p.output.destroyed).toBe(true);
      const before = p.requests.length;
      await expect(
        p.client.call({ method: "conversation.create", provider: "codex" }),
      ).rejects.toThrow();
      expect(p.requests).toHaveLength(before);
      expect(p.requests.filter((r) => r.method === "message.send").length).toBeLessThanOrEqual(1);
    },
  );

  it("ok:false remains a policy refusal with live channels and no automatic send retry", async () => {
    const p = peer();
    const handle = randomUUID();
    p.setAnswer((r) => {
      if (r.method === "hello") p.respond(r, { ok: true, providers: ["codex"] });
      else if (r.method === "conversation.create")
        p.respond(r, { ok: true, handle, provider: "codex" });
      else if (r.method === "message.send")
        p.respond(r, { ok: false, problem: "Native Settings require review." });
      else p.respond(r, { ok: true, handle });
    });
    await p.client.call({ method: "conversation.create", provider: "codex" });
    await expect(
      p.client.call({ method: "message.send", handle, text: "synthetic" }),
    ).rejects.toThrow("Native Settings require review");
    expect(p.input.destroyed || p.output.destroyed).toBe(false);
    await expect(p.client.call({ method: "events.subscribe", handle })).resolves.toMatchObject({
      ok: true,
    });
    await expect(p.client.call({ method: "message.send", handle, text: "retry" })).rejects.toThrow(
      "One fresh turn",
    );
    expect(p.requests.filter((r) => r.method === "message.send")).toHaveLength(1);
    expect(p.input.destroyed || p.output.destroyed).toBe(false);
  });

  it("a refused hello leaves transport live and permits only an explicit new hello", async () => {
    const p = peer();
    let hellos = 0;
    p.setAnswer((r) =>
      p.respond(
        r,
        ++hellos === 1
          ? { ok: false, problem: "Native preview not ready." }
          : { ok: true, providers: ["codex"] },
      ),
    );
    await expect(p.client.ready()).rejects.toThrow("Native preview not ready");
    expect(p.input.destroyed || p.output.destroyed).toBe(false);
    expect(p.requests).toHaveLength(1);
    await expect(p.client.ready()).resolves.toMatchObject({ providers: ["codex"] });
    expect(p.requests.map((r) => r.method)).toEqual(["hello", "hello"]);
  });
});
