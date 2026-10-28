import { describe, expect, it, vi } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
  OrchestrationV2TurnItem,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import type * as P from "@t3tools/provider-core/server/ProviderAdapter";
import { NativeBridge, type NativeProvider } from "./bridge.ts";
import { makeNativeAdapter, validateNativePolicy } from "./adapter.ts";

const decodeNativeTurnItem = Schema.decodeEffect(OrchestrationV2TurnItem);

const { once } = await vi.importActual<typeof import("node:events")>("node:events");
const { PassThrough } = await vi.importActual<typeof import("node:stream")>("node:stream");
let fixtureUUID = 0;
const randomUUID = () => `00000000-0000-4000-8000-${String(++fixtureUUID).padStart(12, "0")}`;

function fixture(provider: NativeProvider, holdSendAck = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  const requests: Array<Record<string, unknown>> = [];
  const handle = randomUUID();
  const turnID = randomUUID();
  let heldSend: Record<string, unknown> | undefined;
  let notifySend!: () => void;
  const sendReached = new Promise<void>((resolve) => {
    notifySend = resolve;
  });
  const acknowledgeSend = (valid = true) => {
    if (!heldSend) throw new Error("No held send request");
    input.write(
      JSON.stringify({
        version: 1,
        kind: "response",
        id: heldSend.id,
        ok: true,
        handle,
        turnID: valid ? turnID : "invalid-turn",
      }) + "\n",
    );
  };
  output.on("data", (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    if (request.method === "message.send") {
      notifySend();
      if (holdSendAck) {
        heldSend = request;
        return;
      }
    }
    const body =
      request.method === "hello"
        ? { providers: [provider] }
        : request.method === "conversation.create"
          ? { handle, provider }
          : request.method === "message.send"
            ? { handle, turnID }
            : { handle };
    input.write(
      JSON.stringify({ version: 1, kind: "response", id: request.id, ok: true, ...body }) + "\n",
    );
  });
  const bridge = new NativeBridge(input, output, 1000);
  const instanceId = ProviderInstanceId.make(provider === "codex" ? "codex" : "claudeAgent");
  const adapter = makeNativeAdapter(provider, bridge);
  const threadId = ThreadId.make("preview-thread");
  const now = DateTime.makeUnsafe("2026-10-28T00:00:00Z");
  const modelSelection = { instanceId, model: "native-settings" };
  const runtimePolicy = {
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    cwd: null,
  };
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("preview-project"),
    title: "Synthetic preview",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const sessionInput = {
    threadId,
    providerSessionId: ProviderSessionId.make("preview-session"),
    modelSelection,
    runtimePolicy,
  };
  const turn = (
    providerThread: P.ProviderAdapterV2TurnInput["providerThread"],
  ): P.ProviderAdapterV2TurnInput => ({
    appThread,
    threadId,
    runId: RunId.make("run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt"),
    rootNodeId: NodeId.make("root"),
    providerThread,
    message: {
      messageId: MessageId.make("user"),
      text: "Reply exactly synthetic",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  });
  const event = (sequence: number, phase: string, extra: object = {}) =>
    input.write(
      JSON.stringify({
        version: 1,
        kind: "event",
        handle,
        turnID,
        sequence,
        phase,
        provider,
        ...extra,
      }) + "\n",
    );
  return {
    bridge,
    adapter,
    requests,
    sessionInput,
    turn,
    event,
    input,
    output,
    sendReached,
    acknowledgeSend,
    turnID,
  };
}

describe("native TexOS presentation adapter", () => {
  it.effect.each(["codex", "claudeCode"] as const)(
    "%s: creates a fresh handle, sends only user text, streams native lifecycle and does not execute another engine",
    (provider) =>
      Effect.gen(function* () {
        const f = fixture(provider);
        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* f.adapter.openSession(f.sessionInput);
              const thread = yield* runtime.ensureThread(f.sessionInput);
              const request = f.turn(thread);
              yield* runtime.startTurn(request);
              const sent = f.requests.find((r) => r.method === "message.send")!;
              expect(Object.keys(sent).sort()).toEqual([
                "handle",
                "id",
                "kind",
                "method",
                "text",
                "version",
              ]);
              expect(sent.text).toBe(request.message.text);
              expect(f.requests.find((r) => r.method === "conversation.create")?.provider).toBe(
                provider,
              );
              f.event(1, "text", { text: "synthetic" });
              f.event(2, "text", { text: " reply" });
              f.event(3, "completed");
              const events = yield* runtime.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              );
              expect(events.map((e) => e.type)).toEqual([
                "provider_turn.updated",
                "provider_turn.updated",
                "message.updated",
                "turn_item.updated",
                "message.updated",
                "turn_item.updated",
                "message.updated",
                "turn_item.updated",
                "provider_turn.updated",
                "turn.terminal",
              ]);
              expect(events.at(-1)).toMatchObject({ status: "completed", failure: null });
              const items = events.flatMap((event) =>
                event.type === "turn_item.updated" ? [event.turnItem] : [],
              );
              expect(items).toHaveLength(3);
              expect(new Set(items.map((item) => item.id)).size).toBe(1);
              expect(
                items.map((item) => (item.type === "assistant_message" ? item.text : null)),
              ).toEqual(["synthetic", "synthetic reply", "synthetic reply"]);
              expect(items.map((item) => item.status)).toEqual(["running", "running", "completed"]);
              for (const item of items) {
                yield* decodeNativeTurnItem(item);
                expect(item).toMatchObject({
                  type: "assistant_message",
                  threadId: request.threadId,
                  runId: request.runId,
                  nodeId: request.rootNodeId,
                  providerThreadId: thread.id,
                  providerTurnId: `native-texos:${request.attemptId}`,
                  messageId: `native-texos:${request.attemptId}`,
                });
              }
              expect(items[0]).toMatchObject({ streaming: true, completedAt: null });
              expect(items.at(-1)).toMatchObject({ streaming: false });
              expect(items.at(-1)?.completedAt).not.toBeNull();
              const snapshot = yield* runtime.readThreadSnapshot({ providerThread: thread });
              expect(snapshot.messages.map((m) => m.text)).toEqual(["synthetic reply"]);
              expect(snapshot.providerThread.nativeThreadRef).toBeNull();
              expect((yield* Effect.exit(runtime.startTurn(request)))._tag).toBe("Failure");
              expect(
                (yield* Effect.exit(
                  runtime.startTurn({
                    ...request,
                    attemptId: RunAttemptId.make("second-attempt"),
                    runId: RunId.make("second-run"),
                    runOrdinal: 2,
                    providerTurnOrdinal: 2,
                  }),
                ))._tag,
              ).toBe("Failure");
              expect(f.requests.filter((r) => r.method === "message.send")).toHaveLength(1);
            }),
          );
        } finally {
          f.bridge.close();
        }
      }),
  );
  it.effect(
    "Stop ACK does not manufacture terminal cancellation; native settlement ends the projection",
    () =>
      Effect.gen(function* () {
        const f = fixture("codex");
        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* f.adapter.openSession(f.sessionInput);
              const thread = yield* runtime.ensureThread(f.sessionInput);
              yield* runtime.startTurn(f.turn(thread));
              const started = yield* runtime.events.pipe(Stream.take(2), Stream.runCollect);
              const first = started[1]!;
              if (first.type !== "provider_turn.updated")
                throw new Error("Missing native accepted turn");
              yield* runtime.interruptTurn({
                providerThread: thread,
                providerTurnId: first.providerTurn.id,
                requestRuntimeRestart: true,
              });
              expect(f.requests.at(-1)?.method).toBe("turn.stop");
              expect(
                (yield* runtime.readThreadSnapshot({ providerThread: thread })).providerTurns,
              ).toHaveLength(0);
              f.event(1, "stopping");
              f.event(2, "interrupted", {
                remoteCancellationConfirmed: false,
                localCleanupConfirmed: true,
              });
              const events = yield* runtime.events.pipe(
                Stream.takeUntil((event) => event.type === "turn.terminal"),
                Stream.runCollect,
              );
              expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
              expect(events.find((event) => event.type === "turn_item.updated")).toMatchObject({
                turnItem: { type: "assistant_message", status: "interrupted", streaming: false },
              });
            }),
          );
        } finally {
          f.bridge.close();
        }
      }),
  );
  it.effect(
    "denies assembled context, attachments, policy overrides, resume, fork and runtime requests before IPC send",
    () =>
      Effect.gen(function* () {
        const f = fixture("codex");
        try {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* f.adapter.openSession(f.sessionInput);
              const thread = yield* runtime.ensureThread(f.sessionInput);
              const request = f.turn(thread);
              for (const candidate of [
                { ...request, appContext: [{ key: "history", text: "do not send" }] },
                { ...request, runtimePolicy: { ...request.runtimePolicy, cwd: "/owner" } },
                { ...request, modelSelection: { ...request.modelSelection, model: "arbitrary" } },
              ])
                expect((yield* Effect.exit(runtime.startTurn(candidate)))._tag).toBe("Failure");
              expect(f.requests.some((r) => r.method === "message.send")).toBe(false);
              expect(
                (yield* Effect.exit(runtime.resumeThread({ providerThread: thread })))._tag,
              ).toBe("Failure");
              expect(
                (yield* Effect.exit(
                  runtime.forkThread({
                    sourceProviderThread: thread,
                    targetThreadId: ThreadId.make("other"),
                  }),
                ))._tag,
              ).toBe("Failure");
              expect(
                (yield* Effect.exit(
                  runtime.respondToRuntimeRequest({
                    requestId: "request" as import("@t3tools/contracts").RuntimeRequestId,
                  }),
                ))._tag,
              ).toBe("Failure");
              expect(runtime.injectHistory).toBeUndefined();
              expect(runtime.compactThread).toBeUndefined();
              expect(runtime.mcpApps).toBeUndefined();
            }),
          );
        } finally {
          f.bridge.close();
        }
      }),
  );
  it.effect("EOF produces uncertain failure, never successful completion or fallback", () =>
    Effect.gen(function* () {
      const f = fixture("codex");
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* f.adapter.openSession(f.sessionInput);
            const thread = yield* runtime.ensureThread(f.sessionInput);
            yield* runtime.startTurn(f.turn(thread));
            const ended = once(f.input, "end");
            f.input.end();
            yield* Effect.promise(() => ended);
            const events = yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            );
            expect(events.find((event) => event.type === "turn_item.updated")).toMatchObject({
              turnItem: { type: "assistant_message", status: "failed", streaming: false },
            });
            expect(events.at(-1)).toMatchObject({
              type: "turn.terminal",
              status: "failed",
              threadDisposition: "broken",
              failure: { retryable: false, class: "transport_error" },
            });
          }),
        );
      } finally {
        f.bridge.close();
      }
    }),
  );
  it("requires null cwd and native-settings policy even for direct adapter callers", () => {
    const f = fixture("codex");
    try {
      expect(() => validateNativePolicy(f.sessionInput)).not.toThrow();
      for (const patch of [
        { cwd: "/owner" },
        { approvalPolicy: "never" },
        { sandboxPolicy: { type: "dangerFullAccess" } },
        { runtimeMode: "full-access" as const },
      ])
        expect(() =>
          validateNativePolicy({
            ...f.sessionInput,
            runtimePolicy: { ...f.sessionInput.runtimePolicy, ...patch },
          }),
        ).toThrow();
    } finally {
      f.bridge.close();
    }
  });
});

