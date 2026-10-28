import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workspace from "../../../workspace/Workspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as WorkspaceHandlers from "./handlers.ts";
import { WorkspaceToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-agent");
const projectId = ProjectId.make("project-texos");
const providerInstanceId = ProviderInstanceId.make("codex");

const dependencies = Layer.mergeAll(
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "thread:test",
    thread: { threadId, providerSessionId: "session", providerInstanceId },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        id === threadId
          ? ({
              id,
              projectId,
              providerInstanceId,
              activeRunId: "run-1",
              archivedAt: null,
              deletedAt: null,
              runtimeMode: "full-access",
              interactionMode: "default",
            } as unknown as OrchestrationV2ThreadShell)
          : null,
      ),
  }),
).pipe(
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-mcp-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const call = Effect.fn("test.call")(function* (
  name: "t3_workspace_add" | "t3_workspace_update",
  params: Record<string, unknown>,
) {
  const toolkit = yield* WorkspaceToolkit.pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(WorkspaceHandlers.layer)),
  );
  const result = yield* toolkit
    .handle(name, params as never)
    .pipe(Stream.unwrap, Stream.runCollect);
  return result.at(-1)?.result;
});

it.layer(dependencies)("workspace MCP tools", (it) => {
  it.effect("files an agent's item where its thread is, linked back to that thread", () =>
    Effect.gen(function* () {
      const added = yield* call("t3_workspace_add", { kind: "task", title: "Sign in Hermes" });
      expect(added).toMatchObject({
        status: "open",
        source: { threadId },
        createdBy: { _tag: "Agent", threadId },
        filing: { location: { _tag: "Project", projectId } },
      });

      const workspace = yield* Workspace.Workspace;
      const area = yield* workspace.saveArea({ name: "Tools", projectRefs: [] });
      yield* workspace.file(
        { target: { _tag: "Thread", threadId }, location: { _tag: "Area", areaId: area.id } },
        { _tag: "User" },
      );
      const refiled = yield* call("t3_workspace_add", { kind: "idea", title: "Try Pi" });
      expect(refiled).toMatchObject({ filing: { location: { _tag: "Area", areaId: area.id } } });
    }),
  );

  it.effect("marks a task done and moves it to the Inbox in one update", () =>
    Effect.gen(function* () {
      const added = (yield* call("t3_workspace_add", { kind: "task", title: "Renew" })) as {
        readonly id: string;
      };
      const updated = yield* call("t3_workspace_update", {
        itemId: added.id,
        status: "done",
        inbox: true,
      });
      expect(updated).toMatchObject({
        status: "done",
        filing: { location: { _tag: "Inbox" }, filedBy: { _tag: "Agent", threadId } },
      });
    }),
  );
});
