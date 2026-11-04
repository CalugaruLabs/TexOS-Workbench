// @effect-diagnostics nodeBuiltinImport:off -- Synthetic fixture creates only its own temporary Git repository and checks physical identity.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import Migration from "../persistence/Migrations/070_NativeExecutionReceipts.ts";
import * as Receipts from "./executionReceipts.ts";
import { ControlledExecutionProvider, makeExecutionControl } from "./executionControl.ts";
import { executionEnvelope, type ExecutionIntent } from "./executionProtocol.ts";
import {
  syntheticBinding,
  syntheticIntent,
  syntheticRequest,
  syntheticAuthorization,
} from "./execution.testkit.ts";
import { makeControlledCodexFixture, currentReceiptAuthorizer } from "./executionCodex.testkit.ts";
import type { NativeStartAuthorizer } from "./executionControl.ts";
const database = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  NodeServices.layer,
);
const receiptsLayer = Receipts.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(Migration).pipe(Layer.provideMerge(database))),
);

describe("native execution with the actual lower Codex adapter", () => {
  it.effect.each([2, 4])(
    "a fresh denial at callback %s prevents the controlled turn edit",
    (denyAt) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped({
          prefix: "texos-controlled-revocation-",
        });
        const root = yield* Effect.promise(() => NodeFSP.realpath(temporary));
        const template = NodePath.join(root, "empty-template");
        yield* fs.makeDirectory(template);
        yield* Effect.sync(() =>
          NodeChildProcess.execFileSync(
            "/usr/bin/git",
            ["init", "--quiet", `--template=${template}`, root],
            {
              env: {
                PATH: "/usr/bin:/bin",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
              stdio: "pipe",
            },
          ),
        );
        yield* fs.writeFileString(NodePath.join(root, "answer.ts"), "export const answer = 0;\n");
        const stat = yield* Effect.promise(() => NodeFSP.stat(root, { bigint: true }));
        const base = syntheticIntent(root);
        const intent = {
          ...base,
          worktree: { ...base.worktree, device: String(stat.dev), inode: String(stat.ino) },
        };
        let factories = 0;
        let edits = 0;
        const provider = yield* makeControlledCodexFixture({
          repositoryRoot: root,
          onFactory: () => {
            factories++;
          },
          onEdit: () => {
            edits++;
          },
        });
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ControlledExecutionProvider, provider),
        );
        const store = yield* Receipts.ExecutionReceipts;
        const seen: Array<Parameters<NativeStartAuthorizer>[0]> = [];
        const native = currentReceiptAuthorizer(
          store,
          intent,
          yield* Clock.currentTimeMillis,
          denyAt,
          seen,
        );
        yield* control.handle(syntheticRequest("execution.admit", intent), native);
        yield* control.awaitAttempt(intent.commandID);
        assert.equal(factories, 1);
        assert.equal(edits, 0);
        assert.lengthOf(seen, denyAt);
        assert.equal(
          yield* fs.readFileString(NodePath.join(root, "answer.ts")),
          "export const answer = 0;\n",
        );
        const saved = yield* store.get(
          intent.commandID,
          executionEnvelope(intent).digest,
          intent.scope.authorityID,
        );
        assert.equal(saved?.phase, "uncertain");
        if (denyAt === 4) {
          assert.isTrue(
            seen
              .slice(0, 3)
              .every(
                (params) =>
                  params.nativeThreadID === undefined && params.providerThreadID === undefined,
              ),
          );
          assert.equal(seen[3]?.nativeThreadID, "controlled-native-thread");
          assert.equal(seen[3]?.providerThreadID, saved?.mappings.providerThreadID);
          assert.isUndefined(saved?.mappings.nativeTurnID);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            receiptsLayer,
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
          ),
        ),
      ),
  );
  it.effect(
    "edits a disposable repository once and preserves canonical and provider identities",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "texos-controlled-codex-" });
        const root = yield* Effect.promise(() => NodeFSP.realpath(temporary));
        const emptyTemplate = NodePath.join(root, "empty-template");
        yield* fs.makeDirectory(emptyTemplate);
        yield* Effect.sync(() =>
          NodeChildProcess.execFileSync(
            "/usr/bin/git",
            ["init", "--quiet", `--template=${emptyTemplate}`, root],
            {
              env: {
                PATH: "/usr/bin:/bin",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
              stdio: "pipe",
            },
          ),
        );
        yield* fs.writeFileString(NodePath.join(root, "answer.ts"), "export const answer = 0;\n");
        const stat = yield* Effect.promise(() => NodeFSP.stat(root, { bigint: true }));
        const base = syntheticIntent(root);
        const intent: ExecutionIntent = {
          ...base,
          worktree: { ...base.worktree, device: String(stat.dev), inode: String(stat.ino) },
        };
        let factoryCalls = 0;
        let edits = 0;
        let fixtureFailure: unknown;
        const provider = yield* makeControlledCodexFixture({
          repositoryRoot: root,
          onFactory: () => {
            factoryCalls++;
          },
          onEdit: () => {
            edits++;
          },
          onFailure: (cause) => {
            fixtureFailure = cause;
          },
        });
        const control = yield* makeExecutionControl(syntheticBinding).pipe(
          Effect.provideService(ControlledExecutionProvider, provider),
        );
        const now = yield* Clock.currentTimeMillis;
        const authorize = async (request: {
          readonly runtimeID: string;
          readonly childID: string;
        }) => ({
          ...syntheticAuthorization(intent, now),
          runtimeID: request.runtimeID,
          childID: request.childID,
        });
        const admitted = yield* control.handle(
          syntheticRequest("execution.admit", intent),
          authorize,
        );
        const duplicateBeforeResult = yield* control.handle(
          syntheticRequest("execution.admit", intent, 11),
          authorize,
        );
        assert.propertyVal(
          duplicateBeforeResult,
          "childID",
          "childID" in admitted ? admitted.childID : "missing",
        );
        yield* control.awaitAttempt(intent.commandID);
        if (fixtureFailure !== undefined) return yield* Effect.die(fixtureFailure);
        const finished = yield* control.handle(
          syntheticRequest("execution.status", {
            commandID: intent.commandID,
            envelopeDigest: executionEnvelope(intent).digest,
          }),
        );
        assert.propertyVal(finished, "phase", "attemptFinished");
        assert.propertyVal(finished, "drained", true);
        assert.propertyVal(finished, "canonicalAttemptID", intent.canonicalAttemptID);
        assert.propertyVal(finished, "workerRequestID", intent.workerRequestID);
        assert.equal(factoryCalls, 1);
        assert.equal(edits, 1);
        assert.equal(
          yield* fs.readFileString(NodePath.join(root, "answer.ts")),
          "export const answer = 42;\n",
        );
        const duplicateAfterResult = yield* control.handle(
          syntheticRequest("execution.admit", intent, 12),
          authorize,
        );
        assert.deepEqual(duplicateAfterResult, finished);
        assert.equal(factoryCalls, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            receiptsLayer,
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
          ),
        ),
      ),
  );
});
