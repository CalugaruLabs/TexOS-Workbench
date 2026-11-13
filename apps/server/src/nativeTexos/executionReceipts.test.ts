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

import * as Receipts from "./executionReceipts.ts";
import { executionEnvelope } from "./executionProtocol.ts";
import { syntheticIntent, executionReceiptMigrations as Migration } from "./execution.testkit.ts";
import Migration070 from "../persistence/Migrations/070_NativeExecutionReceipts.ts";
import Migration071 from "../persistence/Migrations/071_NativeExecutionOutcomes.ts";
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
          const admitted = yield* store.admit(intent, "generation-1");
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
          const admitted = yield* store.admit(intent, "generation-1");
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
          return yield* store.admit(intent, "generation-1");
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
        const first = yield* store.admit(intent, "generation-1");
        const duplicate = yield* store.admit(intent, "generation-1");
        assert.isTrue(first.created);
        assert.isFalse(duplicate.created);
        assert.deepEqual(first.receipt, duplicate.receipt);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(store.admit({ ...intent, input: "different" }, "generation-1")),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              store.admit(
                { ...intent, commandID: "00000000-0000-4000-8000-000000000002" },
                "generation-1",
              ),
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
        const first = yield* store.admit(intent, "generation-1");
        yield* store.transition(first.receipt, "starting");
        yield* store.recoverInterrupted;
        const repeated = yield* store.admit(intent, "generation-1");
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
        const first = yield* store.admit(syntheticIntent(), "generation-1");
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
      const first = yield* store.admit(intent, "generation-1");
      assert.equal(
        first.receipt.t3ThreadID,
        yield* Effect.promise(() => texosMissionThreadId("canonical-task", "canonical-attempt")),
      );
      yield* sql`UPDATE native_execution_receipts SET phase = 'stopped', drained = 1, outcome = 'interrupted'`;
      const reused = yield* Effect.flip(
        store.admit(
          {
            ...intent,
            commandID: "00000000-0000-4000-8000-000000000002",
            canonicalRunID: "canonical-run-2",
          },
          "generation-1",
        ),
      );
      assert.equal(reused.code, "executionAttemptAlreadyAdmitted");
      const retry = yield* store.admit(
        {
          ...intent,
          commandID: "00000000-0000-4000-8000-000000000003",
          canonicalRunID: "canonical-run-3",
          canonicalAttemptID: "canonical-attempt-2",
        },
        "generation-1",
      );
      assert.equal(
        retry.receipt.t3ThreadID,
        yield* Effect.promise(() => texosMissionThreadId("canonical-task", "canonical-attempt-2")),
      );
    }).pipe(Effect.provide(receiptsLayer)),
  );
  it.effect("a finished run's outcome and answer survive a T3 restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "texos-execution-finish-" });
      const filename = NodePath.join(root, "synthetic-t3.sqlite");
      const intent = syntheticIntent();
      const answer = 'Line one\n\n\u0000 quotes " and emoji \u{1F600}';
      yield* Effect.gen(function* () {
        const store = yield* Receipts.ExecutionReceipts;
        const admitted = yield* store.admit(intent, "generation-1");
        const running = yield* store.transition(
          yield* store.transition(admitted.receipt, "starting"),
          "running",
        );
        assert.equal(
          (yield* Effect.flip(store.transition(running, "attemptFinished"))).code,
          "invalidExecutionTransition",
        );
        yield* store.transition(
          running,
          "attemptFinished",
          {},
          {
            outcome: "failed",
            answer: { text: answer, truncated: false },
          },
        );
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
        return yield* store.get(
          intent.commandID,
          executionEnvelope(intent).digest,
          intent.scope.authorityID,
        );
      }).pipe(
        Effect.provide(Receipts.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename })))),
      );
      assert.equal(reopened?.phase, "attemptFinished");
      assert.equal(reopened?.hostGeneration, "generation-1");
      assert.deepEqual(reopened?.finish, {
        outcome: "failed",
        answer: { text: answer, truncated: false },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an answer over the cap is cut at a code point and marked truncated", () =>
    Effect.sync(() => {
      const text = "a".repeat(Receipts.EXECUTION_ANSWER_BYTES - 1) + "\u{1F600}tail";
      const bounded = Receipts.boundedAnswer({ text, truncated: false });
      assert.isTrue(bounded.truncated);
      assert.equal(bounded.text, "a".repeat(Receipts.EXECUTION_ANSWER_BYTES - 1));
      assert.deepEqual(Receipts.boundedAnswer({ text: "short", truncated: false }), {
        text: "short",
        truncated: false,
      });
    }),
  );

  it.effect("only an uncertain run from an earlier T3 launch can be abandoned", () =>
    Effect.gen(function* () {
      const store = yield* Receipts.ExecutionReceipts;
      const intent = syntheticIntent();
      const digest = executionEnvelope(intent).digest;
      const admitted = yield* store.admit(intent, "generation-1");
      const abandon = (generation: string) =>
        Effect.flip(store.abandon(intent.commandID, digest, intent.scope.authorityID, generation));
      assert.equal((yield* abandon("generation-2")).code, "executionNotAbandonable");
      yield* store.transition(admitted.receipt, "uncertain");
      assert.isTrue(yield* store.hasUnresolved);
      assert.equal((yield* abandon("generation-1")).code, "executionNotAbandonable");
      const abandoned = yield* store.abandon(
        intent.commandID,
        digest,
        intent.scope.authorityID,
        "generation-2",
      );
      assert.equal(abandoned.phase, "abandoned");
      assert.isFalse(abandoned.drained);
      assert.isUndefined(abandoned.finish);
      assert.isFalse(yield* store.hasUnresolved);
      const again = yield* store.abandon(
        intent.commandID,
        digest,
        intent.scope.authorityID,
        "generation-2",
      );
      assert.equal(again.phase, "abandoned");
      const next = yield* store.admit(
        {
          ...intent,
          commandID: "00000000-0000-4000-8000-000000000002",
          canonicalRunID: "canonical-run-2",
          canonicalAttemptID: "canonical-attempt-2",
        },
        "generation-2",
      );
      assert.isTrue(next.created);
    }).pipe(Effect.provide(receiptsLayer)),
  );

  it.effect("receipts written before the outcome columns stay readable and can be reconciled", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration070;
      const uncertain = syntheticIntent();
      const finished = {
        ...uncertain,
        commandID: "00000000-0000-4000-8000-000000000002",
        canonicalRunID: "canonical-run-2",
        canonicalAttemptID: "canonical-attempt-2",
      };
      yield* sql`INSERT INTO native_execution_runtime(singleton, runtime_id) VALUES (1, 'runtime-before')`;
      for (const [intent, phase, drained] of [
        [uncertain, "uncertain", 0],
        [finished, "attemptFinished", 1],
      ] as const) {
        const envelope = executionEnvelope(intent);
        yield* sql`
          INSERT INTO native_execution_receipts
            (command_id, canonical_run_id, authority_id, envelope_digest, envelope_json, runtime_id,
             child_id, t3_thread_id, t3_provider_session_id, phase, mappings_json, drained)
          VALUES (${intent.commandID}, ${intent.canonicalRunID}, ${intent.scope.authorityID},
            ${envelope.digest}, ${envelope.json}, 'runtime-before', ${`child-${phase}`},
            ${`thread-${phase}`}, ${`session-${phase}`}, ${phase}, '{}', ${drained})
        `;
      }
      yield* Migration071;
      const store = yield* Receipts.ExecutionReceipts.pipe(
        Effect.provide(Receipts.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)))),
      );
      const read = (intent: typeof uncertain) =>
        store.get(intent.commandID, executionEnvelope(intent).digest, intent.scope.authorityID);
      const done = yield* read(finished);
      assert.equal(done?.phase, "attemptFinished");
      assert.isTrue(done?.drained);
      assert.equal(done?.hostGeneration, Receipts.LEGACY_HOST_GENERATION);
      assert.isUndefined(done?.finish);
      const saved = yield* read(uncertain);
      assert.equal(saved?.phase, "uncertain");
      assert.equal(saved?.hostGeneration, Receipts.LEGACY_HOST_GENERATION);
      assert.isUndefined(saved?.finish);
      assert.isTrue(yield* store.hasUnresolved);
      const abandoned = yield* store.abandon(
        uncertain.commandID,
        executionEnvelope(uncertain).digest,
        uncertain.scope.authorityID,
        "generation-2",
      );
      assert.equal(abandoned.phase, "abandoned");
      assert.isFalse(yield* store.hasUnresolved);
    }).pipe(Effect.provide(database)),
  );
});
