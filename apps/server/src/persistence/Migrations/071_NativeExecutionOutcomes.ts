import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// SQLite cannot widen a CHECK constraint in place, so the receipts table is rebuilt. Rows from
// before this migration get the generation 'pre-071', so TexOS can reconcile an uncertain one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE native_execution_receipts_v2 (
      command_id TEXT PRIMARY KEY NOT NULL,
      canonical_run_id TEXT NOT NULL UNIQUE,
      authority_id TEXT NOT NULL,
      envelope_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      runtime_id TEXT NOT NULL REFERENCES native_execution_runtime(runtime_id),
      child_id TEXT NOT NULL UNIQUE,
      t3_thread_id TEXT NOT NULL UNIQUE,
      t3_provider_session_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('admitted','starting','running','stopping','attemptFinished','stopped','denied','uncertain','abandoned')),
      mappings_json TEXT NOT NULL,
      drained INTEGER NOT NULL CHECK(drained IN (0, 1)),
      host_generation TEXT,
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','failed','interrupted')),
      answer_text TEXT NOT NULL DEFAULT '',
      answer_truncated INTEGER NOT NULL DEFAULT 0 CHECK(answer_truncated IN (0, 1))
    )
  `;
  yield* sql`
    INSERT INTO native_execution_receipts_v2
      (command_id, canonical_run_id, authority_id, envelope_digest, envelope_json, runtime_id,
       child_id, t3_thread_id, t3_provider_session_id, phase, mappings_json, drained,
       host_generation)
    SELECT command_id, canonical_run_id, authority_id, envelope_digest, envelope_json, runtime_id,
       child_id, t3_thread_id, t3_provider_session_id, phase, mappings_json, drained, 'pre-071'
    FROM native_execution_receipts
  `;
  yield* sql`DROP TABLE native_execution_receipts`;
  yield* sql`ALTER TABLE native_execution_receipts_v2 RENAME TO native_execution_receipts`;
});
