import { EnvironmentId, ProjectId, WorkspaceAreaId, type WorkspaceArea } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { SidebarProvider } from "../ui/sidebar";
import { WorkspaceAreaBreadcrumb } from "./WorkspaceAreaBreadcrumb";
import "../../index.css";

const state = vi.hoisted(() => ({
  groups: [] as { memberProjectRefs: { environmentId: string; projectId: string }[] }[],
  areas: [] as WorkspaceArea[],
  listeners: new Set<() => void>(),
}));
vi.mock("~/hooks/useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => state.groups }));
vi.mock("~/hooks/useWorkspace", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useWorkspace: () => ({ areas: useSyncExternalStore(subscribe, () => state.areas) }),
  };
});

const area = (id: string, name: string, projectRefs: WorkspaceArea["projectRefs"]) => ({
  id: WorkspaceAreaId.make(id),
  name,
  projectRefs,
  createdAt: "2026-10-28T12:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
});

function setAreas(areas: WorkspaceArea[]) {
  state.areas = areas;
  for (const listener of state.listeners) listener();
}

const local = { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("same") };
const remote = { environmentId: EnvironmentId.make("remote"), projectId: ProjectId.make("same") };
const project = { environmentId: local.environmentId, id: local.projectId, title: "Workbench" };

function Header() {
  return (
    <SidebarProvider>
      <WorkspaceBreadcrumb ariaLabel="Thread breadcrumb">
        <WorkspaceAreaBreadcrumb project={project} />
      </WorkspaceBreadcrumb>
    </SidebarProvider>
  );
}

function setup(areas: WorkspaceArea[]) {
  state.groups = [];
  state.areas = areas;
  state.listeners.clear();
}

it("shows Area context for a linked workspace in the same logical project", async () => {
  setup([area("career", "Career", [remote])]);
  state.groups = [{ memberProjectRefs: [local, remote] }];
  await using _screen = await render(<Header />);
  await expect
    .element(page.getByRole("button", { name: "Areas for Workbench: Career" }))
    .toBeVisible();
});

it("keeps unrelated environments separate and updates the visible Areas after reassignment", async () => {
  setup([area("remote", "Remote work", [remote])]);
  await using _screen = await render(<Header />);
  await expect
    .element(page.getByRole("button", { name: /Areas for Workbench/ }))
    .not.toBeInTheDocument();
  act(() => {
    setAreas([area("work", "Work", [local]), area("learning", "Learning", [local])]);
  });
  await expect
    .element(page.getByRole("button", { name: "Areas for Workbench: Work, Learning" }))
    .toHaveTextContent("Work +1");
});
