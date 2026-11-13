// @effect-diagnostics nodeBuiltinImport:off -- Controlled fixtures inspect dev/inode and allocate only synthetic command IDs.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ManagedExecutionProvider } from "./executionManaged.ts";
import * as Receipts from "./executionReceipts.ts";
import {
  ControlledExecutionProvider,
  ExecutionControlError,
  makeExecutionControl,
  type NativeStartAuthorizer,
} from "./executionControl.ts";
import {
  executionEnvelope,
  EXECUTION_CAPABILITY,
  MANAGED_EXECUTION_CAPABILITY,
  MISSION_PANEL_CAPABILITY,
  type ExecutionIntent,
} from "./executionProtocol.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import {
  syntheticBinding,
  syntheticIntent,
  syntheticRequest,
  syntheticAuthorization,
  executionReceiptMigrations as Migration,
} from "./execution.testkit.ts";

const syntheticFinish: Receipts.ExecutionFinish = {
  outcome: "completed",
  answer: { text: "Synthetic answer.", truncated: false },
};

const database = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const receiptsLayer = Receipts.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(Migration).pipe(Layer.provideMerge(database))),
);

const physicalIntent = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "texos-execution-control-" });
  const root = yield* Effect.promise(() => NodeFSP.realpath(directory));
  const stat = yield* Effect.promise(() => NodeFSP.stat(root, { bigint: true }));
  const intent = syntheticIntent(root);
  return {
    ...intent,
    worktree: { ...intent.worktree, device: String(stat.dev), inode: String(stat.ino) },
  };
});

const unavailableProvider = (count: { value: number }) =>
  ControlledExecutionProvider.of({
    mode: "controlled-codex",
    create: () =>
      Effect.sync(() => {
        count.value++;
      }).pipe(
        Effect.andThen(Effect.fail(new ExecutionControlError({ code: "fixtureMustNotStart" }))),
      ),
  });

function authorizer(
  intent: ExecutionIntent,
  now: number,
  patch: object = {},
): NativeStartAuthorizer {
  return async (request) => ({
    ...syntheticAuthorization(intent, now),
    runtimeID: request.runtimeID,
    childID: request.childID,
    ...patch,
  });
}

