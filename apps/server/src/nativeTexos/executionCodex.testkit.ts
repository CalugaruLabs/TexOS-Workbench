// @effect-diagnostics nodeBuiltinImport:off -- Test-only fixture checks physical identity and has no real CLI factory.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import packageJson from "../../package.json" with { type: "json" };
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { ControlledExecutionProvider, ExecutionControlError } from "./executionControl.ts";
import { executionEnvelope, type ExecutionIntent } from "./executionProtocol.ts";
import type { NativeStartAuthorizer } from "./executionControl.ts";
import type * as Receipts from "./executionReceipts.ts";
import { syntheticAuthorization } from "./execution.testkit.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

function replayTranscript(intent: ExecutionIntent): CodexReplay.CodexAppServerReplayTranscript {
  const turn = (status: "inProgress" | "completed") => ({
    id: "controlled-native-turn",
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 1782622440,
    completedAt: status === "completed" ? 1782622450 : null,
    durationMs: null,
  });
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: "native-admitted-controlled-edit",
    entries: [
      {
        type: "expect_outbound",
        frame: {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
            capabilities: {
              experimentalApi: true,
              optOutNotificationMethods: ["turn/diff/updated"],
              extensions: {
                "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
              },
            },
          },
        },
      },
      {
        type: "emit_inbound",
        frame: {
          id: 1,
          result: {
            userAgent: "Controlled TexOS fixture",
            codexHome: NodePath.join(intent.worktree.root, "fixture-profile"),
            platformFamily: "unix",
            platformOs: "macos",
          },
        },
      },
      { type: "expect_outbound", frame: { method: "initialized" } },
      {
        type: "expect_outbound",
        frame: {
          id: 2,
          method: "thread/start",
          params: {
            cwd: intent.worktree.root,
            model: intent.configuration.modelID,
            config: CodexAdapter.CODEX_THREAD_CONFIG,
          },
        },
      },
      {
        type: "emit_inbound",
        frame: {
          id: 2,
          result: {
            thread: {
              id: "controlled-native-thread",
              sessionId: "controlled-native-thread",
              forkedFromId: null,
              preview: "",
              ephemeral: false,
              modelProvider: "openai",
              createdAt: 1782622440,
              updatedAt: 1782622440,
              status: { type: "idle" },
              path: NodePath.join(intent.worktree.root, "fixture-thread.jsonl"),
              cwd: intent.worktree.root,
              cliVersion: "0.144.0",
              source: "vscode",
              threadSource: null,
              agentNickname: null,
              agentRole: null,
              gitInfo: null,
              name: null,
              turns: [],
            },
            model: intent.configuration.modelID,
            modelProvider: "openai",
            serviceTier: null,
            cwd: intent.worktree.root,
            instructionSources: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: {
              type: "workspaceWrite",
              writableRoots: [intent.worktree.root],
              networkAccess: false,
            },
            reasoningEffort: "medium",
          },
        },
      },
      {
        type: "expect_outbound",
        label: "start",
        frame: {
          id: 3,
          method: "turn/start",
          params: {
            threadId: "controlled-native-thread",
            input: [{ type: "text", text: intent.input }],
            cwd: intent.worktree.root,
            model: intent.configuration.modelID,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [intent.worktree.root],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            },
            summary: "detailed",
            collaborationMode: {
              mode: "default",
              settings: { model: intent.configuration.modelID },
            },
          },
        },
      },
      { type: "emit_inbound", frame: { id: 3, result: { turn: turn("inProgress") } } },
      {
        type: "emit_inbound",
        label: "fixture-edit",
        frame: {
          method: "turn/started",
          params: { threadId: "controlled-native-thread", turn: turn("inProgress") },
        },
      },
      {
        type: "emit_inbound",
        frame: {
          method: "turn/completed",
          params: { threadId: "controlled-native-thread", turn: turn("completed") },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  };
}