it.effect.each([true, false])("retains pre-ACK Stop exactly once, accepted ACK=%s", (validAck) =>
  Effect.gen(function* () {
    const f = fixture("codex", true);
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* f.adapter.openSession(f.sessionInput);
          const thread = yield* runtime.ensureThread(f.sessionInput);
          const starting = yield* runtime.startTurn(f.turn(thread)).pipe(Effect.forkScoped);
          yield* Effect.promise(() => f.sendReached);
          const pending = yield* runtime.events.pipe(Stream.take(1), Stream.runCollect);
          const turn = pending[0]!;
          if (turn.type !== "provider_turn.updated") throw new Error("Missing pending Stop target");
          expect(turn.providerTurn.status).toBe("pending");
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: turn.providerTurn.id,
          });
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: turn.providerTurn.id,
          });
          expect(f.requests.filter((r) => r.method === "turn.stop")).toHaveLength(0);
          f.acknowledgeSend(validAck);
          const outcome = yield* Fiber.join(starting).pipe(Effect.exit);
          expect(outcome._tag).toBe(validAck ? "Success" : "Failure");
          const stops = f.requests.filter((r) => r.method === "turn.stop");
          expect(stops).toHaveLength(validAck ? 1 : 0);
          expect(f.requests.filter((r) => r.method === "message.send")).toHaveLength(1);
          if (validAck) {
            expect(stops[0]).toMatchObject({ turnID: f.turnID });
            expect(
              (yield* runtime.readThreadSnapshot({ providerThread: thread })).providerTurns,
            ).toHaveLength(0);
            f.event(1, "interrupted", {
              remoteCancellationConfirmed: false,
              localCleanupConfirmed: true,
            });
            const terminal = yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            );
            expect(terminal.at(-1)).toMatchObject({
              type: "turn.terminal",
              status: "interrupted",
            });
          } else expect(f.input.destroyed && f.output.destroyed).toBe(true);
        }),
      );
    } finally {
      f.bridge.close();
    }
  }),
);

