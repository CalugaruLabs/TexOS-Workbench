import {
  ClaudeSettings,
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off -- Only the explicitly permitted executable is read, after profile access.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexError from "effect-codex-app-server/errors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Claude from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ExecutionBinding,
  executionObservationKey,
  type BoundCliExecution,
} from "./executionBinding.ts";
import { ExecutionControlError, type ControlledExecutionAttempt } from "./executionControl.ts";
import type * as Receipts from "./executionReceipts.ts";
import type { ManagedExecutionObservation } from "./executionProtocol.ts";
import { validateExecutionWorktree } from "./executionWorktree.ts";

export class OwnedExecutionTransportError extends Schema.TaggedError<OwnedExecutionTransportError>()(
  "OwnedExecutionTransportError",
  { operation: Schema.String },
) {}

interface OwnedLifecycle {
  readonly closeAndJoin: Effect.Effect<void, OwnedExecutionTransportError>;
  readonly transportAndParserDrain: Effect.Effect<void, OwnedExecutionTransportError>;
}

// No production supplier: stock adapters cannot currently prove complete owned event drain.
export interface ManagedExecutionTransports {
  readonly codex?: {
    readonly open: (
      input: Parameters<Codex.CodexAppServerClientFactoryShape["open"]>[0],
      binding: BoundCliExecution,
    ) => Effect.Effect<
      OwnedLifecycle & {
        readonly client: Effect.Success<ReturnType<Codex.CodexAppServerClientFactoryShape["open"]>>;
      },
      OwnedExecutionTransportError,
      Scope.Scope
    >;
  };
  readonly claude?: {
    readonly allocateSessionId: (
      binding: BoundCliExecution,
    ) => Claude.ClaudeAgentSdkQueryRunnerShape["allocateSessionId"];
    readonly open: (
      input: Claude.ClaudeAgentSdkQueryOpenInput,
      binding: BoundCliExecution,
    ) => Effect.Effect<
      OwnedLifecycle & {
        readonly query: Claude.ClaudeAgentSdkQuerySession;
      },
      OwnedExecutionTransportError
    >;
  };
}

export class ManagedExecutionProvider extends Context.Service<
  ManagedExecutionProvider,
  {
    readonly mode: "managed-cli-subscription";
    readonly available: boolean;
    readonly supports: (provider: "codex" | "claudeCode") => boolean;
    readonly create: (
      receipt: Receipts.ExecutionReceipt,
      beforeProviderStart: Effect.Effect<void, ExecutionControlError>,
      recordMappings: (
        patch: Receipts.ExecutionMappings,
      ) => Effect.Effect<void, ExecutionControlError>,
    ) => Effect.Effect<ControlledExecutionAttempt, ExecutionControlError>;
    readonly observation: (commandID: string) => ManagedExecutionObservation | undefined;
  }
>()("t3/nativeTexos/executionManaged/ManagedExecutionProvider") {}

const decodeCodex = Schema.decodeSync(CodexSettings);
const decodeClaude = Schema.decodeSync(ClaudeSettings);

