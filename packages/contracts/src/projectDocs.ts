import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_DOC_MAX_MARKDOWN_LENGTH = 200_000;

// Doc ids name files on the server, so they stay a plain token.
export const ProjectDocId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)).pipe(
  Schema.brand("ProjectDocId"),
);
export type ProjectDocId = typeof ProjectDocId.Type;

export const ProjectDocTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const ProjectDocAuthor = Schema.Union([
  Schema.TaggedStruct("User", {}),
  Schema.TaggedStruct("Agent", { threadId: ThreadId }),
  Schema.TaggedStruct("Client", { label: Schema.String }),
]);
export type ProjectDocAuthor = typeof ProjectDocAuthor.Type;

export const ProjectDocSummary = Schema.Struct({
  id: ProjectDocId,
  projectId: ProjectId,
  title: ProjectDocTitle,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  updatedBy: ProjectDocAuthor,
  revision: Schema.Int,
});
export type ProjectDocSummary = typeof ProjectDocSummary.Type;

export const ProjectDoc = Schema.Struct({
  ...ProjectDocSummary.fields,
  markdown: Schema.String.check(Schema.isMaxLength(PROJECT_DOC_MAX_MARKDOWN_LENGTH)),
});
export type ProjectDoc = typeof ProjectDoc.Type;

export const ProjectDocListInput = Schema.Struct({ projectId: ProjectId });
export type ProjectDocListInput = typeof ProjectDocListInput.Type;

export const ProjectDocListResult = Schema.Struct({
  projectId: ProjectId,
  docs: Schema.Array(ProjectDocSummary),
});
export type ProjectDocListResult = typeof ProjectDocListResult.Type;

export const ProjectDocReadInput = Schema.Struct({ projectId: ProjectId, docId: ProjectDocId });
export type ProjectDocReadInput = typeof ProjectDocReadInput.Type;

export const ProjectDocSaveInput = Schema.Struct({
  projectId: ProjectId,
  docId: Schema.optional(ProjectDocId),
  title: ProjectDocTitle,
  markdown: ProjectDoc.fields.markdown,
  // The revision the writer last read; a stale one is rejected instead of overwriting newer text.
  baseRevision: Schema.optional(Schema.Int),
});
export type ProjectDocSaveInput = typeof ProjectDocSaveInput.Type;

export const ProjectDocDeleteInput = ProjectDocReadInput;
export type ProjectDocDeleteInput = typeof ProjectDocDeleteInput.Type;

export class ProjectDocError extends Schema.TaggedError<ProjectDocError>()("ProjectDocError", {
  message: Schema.String,
  reason: Schema.Literals(["not-found", "conflict", "storage"]),
  docId: Schema.optional(ProjectDocId),
  cause: Schema.optional(Schema.Defect()),
}) {}
