// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
  spawnClaudeProcessGroup,
  makeClaudeAdapterV2,
  getClaudeOwnedEventLifecycle,
  CLAUDE_DEFAULT_INSTANCE_ID,
  makeOwnedFrameLines,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
vi.mock("node:child_process", { spy: true });

const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const decodeOwnedClaudeSettings = Schema.decodeEffect(ClaudeSettings);

const writeClaudeSession = Effect.fnUntraced(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
    type: parentUuid === null ? "user" : "assistant",
    uuid,
    parentUuid,
    sessionId: FORK_SESSION_ID,
    cwd: "/repo",
    isSidechain: false,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  });
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    [
      entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
      entry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return projectDir;
});

const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.effect("forks a session stored under the instance's own CLAUDE_CONFIG_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-fork-config-",
      });
      const projectDir = yield* writeClaudeSession(configDir);
      const hostConfigDir = process.env.CLAUDE_CONFIG_DIR;
      const inProcessFork = vi.spyOn(ClaudeSdk, "forkSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-fork-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-config-dir"),
      });

      assert.notEqual(forked.sessionId, FORK_SESSION_ID);
      const transcript = yield* fileSystem.readFileString(
        path.join(projectDir, `${forked.sessionId}.jsonl`),
      );
      assert.include(transcript, '"content":"hello"');
      assert.include(transcript, '"text":"hi"');
      const inheritedHead = transcript
        .trim()
        .split("\n")
        .findLast((line) => line.includes('"type":"assistant"'))
        ?.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
      assert.isString(inheritedHead);
      assert.equal(forked.headMessageId, inheritedHead);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, hostConfigDir);
      assert.equal(inProcessFork.mock.calls.length, 0);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);
const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

const installOwnedSdkFake = Effect.fn("OwnedClaudeTest.installSdkFake")(function* (
  options: {
    readonly closeFails?: boolean;
    readonly spawnTwice?: boolean;
    readonly onPrompt?: (message: ClaudeSdk.SDKUserMessage) => Promise<void>;
  } = {},
) {
  const child = new NodeChildProcess.ChildProcess();
  const stdin = new NodeStream.PassThrough();
  const stdout = new NodeStream.PassThrough();
  child.stdin = stdin;
  child.stdout = stdout;
  const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
    child.emit("exit", null, signal ?? "SIGTERM");
    child.emit("close", null, signal ?? "SIGTERM");
    return true;
  });
  stdin.resume();
  const promptSeen = Promise.withResolvers<ClaudeSdk.SDKUserMessage>();
  const promptEnded = Promise.withResolvers<void>();
  const resultSeen = Promise.withResolvers<void>();
  const controlStarted = Promise.withResolvers<void>();
  const releaseControl = Promise.withResolvers<void>();
  let sdkChild: ClaudeSdk.SpawnedProcess | undefined;
  let nativeSessionId = "owned-sdk-test";
  let closeCalls = 0;
  const spawn = vi.spyOn(NodeChildProcess, "spawn").mockReturnValue(child);
  const sdk = vi
    .spyOn(ClaudeSdk, "query")
    .mockImplementation(({ prompt, options: queryOptions }) => {
      if (typeof prompt === "string") throw Error("Streaming prompt required");
      if (!queryOptions?.spawnClaudeCodeProcess) throw Error("Owned spawn hook required");
      nativeSessionId = queryOptions.sessionId ?? "owned-sdk-test";
      sdkChild = queryOptions.spawnClaudeCodeProcess({
        command: "controlled-fake-only",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      if (options.spawnTwice)
        queryOptions.spawnClaudeCodeProcess({
          command: "second-fake-forbidden",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
      const pipe = sdkChild;
      const messages = (async function* () {
        let buffer = "";
        for await (const chunk of pipe.stdout) {
          buffer += String(chunk);
          for (;;) {
            const i = buffer.indexOf("\n");
            if (i < 0) break;
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            if (!line.trim()) continue;
            const frame = JSON.parse(line) as
              | ClaudeSdk.SDKMessage
              | { type: "control_request"; request_id: string };
            if (frame.type === "control_request") {
              controlStarted.resolve();
              await releaseControl.promise;
              await new Promise<void>((resolve, reject) =>
                pipe.stdin.write(
                  JSON.stringify({
                    type: "control_response",
                    response: {
                      subtype: "success",
                      request_id: frame.request_id,
                      response: { behavior: "allow", updatedInput: {} },
                    },
                  }) + "\n",
                  (error) => (error ? reject(error) : resolve()),
                ),
              );
              continue;
            }
            if (frame.type === "result") resultSeen.resolve();
            yield frame;
          }
        }
      })();
      void (async () => {
        for await (const message of prompt) {
          pipe.stdin.write(JSON.stringify(message) + "\n");
          await options.onPrompt?.(message);
          promptSeen.resolve(message);
        }
        promptEnded.resolve();
        await resultSeen.promise;
        pipe.stdin.end();
      })().catch(() => {});
      return {
        next: messages.next.bind(messages),
        return: messages.return.bind(messages),
        close: () => {
          closeCalls++;
          if (options.closeFails) throw Error("controlled close failure");
        },
        interrupt: async () => {},
        [Symbol.asyncDispose]: async () => {},
      } as unknown as ClaudeSdk.Query;
    });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      releaseControl.resolve();
      resultSeen.resolve();
      stdin.destroy();
      stdout.destroy();
      spawn.mockRestore();
      sdk.mockRestore();
    }),
  );
  const result = () => ({
    type: "result",
    subtype: "success",
    uuid: "00000000-0000-4000-8000-000000000301",
    session_id: nativeSessionId,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "Synthetic answer edited.",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    total_cost_usd: 0,
    usage: {
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
    },
    modelUsage: {},
    permission_denials: [],
  });
  return {
    child,
    stdout,
    promptSeen,
    promptEnded,
    controlStarted,
    releaseControl,
    spawn,
    sdk,
    kill,
    result: () =>
      Effect.sync(() => {
        stdout.write(JSON.stringify(result()) + "\n");
      }),
    endOutput: Effect.sync(() => {
      stdout.end();
    }),
    closeChild: Effect.sync(() => {
      Object.defineProperty(child, "exitCode", { value: 0, configurable: true });
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    }),
    closeCalls: () => closeCalls,
  };
});

