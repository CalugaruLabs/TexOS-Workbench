import type { ScopedProjectRef, WorkspaceArea } from "@t3tools/contracts";

const projectKey = (ref: ScopedProjectRef) => JSON.stringify([ref.environmentId, ref.projectId]);

export function projectBelongsToWorkspaceArea(
  area: Pick<WorkspaceArea, "projectRefs">,
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
