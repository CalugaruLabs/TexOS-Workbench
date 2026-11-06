// @effect-diagnostics nodeBuiltinImport:off -- Only disposable, synthetic repositories; no real SDK query factory.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { NonNullableUsage, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ClaudeAdapter from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { syntheticIntent } from "./execution.testkit.ts";
import { validateExecutionWorktree } from "./executionWorktree.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

export const CLAUDE_FIXTURE_SESSION = "00000000-0000-4000-8000-000000000101";
export const CLAUDE_FIXTURE_CURSORS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
] as const;
export const CLAUDE_FIXTURE_MODEL = "claude-sonnet-4-6";
export const INITIAL_ANSWER = "export const answer = 0;\n";
export const EDITED_ANSWER = "export const answer = 42;\n";

export class ClaudeFixturePermissionDenied extends Schema.TaggedError<ClaudeFixturePermissionDenied>()(
  "ClaudeFixturePermissionDenied",
  {},
) {}

type StartBoundary = "beforeOpen" | "beforeTurn";
type TerminalEvent = Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>;
const usage: NonNullableUsage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "synthetic",
  iterations: [],
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  speed: "standard",
};

// Wire frames belong to the injected SDK fake, not a replacement adapter implementation.
function assistantFrame(uuid: (typeof CLAUDE_FIXTURE_CURSORS)[number]): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: CLAUDE_FIXTURE_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `msg_${uuid}`,
      model: CLAUDE_FIXTURE_MODEL,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Synthetic answer edited.", citations: null }],
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      stop_details: null,
      usage,
    },
  } satisfies SDKMessage;
}

const successFrame = {
  type: "result",
  subtype: "success",
  uuid: "00000000-0000-4000-8000-000000000301",
  session_id: CLAUDE_FIXTURE_SESSION,
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: "Synthetic answer edited.",
  stop_reason: "end_turn",
  terminal_reason: "completed",
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
} satisfies SDKMessage;