it.effect.each(["failed", "interrupted", "uncertain"] as const)(
  "settles the same visible partial assistant item on native %s",
  (phase) =>
    Effect.acquireUseRelease(
      Effect.sync(() => fixture("codex")),
      (f) =>
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* f.adapter.openSession(f.sessionInput);
            const thread = yield* runtime.ensureThread(f.sessionInput);
            yield* runtime.startTurn(f.turn(thread));
            f.event(1, "text", { text: "partial native reply" });
            f.event(2, phase);
            const events = yield* runtime.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            );
            const items = events.flatMap((event) =>
              event.type === "turn_item.updated" ? [event.turnItem] : [],
            );
            expect(items).toHaveLength(2);
            expect(items[1]?.id).toBe(items[0]?.id);
            expect(items[0]).toMatchObject({
              type: "assistant_message",
              text: "partial native reply",
              streaming: true,
              status: "running",
              completedAt: null,
            });
            expect(items[1]).toMatchObject({
              type: "assistant_message",
              text: "partial native reply",
              streaming: false,
              status: phase === "interrupted" ? "interrupted" : "failed",
            });
            expect(items[1]?.completedAt).not.toBeNull();
            expect(events.at(-1)).toMatchObject({
              type: "turn.terminal",
              status: phase === "interrupted" ? "interrupted" : "failed",
            });
            expect(f.requests.filter((request) => request.method === "message.send")).toHaveLength(
              1,
            );
          }),
        ),
      (f) => Effect.sync(() => f.bridge.close()),
    ),
);
