import type { ScopedProjectRef } from "@t3tools/contracts";
import type { SidebarWorkspaceArea } from "@t3tools/contracts/settings";

const projectKey = (ref: ScopedProjectRef) => JSON.stringify([ref.environmentId, ref.projectId]);

export function projectBelongsToWorkspaceArea(
  area: Pick<SidebarWorkspaceArea, "projectRefs">,
  projectRefs: ReadonlyArray<ScopedProjectRef>,
): boolean {
  const members = new Set(area.projectRefs.map(projectKey));
  return projectRefs.some((ref) => members.has(projectKey(ref)));
}

export function updateWorkspaceAreaProjectRefs(
  current: ReadonlyArray<ScopedProjectRef>,
  projectRefs: ReadonlyArray<ScopedProjectRef>,
  include: boolean,
): ScopedProjectRef[] {
  const affected = new Set(projectRefs.map(projectKey));
  const next = current.filter((ref) => !affected.has(projectKey(ref)));
  return include
    ? [...next, ...new Map(projectRefs.map((ref) => [projectKey(ref), ref])).values()]
    : next;
}

export function saveWorkspaceArea(
  areas: ReadonlyArray<SidebarWorkspaceArea>,
  draft: Omit<SidebarWorkspaceArea, "collapsed">,
): SidebarWorkspaceArea[] {
  const name = draft.name.trim();
  if (!name || name.length > 80) throw new Error("Use an area name between 1 and 80 characters.");
  if (
    areas.some((area) => area.id !== draft.id && area.name.toLowerCase() === name.toLowerCase())
  ) {
    throw new Error("An area with this name already exists.");
  }
  const existing = areas.find((area) => area.id === draft.id);
  const next = {
    ...draft,
    name,
    projectRefs: [...new Map(draft.projectRefs.map((ref) => [projectKey(ref), ref])).values()],
    collapsed: existing?.collapsed ?? false,
  };
  return existing ? areas.map((area) => (area.id === draft.id ? next : area)) : [...areas, next];
}

export function removeWorkspaceArea(
  areas: ReadonlyArray<SidebarWorkspaceArea>,
  id: string,
): SidebarWorkspaceArea[] {
  return areas.filter((area) => area.id !== id);
}

export function setWorkspaceAreaCollapsed(
  areas: ReadonlyArray<SidebarWorkspaceArea>,
  id: string,
  collapsed: boolean,
): SidebarWorkspaceArea[] {
  return areas.map((area) => (area.id === id ? { ...area, collapsed } : area));
}
