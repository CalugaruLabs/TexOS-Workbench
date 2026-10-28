import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { NativeBridge, MAX_FRAME } from "./bridge.ts";

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
    for (const data of [Buffer.alloc(MAX_FRAME + 1, 65), Buffer.from([0xff, 10])]) {
      const p = peer();
      const pending = p.client.ready();
      p.input.write(data);
      await expect(pending).rejects.toThrow();
    }
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
