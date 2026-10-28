import {
  OrchestratorMcpFailure,
  type ProjectId,
  type WorkspaceActor,
  type WorkspaceAreaId,
  type WorkspaceError,
  type WorkspaceItem,
  type WorkspaceLocation,
  type WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Workspace from "../../../workspace/Workspace.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { WorkspaceToolkit } from "./tools.ts";

const LIST_LIMIT = 50;

const toFailure = (error: WorkspaceError) =>
  error.reason === "storage"
    ? unavailable()
    : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

interface Placement {
  readonly projectId?: ProjectId | undefined;
  readonly areaId?: WorkspaceAreaId | undefined;
  readonly inbox?: boolean | undefined;
}

const placementLocation = (input: Placement): WorkspaceLocation | undefined =>
  input.inbox === true
    ? { _tag: "Inbox" }
    : input.projectId !== undefined
      ? { _tag: "Project", projectId: input.projectId }
      : input.areaId !== undefined
        ? { _tag: "Area", areaId: input.areaId }
        : undefined;

const sameLocation = (left: WorkspaceLocation, right: WorkspaceLocation) =>
  left._tag === right._tag &&
  (left._tag !== "Area" || (right._tag === "Area" && left.areaId === right.areaId)) &&
  (left._tag !== "Project" || (right._tag === "Project" && left.projectId === right.projectId));

const filterItems = (
  snapshot: WorkspaceSnapshot,
  filter: Placement & {
    readonly kind?: WorkspaceItem["kind"] | undefined;
    readonly status?: WorkspaceItem["status"] | undefined;
    readonly query?: string | undefined;
  },
) => {
  const location = placementLocation(filter);
  const words = (filter.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = snapshot.items
    .filter(
      (item) =>
        (filter.kind === undefined || item.kind === filter.kind) &&
        (filter.status === undefined || item.status === filter.status) &&
        (location === undefined || sameLocation(item.filing.location, location)) &&
        words.every((word) => `${item.title}\n${item.body}`.toLowerCase().includes(word)),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { items: matches.slice(0, LIST_LIMIT), truncated: matches.length > LIST_LIMIT };
};

const callerContext = Effect.gen(function* () {
  const caller = yield* loadCaller();
  const actor: WorkspaceActor =
    caller.scope.thread !== undefined
      ? { _tag: "Agent", threadId: caller.scope.thread.threadId }
      : { _tag: "Client", label: caller.scope.client?.label ?? "MCP client" };
  return { caller, actor };
});

export const layer = McpToolAccess.toLayer(WorkspaceToolkit, {
  t3_workspace_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.Workspace;
      const snapshot = yield* workspace.snapshot;
      return {
        areas: snapshot.areas.map((area) => ({
          id: area.id,
          name: area.name,
          projectIds: area.projectRefs.map((ref) => ref.projectId),
        })),
        ...filterItems(snapshot, input),
      };
    }),
  ),
  t3_workspace_add: McpToolAccess.writesWithCapability(({ projectId, areaId, inbox, ...input }) =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.Workspace;
      const { caller, actor } = yield* callerContext;
      const thread = caller.caller;
      const threadFiling =
        thread === undefined
          ? undefined
          : (yield* workspace.snapshot).threadFilings.find((entry) => entry.threadId === thread.id)
              ?.filing.location;
      const location =
        placementLocation({ projectId, areaId, inbox }) ??
        threadFiling ??
        (thread === undefined ? undefined : { _tag: "Project", projectId: thread.projectId });
      return yield* workspace
        .createItem(
          {
            ...input,
            ...(location === undefined ? {} : { location }),
            ...(thread === undefined ? {} : { source: { threadId: thread.id } }),
          },
          actor,
        )
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_workspace_update: McpToolAccess.writesWithCapability(
    ({ itemId, projectId, areaId, inbox, ...changes }) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const { actor } = yield* callerContext;
        const location = placementLocation({ projectId, areaId, inbox });
        if (location !== undefined) {
          yield* workspace
            .file({ target: { _tag: "Item", itemId }, location }, actor)
            .pipe(Effect.mapError(toFailure));
        }
        return yield* workspace.updateItem({ itemId, ...changes }).pipe(Effect.mapError(toFailure));
      }),
  ),
});
