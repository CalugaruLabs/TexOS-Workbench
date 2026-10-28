import {
  OrchestratorMcpFailure,
  ProjectDoc,
  ProjectDocId,
  ProjectDocListResult,
  ProjectDocSaveInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectDocs from "../../../project/ProjectDocs.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const projectId = Schema.optional(
  ProjectId.annotate({ description: "Omit for the calling thread's project." }),
);

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectDocs.ProjectDocs,
  ],
};

const DocListTool = Tool.make("t3_doc_list", {
  ...shared,
  description:
    "List the project's docs: shared documents the user reads and edits in T3. Newest first, without their text.",
  parameters: Schema.Struct({ projectId }),
  success: ProjectDocListResult,
})
  .annotate(Tool.Title, "List project docs")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DocReadTool = Tool.make("t3_doc_read", {
  ...shared,
  description: "Read one project doc as markdown, with its `revision` for t3_doc_write.",
  parameters: Schema.Struct({ projectId, docId: ProjectDocId }),
  success: ProjectDoc,
})
  .annotate(Tool.Title, "Read a project doc")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DocWriteTool = Tool.make("t3_doc_write", {
  ...shared,
  description:
    "Create a project doc (omit `docId`) or replace one's title and full markdown. To edit, read it first and pass its `revision` as `baseRevision`; a newer edit by the user is rejected, not overwritten. The user sees the doc in the project's Docs.",
  parameters: Schema.Struct({
    projectId,
    docId: Schema.optional(ProjectDocId),
    title: ProjectDocSaveInput.fields.title,
    markdown: ProjectDocSaveInput.fields.markdown,
    baseRevision: ProjectDocSaveInput.fields.baseRevision,
  }),
  success: ProjectDoc,
})
  .annotate(Tool.Title, "Write a project doc")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const DocsToolkit = Toolkit.make(DocListTool, DocReadTool, DocWriteTool);
