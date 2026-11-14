// @effect-diagnostics nodeBuiltinImport:off -- Disposable Git repositories and injected transports only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { texosMissionThreadId } from "@t3tools/shared/texosMission";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Done } from "effect/Cause";
import * as ServerConfig from "../config.ts";
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapter from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeReplayServerConfig } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  ExecutionBinding,
  makeExecutionBinding,
  executionObservationKey,
  ExecutionBindingError,
  type PrivateNativeBindingSource,
} from "./executionBinding.ts";
import * as ReadModel from "./executionReadModel.ts";
import {
  makeExecutableCheck,
  makeManagedExecutionProvider,
  ManagedExecutionProvider,
  OwnedExecutionTransportError,
  type ManagedExecutionTransports,
} from "./executionManaged.ts";
import { makeExecutionControl, type NativeStartAuthorizer } from "./executionControl.ts";
import { ControlledExecutionProvider, ExecutionControlError } from "./executionControl.ts";
import {
  executionEnvelope,
  MANAGED_EXECUTION_CAPABILITY,
  type ExecutionIntent,
} from "./executionProtocol.ts";
import * as Receipts from "./executionReceipts.ts";
import {
  MANAGED_CODEX_DISABLED_FEATURES,
  managedCodexLaunchArgs,
} from "./executionCodexProfile.ts";
import {
  syntheticCodexRestrictions,
  syntheticBinding,
  syntheticIntent,
  syntheticRequest,
  syntheticAuthorization,
  executionReceiptMigrations as Migration,
} from "./execution.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(async () => ({
    effective: {
      env: {
        ANTHROPIC_API_KEY: "synthetic-unapproved",
        ANTHROPIC_BASE_URL: "https://synthetic.invalid",
      },
    },
    provenance: {},
    sources: [],
  })),
  query: () => {
    throw new Error("Real Claude query forbidden");
  },
  forkSession: () => {
    throw new Error("Real Claude fork forbidden");
  },
}));

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
const nativeSession = "00000000-0000-4000-8000-000000000101";
const cursor = "00000000-0000-4000-8000-000000000202";
const assistant: SDKMessage = {
  type: "assistant",
  uuid: cursor,
  session_id: nativeSession,
  parent_tool_use_id: null,
  message: {
    id: "msg_synthetic",
    model: "claude-sonnet-4-6",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Synthetic edit", citations: null }],
    stop_reason: null,
    stop_sequence: null,
    container: null,
    context_management: null,
    stop_details: null,
    usage,
  },
};
const result: SDKMessage = {
  type: "result",
  subtype: "success",
  uuid: "00000000-0000-4000-8000-000000000301",
  session_id: nativeSession,
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: "Synthetic edit",
  stop_reason: "end_turn",
  terminal_reason: "completed",
  total_cost_usd: 0,
  usage,
  modelUsage: {},
  permission_denials: [],
};

/** The effective configuration a managed Codex launch reports through `config/read`. */
function managedConfiguration(model: string) {
  return {
    model,
    model_provider: "openai",
    forced_login_method: "chatgpt",
    cli_auth_credentials_store: "file",
    forced_chatgpt_workspace_id: [syntheticCodexRestrictions.chatgptWorkspaceID],
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: {
      network_access: false,
      exclude_slash_tmp: true,
      exclude_tmpdir_env_var: true,
    },
    web_search: "disabled",
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    notify: [],
    allow_login_shell: false,
    history: { persistence: "none" },
    analytics: { enabled: false },
    agents: { enabled: false },
    tools: { experimental_request_user_input: { enabled: false } },
    include_permissions_instructions: false,
    include_collaboration_mode_instructions: false,
    include_apps_instructions: false,
    include_environment_context: false,
    skills: { include_instructions: false, bundled: { enabled: false } },
    orchestrator: { skills: { enabled: false } },
    mcp_servers: {},
    model_providers: {},
    features: Object.fromEntries(MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false])),
  };
}

