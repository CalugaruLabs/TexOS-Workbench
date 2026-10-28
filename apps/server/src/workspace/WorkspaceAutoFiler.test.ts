import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type {
  WorkspaceItemsGenerationInput,
  WorkspaceItemsGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Workspace from "./Workspace.ts";
import * as WorkspaceAutoFiler from "./WorkspaceAutoFiler.ts";

const environmentId = EnvironmentId.make("env-local");
const SCRATCH = "/home/user/Chats";
const healthProject = ProjectId.make("project-health");
const scratchProject = ProjectId.make("project-scratch");

const state = {
  threads: new Map<
    ThreadId,
    { projectId: ProjectId; title: string; messages: OrchestrationV2ConversationMessage[] }
  >(),
  calls: [] as WorkspaceItemsGenerationInput[],
  reply: { items: [], filing: null } as WorkspaceItemsGenerationResult,
};

const message = (id: string, role: "user" | "assistant", text: string) =>
  ({ id: MessageId.make(id), role, text, streaming: false }) as OrchestrationV2ConversationMessage;

const project = (projectId: ProjectId, title: string, workspaceRoot: string) =>
  ({ projectId, title, workspaceRoot, deletedAt: null }) as ProjectStore.ProjectRow;
const projects = [
  project(healthProject, "health-tracker", "/home/user/health-tracker"),
  project(scratchProject, "Chats", SCRATCH),
];

const layerTest = WorkspaceAutoFiler.layer.pipe(
  Layer.provideMerge(Workspace.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: ((threadId: ThreadId) => {
          const thread = state.threads.get(threadId)!;
          return Effect.succeed({
            thread: {
              id: threadId,
              projectId: thread.projectId,
              title: thread.title,
              worktreePath: null,
              deletedAt: null,
            },
            messages: thread.messages,
          });
        }) as never,
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (projectId) =>
          Effect.succeed(Option.fromNullishOr(projects.find((row) => row.projectId === projectId))),
        list: () => Effect.succeed(projects),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: Effect.succeedSome(SCRATCH),
        namedProjectsRoot: "/projects",
      }),
      Layer.mock(TextGeneration.TextGeneration)({
        generateWorkspaceItems: (input) => {
          state.calls.push(input);
          return Effect.succeed(state.reply);
        },
      }),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-filer-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const setup = (reply: WorkspaceItemsGenerationResult) => {
  state.calls = [];
  state.reply = reply;
};

it.layer(layerTest)("WorkspaceAutoFiler", (it) => {
  it.effect("saves what a project chat produced in that project, once per new message", () =>
    Effect.gen(function* () {
      const filer = yield* WorkspaceAutoFiler.WorkspaceAutoFiler;
      const workspace = yield* Workspace.Workspace;
      const threadId = ThreadId.make("thread-project");
      state.threads.set(threadId, {
        projectId: healthProject,
        title: "Weekly email",
        messages: [
          message("m1", "user", "Let's add a weekly summary email. Use Resend."),
          message("m2", "assistant", "Done. You still need to add the API key."),
        ],
      });
      setup({
        items: [
          { kind: "decision", title: "Send summaries with Resend", body: "", quote: "Use Resend" },
          { kind: "task", title: "Add the Resend API key", body: "", quote: "add the API key" },
        ],
        filing: null,
      });

      yield* filer.fileThread(threadId);
      expect(state.calls[0]?.places).toBeUndefined();
      expect(state.calls[0]?.conversation).toContain("User: Let's add a weekly summary email.");
      const items = (yield* workspace.snapshot).items.filter(
        (item) => item.source?.threadId === threadId,
      );
      expect(items).toMatchObject([
        {
          kind: "decision",
          status: "decided",
          filing: {
            location: { _tag: "Project", projectId: healthProject },
            filedBy: { _tag: "Auto" },
          },
          source: { threadId, messageId: "m2", quote: "Use Resend" },
        },
        { kind: "task", status: "open" },
      ]);

      yield* filer.fileThread(threadId);
      expect(state.calls).toHaveLength(1);

      state.threads.get(threadId)!.messages.push(message("m3", "user", "Also add a test."));
      setup({
        items: [{ kind: "task", title: "add the resend  API key", body: "", quote: "" }],
        filing: null,
      });
      yield* filer.fileThread(threadId);
      expect(state.calls[0]?.conversation).toBe("User: Also add a test.");
      expect(
        (yield* workspace.snapshot).items.filter((item) => item.source?.threadId === threadId),
      ).toHaveLength(2);
    }),
  );

  it.effect("files a chat without a project only when sure, and never over a person's choice", () =>
    Effect.gen(function* () {
      const filer = yield* WorkspaceAutoFiler.WorkspaceAutoFiler;
      const workspace = yield* Workspace.Workspace;
      const area = yield* workspace.saveArea({
        name: "Health",
        projectRefs: [{ environmentId, projectId: healthProject }],
      });

      const sure = ThreadId.make("thread-sure");
      state.threads.set(sure, {
        projectId: scratchProject,
        title: "Sleep tracking",
        messages: [message("s1", "user", "Can the health tracker log sleep?")],
      });
      setup({
        items: [{ kind: "idea", title: "Log sleep in the tracker", body: "", quote: "" }],
        filing: {
          placeId: `project:${healthProject}`,
          confident: true,
          reason: "About the tracker",
        },
      });
      yield* filer.fileThread(sure);
      expect(state.calls[0]?.places).toEqual([
        { id: `area:${area.id}`, name: 'Area "Health"' },
        { id: `project:${healthProject}`, name: 'Project "health-tracker" in Health' },
      ]);
      let snapshot = yield* workspace.snapshot;
      expect(snapshot.threadFilings.find((entry) => entry.threadId === sure)?.filing).toMatchObject(
        {
          location: { _tag: "Project", projectId: healthProject },
          reason: "About the tracker",
        },
      );
      expect(
        snapshot.items.find((item) => item.source?.threadId === sure)?.filing.location,
      ).toEqual({
        _tag: "Project",
        projectId: healthProject,
      });

      const unsure = ThreadId.make("thread-unsure");
      state.threads.set(unsure, {
        projectId: scratchProject,
        title: "Trip ideas",
        messages: [message("u1", "user", "Where should we go in spring?")],
      });
      setup({
        items: [],
        filing: {
          placeId: null,
          confident: false,
          reason: "A new topic",
          newProjectName: "Travel",
        },
      });
      yield* filer.fileThread(unsure);
      snapshot = yield* workspace.snapshot;
      expect(
        snapshot.threadFilings.find((entry) => entry.threadId === unsure)?.filing,
      ).toMatchObject({
        location: { _tag: "Inbox" },
        filedBy: { _tag: "Auto" },
        suggestion: { newProjectName: "Travel", reason: "A new topic" },
      });

      yield* workspace.file(
        {
          target: { _tag: "Thread", threadId: unsure },
          location: { _tag: "Area", areaId: area.id },
        },
        { _tag: "User" },
      );
      state.threads.get(unsure)!.messages.push(message("u2", "user", "Maybe Japan."));
      setup({
        items: [],
        filing: { placeId: `project:${healthProject}`, confident: true, reason: "Wrong" },
      });
      yield* filer.fileThread(unsure);
      expect(state.calls[0]?.places).toBeUndefined();
      expect(
        (yield* workspace.snapshot).threadFilings.find((entry) => entry.threadId === unsure)
          ?.filing,
      ).toMatchObject({ location: { _tag: "Area", areaId: area.id }, filedBy: { _tag: "User" } });
    }),
  );

  it.effect("stays off when automatic saving is turned off", () =>
    Effect.gen(function* () {
      const filer = yield* WorkspaceAutoFiler.WorkspaceAutoFiler;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ workspaceAutoExtract: false });
      const threadId = ThreadId.make("thread-off");
      state.threads.set(threadId, {
        projectId: healthProject,
        title: "Off",
        messages: [message("o1", "user", "Remember to stretch.")],
      });
      setup({ items: [], filing: null });
      yield* filer.fileThread(threadId);
      expect(state.calls).toEqual([]);
      yield* settings.updateSettings({ workspaceAutoExtract: true });
    }),
  );
});