export const makeControlledClaudeFixture = Effect.fn("makeControlledClaudeFixture")(function* (
  options: {
    readonly currentPermission?: (
      boundary: StartBoundary,
    ) => Effect.Effect<void, ClaudeFixturePermissionDenied>;
    readonly pending?: boolean;
    readonly holdClose?: boolean;
    readonly holdDrain?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "texos-controlled-claude-" });
  const root = yield* Effect.promise(() => NodeFSP.realpath(temporary));
  const profile = NodePath.join(root, "fixture-profile");
  const home = NodePath.join(root, "fixture-home");
  const template = NodePath.join(root, "empty-template");
  for (const directory of [profile, home, template]) yield* fs.makeDirectory(directory);
  yield* Effect.sync(() =>
    NodeChildProcess.execFileSync(
      "/usr/bin/git",
      ["init", "--quiet", `--template=${template}`, root],
      {
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdio: "pipe",
      },
    ),
  );
  yield* fs.writeFileString(NodePath.join(root, "answer.ts"), INITIAL_ANSWER);
  const physical = yield* Effect.promise(() => NodeFSP.stat(root, { bigint: true }));
  const base = syntheticIntent(root);
  const intent = {
    ...base,
    configuration: {
      ...base.configuration,
      provider: "claude",
      modelID: CLAUDE_FIXTURE_MODEL,
      runtimeProfileID: "private-claude-fixture",
    },
    worktree: { ...base.worktree, device: String(physical.dev), inode: String(physical.ino) },
  };
  const sdkMessages = yield* Queue.unbounded<
    SDKMessage,
    ClaudeAdapter.ClaudeAgentSdkQueryRunnerError
  >();
  const terminalEvents = yield* Queue.unbounded<TerminalEvent>();
  const closeRequested = yield* Deferred.make<void>();
  const allowClose = yield* Deferred.make<void>();
  const sdkDidClose = yield* Deferred.make<void>();
  const allowDrain = yield* Deferred.make<void>();
  const streamDrained = yield* Deferred.make<void>();
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const opened: Array<ClaudeAdapter.ClaudeAgentSdkQueryOpenInput> = [];
  const prompts: Array<SDKUserMessage> = [];
  const permissionReads: Array<StartBoundary> = [];
  const ownedScope = yield* Scope.make();
  let edits = 0;
  let sdkClosed = false;
  let drained = false;
  let interrupts = 0;
  let adapterSessions = 0;

  const beforeProviderStart = Effect.fn("ControlledClaude.beforeProviderStart")(function* (
    boundary: StartBoundary,
  ) {
    permissionReads.push(boundary);
    yield* options.currentPermission?.(boundary) ?? Effect.void;
    yield* validateExecutionWorktree(intent.worktree);
  });
  const closeSdk = Effect.fn("ControlledClaude.closeSdk")(function* () {
    yield* Deferred.succeed(closeRequested, undefined);
    yield* Deferred.await(allowClose);
    sdkClosed = true;
    yield* Deferred.succeed(sdkDidClose, undefined);
    yield* Queue.shutdown(sdkMessages);
  });
  if (!options.holdClose) yield* Deferred.succeed(allowClose, undefined);
  if (!options.holdDrain) yield* Deferred.succeed(allowDrain, undefined);
  const queryRunner: ClaudeAdapter.ClaudeAgentSdkQueryRunnerShape = {
    allocateSessionId: Effect.succeed(CLAUDE_FIXTURE_SESSION),
    open: (input) =>
      Effect.gen(function* () {
        yield* validateExecutionWorktree(intent.worktree).pipe(Effect.orDie);
        NodeAssert.equal(input.options.model, CLAUDE_FIXTURE_MODEL);
        NodeAssert.equal(input.options.cwd, root);
        NodeAssert.deepEqual(input.options.env, {});
        NodeAssert.equal(
          input.options.pathToClaudeCodeExecutable,
          NodePath.join(root, "not-an-executable"),
        );
        NodeAssert.equal(input.options.sessionId, CLAUDE_FIXTURE_SESSION);
        NodeAssert.equal(input.options.resume, undefined);
        opened.push(input);
        return {
          // Model the owned SDK Query iterator's return/close contract too. No detached writer:
          // the consumed stream's finalizer waits for this fake SDK's gated close before drain.
          messages: Stream.fromQueue(sdkMessages).pipe(
            Stream.ensuring(
              closeSdk().pipe(
                Effect.andThen(Deferred.await(allowDrain)),
                Effect.andThen(
                  Effect.sync(() => {
                    drained = true;
                  }),
                ),
                Effect.andThen(Deferred.succeed(streamDrained, undefined)),
              ),
            ),
          ),
          offer: (message, onQueued) =>
            Effect.gen(function* () {
              yield* validateExecutionWorktree(intent.worktree).pipe(Effect.orDie);
              NodeAssert.equal(prompts.length, 0, "one controlled prompt, never replay");
              NodeAssert.equal(message.message.content, intent.input);
              prompts.push(message);
              onQueued?.();
              yield* Effect.promise(async () => {
                const answer = await NodeFSP.open(
                  NodePath.join(root, "answer.ts"),
                  NodeFS.constants.O_WRONLY | NodeFS.constants.O_NOFOLLOW,
                );
                try {
                  NodeAssert.equal(
                    await NodeFSP.readFile(NodePath.join(root, "answer.ts"), "utf8"),
                    INITIAL_ANSWER,
                  );
                  await answer.truncate(0);
                  await answer.writeFile(EDITED_ANSWER);
                  edits++;
                } finally {
                  await answer.close();
                }
              });
              for (const cursor of CLAUDE_FIXTURE_CURSORS)
                yield* Queue.offer(sdkMessages, assistantFrame(cursor));
              if (!options.pending) yield* Queue.offer(sdkMessages, successFrame);
            }),
          setModel: () => Effect.die("No model fallback in this fixture"),
          applyFlagSettings: () => Effect.die("No profile fallback in this fixture"),
          setPermissionMode: () => Effect.die("No permission fallback in this fixture"),
          backgroundTasks: () => Effect.die("No background execution in this fixture"),
          stopTask: () => Effect.die("No delegated execution in this fixture"),
          interrupt: Effect.sync(() => {
            interrupts++;
          }),
          close: closeSdk(),
        };
      }),
    forkSession: () => Effect.die("No fork fallback in this fixture"),
    subagentLaunchToolUseId: () => Effect.die("No subagent fallback in this fixture"),
    assertComplete: Effect.sync(() => {
      NodeAssert.ok(
        opened.length === 0 || (sdkClosed && drained),
        "SDK close AND stream drain required",
      );
    }),
  };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const isolate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.WorkingDirectory, root),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
        ...spawner,
        spawn: () => Effect.die("Subprocess launch forbidden in controlled Claude adapter"),
        string: () => Effect.die("Subprocess launch forbidden in controlled Claude adapter"),
      }),
    );
  const adapter = yield* isolate(
    ClaudeAdapter.makeClaudeAdapterV2({
      instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: decodeClaudeSettings({
        binaryPath: NodePath.join(root, "not-an-executable"),
        homePath: profile,
        launchArgs: "",
      }),
      environment: {},
      attachmentsDir: NodePath.join(root, "attachments"),
      fileSystem: fs,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner,
    }),
  );
  const threadId = ThreadId.make("synthetic-claude-thread");
  const providerSessionId = ProviderSessionId.make("synthetic-claude-provider-session");
  const modelSelection = {
    instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
    model: CLAUDE_FIXTURE_MODEL,
  };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "approval-required",
    interactionMode: "default",
    cwd: root,
  });
  const closeOwned = Scope.close(ownedScope, Exit.void).pipe(
    Effect.andThen(
      Effect.suspend(() => (opened.length === 0 ? Effect.void : Deferred.await(streamDrained))),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Deferred.succeed(allowClose, undefined).pipe(
      Effect.andThen(Deferred.succeed(allowDrain, undefined)),
      Effect.andThen(closeOwned),
    ),
  );

  const open = Effect.fn("ControlledClaude.open")(function* () {
    yield* beforeProviderStart("beforeOpen");
    const runtime = yield* adapter
      .openSession({ threadId, providerSessionId, modelSelection, runtimePolicy })
      .pipe(Effect.provideService(Scope.Scope, ownedScope));
    adapterSessions++;
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    NodeAssert.equal(providerThread.nativeThreadRef?.nativeId, CLAUDE_FIXTURE_SESSION);
    yield* runtime.events.pipe(
      Stream.runForEach((event) => {
        events.push(event);
        return event.type === "turn.terminal"
          ? Queue.offer(terminalEvents, event).pipe(Effect.asVoid)
          : Effect.void;
      }),
      Effect.forkScoped,
    );
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make(intent.scope.projectID),
      title: "Synthetic Claude lower adapter",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: root,
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
    return {
      runtime,
      providerThread,
      start: Effect.fn("ControlledClaude.start")(function* () {
        yield* beforeProviderStart("beforeTurn");
        yield* runtime.startTurn({
          appThread,
          threadId,
          runId: RunId.make(intent.canonicalRunID),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make(intent.canonicalAttemptID),
          rootNodeId: NodeId.make("synthetic-claude-child"),
          providerThread,
          message: {
            messageId: MessageId.make("synthetic-claude-message"),
            text: intent.input,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        });
      }, isolate),
    };
  }, isolate);
  return {
    root,
    profile,
    home,
    intent,
    open,
    closeOwned,
    events,
    opened,
    prompts,
    permissionReads,
    closeRequested,
    sdkDidClose,
    releaseClose: Deferred.succeed(allowClose, undefined),
    releaseDrain: Deferred.succeed(allowDrain, undefined),
    loseSdkStream: Queue.fail(
      sdkMessages,
      new ClaudeAdapter.ClaudeAgentSdkQueryRunnerError({
        method: "messages",
        cause: new Error("Synthetic SDK connection lost"),
      }),
    ),
    terminal: Queue.take(terminalEvents),
    snapshot: () => ({
      edits,
      sdkClosed,
      drained,
      interrupts,
      adapterSessions,
      cessation: opened.length > 0 && sdkClosed && drained ? "proven" : "uncertain",
    }),
  };
});