const ownedQueryInput = {
  threadId: ThreadId.make("thread-owned-stream"),
  providerSessionId: ProviderSessionId.make("session-owned-stream"),
  options: {
    sessionId: "00000000-0000-4000-8000-000000000101",
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    env: {},
    settingSources: [],
  },
} satisfies ClaudeAgentSdkQueryOpenInput;
const ownedPrompt = {
  type: "user",
  session_id: "00000000-0000-4000-8000-000000000101",
  parent_tool_use_id: null,
  message: { role: "user", content: "Synthetic only" },
} satisfies ClaudeSdk.SDKUserMessage;

describe("owned Claude transport observations", () => {
  it("splits owned SDK frames across chunks and bounds each frame, not each chunk", () => {
    const lines: Array<string> = [];
    const feed = makeOwnedFrameLines(16, (text) => lines.push(text));
    const bytes = new TextEncoder().encode('{"a":"é"}\n{"b":2}\n');
    for (const byte of bytes) feed(Uint8Array.of(byte));
    feed(new TextEncoder().encode("1234567890\nabcdefghij\n"));
    feed();
    assert.deepEqual(lines, ['{"a":"é"}', '{"b":2}', "1234567890", "abcdefghij", ""]);
    const bounded = makeOwnedFrameLines(16, () => {});
    assert.throws(() => {
      for (const byte of new TextEncoder().encode("x".repeat(17))) bounded(Uint8Array.of(byte));
    }, "SDK frame too large");
  });

  it.effect.each(["[]\n", "{}\n", '{"type":"unknown-provider-frame"}\n'])(
    "unsupported JSON SDK input remains unknown: %s",
    (bytes) =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* installOwnedSdkFake();
          const runner = yield* ClaudeAgentSdkQueryRunner;
          assert.ok(runner.openOwned);
          const session = yield* runner.openOwned(ownedQueryInput);
          const owned = session.ownedTransport;
          assert.ok(owned);
          const messages = yield* session.messages.pipe(
            Stream.runDrain,
            Effect.exit,
            Effect.forkScoped,
          );
          f.stdout.write(bytes);
          yield* f.endOutput;
          yield* f.closeChild;
          assert.isTrue(Exit.isFailure(yield* owned.parserDispatch("1 second").pipe(Effect.exit)));
          assert.isTrue(Exit.isFailure(yield* Fiber.join(messages)));
        }).pipe(Effect.provide(realQueryRunner)),
      ),
  );

  it.effect(
    "a second SDK child is rejected before spawn and failed-open cleanup remains unknown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* installOwnedSdkFake({ spawnTwice: true });
          const runner = yield* ClaudeAgentSdkQueryRunner;
          assert.ok(runner.openOwned);
          const result = yield* runner.openOwned(ownedQueryInput).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          assert.equal(f.spawn.mock.calls.length, 1);
          assert.deepEqual(f.kill.mock.calls, [["SIGKILL"]]);
          assert.equal(f.sdk.mock.calls.length, 1);
        }).pipe(Effect.provide(realQueryRunner)),
      ),
  );

  it.effect("fatal UTF8 validation cannot qualify a parser after physical stdout EOF", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const session = yield* runner.openOwned(ownedQueryInput);
        const owned = session.ownedTransport;
        assert.ok(owned);
        const messages = yield* session.messages.pipe(
          Stream.runDrain,
          Effect.exit,
          Effect.forkScoped,
        );
        f.stdout.write(new Uint8Array([0xe2, 0x82]));
        yield* f.endOutput;
        yield* f.closeChild;
        yield* owned.inputEOF("1 second");
        assert.isTrue(Exit.isFailure(yield* owned.parserDispatch("1 second").pipe(Effect.exit)));
        assert.isTrue(Exit.isFailure(yield* Fiber.join(messages)));
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );

  it.effect.each([
    { refusedStop: false, name: "after one repository edit" },
    { refusedStop: true, name: "after a refused stop for a turn that is not active" },
  ])(
    "actual Claude adapter joins a fake owned child and actual consumer $name",
    ({ refusedStop }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "owned-claude-adapter-" });
          const profile = path.join(root, "profile");
          yield* fs.makeDirectory(profile);
          const answer = path.join(root, "answer.ts");
          yield* fs.writeFileString(answer, "export const answer = 0;\n");
          NodeChildProcess.execFileSync("/usr/bin/git", ["init", root], { stdio: "ignore" });
          let edits = 0;
          const f = yield* installOwnedSdkFake({
            onPrompt: async () => {
              assert.equal(edits++, 0);
              NodeFS.writeFileSync(answer, "export const answer = 42;\n");
            },
          });
          const adapter = yield* makeClaudeAdapterV2({
            ownedEvents: true,
            instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
            settings: yield* decodeOwnedClaudeSettings({
              binaryPath: path.join(root, "not-an-executable"),
              homePath: profile,
              launchArgs: "",
            }),
            environment: {},
            attachmentsDir: path.join(root, "attachments"),
            fileSystem: fs,
            path,
            crypto: yield* Crypto.Crypto,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            queryRunner: yield* ClaudeAgentSdkQueryRunner,
          });
          const threadId = ThreadId.make("owned-adapter-thread");
          const modelSelection = {
            instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
            model: "claude-sonnet-4-6",
          };
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: root,
          });
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("owned-adapter-session"),
            modelSelection,
            runtimePolicy,
          });
          const consumer = runtime.ownedEventConsumer;
          assert.ok(consumer);
          assert.equal(getClaudeOwnedEventLifecycle(runtime), undefined);
          const eventSeen = yield* Deferred.make<void>();
          const releaseHandler = yield* Deferred.make<void>();
          const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
          yield* consumer
            .consume((event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(
                Effect.andThen(Deferred.succeed(eventSeen, undefined)),
                Effect.andThen(Deferred.await(releaseHandler)),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* consumer.started;
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          const now = yield* DateTime.now;
          const appThread: OrchestrationV2AppThread = {
            id: threadId,
            projectId: ProjectId.make("owned-adapter-project"),
            title: "Owned fake test",
            createdBy: "user",
            creationSource: "web",
            providerInstanceId: CLAUDE_DEFAULT_INSTANCE_ID,
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
          yield* runtime.startTurn({
            appThread,
            threadId,
            runId: RunId.make("owned-adapter-run"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("owned-adapter-attempt"),
            rootNodeId: NodeId.make("owned-adapter-node"),
            providerThread,
            message: {
              messageId: MessageId.make("owned-adapter-message"),
              text: "Edit only answer.ts",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection,
            runtimePolicy,
          });
          yield* Effect.promise(() => f.promptSeen.promise);
          assert.equal(edits, 1);
          assert.equal(yield* fs.readFileString(answer), "export const answer = 42;\n");
          if (refusedStop) {
            const refused = yield* runtime
              .interruptTurn({
                providerThread,
                providerTurnId: ProviderTurnId.make("owned-adapter-finished-turn"),
              })
              .pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(refused));
          }
          const observation = getClaudeOwnedEventLifecycle(runtime);
          assert.ok(observation);
          assert.equal(getClaudeOwnedEventLifecycle({ ...runtime }), undefined);
          const sealing = yield* observation.seal("1 second").pipe(Effect.forkScoped);
          yield* Effect.promise(() => f.promptEnded.promise);
          yield* f.result();
          yield* f.endOutput;
          assert.equal(sealing.pollUnsafe(), undefined);
          yield* f.closeChild;
          const fence = yield* Fiber.join(sealing);
          yield* Deferred.await(eventSeen);
          const waiting = yield* consumer
            .awaitPrefix(observation.generation, fence, { timeout: "1 second" })
            .pipe(Effect.forkScoped);
          assert.equal(waiting.pollUnsafe(), undefined);
          yield* Deferred.succeed(releaseHandler, undefined);
          const proof = yield* Fiber.join(waiting);
          const prefix = yield* consumer.inspect(observation.generation, fence, proof);
          assert.isAbove(prefix.highWater, 0);
          assert.isTrue(events.some((event) => event.type === "turn.terminal"));
          const turns = events.filter((event) => event.type === "provider_turn.updated");
          assert.isAbove(turns.length, 0);
          assert.equal(f.sdk.mock.calls.length, 1);
          assert.equal(f.spawn.mock.calls.length, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              realQueryRunner,
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
            ),
          ),
        ),
      ),
  );

  it.effect("joins natural prompt, real forwarding/parser and child close independently", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const session = yield* runner.openOwned(ownedQueryInput);
        const owned = session.ownedTransport;
        assert.ok(owned);
        assert.strictEqual(yield* owned.transport("1 second"), f.child);
        const messages = yield* session.messages.pipe(Stream.runCollect, Effect.forkScoped);
        yield* session.offer(ownedPrompt);
        yield* Effect.promise(() => f.promptSeen.promise);
        yield* owned.finishInput;
        yield* Effect.promise(() => f.promptEnded.promise);
        yield* owned.promptEOF("1 second");
        yield* f.result();
        yield* f.endOutput;
        yield* owned.providerInput("1 second");
        yield* owned.inputEOF("1 second");
        yield* owned.parserDispatch("1 second");
        yield* owned.callbacks("1 second");
        const closing = yield* owned.childClose("1 second").pipe(Effect.forkScoped);
        assert.equal(closing.pollUnsafe(), undefined);
        yield* f.closeChild;
        assert.deepEqual(yield* Fiber.join(closing), { code: 0, signal: null });
        assert.equal((yield* Fiber.join(messages)).length, 1);
        assert.equal(f.closeCalls(), 0);
        assert.equal(f.spawn.mock.calls.length, 1);
        assert.equal(f.sdk.mock.calls.length, 1);
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );

  it.effect("a pending control request cannot become a callback-drain fact at pipe EOF", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const session = yield* runner.openOwned(ownedQueryInput);
        const owned = session.ownedTransport;
        assert.ok(owned);
        const messages = yield* session.messages.pipe(Stream.runDrain, Effect.forkScoped);
        yield* session.offer(ownedPrompt);
        yield* Effect.promise(() => f.promptSeen.promise);
        f.stdout.write(
          JSON.stringify({
            type: "control_request",
            request_id: "owned-request",
            request: { subtype: "can_use_tool" },
          }) + "\n",
        );
        yield* Effect.promise(() => f.controlStarted.promise);
        const joining = yield* owned.callbacks("1 second").pipe(Effect.forkScoped);
        assert.equal(joining.pollUnsafe(), undefined);
        f.releaseControl.resolve();
        yield* f.result();
        yield* owned.finishInput;
        yield* f.endOutput;
        yield* f.closeChild;
        yield* Fiber.join(joining);
        yield* owned.parserDispatch("1 second");
        yield* Fiber.join(messages);
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );

  it.effect("consumer take-one cancellation is not natural SDK iteration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const session = yield* runner.openOwned(ownedQueryInput);
        const owned = session.ownedTransport;
        assert.ok(owned);
        const messages = yield* session.messages.pipe(
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* session.offer(ownedPrompt);
        yield* Effect.promise(() => f.promptSeen.promise);
        yield* owned.finishInput;
        yield* f.result();
        yield* Fiber.join(messages);
        yield* f.endOutput;
        yield* f.closeChild;
        assert.isTrue(Exit.isFailure(yield* owned.parserDispatch("1 second").pipe(Effect.exit)));
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );

  it.effect("an ignored Query.close failure cannot later qualify parser completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake({ closeFails: true });
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const session = yield* runner.openOwned(ownedQueryInput);
        const owned = session.ownedTransport;
        assert.ok(owned);
        yield* session.close.pipe(Effect.ignore);
        yield* f.endOutput;
        yield* f.closeChild;
        assert.equal(f.closeCalls(), 1);
        assert.isTrue(Exit.isFailure(yield* owned.parserDispatch("1 second").pipe(Effect.exit)));
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );

  it.effect("unobserved custom spawn is rejected before SDK query creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* installOwnedSdkFake();
        const runner = yield* ClaudeAgentSdkQueryRunner;
        assert.ok(runner.openOwned);
        const result = yield* runner
          .openOwned({
            ...ownedQueryInput,
            options: {
              ...ownedQueryInput.options,
              spawnClaudeCodeProcess: () => {
                throw Error("must not open");
              },
            },
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        assert.equal(f.sdk.mock.calls.length, 0);
        assert.equal(f.spawn.mock.calls.length, 0);
      }).pipe(Effect.provide(realQueryRunner)),
    ),
  );
});

