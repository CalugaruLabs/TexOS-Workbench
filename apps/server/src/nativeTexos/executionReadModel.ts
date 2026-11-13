import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CommandId,
  ProjectId,
  type MessageId,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type ProviderSessionId,
  type RunAttemptId,
  type RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointCaptureService from "../orchestration-v2/CheckpointCaptureService.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";

// Native mode keeps exactly one T3 project; TexOS owns the real project.
const NATIVE_PROJECT_ID = ProjectId.make("native-texos-preview");

type DomainEventFields = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id">
    : never
  : never;

export type ManagedRunReadModelOutcome = "completed" | "failed" | "interrupted";

export interface ManagedRunReadModelStart {
  readonly appThread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerSessionId: ProviderSessionId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly messageId: MessageId;
  readonly text: string;
}

export interface ManagedRunReadModelHandle {
  readonly ingest: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly finish: (outcome: ManagedRunReadModelOutcome) => Effect.Effect<void>;
}

const noopHandle: ManagedRunReadModelHandle = {
  ingest: () => Effect.void,
  finish: () => Effect.void,
};

/**
 * T3's view of a run TexOS executes. Every write is best effort: a failure is logged and never
 * reaches the run, because TexOS's own record is the source of truth.
 */
export class ManagedRunReadModel extends Context.Reference<{
  readonly begin: (input: ManagedRunReadModelStart) => Effect.Effect<ManagedRunReadModelHandle>;
}>("t3/nativeTexos/ManagedRunReadModel", {
  defaultValue: () => ({ begin: () => Effect.succeed(noopHandle) }),
}) {}

const bestEffort =
  (step: string, runId: RunId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("TexOS mission read model write failed", { step, runId, cause }),
      ),
    );

const make = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  const begin = Effect.fn("ManagedRunReadModel.begin")(function* (input: ManagedRunReadModelStart) {
    const threadId = input.appThread.id;
    const providerInstanceId = input.appThread.providerInstanceId;
    const commandId = CommandId.make(`command:texos-mission:${input.runId}`);
    const now = yield* DateTime.now;
    const event = (fields: DomainEventFields) =>
      ids.allocate
        .event({ threadId, commandId })
        .pipe(Effect.map((id): OrchestrationV2DomainEvent => ({ ...fields, id })));
    const base = { threadId, runId: input.runId, nodeId: input.rootNodeId, providerInstanceId };

    let scope: OrchestrationV2CheckpointScope | undefined;
    let run: OrchestrationV2Run | undefined;
    let attempt: OrchestrationV2RunAttempt | undefined;
    let rootNode: OrchestrationV2ExecutionNode | undefined;
    let finished = false;

    yield* bestEffort(
      "start",
      input.runId,
    )(
      Effect.gen(function* () {
        const existing = yield* projections.getThreadShell(threadId);
        scope = yield* checkpoints.prepareRootRunScope({
          threadId,
          runId: input.runId,
          rootNodeId: input.rootNodeId,
          providerThreadId: input.providerThread.id,
          cwd: input.appThread.worktreePath ?? "/",
          createdAt: now,
        });
        run = {
          id: input.runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: input.appThread.modelSelection,
          providerThreadId: input.providerThread.id,
          userMessageId: input.messageId,
          rootNodeId: input.rootNodeId,
          activeAttemptId: input.attemptId,
          status: "running",
          queuePosition: null,
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        attempt = {
          id: input.attemptId,
          runId: input.runId,
          attemptOrdinal: 1,
          rootNodeId: input.rootNodeId,
          providerInstanceId,
          providerThreadId: input.providerThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        };
        rootNode = {
          id: input.rootNodeId,
          threadId,
          runId: input.runId,
          parentNodeId: null,
          rootNodeId: input.rootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: input.providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scope.id,
          startedAt: now,
          completedAt: null,
        };
        const author = { createdBy: "user", creationSource: "web" } as const;
        const events = [
          ...(existing === null
            ? [
                yield* event({
                  type: "thread.created",
                  threadId,
                  providerInstanceId,
                  occurredAt: now,
                  payload: { ...input.appThread, projectId: NATIVE_PROJECT_ID },
                }),
              ]
            : []),
          yield* event({
            type: "provider-thread.updated",
            threadId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...input.providerThread, appThreadId: threadId, status: "active" },
          }),
          yield* event({ ...base, type: "run.created", occurredAt: now, payload: run }),
          yield* event({ ...base, type: "run-attempt.created", occurredAt: now, payload: attempt }),
          yield* event({ ...base, type: "node.updated", occurredAt: now, payload: rootNode }),
          yield* event({
            ...base,
            type: "checkpoint-scope.created",
            occurredAt: now,
            payload: yield* checkpoints.ensureScope(scope),
          }),
          yield* event({
            ...base,
            type: "message.updated",
            occurredAt: now,
            payload: {
              ...author,
              id: input.messageId,
              threadId,
              runId: input.runId,
              nodeId: input.rootNodeId,
              role: "user",
              text: input.text,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          }),
          yield* event({
            ...base,
            type: "turn-item.updated",
            occurredAt: now,
            payload: {
              ...author,
              id: ids.derive.userTurnItem({ messageId: input.messageId }),
              threadId,
              runId: input.runId,
              nodeId: input.rootNodeId,
              providerThreadId: input.providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 100,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: input.messageId,
              inputIntent: "turn_start",
              text: input.text,
              attachments: [],
            },
          }),
        ];
        yield* eventSink.write({ commandId, events });
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
      }),
    );
    if (run === undefined) return noopHandle;

    return {
      ingest: (providerEvent) =>
        finished
          ? Effect.void
          : bestEffort(
              providerEvent.type,
              input.runId,
            )(
              ingestor.ingestNormalized({
                providerSessionId: input.providerSessionId,
                providerInstanceId,
                threadId,
                runId: input.runId,
                nodeId: input.rootNodeId,
                event: providerEvent,
              }),
            ),
      finish: (outcome) =>
        Effect.suspend(() => {
          if (finished || !run || !attempt || !rootNode || !scope) return Effect.void;
          finished = true;
          const finalRun = run;
          const finalScope = scope;
          // Completed runs wait for their checkpoint, as T3's own finalization does.
          const status = outcome === "completed" ? "waiting" : outcome;
          return bestEffort(
            "finish",
            input.runId,
          )(
            Effect.gen(function* () {
              const completedAt = yield* DateTime.now;
              const done = outcome === "completed" ? null : completedAt;
              yield* eventSink.write({
                commandId,
                events: [
                  yield* event({
                    ...base,
                    type: "run-attempt.updated",
                    occurredAt: completedAt,
                    payload: { ...attempt!, status: outcome, completedAt },
                  }),
                  yield* event({
                    ...base,
                    type: "run.updated",
                    occurredAt: completedAt,
                    payload: { ...finalRun, status, completedAt: done },
                  }),
                  yield* event({
                    ...base,
                    type: "node.updated",
                    occurredAt: completedAt,
                    payload: { ...rootNode!, status, completedAt: done },
                  }),
                ],
              });
              if (outcome !== "failed")
                yield* capture.execute({ threadId, runId: finalRun.id, scopeId: finalScope.id });
            }),
          );
        }),
    } satisfies ManagedRunReadModelHandle;
  });

  return { begin };
});

export const layer = Layer.effect(ManagedRunReadModel, make);
