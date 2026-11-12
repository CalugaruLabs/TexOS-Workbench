import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { texosMissionThreadId } from "@t3tools/shared/texosMission";

import { exact, executionEnvelope, identifier, type ExecutionIntent } from "./executionProtocol.ts";

export type ExecutionPhase =
  | "admitted"
  | "starting"
  | "running"
  | "stopping"
  | "attemptFinished"
  | "stopped"
  | "denied"
  | "uncertain"
  | "abandoned";
export type ExecutionOutcome = "completed" | "failed" | "interrupted";
/** The assistant's answer, kept with the receipt so a T3 restart can still return it. */
export interface ExecutionAnswer {
  readonly text: string;
  readonly truncated: boolean;
}
export interface ExecutionFinish {
  readonly outcome: ExecutionOutcome;
  readonly answer: ExecutionAnswer;
}
export const EXECUTION_ANSWER_BYTES = 128 * 1024;
export interface ExecutionMappings {
  readonly providerThreadID?: string;
  readonly providerTurnID?: string;
  readonly nativeThreadID?: string;
  readonly nativeTurnID?: string;
}
export interface ExecutionReceipt {
  readonly intent: ExecutionIntent;
  readonly envelopeDigest: string;
  readonly runtimeID: string;
  readonly childID: string;
  readonly t3ThreadID: string;
  readonly t3ProviderSessionID: string;
  readonly phase: ExecutionPhase;
  readonly mappings: ExecutionMappings;
  readonly drained: boolean;
  /** The TexOS launch of T3 that admitted this run; absent only on receipts from before 071. */
  readonly hostGeneration: string | undefined;
  readonly finish: ExecutionFinish | undefined;
}

export class ExecutionReceiptError extends Schema.TaggedError<ExecutionReceiptError>()(
  "ExecutionReceiptError",
  { code: Schema.String },
) {}

const isExecutionReceiptError = Schema.is(ExecutionReceiptError);

export class ExecutionReceipts extends Context.Service<
  ExecutionReceipts,
  {
    readonly runtimeID: string;
    readonly hasUnresolved: Effect.Effect<boolean, ExecutionReceiptError>;
    readonly admit: (
      intent: ExecutionIntent,
      hostGeneration: string,
    ) => Effect.Effect<
      { readonly created: boolean; readonly receipt: ExecutionReceipt },
      ExecutionReceiptError
    >;
    readonly get: (
      commandID: string,
      digest: string,
      authorityID: string,
    ) => Effect.Effect<ExecutionReceipt | undefined, ExecutionReceiptError>;
    readonly transition: (
      receipt: ExecutionReceipt,
      phase: ExecutionPhase,
      mappings?: ExecutionMappings,
      finish?: ExecutionFinish,
    ) => Effect.Effect<ExecutionReceipt, ExecutionReceiptError>;
    /** Ends an uncertain run that an earlier T3 launch admitted, once TexOS proved that launch gone. */
    readonly abandon: (
      commandID: string,
      digest: string,
      authorityID: string,
      currentHostGeneration: string,
    ) => Effect.Effect<ExecutionReceipt, ExecutionReceiptError>;
    readonly recoverInterrupted: Effect.Effect<void, ExecutionReceiptError>;
  }
>()("t3/nativeTexos/executionReceipts") {}

interface Row {
  readonly command_id: string;
  readonly canonical_run_id: string;
  readonly authority_id: string;
  readonly envelope_digest: string;
  readonly envelope_json: string;
  readonly runtime_id: string;
  readonly child_id: string;
  readonly t3_thread_id: string;
  readonly t3_provider_session_id: string;
  readonly phase: ExecutionPhase;
  readonly mappings_json: string;
  readonly drained: number;
  readonly host_generation: string | null;
  readonly outcome: string | null;
  readonly answer_text: string;
  readonly answer_truncated: number;
}

const mappingKeys = [
  "providerThreadID",
  "providerTurnID",
  "nativeThreadID",
  "nativeTurnID",
] as const;
const encodeMappings = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      providerThreadID: Schema.optionalKey(Schema.String),
      providerTurnID: Schema.optionalKey(Schema.String),
      nativeThreadID: Schema.optionalKey(Schema.String),
      nativeTurnID: Schema.optionalKey(Schema.String),
    }),
  ),
);

