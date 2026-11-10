import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { texosMissionThreadId } from "@t3tools/shared/texosMission";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as CheckpointCaptureService from "../orchestration-v2/CheckpointCaptureService.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReadModel from "./executionReadModel.ts";

const CODEX = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("texos-managed-codex");
const modelSelection = { instanceId, model: "gpt-5.4" };

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const realSink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, database)));
const git = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mission-read-model-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeLayer = (sink: Layer.Layer<EventSink.EventSinkV2>, captured: Array<RunId>) => {
  const checkpoints = Layer.mock(CheckpointService.CheckpointServiceV2)({
    prepareRootRunScope: (input) =>
      Effect.succeed({
        id: CheckpointScopeId.make(`scope:${input.runId}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.rootNodeId,
        parentScopeId: null,
        providerThreadId: input.providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: input.cwd,
        createdAt: input.createdAt,
      }),
    ensureScope: (scope) => Effect.succeed(scope),
    captureBaseline: () => Effect.void,
  });
  const capture = Layer.mock(CheckpointCaptureService.CheckpointCaptureServiceV2)({
    execute: (input) => Effect.sync(() => void captured.push(input.runId)),
  });
  return ReadModel.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProviderEventIngestor.layer.pipe(
          Layer.provide(
            Layer.mergeAll(stores, sink, IdAllocator.layer, ThreadCommandExecutor.layer, git),
          ),
        ),
        checkpoints,
        capture,
        sink,
        stores,
        IdAllocator.layer,
      ),
    ),
  );
};

const fixture = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threadId = ThreadId.make(
    yield* Effect.promise(() => texosMissionThreadId("task-1", "attempt-1")),
  );
  const providerSessionId = yield* ids.allocate.providerSession({
    providerInstanceId: instanceId,
    threadId,
  });
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver: CODEX, nativeThreadId: "native-mission" }),
    driver: CODEX,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: CODEX, nativeId: "native-mission", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: "texos-project" as never,
    title: "Fix the export button",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: "/synthetic/repository",
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const start: ReadModel.ManagedRunReadModelStart = {
    appThread,
    providerThread,
    providerSessionId,
    runId: RunId.make("canonical-run"),
    attemptId: RunAttemptId.make("attempt-1"),
    rootNodeId: NodeId.make("child-1"),
    messageId: MessageId.make("child-1"),
    text: "Fix the export button",
  };
  return { now, start };
});

describe("TexOS mission read model", () => {
  it.effect("records a managed run as a normal T3 thread with its timeline", () => {
    const captured: Array<RunId> = [];
    return Effect.gen(function* () {
      const { now, start } = yield* fixture;
      const model = yield* ReadModel.ManagedRunReadModel;
      const handle = yield* model.begin(start);

      yield* handle.ingest({
        type: "turn_item.updated",
        driver: CODEX,
        turnItem: {
          id: TurnItemId.make("turn-item:mission-answer"),
          threadId: start.appThread.id,
          runId: start.runId,
          nodeId: start.rootNodeId,
          providerThreadId: start.providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:mission-answer"),
          text: "Done.",
          streaming: false,
        },
      });
      yield* handle.finish("completed");
      yield* handle.finish("failed");

      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const thread = yield* projections.getThread(start.appThread.id);
      assert.equal(thread.projectId, "native-texos-preview");
      assert.equal(thread.worktreePath, "/synthetic/repository");
      const records = yield* projections.getThreadRecords(start.appThread.id, [
        "runs",
        "attempts",
        "messages",
        "turnItems",
      ]);
      assert.deepEqual(
        records.runs.map((run) => [run.id, run.status]),
        [[start.runId, "waiting"]],
      );
      assert.deepEqual(
        records.attempts.map((attempt) => [attempt.id, attempt.status]),
        [[start.attemptId, "completed"]],
      );
      assert.deepEqual(
        records.turnItems.map((item) => item.type),
        ["user_message", "assistant_message"],
      );
      assert.deepEqual(captured, [start.runId]);
    }).pipe(Effect.provide(makeLayer(realSink, captured)));
  });

  it.effect("a store that refuses every write never reaches the run", () => {
    const captured: Array<RunId> = [];
    const refusing = Layer.mock(EventSink.EventSinkV2)({
      write: () => Effect.fail(new EventSink.EventSinkWriteError({ eventCount: 1, cause: null })),
    });
    return Effect.gen(function* () {
      const { start } = yield* fixture;
      const handle = yield* (yield* ReadModel.ManagedRunReadModel).begin(start);
      yield* handle.ingest({
        type: "provider_thread.updated",
        driver: CODEX,
        providerThread: start.providerThread,
      });
      yield* handle.finish("completed");
      assert.deepEqual(captured, []);
    }).pipe(Effect.provide(makeLayer(refusing, captured)));
  });
});
