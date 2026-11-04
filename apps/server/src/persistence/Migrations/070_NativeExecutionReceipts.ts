import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE native_execution_runtime (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), runtime_id TEXT NOT NULL UNIQUE
    )
  `;
  yield* sql`
    CREATE TABLE native_execution_receipts (
      command_id TEXT PRIMARY KEY NOT NULL,
      canonical_run_id TEXT NOT NULL UNIQUE,
      authority_id TEXT NOT NULL,
      envelope_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      runtime_id TEXT NOT NULL REFERENCES native_execution_runtime(runtime_id),
      child_id TEXT NOT NULL UNIQUE,
      t3_thread_id TEXT NOT NULL UNIQUE,
      t3_provider_session_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('admitted','starting','running','stopping','attemptFinished','stopped','denied','uncertain')),
      mappings_json TEXT NOT NULL,
      drained INTEGER NOT NULL CHECK(drained IN (0, 1))
    )
  `;
});
