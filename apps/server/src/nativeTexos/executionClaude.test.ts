// @effect-diagnostics nodeBuiltinImport:off -- Only this suite's disposable Git repositories.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CLAUDE_PROVIDER } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ExecutionWorktreeError } from "./executionWorktree.ts";
import {
  CLAUDE_FIXTURE_CURSORS,
  CLAUDE_FIXTURE_SESSION,
  ClaudeFixturePermissionDenied,
  EDITED_ANSWER,
  INITIAL_ANSWER,
  makeControlledClaudeFixture,
} from "./executionClaude.testkit.ts";

// The adapter uses this SDK helper outside queryRunner injection. Keep it synthetic too;
// never resolve ambient user/project settings, invoke query(), or fork an actual SDK session.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
  query: () => {
    throw new Error("Real Claude query forbidden");
  },
  forkSession: () => {
    throw new Error("Real Claude fork forbidden");
  },
}));
beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings)
    .mockReset()
    .mockImplementation(async (input) => {
      assert.isTrue(input?.cwd?.includes("texos-controlled-claude-") ?? false);
      assert.deepEqual(input?.settingSources, ["project", "local"]);
      return { effective: {}, provenance: {}, sources: [] };
    });
});
const layers = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

describe("synthetic Claude qualification through the actual lower adapter", () => {
  it.effect(
    "one edit, persistent SDK session, stable T3 turn, changing assistant cursors, owned close/drain",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeControlledClaudeFixture({ holdClose: true, holdDrain: true });
        const opened = yield* fixture.open();
        yield* opened.start();
        const terminal = yield* fixture.terminal;
        assert.equal(terminal.status, "completed");
        assert.equal(fixture.snapshot().edits, 1);
        assert.equal(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(fixture.root, "answer.ts"), "utf8"),
          ),
          EDITED_ANSWER,
        );
        assert.lengthOf(fixture.opened, 1);
        assert.lengthOf(fixture.prompts, 1);
        assert.deepEqual(fixture.permissionReads, ["beforeOpen", "beforeTurn"]);
        assert.equal(opened.providerThread.nativeThreadRef?.nativeId, CLAUDE_FIXTURE_SESSION);
        assert.equal(fixture.opened[0]?.options.sessionId, CLAUDE_FIXTURE_SESSION);
        assert.equal(fixture.opened[0]?.threadId, "synthetic-claude-thread");
        assert.equal(fixture.opened[0]?.providerSessionId, "synthetic-claude-provider-session");
        const turns = fixture.events
          .filter((event) => event.type === "provider_turn.updated")
          .map((event) => event.providerTurn);
        assert.isTrue(turns.length > 2);
        assert.deepEqual([...new Set(turns.map((turn) => turn.id))], [terminal.providerTurnId]);
        assert.isTrue(
          turns.every(
            (turn) =>
              turn.providerThreadId === opened.providerThread.id &&
              turn.runAttemptId === fixture.intent.canonicalAttemptID &&
              turn.nodeId === "synthetic-claude-child",
          ),
        );
        // Intermediate assistant snapshots do not each emit a provider-turn update.
        // The actual public reference changes from the attempt placeholder to the final cursor.
        assert.equal(
          turns[0]?.nativeTurnRef?.nativeId,
          `turn:${fixture.intent.canonicalAttemptID}`,
        );
        assert.equal(turns.at(-1)?.nativeTurnRef?.nativeId, CLAUDE_FIXTURE_CURSORS[1]);
        assert.equal(turns.at(-1)?.nativeTurnRef?.strength, "weak");
        for (const cursor of CLAUDE_FIXTURE_CURSORS) {
          assert.notEqual(String(terminal.providerTurnId), cursor);
        }
        assert.equal(
          fixture.snapshot().cessation,
          "uncertain",
          "provider result alone cannot prove cessation",
        );
        assert.isFalse(fixture.snapshot().sdkClosed);
        assert.isFalse(fixture.snapshot().drained);
        const closing = yield* fixture.closeOwned.pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.closeRequested);
        assert.equal(fixture.snapshot().cessation, "uncertain", "close requested is insufficient");
        yield* fixture.releaseClose;
        yield* Deferred.await(fixture.sdkDidClose);
        assert.isTrue(fixture.snapshot().sdkClosed);
        assert.isFalse(fixture.snapshot().drained);
        assert.equal(
          fixture.snapshot().cessation,
          "uncertain",
          "SDK close alone cannot prove drain",
        );
        yield* fixture.releaseDrain;
        yield* Fiber.join(closing);
        assert.equal(fixture.snapshot().cessation, "proven");
        assert.isTrue(fixture.snapshot().sdkClosed);
        assert.isTrue(fixture.snapshot().drained);
        assert.equal(fixture.snapshot().edits, 1);
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect.each(["beforeOpen", "beforeTurn"] as const)(
    "fresh permission denial at %s prevents every SDK offer/edit",
    (denyAt) =>
      Effect.gen(function* () {
        let allowed = denyAt !== "beforeOpen";
        const fixture = yield* makeControlledClaudeFixture({
          currentPermission: () =>
            Effect.suspend(() =>
              allowed ? Effect.void : Effect.fail(new ClaudeFixturePermissionDenied()),
            ),
        });
        const denied = yield* Effect.gen(function* () {
          const opened = yield* fixture.open();
          allowed = false;
          yield* opened.start();
        }).pipe(Effect.flip);
        assert.instanceOf(denied, ClaudeFixturePermissionDenied);
        assert.equal(fixture.snapshot().adapterSessions, denyAt === "beforeOpen" ? 0 : 1);
        assert.deepEqual(
          fixture.permissionReads,
          denyAt === "beforeOpen" ? ["beforeOpen"] : ["beforeOpen", "beforeTurn"],
        );
        assert.lengthOf(fixture.opened, 0);
        assert.lengthOf(fixture.prompts, 0);
        assert.equal(fixture.snapshot().edits, 0);
        assert.equal(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(fixture.root, "answer.ts"), "utf8"),
          ),
          INITIAL_ANSWER,
        );
        assert.equal(fixture.snapshot().cessation, "uncertain");
        yield* fixture.closeOwned;
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("rechecks physical root after open and rejects replacement before any SDK start", () =>
    Effect.gen(function* () {
      const fixture = yield* makeControlledClaudeFixture();
      const opened = yield* fixture.open();
      const retained = `${fixture.root}-retained`;
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await NodeFSP.rename(fixture.root, retained);
          await NodeFSP.mkdir(fixture.root);
          await NodeFSP.writeFile(NodePath.join(fixture.root, "answer.ts"), INITIAL_ANSWER);
        }),
        () =>
          Effect.promise(async () => {
            await NodeFSP.rm(fixture.root, { recursive: true });
            await NodeFSP.rename(retained, fixture.root);
          }),
      );
      assert.instanceOf(yield* opened.start().pipe(Effect.flip), ExecutionWorktreeError);
      assert.lengthOf(fixture.opened, 0);
      assert.lengthOf(fixture.prompts, 0);
      assert.equal(fixture.snapshot().edits, 0);
      for (const root of [fixture.root, retained]) {
        assert.equal(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(root, "answer.ts"), "utf8")),
          INITIAL_ANSWER,
        );
      }
      yield* fixture.closeOwned;
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect(
    "interrupt acknowledgement leaves uncertainty until the owned SDK closes and drains; interrupted is never completed",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeControlledClaudeFixture({ pending: true, holdClose: true });
        const opened = yield* fixture.open();
        yield* opened.start();
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: CLAUDE_PROVIDER,
          nativeTurnId: `turn:${fixture.intent.canonicalAttemptID}`,
        });
        const stopping = yield* opened.runtime
          .interruptTurn({ providerThread: opened.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.closeRequested);
        assert.equal(fixture.snapshot().interrupts, 1);
        assert.equal(fixture.snapshot().cessation, "uncertain");
        assert.isFalse(fixture.snapshot().sdkClosed);
        assert.isFalse(fixture.snapshot().drained);
        assert.isFalse(
          fixture.events.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        );
        yield* fixture.releaseClose;
        yield* Fiber.join(stopping);
        const terminal = yield* fixture.terminal;
        assert.equal(terminal.status, "interrupted");
        yield* fixture.closeOwned;
        assert.equal(fixture.snapshot().cessation, "proven");
        assert.equal(fixture.snapshot().edits, 1);
        assert.lengthOf(fixture.prompts, 1);
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect(
    "lost SDK stream remains an unknown outcome, even after controlled scope cessation is proven",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeControlledClaudeFixture({ pending: true, holdClose: true });
        const opened = yield* fixture.open();
        yield* opened.start();
        yield* fixture.loseSdkStream;
        yield* Deferred.await(fixture.closeRequested);
        assert.equal(fixture.snapshot().cessation, "uncertain");
        assert.isFalse(fixture.snapshot().sdkClosed);
        assert.isFalse(fixture.snapshot().drained);
        yield* fixture.releaseClose;
        const terminal = yield* fixture.terminal;
        assert.equal(terminal.status, "failed");
        yield* fixture.closeOwned;
        assert.equal(fixture.snapshot().cessation, "proven");
        assert.isFalse(
          fixture.events.some(
            (event) => event.type === "turn.terminal" && event.status === "completed",
          ),
        );
        assert.lengthOf(fixture.prompts, 1, "a lost acknowledgement never replays the edit");
        assert.equal(fixture.snapshot().edits, 1);
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});
