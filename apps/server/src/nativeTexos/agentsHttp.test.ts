import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AgentsHttp from "./agentsHttp.ts";
import * as Native from "./bridge.ts";
// @effect-diagnostics nodeBuiltinImport:off - In-memory synthetic peer, never inherited descriptors or provider processes.
import * as NodeStream from "node:stream";
import canonicalSnapshot from "../../../../packages/contracts/test-fixtures/personal-agent-canonical-tasks.json" with { type: "json" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const id = "00000000-0000-4000-8000-000000000001";

function nativePeer() {
  const input = new NodeStream.PassThrough(),
    output = new NodeStream.PassThrough();
  const bridge = new Native.NativeBridge(input, output, 2000);
  let snapshot = structuredClone(canonicalSnapshot);
  const held = new Map<string, unknown>();
  const holdIDs = new Set<string>();
  const commands: string[] = [];
  let buffer = "";
  const reply = (requestID: string, result: unknown) =>
    input.write(
      JSON.stringify({
        version: 2,
        kind: "response",
        id: requestID,
        ok: true,
        result,
      }) + "\n",
    );
  output.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
      buffer = buffer.slice(newline + 1);
      commands.push(frame.method);
      if (frame.method === "hello")
        input.write(
          JSON.stringify({
            version: 1,
            kind: "response",
            id: frame.id,
            ok: true,
            providers: ["codex", "claudeCode"],
          }) + "\n",
        );
      else if (frame.method === "agents.hello")
        reply(frame.id, {
          protocolVersion: 2,
          personalOnly: true,
          runtimeID: "r",
          mode: "fake",
          capabilities: ["agents.v2", "events"],
        });
      else if (frame.method === "agents.snapshot") {
        if (holdIDs.has(frame.id)) held.set(frame.id, structuredClone(snapshot));
        else reply(frame.id, structuredClone(snapshot));
      } else reply(frame.id, { snapshot: structuredClone(snapshot) });
    }
  });
  return {
    bridge,
    held,
    holdIDs,
    commands,
    setSnapshot(next: typeof canonicalSnapshot) {
      snapshot = structuredClone(next);
    },
    release(requestID: string) {
      if (!held.has(requestID)) throw new Error("No held synthetic read");
      reply(requestID, held.get(requestID));
      held.delete(requestID);
    },
    emit(next: typeof canonicalSnapshot, sequence: number) {
      input.write(
        JSON.stringify({
          version: 2,
          kind: "event",
          authorityID: "synthetic-space",
          sequence,
          event: "snapshot",
          snapshot: next,
        }) + "\n",
      );
    },
    close() {
      input.destroy();
      output.destroy();
    },
  };
}

function nativeHTTP(peer: ReturnType<typeof nativePeer>) {
  vi.stubEnv("T3CODE_TEXOS_NATIVE_BRIDGE", "1");
  vi.spyOn(Native, "inheritedNativeBridge").mockReturnValue(peer.bridge);
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("synthetic"),
        subject: "synthetic",
        method: "browser-session-cookie",
        scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
      }),
  });
  const server = HttpRouter.toWebHandler(
    AgentsHttp.layer.pipe(Layer.provideMerge(auth), Layer.provideMerge(NodeServices.layer)),
    { disableLogger: true },
  );
  return {
    ...server,
    post(requestID: string) {
      return server.handler(
        new Request("http://localhost/api/texos/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: requestID, method: "agents.snapshot", params: {} }),
        }),
      );
    },
  };
}