export const makeManagedExecutionProvider = Effect.fn("ManagedExecutionProvider.make")(function* (
  transports?: ManagedExecutionTransports,
) {
  const bindings = yield* ExecutionBinding;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const config = yield* ServerConfig.ServerConfig;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const observations = new Map<string, ManagedExecutionObservation>();
  const supports = (provider: "codex" | "claudeCode") =>
    bindings.available &&
    (provider === "codex" ? transports?.codex !== undefined : transports?.claude !== undefined);
  return ManagedExecutionProvider.of({
    mode: "managed-cli-subscription",
    available:
      bindings.available && (transports?.codex !== undefined || transports?.claude !== undefined),
    supports,
    observation: (id) => observations.get(id),
    create: Effect.fn("ManagedExecutionProvider.create")(
      function* (receipt, beforeProviderStart, recordMappings) {
        if (!supports(receipt.intent.configuration.provider))
          return yield* new ExecutionControlError({ code: "managedRouteUnavailable" });
        let runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined;
        let providerThread:
          | Awaited<
              Effect.Success<
                ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"]>
              >
            >
          | undefined;
        let providerTurnID: Receipts.ExecutionMappings["providerTurnID"];
        let stopping = false;
        const observation: ManagedExecutionObservation = {
          key: executionObservationKey(receipt),
          outcome: "unknown",
          closeAndJoin: "unknown",
          transportAndParserDrain: "unknown",
          adapterEventDrain: "unknown",
        };
        const publish = (patch: Partial<Omit<ManagedExecutionObservation, "key">>) => {
          observations.set(
            receipt.intent.commandID,
            Object.freeze({
              ...(observations.get(receipt.intent.commandID) ?? observation),
              ...patch,
            }),
          );
        };
        return {
          stop: Effect.gen(function* () {
            stopping = true;
            if (runtime && providerThread && providerTurnID)
              yield* runtime
                .interruptTurn({
                  providerThread,
                  providerTurnId: providerTurnID as Parameters<
                    typeof runtime.interruptTurn
                  >[0]["providerTurnId"],
                })
                .pipe(Effect.ignore);
          }),
          run: Effect.scoped(
            Effect.gen(function* () {
              yield* beforeProviderStart;
              const bound = yield* bindings.resolve(receipt);
              publish({});
              const ownedScope = yield* Scope.make();
              yield* Effect.addFinalizer(() => Scope.close(ownedScope, Exit.void));
              const intent = receipt.intent;
              const root = intent.worktree.root;
              const checkExecutable = Effect.tryPromise({
                try: async () => {
                  if ((await NodeFSP.realpath(bound.executablePath)) !== bound.executablePath)
                    throw new Error("linkedExecutable");
                  const handle = await NodeFSP.open(
                    bound.executablePath,
                    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
                  );
                  try {
                    if (
                      !(await handle.stat()).isFile() ||
                      NodeCrypto.createHash("sha256")
                        .update(await handle.readFile())
                        .digest("hex") !== bound.executableSHA256
                    )
                      throw new Error("changedExecutable");
                  } finally {
                    await handle.close();
                  }
                },
                catch: () => new ExecutionControlError({ code: "managedExecutableChanged" }),
              });
              yield* checkExecutable;
              const checkedStart = beforeProviderStart.pipe(
                Effect.andThen(checkExecutable),
                Effect.andThen(beforeProviderStart),
              );
              const environment = {
                ...bound.profile.environment,
                HOME: bound.profile.homeDirectory,
                ...(intent.configuration.provider === "codex"
                  ? { CODEX_HOME: bound.profile.profileDirectory }
                  : { CLAUDE_CONFIG_DIR: bound.profile.profileDirectory }),
              };
              const isolate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.provideService(HostProcess.Environment, environment),
                  Effect.provideService(HostProcess.HomeDirectory, bound.profile.homeDirectory),
                  Effect.provideService(HostProcess.WorkingDirectory, root),
                  Effect.provideService(Scope.Scope, ownedScope),
                  Effect.provideService(McpProviderSessions.McpProviderSessions, mcpSessions),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
                    ...spawner,
                    spawn: () => Effect.die("Managed execution requires its owned transport"),
                    string: () => Effect.die("Managed execution requires its owned transport"),
                  }),
                );
              let lifecycle: OwnedLifecycle | undefined;
              let closeFailed = false;
              let closeOwnedQuery: Claude.ClaudeAgentSdkQuerySession["close"] | undefined;
              let sdkStreamSucceeded = false;
              const instanceId = ProviderInstanceId.make(
                `native_${NodeCrypto.createHash("sha256").update(bound.configuration.connectionID).digest("hex").slice(0, 56)}`,
              );
              const adapter =
                intent.configuration.provider === "codex"
                  ? yield* isolate(
                      Codex.makeCodexAdapterV2({
                        instanceId,
                        settings: decodeCodex({
                          setupMode: "existing",
                          binaryPath: bound.executablePath,
                          homePath: bound.profile.profileDirectory,
                          launchArgs: "",
                        }),
                        environment,
                        crypto,
                        fileSystem: fs,
                        idAllocator: allocator,
                        serverConfig: config,
                        clientFactory: {
                          open: Effect.fn("ManagedExecutionProvider.openCodex")(
                            function* (input) {
                              yield* checkedStart;
                              const owned = yield* transports!.codex!.open(input, bound);
                              lifecycle = owned;
                              const request: typeof owned.client.request = (method, payload) =>
                                method === "turn/start"
                                  ? checkedStart.pipe(
                                      Effect.mapError(
                                        () =>
                                          new CodexError.CodexAppServerRequestError({
                                            code: -32001,
                                            errorMessage: "Native execution start denied",
                                            method: "turn/start",
                                          }),
                                      ),
                                      Effect.andThen(owned.client.request(method, payload)),
                                    )
                                  : owned.client.request(method, payload);
                              return { ...owned.client, request };
                            },
                            (effect, input) =>
                              effect.pipe(
                                Effect.mapError(
                                  (cause) =>
                                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                                      driver: Codex.CODEX_DRIVER_KIND,
                                      providerSessionId: input.providerSessionId,
                                      cause,
                                    }),
                                ),
                              ),
                          ),
                        },
                      }),
                    )
                  : yield* isolate(
                      Claude.makeClaudeAdapterV2({
                        instanceId,
                        settings: decodeClaude({
                          binaryPath: bound.executablePath,
                          homePath: bound.profile.profileDirectory,
                          launchArgs: "",
                        }),
                        environment,
                        attachmentsDir: path.join(root, ".texos-attachments"),
                        fileSystem: fs,
                        path,
                        crypto,
                        idAllocator: allocator,
                        queryRunner: {
                          allocateSessionId: transports!.claude!.allocateSessionId(bound),
                          open: Effect.fn("ManagedExecutionProvider.openClaude")(
                            function* (input) {
                              yield* checkedStart;
                              const owned = yield* transports!.claude!.open(
                                {
                                  ...input,
                                  options: {
                                    ...input.options,
                                    model: bound.configuration.modelID,
                                    env: environment,
                                    settingSources: [],
                                    settings: { env: {} },
                                    extraArgs: {},
                                    mcpServers: {},
                                    permissionMode: "default",
                                    allowDangerouslySkipPermissions: false,
                                  },
                                },
                                bound,
                              );
                              lifecycle = owned;
                              closeOwnedQuery = owned.query.close.pipe(
                                Effect.tapError(() =>
                                  Effect.sync(() => {
                                    closeFailed = true;
                                    publish({ closeAndJoin: "unknown" });
                                  }),
                                ),
                              );
                              return {
                                ...owned.query,
                                offer: (
                                  message: Parameters<
                                    Claude.ClaudeAgentSdkQuerySession["offer"]
                                  >[0],
                                  onQueued?: () => void,
                                ) =>
                                  checkedStart.pipe(
                                    Effect.andThen(owned.query.offer(message, onQueued)),
                                    Effect.mapError(
                                      (cause) =>
                                        new Claude.ClaudeAgentSdkQueryRunnerError({
                                          method: "offer",
                                          cause,
                                        }),
                                    ),
                                  ),
                                messages: owned.query.messages.pipe(
                                  Stream.onExit((exit) =>
                                    Effect.sync(() => {
                                      sdkStreamSucceeded = Exit.isSuccess(exit);
                                    }),
                                  ),
                                ),
                                close: closeOwnedQuery,
                              };
                            },
                            Effect.mapError(
                              (cause) =>
                                new Claude.ClaudeAgentSdkQueryRunnerError({
                                  method: "open",
                                  cause,
                                }),
                            ),
                          ),
                          forkSession: () => Effect.die("Managed execution does not fork sessions"),
                          subagentLaunchToolUseId: () => Effect.succeed(null),
                          assertComplete: Effect.void,
                        },
                      }),
                    );
              const modelSelection = { instanceId, model: bound.configuration.modelID };
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
              const threadId = ThreadId.make(receipt.t3ThreadID);
              yield* beforeProviderStart;
              runtime = yield* isolate(
                adapter.openSession({
                  threadId,
                  providerSessionId: ProviderSessionId.make(receipt.t3ProviderSessionID),
                  modelSelection,
                  runtimePolicy,
                }),
              );
              providerThread = yield* isolate(
                runtime.ensureThread({ threadId, modelSelection, runtimePolicy }),
              );
              const nativeThreadID = providerThread.nativeThreadRef?.nativeId;
              if (!nativeThreadID)
                return yield* new ExecutionControlError({ code: "managedThreadIdentityMissing" });
              const mappings: {
                providerThreadID: string;
                nativeThreadID: string;
                providerTurnID?: string;
                nativeTurnID?: string;
              } = { providerThreadID: providerThread.id, nativeThreadID };
              yield* recordMappings(mappings);
              const terminal = yield* Deferred.make<void>();
              let eventStreamSucceeded = false;
              yield* runtime.events.pipe(
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.type === "provider_turn.updated") {
                      const turn = event.providerTurn;
                      if (
                        turn.providerThreadId !== mappings.providerThreadID ||
                        turn.runAttemptId !== intent.canonicalAttemptID ||
                        turn.nodeId !== receipt.childID ||
                        (providerTurnID !== undefined && providerTurnID !== turn.id)
                      )
                        return yield* new ExecutionControlError({
                          code: "managedTurnIdentityMismatch",
                        });
                      providerTurnID = turn.id;
                      mappings.providerTurnID = turn.id;
                      if (
                        intent.configuration.provider === "codex" &&
                        turn.nativeTurnRef?.strength === "strong" &&
                        turn.nativeTurnRef.nativeId
                      )
                        mappings.nativeTurnID = turn.nativeTurnRef.nativeId;
                      if (
                        intent.configuration.provider === "claudeCode" &&
                        turn.nativeTurnRef?.nativeId
                      )
                        publish({ assistantCursor: turn.nativeTurnRef.nativeId });
                      yield* recordMappings(mappings);
                    }
                    if (event.type === "turn.terminal") {
                      if (!providerTurnID || event.providerTurnId !== providerTurnID)
                        return yield* new ExecutionControlError({
                          code: "managedTerminalIdentityMismatch",
                        });
                      publish({
                        outcome: event.status === "cancelled" ? "interrupted" : event.status,
                      });
                      yield* Deferred.succeed(terminal, undefined);
                    }
                  }),
                ),
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    eventStreamSucceeded = Exit.isSuccess(exit);
                  }).pipe(Effect.andThen(Deferred.succeed(terminal, undefined))),
                ),
                Effect.forkScoped,
              );
              const now = yield* DateTime.now;
              const appThread: OrchestrationV2AppThread = {
                id: threadId,
                projectId: ProjectId.make(intent.scope.projectID),
                title: "Native admitted execution",
                createdBy: "user",
                creationSource: "web",
                providerInstanceId: instanceId,
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
              if (stopping) return yield* new ExecutionControlError({ code: "executionStopped" });
              yield* beforeProviderStart;
              yield* validateExecutionWorktree(intent.worktree);
              yield* isolate(
                runtime.startTurn({
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
                }),
              );
              yield* Deferred.await(terminal);
              if (closeOwnedQuery) yield* closeOwnedQuery.pipe(Effect.ignore);
              if (lifecycle) {
                const joined = yield* Effect.exit(lifecycle.closeAndJoin);
                if (Exit.isSuccess(joined) && !closeFailed) publish({ closeAndJoin: "observed" });
                const parsed = yield* Effect.exit(lifecycle.transportAndParserDrain);
                if (
                  Exit.isSuccess(parsed) &&
                  (intent.configuration.provider === "codex" || sdkStreamSucceeded)
                )
                  publish({ transportAndParserDrain: "observed" });
                else publish({ outcome: "unknown" });
              }
              // Cancellation/scope finalizers cannot turn the adapter's unbounded event queue into EOF.
              if (eventStreamSucceeded) publish({ adapterEventDrain: "observed" });
              const final = observations.get(intent.commandID)!;
              return {
                mappings,
                drained:
                  final.outcome !== "unknown" &&
                  final.closeAndJoin === "observed" &&
                  final.transportAndParserDrain === "observed" &&
                  final.adapterEventDrain === "observed",
              };
            }),
          ).pipe(
            Effect.mapError(() => new ExecutionControlError({ code: "managedExecutionUncertain" })),
          ),
        };
      },
    ),
  });
});
