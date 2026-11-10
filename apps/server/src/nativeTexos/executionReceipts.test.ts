// @effect-diagnostics nodeBuiltinImport:off -- Test-only paths address a disposable receipt database.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import Migration from "../persistence/Migrations/070_NativeExecutionReceipts.ts";
import * as Receipts from "./executionReceipts.ts";
import { executionEnvelope } from "./executionProtocol.ts";
import { syntheticIntent } from "./execution.testkit.ts";
import { texosMissionThreadId } from "@t3tools/shared/texosMission";

const database = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const receiptsLayer = Receipts.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(Migration).pipe(Layer.provideMerge(database))),
);

describe("native execution durable receipts", () => {
  it.effect(
    "a present undefined field cannot erase an ID, enable rebinding, or survive a database reopen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "texos-mapping-erasure-" });
        const filename = NodePath.join(root, "synthetic-t3.sqlite");
        const intent = syntheticIntent();
        const original = yield* Effect.gen(function* () {
          const store = yield* Receipts.ExecutionReceipts;
          const admitted = yield* store.admit(intent);
          const starting = yield* store.transition(admitted.receipt, "starting");
          const running = yield* store.transition(starting, "running", {
            nativeThreadID: "original-native-thread",
          });
          const erased = yield* Effect.exit(
            store.transition(running, "running", {
              nativeThreadID: undefined,
            } as unknown as Receipts.ExecutionMappings),
          );
          assert.isTrue(Exit.isFailure(erased));
          const retained = yield* store.get(
            intent.commandID,
            running.envelopeDigest,
            intent.scope.authorityID,
          );
          assert.equal(retained?.mappings.nativeThreadID, "original-native-thread");
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                store.transition(retained!, "running", {
                  nativeThreadID: "replacement-native-thread",
                }),
              ),
            ),
          );
          return retained!;
        }).pipe(
          Effect.provide(
            Receipts.layer.pipe(
              Layer.provide(
                Layer.effectDiscard(Migration).pipe(
                  Layer.provideMerge(NodeSqliteClient.layer({ filename })),
                ),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const store = yield* Receipts.ExecutionReceipts;
          const saved = yield* store.get(
            intent.commandID,
            original.envelopeDigest,
            intent.scope.authorityID,
          );
          assert.deepEqual(saved?.mappings, { nativeThreadID: "original-native-thread" });
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                store.transition(saved!, "running", { nativeThreadID: "replacement-after-reopen" }),
              ),
            ),
          );
          assert.equal(
            (yield* store.get(intent.commandID, original.envelopeDigest, intent.scope.authorityID))
              ?.mappings.nativeThreadID,
            "original-native-thread",
          );
        }).pipe(
          Effect.provide(Receipts.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename })))),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reopening the same disposable T3 database retains the original command and runtime IDs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "texos-execution-receipt-" });
        const filename = NodePath.join(root, "synthetic-t3.sqlite");
        const intent = syntheticIntent();
        const first = yield* Effect.gen(function* () {
          const store = yield* Receipts.ExecutionReceipts;
          const admitted = yield* store.admit(intent);
          yield* store.transition(admitted.receipt, "starting");
          return admitted.receipt;
        }).pipe(
          Effect.provide(
            Receipts.layer.pipe(
              Layer.provide(
                Layer.effectDiscard(Migration).pipe(
                  Layer.provideMerge(NodeSqliteClient.layer({ filename })),
                ),
              ),
            ),
          ),
        );
        const reopened = yield* Effect.gen(function* () {
          const store = yield* Receipts.ExecutionReceipts;
          yield* store.recoverInterrupted;
          return yield* store.admit(intent);
        }).pipe(
          Effect.provide(Receipts.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename })))),
        );
        assert.isFalse(reopened.created);
        assert.equal(reopened.receipt.phase, "uncertain");
        assert.equal(reopened.receipt.runtimeID, first.runtimeID);
        assert.equal(reopened.receipt.childID, first.childID);
        assert.equal(reopened.receipt.envelopeDigest, first.envelopeDigest);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "matching duplicates recover original IDs, while changed content and run reuse fail",
    () =>
      Effect.gen(function* () {
        const store = yield* Receipts.ExecutionReceipts;
        const intent = syntheticIntent();
        const first = yield* store.admit(intent);
        const duplicate = yield* store.admit(intent);
        assert.isTrue(first.created);
        assert.isFalse(duplicate.created);
        assert.deepEqual(first.receipt, duplicate.receipt);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(store.admit({ ...intent, input: "different" }))),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              store.admit({ ...intent, commandID: "00000000-0000-4000-8000-000000000002" }),
            ),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              store.get(intent.commandID, first.receipt.envelopeDigest, "wrong-authority"),
            ),
          ),
        );
      }).pipe(Effect.provide(receiptsLayer)),
  );

  it.effect(
    "interrupted admission retains uncertainty and can never be relaunched by duplicate or stop",
    () =>
      Effect.gen(function* () {
        const store = yield* Receipts.ExecutionReceipts;
        const intent = syntheticIntent();
        const first = yield* store.admit(intent);
        yield* store.transition(first.receipt, "starting");
        yield* store.recoverInterrupted;
        const repeated = yield* store.admit(intent);
        assert.isFalse(repeated.created);
        assert.equal(repeated.receipt.phase, "uncertain");
        assert.equal(repeated.receipt.childID, first.receipt.childID);
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(store.transition(repeated.receipt, "running"))),
        );
        assert.isUndefined(
          yield* store.get("unknown", executionEnvelope(intent).digest, intent.scope.authorityID),
        );
        const sql = yield* SqlClient.SqlClient;
        const count = yield* sql<{
          readonly total: number;
        }>`SELECT COUNT(*) AS total FROM native_execution_receipts`;
        assert.equal(count[0]?.total, 1);
      }).pipe(Effect.provide(receiptsLayer)),
  );

  it.effect(
    "one-time session associations cannot be overwritten, and corrupt envelopes fail closed",
    () =>
      Effect.gen(function* () {
        const store = yield* Receipts.ExecutionReceipts;
        const first = yield* store.admit(syntheticIntent());
        const starting = yield* store.transition(first.receipt, "starting");
        const running = yield* store.transition(starting, "running", {
          nativeThreadID: "fixture-thread",
        });
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              store.transition(running, "running", { nativeThreadID: "other-thread" }),
            ),
          ),
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE native_execution_receipts SET envelope_json = '{}' WHERE command_id = ${first.receipt.intent.commandID}`;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              store.get(
                first.receipt.intent.commandID,
                first.receipt.envelopeDigest,
                first.receipt.intent.scope.authorityID,
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(receiptsLayer)),
  );

  it.effect("each TexOS attempt keys exactly one derived T3 thread", () =>
    Effect.gen(function* () {
      const store = yield* Receipts.ExecutionReceipts;
      const sql = yield* SqlClient.SqlClient;
      const intent = syntheticIntent();
      const first = yield* store.admit(intent);
      assert.equal(
        first.receipt.t3ThreadID,
        yield* Effect.promise(() => texosMissionThreadId("canonical-task", "canonical-attempt")),
      );
      yield* sql`UPDATE native_execution_receipts SET phase = 'stopped', drained = 1`;
      const reused = yield* Effect.flip(
        store.admit({
          ...intent,
          commandID: "00000000-0000-4000-8000-000000000002",
          canonicalRunID: "canonical-run-2",
        }),
      );
      assert.equal(reused.code, "executionAttemptAlreadyAdmitted");
      const retry = yield* store.admit({
        ...intent,
        commandID: "00000000-0000-4000-8000-000000000003",
        canonicalRunID: "canonical-run-3",
        canonicalAttemptID: "canonical-attempt-2",
      });
      assert.equal(
        retry.receipt.t3ThreadID,
        yield* Effect.promise(() => texosMissionThreadId("canonical-task", "canonical-attempt-2")),
      );
    }).pipe(Effect.provide(receiptsLayer)),
  );
});