async function nextSnapshot(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  if (chunk.done) throw new Error("Synthetic event stream ended");
  const body = new TextDecoder().decode(chunk.value).trim();
  if (!body.startsWith("data: ")) throw new Error("Invalid synthetic SSE frame");
  return JSON.parse(body.slice(6)) as { canonicalTasks?: typeof canonicalSnapshot.canonicalTasks };
}
async function request(input: {
  native: boolean;
  scopes?: ReadonlyArray<AuthEnvironmentScope>;
  method?: string;
  path?: string;
  body?: object;
}) {
  vi.stubEnv("T3CODE_TEXOS_NATIVE_BRIDGE", input.native ? "1" : "0");
  const checked: string[] = [];
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateHttpRequest: (incoming) => {
      checked.push(incoming.url);
      return input.scopes
        ? Effect.succeed({
            sessionId: AuthSessionId.make("synthetic"),
            subject: "synthetic",
            method: "browser-session-cookie",
            scopes: input.scopes,
          })
        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
    },
  });
  const { handler, dispose } = HttpRouter.toWebHandler(
    AgentsHttp.layer.pipe(Layer.provideMerge(auth), Layer.provideMerge(NodeServices.layer)),
    {
      disableLogger: true,
    },
  );
  try {
    const response = await handler(
      new Request(`http://localhost${input.path ?? "/api/texos/agents"}`, {
        method: input.method ?? "POST",
        ...(input.body
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(input.body) }
          : {}),
      }),
    );
    return { status: response.status, checked };
  } finally {
    await dispose();
  }
}
describe("native personal agents HTTP admission", () => {
  it("fences pending reads across source invalidation without relying on a second request", async () => {
    const peer = nativePeer(),
      server = nativeHTTP(peer);
    const updates: Array<{ snapshot: { canonicalTasks?: unknown } }> = [];
    const detach = peer.bridge.onAgentEvent((event) => updates.push(event));
    try {
      await (await server.post("00000000-0000-4000-8000-000000000003")).arrayBuffer();
      peer.holdIDs.add(id);
      const pending = server.post(id);
      await expect.poll(() => peer.held.has(id)).toBe(true);
      const next = structuredClone(canonicalSnapshot);
      next.canonicalTasks.projectionGeneration = "new-source";
      peer.emit(next, 1);
      expect(updates.at(-1)?.snapshot.canonicalTasks).toBeUndefined();
      peer.release(id);
      const stale = (await (await pending).json()) as { result: { canonicalTasks?: unknown } };
      expect(stale.result.canonicalTasks).toBeUndefined();
      peer.emit(canonicalSnapshot, 2);
      expect(updates.at(-1)?.snapshot.canonicalTasks).toBeUndefined();
      peer.setSnapshot(next);
      const fresh = (await (await server.post("00000000-0000-4000-8000-000000000002")).json()) as {
        result: typeof canonicalSnapshot;
      };
      expect(fresh.result.canonicalTasks.projectionGeneration).toBe("new-source");
      expect(
        peer.commands.every((method) =>
          ["hello", "agents.hello", "agents.snapshot"].includes(method),
        ),
      ).toBe(true);
    } finally {
      detach();
      await server.dispose();
      peer.close();
    }
  });
  it("serves the same composed tasks to HTTP and SSE and accepts native-only revision changes", async () => {
    const peer = nativePeer(),
      server = nativeHTTP(peer);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await server.post(id);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: typeof canonicalSnapshot };
      const events = await server.handler(new Request("http://localhost/api/texos/agents/events"));
      expect(events.status).toBe(200);
      reader = events.body!.getReader();
      expect((await nextSnapshot(reader)).canonicalTasks).toEqual(body.result.canonicalTasks);
      const next = structuredClone(canonicalSnapshot);
      next.canonicalTasks.revision = 2;
      next.canonicalTasks.items[0]!.title = "Renamed native task";
      peer.emit(next, 1);
      expect((await nextSnapshot(reader)).canonicalTasks?.items[0]?.title).toBe(
        "Renamed native task",
      );
      const replacement = structuredClone(next);
      replacement.canonicalTasks.projectionGeneration = "replacement-source";
      peer.emit(replacement, 2);
      expect((await nextSnapshot(reader)).canonicalTasks).toBeUndefined();
      peer.emit(next, 3);
      expect((await nextSnapshot(reader)).canonicalTasks).toBeUndefined();
      peer.setSnapshot(replacement);
      const refreshed = (await (
        await server.post("00000000-0000-4000-8000-000000000002")
      ).json()) as { result: typeof canonicalSnapshot };
      expect(refreshed.result.canonicalTasks.projectionGeneration).toBe("replacement-source");
      peer.emit(replacement, 4);
      expect((await nextSnapshot(reader)).canonicalTasks).toEqual(replacement.canonicalTasks);
      expect(
        peer.commands.every((method) =>
          ["hello", "agents.hello", "agents.snapshot"].includes(method),
        ),
      ).toBe(true);
    } finally {
      await reader?.cancel();
      await server.dispose();
      peer.close();
    }
  });
  it("two readers at once both get the tasks when their answers arrive in order", async () => {
    const peer = nativePeer(),
      server = nativeHTTP(peer);
    const second = "00000000-0000-4000-8000-000000000002";
    try {
      await (await server.post("00000000-0000-4000-8000-000000000003")).arrayBuffer();
      peer.holdIDs.add(id);
      peer.holdIDs.add(second);
      const first = server.post(id);
      await expect.poll(() => peer.held.has(id)).toBe(true);
      const other = server.post(second);
      await expect.poll(() => peer.held.has(second)).toBe(true);
      peer.release(id);
      const firstResult = (await (await first).json()) as { result: typeof canonicalSnapshot };
      peer.release(second);
      const otherResult = (await (await other).json()) as { result: typeof canonicalSnapshot };
      expect(firstResult.result.canonicalTasks).toEqual(canonicalSnapshot.canonicalTasks);
      expect(otherResult.result.canonicalTasks).toEqual(canonicalSnapshot.canonicalTasks);
    } finally {
      await server.dispose();
      peer.close();
    }
  });
  it("an overtaken read shows the newer read's tasks, never its own stale ones", async () => {
    const peer = nativePeer(),
      server = nativeHTTP(peer);
    try {
      await (await server.post("00000000-0000-4000-8000-000000000003")).arrayBuffer();
      const stale = structuredClone(canonicalSnapshot);
      stale.canonicalTasks.revision = 99;
      stale.canonicalTasks.items[0]!.title = "Superseded title";
      peer.setSnapshot(stale);
      peer.holdIDs.add(id);
      const older = server.post(id);
      await expect.poll(() => peer.held.has(id)).toBe(true);
      const current = structuredClone(canonicalSnapshot);
      current.canonicalTasks.revision = 2;
      current.canonicalTasks.items[0]!.title = "Current title";
      peer.setSnapshot(current);
      const newer = (await (await server.post("00000000-0000-4000-8000-000000000002")).json()) as {
        result: typeof canonicalSnapshot;
      };
      expect(newer.result.canonicalTasks.items[0]!.title).toBe("Current title");
      peer.release(id);
      const oldResult = (await (await older).json()) as { result: typeof canonicalSnapshot };
      expect(oldResult.result.canonicalTasks.items[0]!.title).toBe("Current title");
      expect(
        peer.commands.every((method) =>
          ["hello", "agents.hello", "agents.snapshot"].includes(method),
        ),
      ).toBe(true);
    } finally {
      await server.dispose();
      peer.close();
    }
  });
  it("standard builds do not probe or authenticate a personal engine", async () => {
    expect(
      await request({ native: false, body: { id, method: "agents.hello", params: {} } }),
    ).toEqual({ status: 404, checked: [] });
  });
  it("requires an authenticated session before commands or event reads", async () => {
    expect(
      (await request({ native: true, body: { id, method: "agents.hello", params: {} } })).status,
    ).toBe(401);
    expect(
      (await request({ native: true, method: "GET", path: "/api/texos/agents/events" })).status,
    ).toBe(401);
  });
  it("read scope cannot mutate personal agents", async () => {
    expect(
      (
        await request({
          native: true,
          scopes: [AuthOrchestrationReadScope],
          body: { id, method: "agents.submit", params: { agentID: "a", text: "work" } },
        })
      ).status,
    ).toBe(403);
  });
  it("rejects authority overrides before reaching native dispatch", async () => {
    expect(
      (
        await request({
          native: true,
          scopes: [AuthOrchestrationOperateScope],
          body: {
            id,
            method: "agents.submit",
            authorityID: "other-space",
            params: { agentID: "a", text: "work" },
          },
        })
      ).status,
    ).toBe(400);
  });
});
