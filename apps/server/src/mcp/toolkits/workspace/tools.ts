import {
  OrchestratorMcpFailure,
  ProjectId,
  WorkspaceAreaId,
  WorkspaceItem,
  WorkspaceItemBody,
  WorkspaceItemId,
  WorkspaceItemKind,
  WorkspaceItemStatus,
  WorkspaceItemTitle,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workspace from "../../../workspace/Workspace.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Workspace.Workspace,
  ],
};

const placement = {
  projectId: Schema.optional(ProjectId),
  areaId: Schema.optional(WorkspaceAreaId),
  inbox: Schema.optional(
    Schema.Boolean.annotate({ description: "true files it in the Inbox for the user to sort." }),
  ),
};

const WorkspaceListResult = Schema.Struct({
  areas: Schema.Array(
    Schema.Struct({
      id: WorkspaceAreaId,
      name: Schema.String,
      projectIds: Schema.Array(ProjectId),
    }),
  ),
  items: Schema.Array(WorkspaceItem),
  truncated: Schema.Boolean,
});

const WorkspaceListTool = Tool.make("t3_workspace_list", {
  ...shared,
  description:
    "List the user's workspace: their areas and the ideas, tasks and decisions filed in them. Newest first, at most 50 items. Filter to answer questions like 'what's open in this project?'.",
  parameters: Schema.Struct({
    kind: Schema.optional(WorkspaceItemKind),
    status: Schema.optional(WorkspaceItemStatus),
    ...placement,
    query: Schema.optional(
      Schema.String.annotate({ description: "Words to match in the title or body." }),
    ),
  }),
  success: WorkspaceListResult,
})
  .annotate(Tool.Title, "List workspace items")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkspaceAddTool = Tool.make("t3_workspace_add", {
  ...shared,
  description:
    "Save an idea, task or decision to the user's workspace, linked to this thread. Only save what the user would want to find later. With no projectId, areaId or inbox it is filed where this thread is filed. To record a changed decision, pass the old one's id as replacesId.",
  parameters: Schema.Struct({
    kind: WorkspaceItemKind,
    title: WorkspaceItemTitle,
    body: Schema.optional(WorkspaceItemBody),
    status: Schema.optional(WorkspaceItemStatus),
    ...placement,
    replacesId: Schema.optional(WorkspaceItemId),
  }),
  success: WorkspaceItem,
})
  .annotate(Tool.Title, "Add a workspace item")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const WorkspaceUpdateTool = Tool.make("t3_workspace_update", {
  ...shared,
  description:
    "Change a workspace item's title, body or status (for example mark a task done), or move it by passing projectId, areaId or inbox.",
  parameters: Schema.Struct({
    itemId: WorkspaceItemId,
    title: Schema.optional(WorkspaceItemTitle),
    body: Schema.optional(WorkspaceItemBody),
    status: Schema.optional(WorkspaceItemStatus),
    ...placement,
  }),
  success: WorkspaceItem,
})
  .annotate(Tool.Title, "Update a workspace item")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const WorkspaceToolkit = Toolkit.make(
  WorkspaceListTool,
  WorkspaceAddTool,
  WorkspaceUpdateTool,
);