type CodexFault =
  | "configuration"
  | "approvalRequest"
  | "toolCall"
  | "unknownRequest"
  | "undecodableRequest";

// Requests Codex might send mid-turn; a managed run answers each with a refusal and ends.
const codexRequests = {
  approvalRequest: {
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "controlled-native-thread",
      turnId: "controlled-native-turn",
      itemId: "synthetic-patch",
      reason: "Synthetic write outside the folder",
    },
  },
  toolCall: {
    method: "item/tool/call",
    params: {
      threadId: "controlled-native-thread",
      turnId: "controlled-native-turn",
      callId: "synthetic-call",
      tool: "synthetic_tool",
      arguments: {},
    },
  },
  unknownRequest: { method: "synthetic/unknownRequest", params: {} },
  // No callId: it fails to decode, so no handler runs and only the request stream sees it.
  undecodableRequest: {
    method: "item/tool/call",
    params: {
      threadId: "controlled-native-thread",
      turnId: "controlled-native-turn",
      tool: "synthetic_tool",
      arguments: {},
    },
  },
} as const;

const codexRefusals: Record<keyof typeof codexRequests, object> = {
  approvalRequest: { code: -32001, message: "Refused by native execution" },
  toolCall: { code: -32001, message: "Refused by native execution" },
  unknownRequest: { code: -32001, message: "Refused by native execution" },
  undecodableRequest: {
    code: -32602,
    message: "Invalid payload for method 'item/tool/call' during 'decode-payload'",
    data: {
      issueCount: 3,
      issueKinds: ["Composite", "Pointer", "MissingKey"],
      maximumPathDepth: 1,
    },
  },
};

function codexTranscript(
  intent: ExecutionIntent,
  fault?: CodexFault,
): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: "managed-private-admission",
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
      ...managedProfileCheck(intent, 2, fault),
      ...(fault === "configuration"
        ? []
        : ([
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "thread/start",
                params: {
                  cwd: intent.worktree.root,
                  model: intent.configuration.modelID,
                  config: CodexAdapter.CODEX_THREAD_CONFIG,
                  developerInstructions: syntheticCodexRestrictions.developerInstructions,
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                id: 4,
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
                  approvalPolicy: "never",
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
            ...managedProfileCheck(intent, 5),
            ...codexTurn(intent, fault),
          ] as const)),
    ],
  };
}

/** The effective-configuration and MCP check, before the thread and again before the turn. */
function managedProfileCheck(
  intent: ExecutionIntent,
  id: number,
  fault?: CodexFault,
): CodexReplay.CodexAppServerReplayTranscript["entries"] {
  return [
    {
      type: "expect_outbound",
      frame: {
        id,
        method: "config/read",
        params: { cwd: intent.worktree.root, includeLayers: false },
      },
    },
    {
      type: "emit_inbound",
      frame: {
        id,
        result: {
          config: {
            ...managedConfiguration(intent.configuration.modelID),
            ...(fault === "configuration"
              ? {
                  features: {
                    ...managedConfiguration(intent.configuration.modelID).features,
                    shell_tool: true,
                  },
                }
              : {}),
          },
          origins: {},
        },
      },
    },
    ...(fault === "configuration"
      ? []
      : ([
          {
            type: "expect_outbound",
            frame: { id: id + 1, method: "mcpServerStatus/list", params: { limit: 256 } },
          },
          { type: "emit_inbound", frame: { id: id + 1, result: { data: [], nextCursor: null } } },
        ] as const)),
  ];
}