describe("private admitted execution", () => {
  it.effect(
    "managed and controlled XOR rejects both, and receipt recovery is explicit control activation",
    () =>
      Effect.gen(function* () {
        const intent = yield* physicalIntent;
        const store = yield* Receipts.ExecutionReceipts;
        let recoveries = 0;
        const count = { value: 0 };
        const controlled = unavailableProvider(count);
        const managed = ManagedExecutionProvider.of({
          mode: "managed-cli-subscription",
          available: true,
          supports: () => true,
          create: () =>
            Effect.sync(() => {
              count.value++;
            }).pipe(
              Effect.andThen(Effect.fail(new ExecutionControlError({ code: "mustNotCreate" }))),
            ),
          observation: () => undefined,
          answer: () => undefined,
        });
        assert.equal(recoveries, 0);
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ControlledExecutionProvider, controlled),
          Effect.provideService(ManagedExecutionProvider, managed),
          Effect.provideService(Receipts.ExecutionReceipts, {
            ...store,
            recoverInterrupted: Effect.sync(() => {
              recoveries++;
            }).pipe(Effect.andThen(store.recoverInterrupted)),
          }),
        );
        assert.equal(recoveries, 1);
        const native = authorizer(intent, yield* Clock.currentTimeMillis);
        assert.deepEqual(
          yield* control.handle(syntheticRequest("execution.hello", { capabilities: [] }), native),
          { capabilities: [] },
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(control.handle(syntheticRequest("execution.admit", intent), native)),
          ),
        );
        assert.equal(count.value, 0);
      }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );
  it.effect("the Mission panel's sign-in can only read, and only on the managed route", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const issued: Array<{ readonly scopes?: ReadonlyArray<string> }> = [];
      const auth = EnvironmentAuth.of({
        createPairingLink: (input) =>
          Effect.sync(() => {
            issued.push(input ?? {});
            return {
              id: "panel-link",
              credential: "PANELTOKEN23",
              scopes: input?.scopes ?? [],
              subject: input?.subject ?? "",
              createdAt: DateTime.makeUnsafe(0),
              expiresAt: DateTime.makeUnsafe(300_000),
            };
          }),
      } as Partial<EnvironmentAuth["Service"]> as EnvironmentAuth["Service"]);
      const managed = ManagedExecutionProvider.of({
        mode: "managed-cli-subscription",
        available: true,
        supports: () => true,
        create: () => Effect.fail(new ExecutionControlError({ code: "mustNotCreate" })),
        observation: () => undefined,
        answer: () => undefined,
      });
      const native = authorizer(intent, yield* Clock.currentTimeMillis);
      const signIn = syntheticRequest("execution.panelSignIn", {}, 11);

      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ManagedExecutionProvider, managed),
        Effect.provideService(EnvironmentAuth, auth),
      );
      const hello = yield* control.handle(
        syntheticRequest("execution.hello", { capabilities: [] }),
        native,
      );
      assert.deepEqual("capabilities" in hello && hello.capabilities, [
        MANAGED_EXECUTION_CAPABILITY,
        MISSION_PANEL_CAPABILITY,
      ]);
      assert.deepEqual(yield* control.handle(signIn, native), {
        credential: "PANELTOKEN23",
        expiresAtMs: 300_000,
      });
      assert.deepEqual(
        issued.map((input) => input.scopes),
        [["orchestration:read"]],
      );
      // Without TexOS's start check the engine runs no Mission, so it has no panel either.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(control.handle(signIn))));

      const controlled = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, unavailableProvider({ value: 0 })),
        Effect.provideService(EnvironmentAuth, auth),
      );
      const plain = yield* controlled.handle(
        syntheticRequest("execution.hello", { capabilities: [] }),
        native,
      );
      assert.deepEqual("capabilities" in plain && plain.capabilities, [EXECUTION_CAPABILITY]);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(controlled.handle(signIn, native))));
      assert.equal(issued.length, 1);
      assert.throws(() => syntheticRequest("execution.panelSignIn", { scopes: ["*"] }));
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect(
    "missing native authorization or provider handler advertises nothing and starts nothing",
    () =>
      Effect.gen(function* () {
        const intent = yield* physicalIntent;
        const control = yield* makeExecutionControl(syntheticBinding);
        assert.deepEqual(
          yield* control.handle(syntheticRequest("execution.hello", { capabilities: [] })),
          { capabilities: [] },
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(control.handle(syntheticRequest("execution.admit", intent))),
          ),
        );
        const receipts = yield* Receipts.ExecutionReceipts;
        assert.isUndefined(
          yield* receipts.get(
            intent.commandID,
            executionEnvelope(intent).digest,
            intent.scope.authorityID,
          ),
        );
        const count = { value: 0 };
        const installed = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ControlledExecutionProvider, unavailableProvider(count)),
        );
        assert.deepEqual(
          yield* installed.handle(syntheticRequest("execution.hello", { capabilities: [] })),
          { capabilities: [] },
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(installed.handle(syntheticRequest("execution.admit", intent))),
          ),
        );
        assert.equal(count.value, 0);
      }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect(
    "unknown billing, revoke, rebinding and untrusted JSON are denied before provider construction",
    () =>
      Effect.gen(function* () {
        for (const patch of [
          { outcome: "unknown" },
          { revoked: true },
          { accountBindingGeneration: "2" },
          {
            checks: { ...syntheticAuthorization(syntheticIntent(), 0).checks, billing: "unknown" },
          },
          { envelopeDigest: "f".repeat(64) },
          { unexpectedCredential: "rejected" },
        ]) {
          const intent = yield* physicalIntent;
          const count = { value: 0 };
          const control = yield* makeExecutionControl(syntheticBinding).pipe(
            Effect.provideService(ControlledExecutionProvider, unavailableProvider(count)),
          );
          const now = yield* Clock.currentTimeMillis;
          const request = {
            ...intent,
            commandID: NodeCrypto.randomUUID(),
            canonicalRunID: NodeCrypto.randomUUID(),
            canonicalAttemptID: NodeCrypto.randomUUID(),
          };
          const native = authorizer(request, now, patch);
          const hello = yield* control.handle(
            syntheticRequest("execution.hello", { capabilities: [] }),
            native,
          );
          assert.deepEqual("capabilities" in hello ? hello.capabilities : [], [
            EXECUTION_CAPABILITY,
          ]);
          yield* control.handle(syntheticRequest("execution.admit", request), native);
          yield* control.awaitAttempt(request.commandID);
          assert.equal(count.value, 0);
          const receipts = yield* Receipts.ExecutionReceipts;
          assert.equal(
            (yield* receipts.get(
              request.commandID,
              executionEnvelope(request).digest,
              request.scope.authorityID,
            ))?.phase,
            "denied",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("physical identity mismatch and symlink roots cannot reach the provider factory", () =>
    Effect.gen(function* () {
      const original = yield* physicalIntent;
      const count = { value: 0 };
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, unavailableProvider(count)),
      );
      const fs = yield* FileSystem.FileSystem;
      const alias = NodePath.join(original.worktree.root, "alias");
      yield* fs.symlink(original.worktree.root, alias);
      const intent = { ...original, worktree: { ...original.worktree, root: alias } };
      const now = yield* Clock.currentTimeMillis;
      yield* control.handle(syntheticRequest("execution.admit", intent), authorizer(intent, now));
      yield* control.awaitAttempt(intent.commandID);
      const wrongInode = {
        ...original,
        commandID: NodeCrypto.randomUUID(),
        canonicalRunID: NodeCrypto.randomUUID(),
        canonicalAttemptID: NodeCrypto.randomUUID(),
        worktree: { ...original.worktree, inode: String(BigInt(original.worktree.inode) + 1n) },
      };
      yield* control.handle(
        syntheticRequest("execution.admit", wrongInode),
        authorizer(wrongInode, now),
      );
      yield* control.awaitAttempt(wrongInode.commandID);
      assert.equal(count.value, 0);
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("Claude remains explicitly unsupported and status/stop do not invent a receipt", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const count = { value: 0 };
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, unavailableProvider(count)),
      );
      const now = yield* Clock.currentTimeMillis;
      const claude = {
        ...intent,
        configuration: {
          ...intent.configuration,
          provider: "claudeCode" as const,
          modelID: "synthetic-claude-model",
        },
      };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            control.handle(syntheticRequest("execution.admit", claude), authorizer(claude, now)),
          ),
        ),
      );
      for (const method of ["execution.status", "execution.stop"] as const) {
        const result = yield* control.handle(
          syntheticRequest(method, {
            commandID: intent.commandID,
            envelopeDigest: executionEnvelope(intent).digest,
          }),
        );
        assert.deepEqual(result, {
          commandID: intent.commandID,
          phase: "unknown",
          reconciliationRequired: true,
        });
      }
      assert.equal(count.value, 0);
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("disconnect retains uncertain custody and requests cessation without a replay", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let starts = 0;
      const provider = ControlledExecutionProvider.of({
        mode: "controlled-codex",
        create: () =>
          Effect.succeed({
            run: Effect.sync(() => {
              starts++;
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ mappings: {}, drained: true, finish: syntheticFinish }),
            ),
            stop: Deferred.succeed(finish, undefined).pipe(Effect.asVoid),
          }),
      });
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, provider),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* control.handle(syntheticRequest("execution.admit", intent), authorizer(intent, now));
      yield* Deferred.await(entered);
      yield* control.disconnect;
      const receipts = yield* Receipts.ExecutionReceipts;
      const saved = yield* receipts.get(
        intent.commandID,
        executionEnvelope(intent).digest,
        intent.scope.authorityID,
      );
      assert.equal(saved?.phase, "uncertain");
      const restarted = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, provider),
      );
      const duplicate = yield* restarted.handle(
        syntheticRequest("execution.admit", intent),
        authorizer(intent, now),
      );
      assert.propertyVal(duplicate, "phase", "uncertain");
      assert.equal(starts, 1);
      const replacement = {
        ...intent,
        commandID: NodeCrypto.randomUUID(),
        canonicalRunID: NodeCrypto.randomUUID(),
        canonicalAttemptID: NodeCrypto.randomUUID(),
      };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            restarted.handle(
              syntheticRequest("execution.admit", replacement),
              authorizer(replacement, now),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("a factory failure stays uncertain and cannot free the execution slot", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const count = { value: 0 };
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, unavailableProvider(count)),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* control.handle(syntheticRequest("execution.admit", intent), authorizer(intent, now));
      yield* control.awaitAttempt(intent.commandID);
      const store = yield* Receipts.ExecutionReceipts;
      assert.equal(count.value, 1);
      assert.equal(
        (yield* store.get(
          intent.commandID,
          executionEnvelope(intent).digest,
          intent.scope.authorityID,
        ))?.phase,
        "uncertain",
      );
      assert.isTrue(yield* store.hasUnresolved);
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("stop waits for controlled cessation and preserves the original receipt", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const entered = yield* Deferred.make<void>();
      const ceased = yield* Deferred.make<void>();
      let starts = 0;
      const provider = ControlledExecutionProvider.of({
        mode: "controlled-codex",
        create: () =>
          Effect.succeed({
            run: Effect.sync(() => {
              starts++;
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(ceased)),
              Effect.as({ mappings: {}, drained: true, finish: syntheticFinish }),
            ),
            stop: Deferred.succeed(ceased, undefined).pipe(Effect.asVoid),
          }),
      });
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ControlledExecutionProvider, provider),
      );
      const now = yield* Clock.currentTimeMillis;
      const native = authorizer(intent, now);
      yield* control.handle(syntheticRequest("execution.admit", intent), native);
      yield* Deferred.await(entered);
      const stopped = yield* control.handle(
        syntheticRequest(
          "execution.stop",
          { commandID: intent.commandID, envelopeDigest: executionEnvelope(intent).digest },
          12,
        ),
      );
      assert.propertyVal(stopped, "phase", "stopping");
      yield* control.awaitAttempt(intent.commandID);
      const duplicate = yield* control.handle(
        syntheticRequest("execution.admit", intent, 13),
        native,
      );
      assert.propertyVal(duplicate, "phase", "stopped");
      assert.propertyVal(duplicate, "drained", true);
      assert.equal(starts, 1);
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );
  it.effect(
    "reconcile ends an earlier launch's uncertain run, and status pages the live answer until then",
    () =>
      Effect.gen(function* () {
        const intent = yield* physicalIntent;
        const store = yield* Receipts.ExecutionReceipts;
        const digest = executionEnvelope(intent).digest;
        const earlier = yield* store.admit(intent, "generation-0");
        yield* store.transition(earlier.receipt, "uncertain");
        const managed = ManagedExecutionProvider.of({
          mode: "managed-cli-subscription",
          available: true,
          supports: () => true,
          create: () => Effect.fail(new ExecutionControlError({ code: "mustNotCreate" })),
          observation: () => undefined,
          answer: (commandID) => (commandID === intent.commandID ? "Partial 😀 answer" : undefined),
        });
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, managed),
        );
        const command = { commandID: intent.commandID, envelopeDigest: digest };
        const status = yield* control.handle(
          syntheticRequest("execution.status", { ...command, textOffset: 8 }),
        );
        assert.propertyVal(status, "phase", "uncertain");
        assert.propertyVal(status, "outcome", null);
        assert.deepPropertyVal(status, "answer", {
          offset: 8,
          text: "😀 answer",
          nextOffset: 16,
          total: 16,
          final: false,
          truncated: false,
        });
        const native = authorizer(intent, yield* Clock.currentTimeMillis);
        const second = {
          ...intent,
          commandID: "00000000-0000-4000-8000-000000000002",
          canonicalRunID: "canonical-run-2",
          canonicalAttemptID: "canonical-attempt-2",
        };
        assert.equal(
          (yield* Effect.flip(control.handle(syntheticRequest("execution.admit", second), native)))
            .code,
          "executionCapacityOccupied",
        );
        const reconciled = yield* control.handle(syntheticRequest("execution.reconcile", command));
        assert.propertyVal(reconciled, "phase", "abandoned");
        assert.propertyVal(reconciled, "reconciliationRequired", false);
        assert.propertyVal(
          yield* control.handle(syntheticRequest("execution.reconcile", command)),
          "phase",
          "abandoned",
        );
        assert.isFalse(yield* store.hasUnresolved);
        assert.propertyVal(
          yield* control.handle(
            syntheticRequest("execution.reconcile", {
              commandID: second.commandID,
              envelopeDigest: executionEnvelope(second).digest,
            }),
          ),
          "phase",
          "unknown",
        );
      }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );

  it.effect("a run admitted by this T3 launch cannot be reconciled", () =>
    Effect.gen(function* () {
      const intent = yield* physicalIntent;
      const store = yield* Receipts.ExecutionReceipts;
      const admitted = yield* store.admit(intent, syntheticBinding.hostGeneration);
      yield* store.transition(admitted.receipt, "uncertain");
      const control = yield* makeExecutionControl(syntheticBinding);
      assert.equal(
        (yield* Effect.flip(
          control.handle(
            syntheticRequest("execution.reconcile", {
              commandID: intent.commandID,
              envelopeDigest: executionEnvelope(intent).digest,
            }),
          ),
        )).code,
        "executionNotAbandonable",
      );
    }).pipe(Effect.scoped, Effect.provide(receiptsLayer)),
  );
});
