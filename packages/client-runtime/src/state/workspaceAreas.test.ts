import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { projectBelongsToWorkspaceArea, updateWorkspaceAreaProjectRefs } from "./workspaceAreas.ts";

const local = { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("same") };
const remote = { environmentId: EnvironmentId.make("remote"), projectId: ProjectId.make("same") };

describe("workspace areas", () => {
  it("matches stable project identities across grouping changes without confusing machines", () => {
    const area = { projectRefs: [local] };
    expect(projectBelongsToWorkspaceArea(area, [remote])).toBe(false);
    expect(projectBelongsToWorkspaceArea(area, [remote, local])).toBe(true);
  });

  it("changes a visible workspace group while preserving disconnected memberships", () => {
    expect(updateWorkspaceAreaProjectRefs([local, remote], [local], false)).toEqual([remote]);
    expect(updateWorkspaceAreaProjectRefs([remote], [local], true)).toEqual([remote, local]);
  });
});