function codexTurn(
  intent: ExecutionIntent,
  fault: CodexFault | undefined,
): CodexReplay.CodexAppServerReplayTranscript["entries"] {
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
  const started = { threadId: "controlled-native-thread", turn: turn("inProgress") };
  return [
    {
      type: "expect_outbound",
      frame: {
        id: 7,
        method: "turn/start",
        params: {
          threadId: "controlled-native-thread",
          input: [{ type: "text", text: intent.input }],
          cwd: intent.worktree.root,
          model: intent.configuration.modelID,
          approvalPolicy: "never",
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
    { type: "emit_inbound", frame: { id: 7, result: { turn: turn("inProgress") } } },
    ...(fault !== undefined && fault !== "configuration"
      ? ([
          { type: "emit_inbound", frame: { method: "turn/started", params: started } },
          { type: "emit_inbound", frame: { id: 77, ...codexRequests[fault] } },
          { type: "expect_outbound", frame: { id: 77, error: codexRefusals[fault] } },
        ] as const)
      : ([
          {
            type: "emit_inbound",
            label: "edit",
            frame: { method: "turn/started", params: started },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "item/completed",
              params: {
                threadId: "controlled-native-thread",
                turnId: "controlled-native-turn",
                completedAtMs: 2,
                item: { type: "agentMessage", id: "answer-item", text: CODEX_ANSWER },
              },
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
        ] as const)),
  ];
}

const CODEX_ANSWER = 'Wrote answer.ts: "42" 😀';

const database = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const receipts = Receipts.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(Migration).pipe(Layer.provideMerge(database))),
);
const layers = Layer.mergeAll(
  receipts,
  IdAllocator.layer,
  McpProviderSessions.layer,
  NodeServices.layer,
);

const setup = Effect.fn("ManagedExecutionTest.setup")(function* (
  provider: "codex" | "claudeCode",
  fault?:
    | "close"
    | "parser"
    | "ignored-sdk-close"
    | "profile"
    | "executable"
    | "stream"
    | "interrupt"
    | CodexFault,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "texos-managed-" });
  const root = yield* Effect.promise(() => NodeFSP.realpath(temporary));
  const template = NodePath.join(root, "empty-template");
  const profileDirectory = NodePath.join(root, "fixture-profile");
  const homeDirectory = NodePath.join(root, "fixture-home");
  for (const dir of [template, profileDirectory, homeDirectory]) yield* fs.makeDirectory(dir);
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
  const answer = NodePath.join(root, "answer.ts");
  yield* fs.writeFileString(answer, "export const answer = 0;\n");
  const executableBytes = "synthetic executable sentinel; never launched\n";
  yield* fs.writeFileString(NodePath.join(root, "not-an-executable"), executableBytes);
  const stat = yield* Effect.promise(() => NodeFSP.stat(root, { bigint: true }));
  const original = syntheticIntent(root);
  const intent: ExecutionIntent = {
    ...original,
    configuration: {
      ...original.configuration,
      provider,
      modelID: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
    },
    worktree: { ...original.worktree, device: String(stat.dev), inode: String(stat.ino) },
  };
  const store = yield* Receipts.ExecutionReceipts;
  let reads = 0;
  let access = 0;
  let opens = 0;
  let edits = 0;
  let joins = 0;
  const source: PrivateNativeBindingSource = {
    readRetained: (key) =>
      Effect.gen(function* () {
        reads++;
        const saved = yield* store
          .get(key.commandID, key.envelopeDigest, intent.scope.authorityID)
          .pipe(Effect.mapError(() => new ExecutionBindingError({ code: "receiptUnavailable" })));
        if (!saved) return undefined;
        return {
          admission: { ...executionObservationKey(saved), intent },
          connection: intent.configuration,
          account: {
            id: intent.configuration.accountBindingID,
            generation: "1",
            route: "cli-subscription" as const,
          },
          profile: {
            id: intent.configuration.runtimeProfileID,
            revision: "1",
            accountBindingID: intent.configuration.accountBindingID,
            accountBindingGeneration: "1",
          },
          executable: {
            path: NodePath.join(root, "not-an-executable"),
            sha256:
              fault === "executable"
                ? "1".repeat(64)
                : NodeCrypto.createHash("sha256").update(executableBytes).digest("hex"),
            profileID: intent.configuration.runtimeProfileID,
            profileRevision: "1",
          },
          model: { id: intent.configuration.modelID, provider },
          ...(provider === "codex" ? { codex: syntheticCodexRestrictions } : {}),
          acquirePermittedProfile:
            fault === "profile"
              ? Effect.fail(new ExecutionBindingError({ code: "profileAccessDenied" }))
              : Effect.sync(() => {
                  access++;
                  return {
                    profileID: intent.configuration.runtimeProfileID,
                    profileRevision: "1",
                    accountBindingID: intent.configuration.accountBindingID,
                    accountBindingGeneration: "1",
                    homeDirectory,
                    profileDirectory,
                    environment: {},
                  };
                }),
        };
      }),
  };
  const edit = Effect.fn("ManagedExecutionTest.edit")(function* () {
    assert.equal(edits, 0);
    assert.equal(yield* fs.readFileString(answer), "export const answer = 0;\n");
    yield* fs.writeFileString(answer, "export const answer = 42;\n");
    edits++;
  });
  const sdkFrames = yield* Queue.unbounded<SDKMessage, Done>();
  const sdkDrain = yield* Deferred.make<void, OwnedExecutionTransportError>();
  const edited = yield* Deferred.make<void>();
  const mappedTurn = yield* Deferred.make<void>();
  const joined = Effect.gen(function* () {
    joins++;
    yield* Queue.end(sdkFrames);
    if (fault === "close")
      return yield* new OwnedExecutionTransportError({ operation: "closeAndJoin" });
  });
  const transports: ManagedExecutionTransports = {
    codex: {
      open: (input) =>
        Effect.gen(function* () {
          opens++;
          assert.equal(input.settings.setupMode, "existing");
          assert.equal(input.settings.homePath, profileDirectory);
          assert.equal(input.settings.binaryPath, NodePath.join(root, "not-an-executable"));
          assert.equal(
            input.settings.launchArgs,
            managedCodexLaunchArgs(intent.configuration.modelID, syntheticCodexRestrictions),
          );
          assert.deepEqual(input.environment, {
            HOME: homeDirectory,
            CODEX_HOME: profileDirectory,
          });
          const transcript = codexTranscript(
            intent,
            fault === "configuration" || (fault !== undefined && fault in codexRequests)
              ? (fault as CodexFault)
              : undefined,
          );
          const driver = yield* CodexReplay.makeReplayDriver(transcript, {
            beforeEmitInbound: (entry) =>
              entry.label === "edit" ? edit().pipe(Effect.orDie) : Effect.void,
          });
          const handle = yield* CodexReplay.makeReplayChildProcess(driver);
          const context = yield* Layer.build(
            CodexClient.layerChildProcess(handle, { observeOwnedInput: true }),
          );
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          return {
            client,
            closeAndJoin: joined,
            transportAndParserDrain: Effect.gen(function* () {
              if (fault === "parser")
                return yield* new OwnedExecutionTransportError({ operation: "parser" });
              const state = yield* Ref.get(driver.state);
              assert.equal(state.failure, null);
              assert.equal(state.cursor, transcript.entries.length);
            }),
          };
        }).pipe(
          Effect.mapError(() => new OwnedExecutionTransportError({ operation: "openCodex" })),
        ),
    },
    claude: {
      allocateSessionId: () => Effect.succeed(nativeSession),
      open: (input) =>
        Effect.sync(() => {
          opens++;
          assert.equal(input.options.model, intent.configuration.modelID);
          assert.equal(
            input.options.pathToClaudeCodeExecutable,
            NodePath.join(root, "not-an-executable"),
          );
          assert.equal(input.options.cwd, root);
          assert.deepEqual(input.options.settingSources, []);
          assert.deepEqual(input.options.settings, { env: {} });
          assert.deepEqual(input.options.extraArgs, {});
          assert.deepEqual(input.options.mcpServers, {});
          assert.deepEqual(input.options.env, {
            HOME: homeDirectory,
            CLAUDE_CONFIG_DIR: profileDirectory,
          });
          return {
            closeAndJoin: joined,
            transportAndParserDrain:
              fault === "parser"
                ? Effect.fail(new OwnedExecutionTransportError({ operation: "parser" }))
                : Deferred.await(sdkDrain),
            query: {
              messages: Stream.fromQueue(sdkFrames).pipe(
                Stream.concat(
                  fault === "stream"
                    ? Stream.fail(
                        new ClaudeAdapter.ClaudeAgentSdkQueryRunnerError({
                          method: "messages",
                          cause: new Error("Synthetic SDK stream lost"),
                        }),
                      )
                    : Stream.empty,
                ),
                Stream.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Deferred.succeed(sdkDrain, undefined)
                    : Deferred.fail(
                        sdkDrain,
                        new OwnedExecutionTransportError({ operation: "stream" }),
                      ),
                ),
              ),
              offer: (_message, onQueued) =>
                Effect.gen(function* () {
                  onQueued?.();
                  yield* edit().pipe(Effect.orDie);
                  yield* Deferred.succeed(edited, undefined);
                  yield* Queue.offer(sdkFrames, assistant);
                  if (fault === "stream") yield* Queue.end(sdkFrames);
                  else if (fault !== "interrupt") yield* Queue.offer(sdkFrames, result);
                }),
              setModel: () => Effect.die("No model fallback"),
              applyFlagSettings: () => Effect.die("No profile fallback"),
              setPermissionMode: () => Effect.die("No policy fallback"),
              stopTask: () => Effect.die("No background task"),
              backgroundTasks: () => Effect.succeed(false),
              interrupt: Effect.void,
              close:
                fault === "ignored-sdk-close"
                  ? Effect.fail(
                      new ClaudeAdapter.ClaudeAgentSdkQueryRunnerError({
                        method: "close",
                        cause: new Error("synthetic close failure"),
                      }),
                    )
                  : Queue.end(sdkFrames).pipe(Effect.asVoid),
            },
          };
        }),
    },
  };
  const config = { ...(yield* makeReplayServerConfig("managed-execution")), cwd: root };
  yield* Effect.addFinalizer(() =>
    fs.remove(config.baseDir, { recursive: true }).pipe(Effect.ignore),
  );
  const actual = yield* makeManagedExecutionProvider(transports).pipe(
    Effect.provideService(ExecutionBinding, makeExecutionBinding(source)),
    Effect.provideService(ServerConfig.ServerConfig, config),
  );
  const outcomes: Array<{ readonly drained: boolean }> = [];
  const managed = {
    ...actual,
    create: (...args: Parameters<typeof actual.create>) =>
      actual
        .create(args[0], args[1], (patch) =>
          args[2](patch).pipe(
            Effect.andThen(
              patch.providerTurnID ? Deferred.succeed(mappedTurn, undefined) : Effect.void,
            ),
          ),
        )
        .pipe(
          Effect.map((attempt) => ({
            ...attempt,
            run: attempt.run.pipe(
              Effect.tap((outcome) =>
                Effect.sync(() => {
                  outcomes.push(outcome);
                }),
              ),
            ),
          })),
        ),
  };
  const now = yield* Clock.currentTimeMillis;
  const authorize: NativeStartAuthorizer = async (key) => ({
    ...syntheticAuthorization(intent, now),
    runtimeID: key.runtimeID,
    childID: key.childID,
  });
  return {
    root,
    intent,
    managed,
    authorize,
    source,
    config,
    outcomes,
    edited,
    mappedTurn,
    counts: () => ({ reads, access, opens, edits, joins }),
    readAnswer: fs.readFileString(answer),
    stored: store.get(intent.commandID, executionEnvelope(intent).digest, intent.scope.authorityID),
  };
});

