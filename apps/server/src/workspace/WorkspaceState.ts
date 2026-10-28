import {
  WORKSPACE_ITEM_STATUSES,
  WorkspaceError,
  type WorkspaceActor,
  type WorkspaceArea,
  type WorkspaceAreaId,
  type WorkspaceCreateItemInput,
  type WorkspaceFileInput,
  type WorkspaceFiling,
  type WorkspaceItem,
  type WorkspaceItemId,
  type WorkspaceItemKind,
  type WorkspaceItemStatus,
  type WorkspaceLocation,
  type WorkspaceSaveAreaInput,
  type WorkspaceSnapshot,
  type WorkspaceUpdateItemInput,
} from "@t3tools/contracts";

export const EMPTY_WORKSPACE: WorkspaceSnapshot = { areas: [], items: [], threadFilings: [] };

const INBOX: WorkspaceLocation = { _tag: "Inbox" };

const invalid = (message: string) => new WorkspaceError({ message, reason: "invalid" });
const notFound = (message: string) => new WorkspaceError({ message, reason: "not-found" });

const defaultReason = (actor: WorkspaceActor) =>
  actor._tag === "User" ? "You filed it here." : actor._tag === "Auto" ? "" : "Filed by an agent.";

const statusFits = (kind: WorkspaceItemKind, status: WorkspaceItemStatus) =>
  (WORKSPACE_ITEM_STATUSES[kind] as ReadonlyArray<WorkspaceItemStatus>).includes(status);

const checkLocation = (snapshot: WorkspaceSnapshot, location: WorkspaceLocation) => {
  if (location._tag === "Area" && !snapshot.areas.some((area) => area.id === location.areaId)) {
    throw notFound("That area doesn't exist.");
  }
};

// Thrown errors are WorkspaceError; the service turns them into typed failures.
export function saveArea(
  snapshot: WorkspaceSnapshot,
  input: WorkspaceSaveAreaInput,
  newId: WorkspaceAreaId,
  now: string,
): { readonly snapshot: WorkspaceSnapshot; readonly area: WorkspaceArea } {
  const existing =
    input.areaId === undefined
      ? undefined
      : snapshot.areas.find((area) => area.id === input.areaId);
  if (input.areaId !== undefined && existing === undefined)
    throw notFound("That area doesn't exist.");
  const name = input.name.trim();
  if (
    snapshot.areas.some(
      (area) => area.id !== existing?.id && area.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw invalid("An area with this name already exists.");
  }
  const projectRefs = [
    ...new Map(
      input.projectRefs.map((ref) => [`${ref.environmentId}\u0000${ref.projectId}`, ref]),
    ).values(),
  ];
  const area: WorkspaceArea = {
    id: existing?.id ?? input.areaId ?? newId,
    name,
    projectRefs,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    area,
    snapshot: {
      ...snapshot,
      areas: existing
        ? snapshot.areas.map((candidate) => (candidate.id === area.id ? area : candidate))
        : [...snapshot.areas, area],
    },
  };
}

export function deleteArea(
  snapshot: WorkspaceSnapshot,
  areaId: WorkspaceAreaId,
  now: string,
): WorkspaceSnapshot {
  if (!snapshot.areas.some((area) => area.id === areaId))
    throw notFound("That area doesn't exist.");
  const rehome = (filing: WorkspaceFiling): WorkspaceFiling =>
    filing.location._tag === "Area" && filing.location.areaId === areaId
      ? {
          location: INBOX,
          filedBy: { _tag: "Auto" },
          reason: "Its area was removed.",
          filedAt: now,
        }
      : filing;
  return {
    areas: snapshot.areas.filter((area) => area.id !== areaId),
    items: snapshot.items.map((item) => {
      const filing = rehome(item.filing);
      return filing === item.filing ? item : { ...item, filing, updatedAt: now };
    }),
    threadFilings: snapshot.threadFilings.map((entry) => ({
      ...entry,
      filing: rehome(entry.filing),
    })),
  };
}

export function createItem(
  snapshot: WorkspaceSnapshot,
  input: WorkspaceCreateItemInput,
  actor: WorkspaceActor,
  newId: WorkspaceItemId,
  now: string,
): { readonly snapshot: WorkspaceSnapshot; readonly item: WorkspaceItem } {
  const status = input.status ?? WORKSPACE_ITEM_STATUSES[input.kind][0];
  if (!statusFits(input.kind, status)) {
    throw invalid(`A ${input.kind} can't be "${status}".`);
  }
  const location = input.location ?? INBOX;
  checkLocation(snapshot, location);
  const replaced =
    input.replacesId === undefined
      ? undefined
      : snapshot.items.find((item) => item.id === input.replacesId);
  if (input.replacesId !== undefined) {
    if (replaced === undefined) throw notFound("The decision it replaces doesn't exist.");
    if (input.kind !== "decision" || replaced.kind !== "decision") {
      throw invalid("Only a decision can replace another decision.");
    }
  }
  const item: WorkspaceItem = {
    id: newId,
    kind: input.kind,
    title: input.title,
    body: input.body ?? "",
    status,
    filing: {
      location,
      filedBy: actor,
      reason: input.reason ?? defaultReason(actor),
      filedAt: now,
    },
    ...(input.source === undefined ? {} : { source: input.source }),
    createdBy: actor,
    ...(input.replacesId === undefined ? {} : { replacesId: input.replacesId }),
    createdAt: now,
    updatedAt: now,
  };
  const items = snapshot.items.map((candidate) =>
    candidate.id === replaced?.id
      ? { ...candidate, status: "replaced" as const, updatedAt: now }
      : candidate,
  );
  return { item, snapshot: { ...snapshot, items: [...items, item] } };
}

export function updateItem(
  snapshot: WorkspaceSnapshot,
  input: WorkspaceUpdateItemInput,
  now: string,
): { readonly snapshot: WorkspaceSnapshot; readonly item: WorkspaceItem } {
  const existing = snapshot.items.find((item) => item.id === input.itemId);
  if (existing === undefined) throw notFound("That item doesn't exist.");
  if (input.status !== undefined && !statusFits(existing.kind, input.status)) {
    throw invalid(`A ${existing.kind} can't be "${input.status}".`);
  }
  const item: WorkspaceItem = {
    ...existing,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.status === undefined ? {} : { status: input.status }),
    updatedAt: now,
  };
  return {
    item,
    snapshot: {
      ...snapshot,
      items: snapshot.items.map((candidate) => (candidate.id === item.id ? item : candidate)),
    },
  };
}

