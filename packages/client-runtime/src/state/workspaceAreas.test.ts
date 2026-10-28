import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { SidebarWorkspaceArea } from "@t3tools/contracts/settings";

import {
  projectBelongsToWorkspaceArea,
  removeWorkspaceArea,
  saveWorkspaceArea,
  setWorkspaceAreaCollapsed,
  updateWorkspaceAreaProjectRefs,
} from "./workspaceAreas.ts";

const local = { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("same") };
const remote = { environmentId: EnvironmentId.make("remote"), projectId: ProjectId.make("same") };
const area: SidebarWorkspaceArea = {
  id: "work",
  name: "Work",
  projectRefs: [local],
  collapsed: true,
};

describe("workspace areas", () => {
  it("matches stable project identities across grouping changes without confusing machines", () => {
    expect(projectBelongsToWorkspaceArea(area, [remote])).toBe(false);
    expect(projectBelongsToWorkspaceArea(area, [remote, local])).toBe(true);
  });

  it("saves a renamed area, deduplicates memberships and preserves other areas and collapse state", () => {
    const personal = { ...area, id: "personal", name: "Personal", projectRefs: [remote] };
    expect(
      saveWorkspaceArea([area, personal], {
        id: "work",
        name: "  Career  ",
        projectRefs: [local, local, remote],
      }),
    ).toEqual([{ ...area, name: "Career", projectRefs: [local, remote] }, personal]);
    expect(area.name).toBe("Work");
  });

  it("rejects blank, overlong and duplicate area names without replacing another area", () => {
    for (const name of [" ", "x".repeat(81), " work "]) {
      expect(() => saveWorkspaceArea([area], { id: "new", name, projectRefs: [] })).toThrow();
    }
    expect(saveWorkspaceArea([area], { id: "new", name: "Personal", projectRefs: [] })).toEqual([
      area,
      { id: "new", name: "Personal", projectRefs: [], collapsed: false },
    ]);
  });

  it("changes a visible workspace group while preserving disconnected memberships", () => {
    expect(updateWorkspaceAreaProjectRefs([local, remote], [local], false)).toEqual([remote]);
    expect(updateWorkspaceAreaProjectRefs([remote], [local], true)).toEqual([remote, local]);
  });

  it("allows a project in multiple areas and removes only the requested area", () => {
    const second = { ...area, id: "second", name: "Second" };
    const areas = [area, second];
    expect(removeWorkspaceArea(areas, "work")).toEqual([second]);
    expect(setWorkspaceAreaCollapsed(areas, "work", false)).toEqual([
      { ...area, collapsed: false },
      second,
    ]);
    expect(areas[0]).toBe(area);
    expect(second.projectRefs).toEqual([local]);
  });
});