describe("control through private binding and actual managed lower adapters", () => {
  it.effect(
    "an SDK read failure retains unknown outcome despite an adapter-synthesized terminal",
    () =>
      Effect.gen(function* () {
        const f = yield* setup("claudeCode", "stream");
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        yield* control.awaitAttempt(f.intent.commandID);
        assert.equal(f.counts().edits, 1);
        assert.lengthOf(f.outcomes, 1);
        assert.equal((yield* f.stored)?.phase, "uncertain");
        assert.equal(f.managed.observation(f.intent.commandID)?.outcome, "unknown");
        assert.equal(f.managed.observation(f.intent.commandID)?.transportAndParserDrain, "unknown");
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        assert.equal(f.counts().edits, 1);
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect(
    "a control stop reaches the owned Claude query but cannot turn cancellation into event drain",
    () =>
      Effect.gen(function* () {
        const f = yield* setup("claudeCode", "interrupt");
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        yield* Deferred.await(f.edited);
        yield* Deferred.await(f.mappedTurn);
        yield* control.handle(
          syntheticRequest("execution.stop", {
            commandID: f.intent.commandID,
            envelopeDigest: executionEnvelope(f.intent).digest,
          }),
          f.authorize,
        );
        yield* control.awaitAttempt(f.intent.commandID);
        assert.equal(f.counts().edits, 1);
        assert.lengthOf(f.outcomes, 1);
        assert.equal((yield* f.stored)?.phase, "uncertain");
        assert.equal(f.managed.observation(f.intent.commandID)?.adapterEventDrain, "unknown");
        assert.notEqual(f.managed.observation(f.intent.commandID)?.outcome, "completed");
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );
  it.effect.each([
    "configuration",
    "approvalRequest",
    "toolCall",
    "unknownRequest",
    "undecodableRequest",
  ] as const)(
    "a managed Codex run refused for %s never settles and leaves the file alone",
    (fault) =>
      Effect.gen(function* () {
        const f = yield* setup("codex", fault);
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        yield* control.awaitAttempt(f.intent.commandID);
        const saved = yield* f.stored;
        assert.equal(yield* f.readAnswer, "export const answer = 0;\n");
        assert.equal(f.counts().edits, 0);
        assert.equal(f.counts().opens, 1);
        assert.equal(saved?.phase, "uncertain");
        assert.isUndefined(saved?.finish);
        assert.notEqual(f.managed.observation(f.intent.commandID)?.outcome, "completed");
        // A configuration that isn't the managed profile is refused before the thread starts.
        if (fault === "configuration") assert.deepEqual(saved?.mappings, {});
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect.each(["codex", "claudeCode"] as const)(
    "%s edits once through its actual adapter; only an owned drain proof settles the attempt",
    (provider) =>
      Effect.gen(function* () {
        const f = yield* setup(provider);
        assert.deepEqual(f.counts(), { reads: 0, access: 0, opens: 0, edits: 0, joins: 0 });
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        const now = yield* Clock.currentTimeMillis;
        const currentNative: NativeStartAuthorizer = async (key) => ({
          ...syntheticAuthorization(f.intent, now),
          runtimeID: key.runtimeID,
          childID: key.childID,
          currentConfigurationRevision: "2",
        });
        const hello = yield* control.handle(
          syntheticRequest("execution.hello", { capabilities: [] }),
          currentNative,
        );
        assert.deepEqual("capabilities" in hello ? hello.capabilities : [], [
          MANAGED_EXECUTION_CAPABILITY,
        ]);
        yield* control.handle(syntheticRequest("execution.admit", f.intent), currentNative);
        yield* control.awaitAttempt(f.intent.commandID);
        const saved = yield* f.stored;
        assert.equal(yield* f.readAnswer, "export const answer = 42;\n");
        assert.equal(f.counts().edits, 1);
        assert.equal(f.counts().opens, 1);
        assert.lengthOf(f.outcomes, 1, "the actual wrapper must return, not fail into uncertainty");
        // Codex runs owned and proves its event prefix; Claude is not owned yet and stays unproven.
        const proven = provider === "codex";
        assert.equal(f.outcomes[0]?.drained, proven);
        assert.equal(saved?.phase, proven ? "attemptFinished" : "uncertain");
        assert.equal(saved?.drained, proven);
        if (proven)
          assert.deepEqual(saved?.finish, {
            outcome: "completed",
            answer: { text: CODEX_ANSWER, truncated: false },
          });
        else assert.isUndefined(saved?.finish);
        assert.isString(saved?.mappings.providerThreadID);
        assert.isString(saved?.mappings.providerTurnID);
        const observation = f.managed.observation(f.intent.commandID);
        assert.equal(observation?.outcome, "completed");
        assert.equal(observation?.closeAndJoin, "observed");
        assert.equal(observation?.transportAndParserDrain, "observed");
        assert.equal(observation?.adapterEventDrain, proven ? "observed" : "unknown");
        if (provider === "claudeCode") {
          assert.equal(saved?.mappings.nativeThreadID, nativeSession);
          assert.isUndefined(saved?.mappings.nativeTurnID);
          assert.notEqual(saved?.mappings.providerTurnID, cursor);
          assert.equal(observation?.assistantCursor, cursor);
        } else assert.equal(saved?.mappings.nativeTurnID, "controlled-native-turn");
        let fixtureFactories = 0;
        const oldMode = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ControlledExecutionProvider, {
            mode: "controlled-codex",
            create: () =>
              Effect.sync(() => {
                fixtureFactories++;
              }).pipe(
                Effect.andThen(Effect.fail(new ExecutionControlError({ code: "mustNotReplay" }))),
              ),
          }),
        );
        const oldView = yield* oldMode.handle(
          syntheticRequest("execution.admit", f.intent),
          currentNative,
        );
        assert.equal("phase" in oldView ? oldView.phase : undefined, saved?.phase);
        assert.equal(fixtureFactories, 0);
        const reopened = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* reopened.handle(syntheticRequest("execution.admit", f.intent), currentNative);
        assert.equal(f.counts().edits, 1);
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect.each(["codex", "claudeCode"] as const)(
    "%s run is recorded once for the coding view, keyed by the TexOS mission",
    (provider) => {
      const recorded: Array<string> = [];
      const recorder = {
        begin: (input: ReadModel.ManagedRunReadModelStart) =>
          Effect.sync(() => {
            recorded.push(`begin:${input.appThread.id}:${input.attemptId}`);
            return {
              ingest: (event: { readonly type: string }) =>
                Effect.sync(() => void recorded.push(event.type)),
              finish: (outcome: ReadModel.ManagedRunReadModelOutcome) =>
                Effect.sync(() => void recorded.push(`finish:${outcome}`)),
            };
          }),
      };
      return Effect.gen(function* () {
        const f = yield* setup(provider);
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        yield* control.awaitAttempt(f.intent.commandID);
        const threadId = yield* Effect.promise(() =>
          texosMissionThreadId(f.intent.canonicalTaskID, f.intent.canonicalAttemptID),
        );
        assert.equal(recorded[0], `begin:${threadId}:${f.intent.canonicalAttemptID}`);
        assert.include(recorded, "turn.terminal");
        assert.deepEqual(
          recorded.filter((entry) => entry.startsWith("finish:")),
          ["finish:completed"],
        );
      }).pipe(
        Effect.provideService(ReadModel.ManagedRunReadModel, recorder),
        Effect.scoped,
        Effect.provide(layers),
      );
    },
  );

  it.effect.each(["close", "parser", "ignored-sdk-close"] as const)(
    "Claude %s failure cannot be hidden by scope closure or adapter terminal",
    (fault) =>
      Effect.gen(function* () {
        const f = yield* setup("claudeCode", fault);
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), f.authorize);
        yield* control.awaitAttempt(f.intent.commandID);
        assert.equal(f.counts().edits, 1);
        assert.equal((yield* f.stored)?.phase, "uncertain");
        assert.lengthOf(f.outcomes, 1);
        assert.equal(
          f.managed.observation(f.intent.commandID)?.[
            fault === "parser" ? "transportAndParserDrain" : "closeAndJoin"
          ],
          "unknown",
        );
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect.each(["native", "profile", "before-turn", "before-offer", "executable"] as const)(
    "%s denial prevents the actual turn edit",
    (boundary) =>
      Effect.gen(function* () {
        const f = yield* setup(
          "claudeCode",
          boundary === "profile" ? "profile" : boundary === "executable" ? "executable" : undefined,
        );
        const now = yield* Clock.currentTimeMillis;
        const authorize: NativeStartAuthorizer = async (key) => ({
          ...syntheticAuthorization(f.intent, now),
          runtimeID: key.runtimeID,
          childID: key.childID,
          outcome:
            boundary === "native" ||
            (boundary === "before-turn" && key.nativeThreadID !== undefined) ||
            (boundary === "before-offer" && f.counts().opens > 0)
              ? "deny"
              : "allow",
        });
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ManagedExecutionProvider, f.managed),
        );
        yield* control.handle(syntheticRequest("execution.admit", f.intent), authorize);
        yield* control.awaitAttempt(f.intent.commandID);
        assert.equal(f.counts().edits, 0);
        assert.equal(f.counts().opens, boundary === "before-offer" ? 1 : 0);
        assert.equal(yield* f.readAnswer, "export const answer = 0;\n");
      }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("an absent production supplier stays unavailable without binding/profile reads", () =>
    Effect.gen(function* () {
      const f = yield* setup("claudeCode");
      const provider = yield* makeManagedExecutionProvider().pipe(
        Effect.provideService(ExecutionBinding, makeExecutionBinding(f.source)),
        Effect.provideService(ServerConfig.ServerConfig, f.config),
      );
      const control = yield* makeExecutionControl(syntheticBinding).pipe(
        Effect.provideService(ManagedExecutionProvider, provider),
      );
      const hello = yield* control.handle(
        syntheticRequest("execution.hello", { capabilities: [] }),
        f.authorize,
      );
      assert.deepEqual("capabilities" in hello ? hello.capabilities : [], []);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            control.handle(syntheticRequest("execution.admit", f.intent), f.authorize),
          ),
        ),
      );
      assert.deepEqual(f.counts(), { reads: 0, access: 0, opens: 0, edits: 0, joins: 0 });
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});

describe("managed executable check", () => {
  const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
  const withExecutable = async (run: (path: string) => Promise<void>) => {
    const directory = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "texos-executable-")),
    );
    try {
      const path = NodePath.join(directory, "cli");
      await NodeFSP.writeFile(path, "first build");
      await run(path);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };
  const countingCheck = () => {
    let hashes = 0;
    const check = makeExecutableCheck(async (handle) => {
      hashes++;
      return sha256(String(await handle.readFile()));
    });
    return { check, hashes: () => hashes };
  };

  it("hashes a settled executable once and still refuses a changed one", async () => {
    await withExecutable(async (path) => {
      const f = countingCheck();
      const later = Number.MAX_SAFE_INTEGER;
      await f.check(path, sha256("first build"), later);
      await f.check(path, sha256("first build"), later);
      assert.equal(f.hashes(), 1);
      await NodeFSP.writeFile(path, "a longer second build");
      assert.equal(
        await f.check(path, sha256("first build"), later).then(
          () => "accepted",
          () => "refused",
        ),
        "refused",
      );
      assert.equal(f.hashes(), 2);
    });
  });

  it("hashes a just-changed executable every time, so a same-size rewrite is caught", async () => {
    await withExecutable(async (path) => {
      const f = countingCheck();
      const changedAt = async () => (await NodeFSP.stat(path)).ctimeMs;
      await f.check(path, sha256("first build"), await changedAt());
      await NodeFSP.writeFile(path, "other build");
      assert.equal(
        await f.check(path, sha256("first build"), await changedAt()).then(
          () => "accepted",
          () => "refused",
        ),
        "refused",
      );
      assert.equal(f.hashes(), 2);
    });
  });
});