export const makeControlledCodexFixture = Effect.fn("ControlledCodexFixture.make")(
  function* (options: {
    readonly repositoryRoot: string;
    readonly onFactory?: () => void;
    readonly onEdit?: (intent: ExecutionIntent) => void;
    readonly onFailure?: (cause: unknown) => void;
    readonly holdAttempt?: boolean;
  }) {
    const root = options.repositoryRoot;
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const preparedConfig = yield* makeReplayServerConfig("native-admitted-controlled-edit");
    const serverConfig = { ...preparedConfig, cwd: root };
    yield* Effect.addFinalizer(() =>
      fs.remove(serverConfig.baseDir, { recursive: true }).pipe(Effect.ignore),
    );
    const writeAnswer = Effect.fn("ControlledCodexFixture.writeAnswer")(function* (
      intent: ExecutionIntent,
    ) {
      yield* Effect.tryPromise({
        try: async () => {
          const file = await NodeFSP.open(
            NodePath.join(root, "answer.ts"),
            NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1)
              throw new Error("fixtureAnswerNotOwnedRegularFile");
            await file.truncate(0);
            await file.writeFile("export const answer = 42;\n");
          } finally {
            await file.close();
          }
        },
        catch: () => new ExecutionControlError({ code: "controlledAnswerWriteRefused" }),
      });
      yield* Effect.sync(() => options.onEdit?.(intent));
    });
    const provider = ControlledExecutionProvider.of({
      mode: "controlled-codex",
      create: (receipt, beforeProviderStart, recordMappings) =>
        Effect.gen(function* () {
          const releaseHold = yield* Deferred.make<void>();
          options.onFactory?.();
          const intent = receipt.intent;
          NodeAssert.equal(intent.worktree.root, root);
          return {
            stop: Deferred.succeed(releaseHold, undefined).pipe(Effect.asVoid),
            run: Effect.scoped(
              Effect.gen(function* () {
                yield* beforeProviderStart;
                const transcript = replayTranscript(receipt.intent);
                const driver = yield* CodexReplay.makeReplayDriver(transcript, {
                  beforeEmitInbound: (entry) =>
                    entry.label === "fixture-edit"
                      ? writeAnswer(intent).pipe(Effect.orDie)
                      : Effect.void,
                });
                const profile = NodePath.join(root, "fixture-profile");
                yield* fs.makeDirectory(profile, { recursive: true });
                const settings = decodeCodexSettings({
                  binaryPath: NodePath.join(root, "fixture-not-an-executable"),
                  homePath: profile,
                  launchArgs: "",
                });
                const adapter = yield* CodexAdapter.makeCodexAdapterV2({
                  instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
                  settings,
                  environment: {},
                  crypto,
                  fileSystem: fs,
                  idAllocator,
                  serverConfig,
                  clientFactory: {
                    open: (input) =>
                      Effect.gen(function* () {
                        NodeAssert.deepEqual(input.environment, {});
                        NodeAssert.equal(
                          input.settings.binaryPath,
                          NodePath.join(root, "fixture-not-an-executable"),
                        );
                        NodeAssert.equal(input.settings.homePath, profile);
                        NodeAssert.equal(input.runtimePolicy.cwd, root);
                        const context = yield* Layer.build(
                          CodexReplay.layerReplayWithDriver(driver),
                        );
                        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                          Effect.provide(context),
                        );
                      }).pipe(
                        Effect.mapError(
                          (cause) =>
                            new ProviderAdapter.ProviderAdapterOpenSessionError({
                              driver: CodexAdapter.CODEX_DRIVER_KIND,
                              providerSessionId: input.providerSessionId,
                              cause,
                            }),
                        ),
                      ),
                  },
                }).pipe(
                  Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
                );
                const threadId = ThreadId.make(receipt.t3ThreadID);
                const modelSelection = {
                  instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
                  model: intent.configuration.modelID,
                };
                const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  cwd: root,
                  approvalPolicy: "on-request",
                  sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [root],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true,
                  },
                });
                const runtime = yield* adapter.openSession({
                  threadId,
                  providerSessionId: ProviderSessionId.make(receipt.t3ProviderSessionID),
                  modelSelection,
                  runtimePolicy,
                });
                const providerThread = yield* runtime.ensureThread({
                  threadId,
                  modelSelection,
                  runtimePolicy,
                });
                const nativeThreadID = providerThread.nativeThreadRef?.nativeId;
                if (typeof nativeThreadID !== "string" || !nativeThreadID)
                  return yield* new ExecutionControlError({
                    code: "controlledThreadIdentityMissing",
                  });
                yield* recordMappings({ providerThreadID: providerThread.id, nativeThreadID });
                const terminal = yield* Deferred.make<void, ExecutionControlError>();
                let providerTurnID: string | undefined;
                let nativeTurnID: string | undefined;
                yield* runtime.events.pipe(
                  Stream.runForEach((event) => {
                    if (event.type === "provider_turn.updated") {
                      providerTurnID = event.providerTurn.id;
                      nativeTurnID = event.providerTurn.nativeTurnRef?.nativeId ?? undefined;
                    }
                    if (event.type === "provider_turn.updated" && providerTurnID && nativeTurnID) {
                      return recordMappings({ providerTurnID, nativeTurnID });
                    }
                    return event.type === "turn.terminal"
                      ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
                      : Effect.void;
                  }),
                  Effect.catchCause(() =>
                    Deferred.fail(
                      terminal,
                      new ExecutionControlError({ code: "controlledFixtureEventFailed" }),
                    ).pipe(Effect.asVoid),
                  ),
                  Effect.forkScoped,
                );
                const now = yield* DateTime.now;
                const appThread: OrchestrationV2AppThread = {
                  id: threadId,
                  projectId: ProjectId.make(intent.scope.projectID),
                  title: "Synthetic admitted edit",
                  createdBy: "user",
                  creationSource: "web",
                  providerInstanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
                  modelSelection,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: root,
                  activeProviderThreadId: providerThread.id,
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                  archivedAt: null,
                  settledOverride: null,
                  settledAt: null,
                  lastVisitedAt: null,
                  deletedAt: null,
                };
                yield* beforeProviderStart;
                yield* runtime.startTurn({
                  appThread,
                  threadId,
                  runId: RunId.make(intent.canonicalRunID),
                  runOrdinal: 1,
                  providerTurnOrdinal: 1,
                  attemptId: RunAttemptId.make(intent.canonicalAttemptID),
                  rootNodeId: NodeId.make(receipt.childID),
                  providerThread,
                  message: {
                    messageId: MessageId.make(receipt.childID),
                    text: intent.input,
                    attachments: [],
                    createdBy: "user",
                    creationSource: "web",
                  },
                  modelSelection,
                  runtimePolicy,
                });
                yield* Deferred.await(terminal);
                const replay = yield* Ref.get(driver.state);
                NodeAssert.equal(replay.failure, null);
                NodeAssert.equal(replay.cursor, transcript.entries.length);
                NodeAssert.ok(providerTurnID);
                NodeAssert.equal(nativeTurnID, "controlled-native-turn");
                return {
                  providerThreadID: providerThread.id,
                  providerTurnID: providerTurnID!,
                  nativeThreadID,
                  nativeTurnID: nativeTurnID!,
                };
              }),
            ).pipe(
              Effect.flatMap((mappings) =>
                options.holdAttempt
                  ? Deferred.await(releaseHold).pipe(Effect.as({ mappings, drained: true }))
                  : Effect.succeed({ mappings, drained: true }),
              ),
              Effect.catchCause((cause) => {
                options.onFailure?.(cause);
                return Effect.fail(
                  new ExecutionControlError({ code: "controlledProtocolFixtureFailed" }),
                );
              }),
            ),
          };
        }),
    });
    return provider;
  },
);

export function currentReceiptAuthorizer(
  store: Receipts.ExecutionReceipts["Service"],
  intent: ExecutionIntent,
  now: number,
  denyAt: number,
  seen: Array<Parameters<NativeStartAuthorizer>[0]>,
): NativeStartAuthorizer {
  return async (params) => {
    seen.push(params);
    const saved = await Effect.runPromise(
      store.get(intent.commandID, executionEnvelope(intent).digest, intent.scope.authorityID),
    );
    NodeAssert.ok(saved);
    if (params.nativeThreadID !== undefined || params.providerThreadID !== undefined) {
      NodeAssert.equal(params.nativeThreadID, saved.mappings.nativeThreadID);
      NodeAssert.equal(params.providerThreadID, saved.mappings.providerThreadID);
      NodeAssert.equal(typeof params.nativeThreadID, "string");
      NodeAssert.equal(typeof params.providerThreadID, "string");
    }
    return {
      ...syntheticAuthorization(intent, now),
      runtimeID: saved.runtimeID,
      childID: saved.childID,
      ...(seen.length === denyAt
        ? {
            outcome: "deny",
            checks: { ...syntheticAuthorization(intent, now).checks, permission: "denied" },
          }
        : {}),
    };
  };
}
