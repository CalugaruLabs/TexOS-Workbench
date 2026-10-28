import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedProjectRef } from "./environment.ts";

const WorkspaceToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));

export const WorkspaceAreaId = WorkspaceToken.pipe(Schema.brand("WorkspaceAreaId"));
export type WorkspaceAreaId = typeof WorkspaceAreaId.Type;

export const WorkspaceItemId = WorkspaceToken.pipe(Schema.brand("WorkspaceItemId"));
export type WorkspaceItemId = typeof WorkspaceItemId.Type;

export const WorkspaceAreaName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));

export const WorkspaceArea = Schema.Struct({
  id: WorkspaceAreaId,
  name: WorkspaceAreaName,
  // Areas live on one environment but may group projects from any connected environment.
  projectRefs: Schema.Array(ScopedProjectRef),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceArea = typeof WorkspaceArea.Type;

export const WORKSPACE_ITEM_STATUSES = {
  idea: ["new", "kept", "dropped"],
  task: ["open", "doing", "done", "dropped"],
  decision: ["proposed", "decided", "replaced"],
} as const;

export const WorkspaceItemKind = Schema.Literals(["idea", "task", "decision"]);
export type WorkspaceItemKind = typeof WorkspaceItemKind.Type;

export const WorkspaceItemStatus = Schema.Literals([
  ...WORKSPACE_ITEM_STATUSES.idea,
  ...WORKSPACE_ITEM_STATUSES.task,
  ...WORKSPACE_ITEM_STATUSES.decision,
]);
export type WorkspaceItemStatus = typeof WorkspaceItemStatus.Type;

export const WorkspaceActor = Schema.Union([
  Schema.TaggedStruct("User", {}),
  Schema.TaggedStruct("Agent", { threadId: ThreadId }),
  Schema.TaggedStruct("Client", { label: Schema.String }),
  Schema.TaggedStruct("Auto", {}),
]);
export type WorkspaceActor = typeof WorkspaceActor.Type;

export const WorkspaceLocation = Schema.Union([
  Schema.TaggedStruct("Inbox", {}),
  Schema.TaggedStruct("Area", { areaId: WorkspaceAreaId }),
  Schema.TaggedStruct("Project", { projectId: ProjectId }),
]);
export type WorkspaceLocation = typeof WorkspaceLocation.Type;

const WorkspaceReason = Schema.String.check(Schema.isMaxLength(300));

export const WorkspaceSuggestion = Schema.Struct({
  location: WorkspaceLocation,
  // The app never creates projects itself; a missing home is offered as a name to accept.
  newProjectName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  reason: WorkspaceReason,
});
export type WorkspaceSuggestion = typeof WorkspaceSuggestion.Type;

export const WorkspaceFiling = Schema.Struct({
  location: WorkspaceLocation,
  filedBy: WorkspaceActor,
  reason: WorkspaceReason,
  suggestion: Schema.optional(WorkspaceSuggestion),
  filedAt: IsoDateTime,
});
export type WorkspaceFiling = typeof WorkspaceFiling.Type;

export const WorkspaceItemSource = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.optional(MessageId),
  quote: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type WorkspaceItemSource = typeof WorkspaceItemSource.Type;

export const WorkspaceItemTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
export const WorkspaceItemBody = Schema.String.check(Schema.isMaxLength(4_000));

export const WorkspaceItem = Schema.Struct({
  id: WorkspaceItemId,
  kind: WorkspaceItemKind,
  title: WorkspaceItemTitle,
  body: WorkspaceItemBody,
  status: WorkspaceItemStatus,
  filing: WorkspaceFiling,
  source: Schema.optional(WorkspaceItemSource),
  createdBy: WorkspaceActor,
  replacesId: Schema.optional(WorkspaceItemId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceItem = typeof WorkspaceItem.Type;

export const WorkspaceThreadFiling = Schema.Struct({
  threadId: ThreadId,
  filing: WorkspaceFiling,
});
export type WorkspaceThreadFiling = typeof WorkspaceThreadFiling.Type;

export const WorkspaceSnapshot = Schema.Struct({
  areas: Schema.Array(WorkspaceArea),
  items: Schema.Array(WorkspaceItem),
  threadFilings: Schema.Array(WorkspaceThreadFiling),
});
export type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;

export const WorkspaceSaveAreaInput = Schema.Struct({
  areaId: Schema.optional(WorkspaceAreaId),
  name: WorkspaceAreaName,
  projectRefs: Schema.Array(ScopedProjectRef),
});
export type WorkspaceSaveAreaInput = typeof WorkspaceSaveAreaInput.Type;

export const WorkspaceDeleteAreaInput = Schema.Struct({ areaId: WorkspaceAreaId });
export type WorkspaceDeleteAreaInput = typeof WorkspaceDeleteAreaInput.Type;

export const WorkspaceCreateItemInput = Schema.Struct({
  kind: WorkspaceItemKind,
  title: WorkspaceItemTitle,
  body: Schema.optional(WorkspaceItemBody),
  status: Schema.optional(WorkspaceItemStatus),
  location: Schema.optional(WorkspaceLocation),
  reason: Schema.optional(WorkspaceReason),
  source: Schema.optional(WorkspaceItemSource),
  replacesId: Schema.optional(WorkspaceItemId),
});
export type WorkspaceCreateItemInput = typeof WorkspaceCreateItemInput.Type;

export const WorkspaceUpdateItemInput = Schema.Struct({
  itemId: WorkspaceItemId,
  title: Schema.optional(WorkspaceItemTitle),
  body: Schema.optional(WorkspaceItemBody),
  status: Schema.optional(WorkspaceItemStatus),
});
export type WorkspaceUpdateItemInput = typeof WorkspaceUpdateItemInput.Type;

export const WorkspaceDeleteItemInput = Schema.Struct({ itemId: WorkspaceItemId });
export type WorkspaceDeleteItemInput = typeof WorkspaceDeleteItemInput.Type;

export const WorkspaceFileTarget = Schema.Union([
  Schema.TaggedStruct("Item", { itemId: WorkspaceItemId }),
  Schema.TaggedStruct("Thread", { threadId: ThreadId }),
]);
export type WorkspaceFileTarget = typeof WorkspaceFileTarget.Type;

export const WorkspaceFileInput = Schema.Struct({
  target: WorkspaceFileTarget,
  location: WorkspaceLocation,
  reason: Schema.optional(WorkspaceReason),
});
export type WorkspaceFileInput = typeof WorkspaceFileInput.Type;

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
  reason: Schema.Literals(["not-found", "invalid", "storage"]),
  cause: Schema.optional(Schema.Defect()),
}) {}
