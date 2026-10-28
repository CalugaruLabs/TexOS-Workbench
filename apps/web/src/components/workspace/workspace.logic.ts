import type {
  EnvironmentId,
  ProjectId,
  WorkspaceArea,
  WorkspaceItem,
  WorkspaceItemKind,
  WorkspaceItemStatus,
  WorkspaceLocation,
  WorkspaceSnapshot,
} from "@t3tools/contracts";

export interface WorkspaceFilter {
  readonly kind: WorkspaceItemKind | "all";
  readonly query: string;
  readonly showClosed: boolean;
}

const CLOSED: ReadonlySet<WorkspaceItemStatus> = new Set(["dropped", "done", "replaced"]);

export const isClosed = (item: WorkspaceItem) => CLOSED.has(item.status);

function matches(item: WorkspaceItem, filter: WorkspaceFilter): boolean {
  if (filter.kind !== "all" && item.kind !== filter.kind) return false;
  if (!filter.showClosed && isClosed(item)) return false;
  const words = filter.query.toLowerCase().split(/\s+/u).filter(Boolean);
  const text = `${item.title}\n${item.body}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

const inArea = (area: WorkspaceArea, environmentId: EnvironmentId, location: WorkspaceLocation) =>
  location._tag === "Area"
    ? location.areaId === area.id
    : location._tag === "Project" &&
      area.projectRefs.some(
        (ref) => ref.environmentId === environmentId && ref.projectId === location.projectId,
      );

export interface WorkspaceView {
  readonly inbox: ReadonlyArray<WorkspaceItem>;
  readonly areas: ReadonlyArray<{
    readonly area: WorkspaceArea;
    readonly items: ReadonlyArray<WorkspaceItem>;
  }>;
  /** Filed in a project that belongs to no area. */
  readonly elsewhere: ReadonlyArray<WorkspaceItem>;
}

// Open work first, then newest; a project in two areas shows its items in both.
export function groupWorkspaceItems(
  snapshot: WorkspaceSnapshot,
  environmentId: EnvironmentId,
  filter: WorkspaceFilter,
): WorkspaceView {
  const items = snapshot.items
    .filter((item) => matches(item, filter))
    .toSorted(
      (left, right) =>
        Number(isClosed(left)) - Number(isClosed(right)) ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
  const areas = snapshot.areas.map((area) => ({
    area,
    items: items.filter((item) => inArea(area, environmentId, item.filing.location)),
  }));
  return {
    inbox: items.filter((item) => item.filing.location._tag === "Inbox"),
    areas,
    elsewhere: items.filter(
      (item) =>
        item.filing.location._tag === "Project" &&
        !snapshot.areas.some((area) => inArea(area, environmentId, item.filing.location)),
    ),
  };
}

export function locationLabel(
  location: WorkspaceLocation,
  areas: ReadonlyArray<WorkspaceArea>,
  projectName: (projectId: ProjectId) => string | undefined,
): string {
  switch (location._tag) {
    case "Inbox":
      return "Inbox";
    case "Area":
      return areas.find((area) => area.id === location.areaId)?.name ?? "A removed area";
    case "Project":
      return projectName(location.projectId) ?? "A project on another machine";
  }
}

const STARTERS: Record<WorkspaceItemKind, string> = {
  task: "Work on this task",
  idea: "Let's explore this idea",
  decision: "About this decision",
};

export function itemPrompt(item: Pick<WorkspaceItem, "kind" | "title" | "body">): string {
  const body = item.body.trim();
  return `${STARTERS[item.kind]}: ${item.title}${body.length > 0 ? `\n\n${body}` : ""}`;
}