const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  options: {
    resume: FORK_SESSION_ID,
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "t3-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

it.effect("reopens a stalled MCP registration before delivering the resumed prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposalStarted = Promise.withResolvers<void>();
      const finishDisposal = Promise.withResolvers<void>();
      const prompts: AsyncIterable<ClaudeSdk.SDKUserMessage>[] = [];
      const firstClose = vi.fn();
      const secondClose = vi.fn();
      const firstRegistration = vi.fn(() => {
        registrationStarted.resolve();
        return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
      });
      const secondRegistration = vi.fn(async () => ({
        added: ["t3-code"],
        removed: [],
        errors: {},
      }));
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        assert.notTypeOf(prompt, "string");
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        prompts.push(prompt);
        return {
          setMcpServers: prompts.length === 1 ? firstRegistration : secondRegistration,
          close: prompts.length === 1 ? firstClose : secondClose,
          [Symbol.asyncDispose]: async () => {
            firstClose();
            disposalStarted.resolve();
            await finishDisposal.promise;
          },
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => disposalStarted.promise);
      assert.equal(querySpy.mock.calls.length, 1);
      finishDisposal.resolve();
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      assert.equal(firstClose.mock.calls.length, 1);
      assert.equal(secondClose.mock.calls.length, 0);
      assert.equal(querySpy.mock.calls.length, 2);
      for (const [call] of querySpy.mock.calls) {
        assert.equal(call.options?.resume, FORK_SESSION_ID);
        assert.isUndefined(call.options?.mcpServers);
      }
      assert.deepEqual(secondRegistration.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
      const message = {
        type: "user",
        message: { role: "user", content: "Continue where you left off." },
        parent_tool_use_id: null,
        session_id: FORK_SESSION_ID,
      } satisfies ClaudeSdk.SDKUserMessage;
      yield* session.offer(message);
      assert.isTrue((yield* Effect.promise(() => prompts[0]![Symbol.asyncIterator]().next())).done);
      const delivered = yield* Effect.promise(() => prompts[1]![Symbol.asyncIterator]().next());
      assert.deepEqual(delivered.value, message);
      assert.isFalse(delivered.done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([true, false])("only retries after confirmed process exit: %s", (exits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const cleanupProgress = Promise.withResolvers<"kill" | "retry">();
      const events = new NodeEvents.EventEmitter();
      const stdin = new NodeStream.PassThrough();
      const stdout = new NodeStream.PassThrough();
      const child = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill: vi.fn(() => {
          cleanupProgress.resolve("kill");
          return true;
        }),
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      } satisfies ClaudeSdk.SpawnedProcess;
      const signal = yield* Effect.abortSignal;
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        const first = querySpy.mock.calls.length === 1;
        if (first) {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
        } else {
          cleanupProgress.resolve("retry");
        }
        return {
          setMcpServers: () => {
            registrationStarted.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["t3-code"], removed: [], errors: {} });
          },
          close: vi.fn(),
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          querySpy.mockRestore();
          stdin.destroy();
          stdout.destroy();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, spawnClaudeCodeProcess: () => child },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");

      assert.equal(yield* Effect.promise(() => cleanupProgress.promise), "kill");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
      if (exits) events.emit("exit", null, "SIGKILL");
      else yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(Exit.isSuccess(result), exits);
      if (Exit.isSuccess(result)) yield* result.value.close;
      assert.equal(querySpy.mock.calls.length, exits ? 2 : 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("stops retrying MCP registration after two timeouts and reports the cause", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstRegistration = Promise.withResolvers<void>();
      const secondRegistration = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(() => {
        const started = querySpy.mock.calls.length === 1 ? firstRegistration : secondRegistration;
        return {
          setMcpServers: () => {
            started.resolve();
            return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
          },
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open(resumedMcpQueryInput)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => firstRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => secondRegistration.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(querySpy.mock.calls.length, 2);
      assert.equal(disposed.mock.calls.length, 2);
      assert.equal(
        makeProviderFailure({
          cause: { _tag: "ProviderAdapterTurnStartError", cause: result.failure },
        }).message,
        "Claude timed out while registering its MCP tools. Retry the turn; if it keeps failing, check Claude and the server logs.",
      );
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("cancels a stalled registration without retrying or retaining its prompt queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* Fiber.interrupt(opening);

      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
      const prompt = querySpy.mock.calls[0]![0].prompt;
      if (typeof prompt === "string") throw new Error("Expected streaming input");
      assert.isTrue((yield* Effect.promise(() => prompt[Symbol.asyncIterator]().next())).done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("does not reuse a fresh session ID after MCP registration times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...options, sessionId: resume },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // The leftover child holds a FIFO open; its death produces EOF without polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );

  // The CLI keeps running its turn after its pipes close, so a server that
  // crashed would leave it working next to the session it resumes.
  it.effect("stops the CLI when the server that started it goes away", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"));
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      const child = spawnClaudeProcessGroup({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        // @effect-diagnostics-next-line abortControllerInEffect:off - This crash fixture closes pipes itself; aborting on test teardown raises an unrelated process error.
        signal: new AbortController().signal,
      }) as NodeChildProcess.ChildProcess;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            signalProcessGroup(child.pid ?? 0, "SIGKILL");
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const turnStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const turnStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      yield* Effect.promise(() => turnStarted);

      // A dying server's descriptors close; the kernel would do this for it.
      for (const pipe of child.stdio) pipe?.destroy();
      yield* Effect.promise(() => turnStopped);
    }),
  );
});