function decodeRow(row: Row): ExecutionReceipt {
  const saved = exact(JSON.parse(row.envelope_json), ["version", "namespace", "method", "intent"]);
  const envelope = executionEnvelope(saved.intent);
  if (
    envelope.json !== row.envelope_json ||
    envelope.digest !== row.envelope_digest ||
    envelope.intent.commandID !== row.command_id ||
    envelope.intent.canonicalRunID !== row.canonical_run_id ||
    envelope.intent.scope.authorityID !== row.authority_id ||
    ![0, 1].includes(row.drained) ||
    ![0, 1].includes(row.answer_truncated) ||
    (row.outcome !== null && !["completed", "failed", "interrupted"].includes(row.outcome)) ||
    (row.outcome !== null) !== (row.drained === 1) ||
    (row.outcome === null && (row.answer_text !== "" || row.answer_truncated !== 0)) ||
    utf8Bytes(row.answer_text) > EXECUTION_ANSWER_BYTES ||
    ![
      "admitted",
      "starting",
      "running",
      "stopping",
      "attemptFinished",
      "stopped",
      "denied",
      "uncertain",
      "abandoned",
    ].includes(row.phase) ||
    (row.phase === "attemptFinished" || row.phase === "stopped") !== (row.drained === 1)
  ) {
    throw new Error("invalidExecutionReceipt");
  }
  for (const entry of [row.runtime_id, row.child_id, row.t3_thread_id, row.t3_provider_session_id])
    identifier(entry);
  if (row.host_generation !== null) identifier(row.host_generation);
  const mappings: unknown = JSON.parse(row.mappings_json);
  if (
    !mappings ||
    typeof mappings !== "object" ||
    Array.isArray(mappings) ||
    Object.keys(mappings).some((key) => !mappingKeys.includes(key as (typeof mappingKeys)[number]))
  ) {
    throw new Error("invalidExecutionMapping");
  }
  for (const value of Object.values(mappings)) identifier(value);
  return {
    intent: envelope.intent,
    envelopeDigest: envelope.digest,
    runtimeID: row.runtime_id,
    childID: row.child_id,
    t3ThreadID: row.t3_thread_id,
    t3ProviderSessionID: row.t3_provider_session_id,
    phase: row.phase,
    mappings: mappings as ExecutionMappings,
    drained: row.drained === 1,
    hostGeneration: row.host_generation ?? undefined,
    finish:
      row.outcome === null
        ? undefined
        : {
            outcome: row.outcome as ExecutionOutcome,
            answer: { text: row.answer_text, truncated: row.answer_truncated === 1 },
          },
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const candidateRuntimeID = yield* crypto.randomUUIDv4();
  yield* sql`INSERT INTO native_execution_runtime(singleton, runtime_id) VALUES(1, ${candidateRuntimeID}) ON CONFLICT(singleton) DO NOTHING`;
  const rows = yield* sql<{
    readonly runtime_id: string;
  }>`SELECT runtime_id FROM native_execution_runtime WHERE singleton = 1`;
  const runtimeID = rows[0]?.runtime_id;
  if (!runtimeID) return yield* new ExecutionReceiptError({ code: "missingExecutionRuntime" });
  const decode = (row: Row) =>
    Effect.try({
      try: () => decodeRow(row),
      catch: () => new ExecutionReceiptError({ code: "invalidExecutionReceipt" }),
    });
  const get = Effect.fn("ExecutionReceipts.get")(
    function* (commandID: string, digest: string, authorityID: string) {
      const matches =
        yield* sql<Row>`SELECT * FROM native_execution_receipts WHERE command_id = ${commandID}`;
      if (!matches[0]) return undefined;
      const receipt = yield* decode(matches[0]);
      if (receipt.envelopeDigest !== digest || receipt.intent.scope.authorityID !== authorityID) {
        return yield* new ExecutionReceiptError({ code: "executionCommandConflict" });
      }
      return receipt;
    },
    Effect.mapError((error) =>
      isExecutionReceiptError(error)
        ? error
        : new ExecutionReceiptError({ code: "executionStorageUnavailable" }),
    ),
  );
  const hasUnresolved = sql<{ readonly total: number }>`
    SELECT COUNT(*) AS total FROM native_execution_receipts
    WHERE phase IN ('admitted','starting','running','stopping','uncertain')
       OR (phase IN ('attemptFinished','stopped') AND drained <> 1)
  `.pipe(
    Effect.map((rows) => (rows[0]?.total ?? 1) !== 0),
    Effect.mapError(() => new ExecutionReceiptError({ code: "executionStorageUnavailable" })),
  );

  return ExecutionReceipts.of({
    runtimeID,
    hasUnresolved,
    get,
    admit: Effect.fn("ExecutionReceipts.admit")(
      function* (input, hostGeneration) {
        yield* Effect.try({
          try: () => identifier(hostGeneration),
          catch: () => new ExecutionReceiptError({ code: "invalidExecutionIntent" }),
        });
        const envelope = yield* Effect.try({
          try: () => executionEnvelope(input),
          catch: () => new ExecutionReceiptError({ code: "invalidExecutionIntent" }),
        });
        const childID = yield* crypto.randomUUIDv4();
        const t3ThreadID = yield* Effect.tryPromise({
          try: () =>
            texosMissionThreadId(
              envelope.intent.canonicalTaskID,
              envelope.intent.canonicalAttemptID,
            ),
          catch: () => new ExecutionReceiptError({ code: "invalidExecutionIntent" }),
        });
        const t3ProviderSessionID = yield* crypto.randomUUIDv4();
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const previous = yield* get(
              envelope.intent.commandID,
              envelope.digest,
              envelope.intent.scope.authorityID,
            );
            if (previous) return { created: false, receipt: previous };
            if (yield* hasUnresolved)
              return yield* new ExecutionReceiptError({ code: "executionCapacityOccupied" });
            // One admission per TexOS attempt: a retry is a new attempt and gets its own thread.
            const sameAttempt = yield* sql<{ readonly total: number }>`
          SELECT COUNT(*) AS total FROM native_execution_receipts WHERE t3_thread_id = ${t3ThreadID}
        `.pipe(
              Effect.mapError(
                () => new ExecutionReceiptError({ code: "executionStorageUnavailable" }),
              ),
            );
            if ((sameAttempt[0]?.total ?? 1) !== 0)
              return yield* new ExecutionReceiptError({ code: "executionAttemptAlreadyAdmitted" });
            const inserted = yield* sql<{ readonly command_id: string }>`
          INSERT INTO native_execution_receipts
            (command_id, canonical_run_id, authority_id, envelope_digest, envelope_json,
             runtime_id, child_id, t3_thread_id, t3_provider_session_id, phase, mappings_json, drained,
             host_generation)
          VALUES (${envelope.intent.commandID}, ${envelope.intent.canonicalRunID}, ${envelope.intent.scope.authorityID},
            ${envelope.digest}, ${envelope.json}, ${runtimeID}, ${childID}, ${t3ThreadID}, ${t3ProviderSessionID}, 'admitted', '{}', 0,
            ${hostGeneration})
          ON CONFLICT(command_id) DO NOTHING RETURNING command_id
        `;
            const receipt = yield* get(
              envelope.intent.commandID,
              envelope.digest,
              envelope.intent.scope.authorityID,
            );
            if (!receipt)
              return yield* new ExecutionReceiptError({ code: "missingExecutionReceipt" });
            return { created: inserted.length === 1, receipt };
          }),
        );
      },
      Effect.mapError((error) =>
        isExecutionReceiptError(error)
          ? error
          : new ExecutionReceiptError({ code: "executionStorageUnavailable" }),
      ),
    ),
    transition: Effect.fn("ExecutionReceipts.transition")(
      function* (expected, phase, patch = {}, finish) {
        const drained = finish !== undefined;
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const saved = yield* get(
              expected.intent.commandID,
              expected.envelopeDigest,
              expected.intent.scope.authorityID,
            );
            if (!saved || saved.phase !== expected.phase || saved.childID !== expected.childID) {
              return yield* new ExecutionReceiptError({ code: "staleExecutionReceipt" });
            }
            const edges: Readonly<Record<ExecutionPhase, readonly ExecutionPhase[]>> = {
              admitted: ["starting", "stopping", "denied", "uncertain"],
              starting: ["running", "denied", "stopping", "uncertain"],
              running: ["running", "attemptFinished", "stopping", "uncertain"],
              stopping: ["stopping", "stopped", "uncertain"],
              attemptFinished: [],
              stopped: [],
              denied: [],
              uncertain: [],
              abandoned: [],
            };
            if (
              !edges[saved.phase].includes(phase) ||
              drained !== ["attemptFinished", "stopped"].includes(phase)
            ) {
              return yield* new ExecutionReceiptError({ code: "invalidExecutionTransition" });
            }
            for (const key of Object.keys(patch)) {
              if (
                !mappingKeys.includes(key as (typeof mappingKeys)[number]) ||
                patch[key as (typeof mappingKeys)[number]] === undefined
              )
                return yield* new ExecutionReceiptError({ code: "invalidExecutionMapping" });
            }
            const mappings = { ...saved.mappings, ...patch };
            for (const key of mappingKeys) {
              const value = patch[key];
              if (value !== undefined) {
                yield* Effect.try({
                  try: () => identifier(value),
                  catch: () => new ExecutionReceiptError({ code: "invalidExecutionMapping" }),
                });
                if (saved.mappings[key] !== undefined && saved.mappings[key] !== value) {
                  return yield* new ExecutionReceiptError({ code: "executionMappingConflict" });
                }
              }
            }
            const encodedMappings = yield* encodeMappings(mappings);
            const answer = finish && boundedAnswer(finish.answer);
            yield* sql`UPDATE native_execution_receipts SET phase = ${phase}, mappings_json = ${encodedMappings}, drained = ${drained ? 1 : 0},
              outcome = ${finish?.outcome ?? null}, answer_text = ${answer?.text ?? ""}, answer_truncated = ${answer?.truncated ? 1 : 0}
              WHERE command_id = ${saved.intent.commandID}`;
            return {
              ...saved,
              phase,
              mappings,
              drained,
              finish: finish && answer ? { outcome: finish.outcome, answer } : undefined,
            };
          }),
        );
      },
      Effect.mapError((error) =>
        isExecutionReceiptError(error)
          ? error
          : new ExecutionReceiptError({ code: "executionStorageUnavailable" }),
      ),
    ),
    abandon: Effect.fn("ExecutionReceipts.abandon")(
      function* (commandID, digest, authorityID, currentHostGeneration) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const saved = yield* get(commandID, digest, authorityID);
            if (!saved)
              return yield* new ExecutionReceiptError({ code: "missingExecutionReceipt" });
            if (saved.phase === "abandoned") return saved;
            if (
              saved.phase !== "uncertain" ||
              saved.hostGeneration === undefined ||
              saved.hostGeneration === currentHostGeneration
            )
              return yield* new ExecutionReceiptError({ code: "executionNotAbandonable" });
            yield* sql`UPDATE native_execution_receipts SET phase = 'abandoned' WHERE command_id = ${commandID} AND phase = 'uncertain'`;
            return { ...saved, phase: "abandoned" as const };
          }),
        );
      },
      Effect.mapError((error) =>
        isExecutionReceiptError(error)
          ? error
          : new ExecutionReceiptError({ code: "executionStorageUnavailable" }),
      ),
    ),
    recoverInterrupted: sql`
      UPDATE native_execution_receipts SET phase = 'uncertain', drained = 0
      WHERE phase IN ('admitted', 'starting', 'running', 'stopping')
    `.pipe(
      Effect.asVoid,
      Effect.mapError(() => new ExecutionReceiptError({ code: "executionStorageUnavailable" })),
    ),
  });
});

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

/** Cuts the answer to the byte cap at a code point, so a saved answer is always valid text. */
export function boundedAnswer(answer: ExecutionAnswer): ExecutionAnswer {
  if (utf8Bytes(answer.text) <= EXECUTION_ANSWER_BYTES) return answer;
  let bytes = 0;
  let end = 0;
  for (const point of answer.text) {
    const size = utf8Bytes(point);
    if (bytes + size > EXECUTION_ANSWER_BYTES) break;
    bytes += size;
    end += point.length;
  }
  return { text: answer.text.slice(0, end), truncated: true };
}

// Uses the supplied T3 SQL writer; this module never opens a database or imports owner data.
export const layer = Layer.effect(ExecutionReceipts, make);