export function deleteItem(
  snapshot: WorkspaceSnapshot,
  itemId: WorkspaceItemId,
): WorkspaceSnapshot {
  if (!snapshot.items.some((item) => item.id === itemId))
    throw notFound("That item doesn't exist.");
  return {
    ...snapshot,
    items: snapshot.items
      .filter((item) => item.id !== itemId)
      .map(({ replacesId, ...item }) =>
        replacesId === undefined || replacesId === itemId ? item : { ...item, replacesId },
      ),
  };
}

// Automatic filing never overrides a choice a person or agent made.
const autoMayRefile = (current: WorkspaceFiling | undefined, actor: WorkspaceActor) =>
  actor._tag !== "Auto" || current === undefined || current.filedBy._tag === "Auto";

export function file(
  snapshot: WorkspaceSnapshot,
  input: WorkspaceFileInput & { readonly suggestion?: WorkspaceFiling["suggestion"] },
  actor: WorkspaceActor,
  now: string,
): WorkspaceSnapshot {
  checkLocation(snapshot, input.location);
  const filing: WorkspaceFiling = {
    location: input.location,
    filedBy: actor,
    reason: input.reason ?? defaultReason(actor),
    ...(input.suggestion === undefined ? {} : { suggestion: input.suggestion }),
    filedAt: now,
  };
  const target = input.target;
  if (target._tag === "Item") {
    const existing = snapshot.items.find((item) => item.id === target.itemId);
    if (existing === undefined) throw notFound("That item doesn't exist.");
    if (!autoMayRefile(existing.filing, actor)) return snapshot;
    return {
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.id === existing.id ? { ...item, filing, updatedAt: now } : item,
      ),
    };
  }
  const current = snapshot.threadFilings.find((entry) => entry.threadId === target.threadId);
  if (!autoMayRefile(current?.filing, actor)) return snapshot;
  return {
    ...snapshot,
    threadFilings: [
      ...snapshot.threadFilings.filter((entry) => entry.threadId !== target.threadId),
      { threadId: target.threadId, filing },
    ],
  };
}
