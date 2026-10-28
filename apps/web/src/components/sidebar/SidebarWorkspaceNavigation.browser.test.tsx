import {
  EnvironmentId,
  ProjectId,
  WorkspaceAreaId,
  type WorkspaceArea,
  type WorkspaceSaveAreaInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __resetClientSettingsPersistenceForTests } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarProvider } from "../ui/sidebar";
import { SidebarWorkspaceNavigation } from "./SidebarWorkspaceNavigation";
import "../../index.css";

const state = vi.hoisted(() => ({
  saved: null as ClientSettings | null,
  areas: [] as WorkspaceArea[],
  listeners: new Set<() => void>(),
  saveFailure: null as string | null,
  persist: vi.fn(),
  select: vi.fn(),
  addProject: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => state.saved,
      setClientSettings: async (settings: ClientSettings) => {
        await state.persist(settings);
        state.saved = settings;
      },
    },
  }),
}));

// Stands in for the server workspace: commands change the areas every subscriber sees.
vi.mock("~/hooks/useWorkspace", async () => {
  const { useSyncExternalStore } = await import("react");
  const setAreas = (areas: WorkspaceArea[]) => {
    state.areas = areas;
    for (const listener of state.listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  };
  return {
    useMigrateDeviceAreas: () => undefined,
    useWorkspace: () => ({
      environmentId: "local",
      workspace: null,
      areas: useSyncExternalStore(subscribe, () => state.areas),
    }),
    useWorkspaceAreaCommands: () => ({
      canWrite: true,
      saveArea: async (input: WorkspaceSaveAreaInput) => {
        if (state.saveFailure !== null) {
          const message = state.saveFailure;
          state.saveFailure = null;
          return AsyncResult.failure(Cause.fail(new Error(message)));
        }
        const area: WorkspaceArea = {
          id: input.areaId ?? WorkspaceAreaId.make(`area-${state.areas.length + 1}`),
          name: input.name.trim(),
          projectRefs: input.projectRefs,
          createdAt: "2026-10-28T12:00:00.000Z",
          updatedAt: "2026-10-28T12:00:00.000Z",
        };
        setAreas(
          state.areas.some((candidate) => candidate.id === area.id)
            ? state.areas.map((candidate) => (candidate.id === area.id ? area : candidate))
            : [...state.areas, area],
        );
        return AsyncResult.success(area);
      },
      deleteArea: async (areaId: WorkspaceAreaId) => {
        setAreas(state.areas.filter((area) => area.id !== areaId));
        return AsyncResult.success({});
      },
    }),
  };
});

const project: SidebarProjectSnapshot = {
  id: ProjectId.make("alpha"),
  environmentId: EnvironmentId.make("local"),
  title: "Alpha",
  workspaceRoot: "/sample/alpha",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-10-26T12:00:00.000Z",
  updatedAt: "2026-10-26T12:00:00.000Z",
  scripts: [],
  projectKey: "alpha-group",
  displayName: "Alpha",
  groupedProjectCount: 1,
  environmentPresence: "local-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  memberProjects: [],
  remoteEnvironmentLabels: [],
  memberProjectRefs: [
    { environmentId: EnvironmentId.make("local"), projectId: ProjectId.make("alpha") },
  ],
};
const career: WorkspaceArea = {
  id: WorkspaceAreaId.make("career"),
  name: "Career",
  projectRefs: [...project.memberProjectRefs],
  createdAt: "2026-10-28T12:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
};

function Navigation({
  projects = [project],
}: {
  readonly projects?: ReadonlyArray<SidebarProjectSnapshot>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <SidebarProvider>
      <SidebarWorkspaceNavigation
        projects={projects}
        selectedProjectKey={selected}
        onSelectProject={(key) => {
          state.select(key);
          setSelected(key);
        }}
        onAddProject={state.addProject}
      />
    </SidebarProvider>
  );
}

function setup(areas: WorkspaceArea[] = []) {
  __resetClientSettingsPersistenceForTests();
  state.saved = { ...DEFAULT_CLIENT_SETTINGS, timestampFormat: "24-hour" };
  state.areas = areas;
  state.listeners.clear();
  state.saveFailure = null;
  state.persist.mockReset().mockResolvedValue(undefined);
  state.select.mockReset();
  state.addProject.mockReset();
}

it("creates an area with a project, selects its chats and restores the saved organization", async () => {
  setup();
  await using screen = await render(<Navigation />);
  await page.getByRole("button", { name: "Add area", exact: true }).click();
  await page.getByRole("textbox", { name: "Area name" }).fill("Career");
  await page.getByRole("checkbox", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Create area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.areas).toEqual([
    expect.objectContaining({ name: "Career", projectRefs: project.memberProjectRefs }),
  ]);

  await page.getByRole("button", { name: "Open Alpha", exact: true }).first().click();
  expect(state.select).toHaveBeenCalledWith(project.projectKey);
  await page.getByRole("button", { name: "Show all project chats" }).click();
  expect(state.select).toHaveBeenLastCalledWith(null);

  await page.getByRole("button", { name: "Area Career", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Area Career", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  expect(state.saved?.sidebarCollapsedAreaIds).toEqual([state.areas[0]?.id]);
  expect(state.saved?.timestampFormat).toBe("24-hour");
  await screen.unmount();
  __resetClientSettingsPersistenceForTests();
  await using _restored = await render(<Navigation />);
  await expect
    .element(page.getByRole("button", { name: "Area Career", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Area Career", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Open Alpha" }).first()).toBeVisible();
});

it("renames an area, can cancel removal, then removes only its organization", async () => {
  setup([career]);
  await using _screen = await render(<Navigation />);
  await page.getByRole("button", { name: "Edit area Career" }).click();
  await page.getByRole("textbox", { name: "Area name" }).fill("Work");
  await page.getByRole("button", { name: "Save area", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Edit area Work" })).toBeVisible();
  await page.getByRole("button", { name: "Edit area Work" }).click();
  await page.getByRole("button", { name: "Remove area", exact: true }).click();
  await page.getByRole("button", { name: "Keep area" }).click();
  expect(state.areas[0]?.name).toBe("Work");
  await page.getByRole("button", { name: "Remove area", exact: true }).click();
  await page.getByRole("button", { name: "Remove area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.areas).toEqual([]);
  await expect.element(page.getByRole("button", { name: "Open Alpha" })).toBeVisible();
  await page.getByRole("button", { name: "Add project to workspace" }).click();
  expect(state.addProject).toHaveBeenCalledOnce();
});

it("retains the draft when saving fails and allows retry without claiming it was saved", async () => {
  setup();
  state.saveFailure = "Storage is full";
  await using _screen = await render(<Navigation />);
  await page.getByRole("button", { name: "Add area", exact: true }).click();
  await page.getByRole("textbox", { name: "Area name" }).fill("Career");
  await page.getByRole("button", { name: "Create area", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Storage is full");
  expect(state.areas).toEqual([]);
  await expect.element(page.getByRole("textbox", { name: "Area name" })).toHaveValue("Career");
  await page.getByRole("button", { name: "Create area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.areas).toHaveLength(1);
});

it("reveals longer project lists and keeps the selected project reachable when shortened", async () => {
  setup();
  const projects = Array.from({ length: 9 }, (_, index) => ({
    ...project,
    id: ProjectId.make(`project-${index + 1}`),
    projectKey: `group-${index + 1}`,
    displayName: `Project ${index + 1}`,
  }));
  await using _screen = await render(<Navigation projects={projects} />);
  await expect
    .element(page.getByRole("button", { name: "Open Project 9", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Show all projects in project list" }).click();
  await page.getByRole("button", { name: "Open Project 9", exact: true }).click();
  expect(state.select).toHaveBeenLastCalledWith("group-9");
  await page.getByRole("button", { name: "Show fewer projects in project list" }).click();
  await expect
    .element(page.getByRole("button", { name: "Open Project 9", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(page.getByRole("button", { name: "Open Project 8", exact: true }))
    .not.toBeInTheDocument();
  await _screen.rerender(<Navigation projects={[...projects.slice(0, 6), projects[8]!]} />);
  await expect
    .element(page.getByRole("button", { name: "Show all projects in project list" }))
    .not.toBeInTheDocument();
});

it("retains unavailable project links through editing and shows them when the environment returns", async () => {
  const remoteRef = {
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("remote-project"),
  };
  setup([{ ...career, projectRefs: [remoteRef] }]);
  await using screen = await render(<Navigation />);
  await expect.element(page.getByText("Linked projects aren't available here.")).toBeVisible();
  await page.getByRole("button", { name: "Edit area Career" }).click();
  await page.getByRole("textbox", { name: "Area name" }).fill("Remote work");
  await page.getByRole("button", { name: "Save area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.areas[0]?.projectRefs).toEqual([remoteRef]);

  const remote = {
    ...project,
    environmentId: remoteRef.environmentId,
    id: remoteRef.projectId,
    projectKey: "remote-group",
    displayName: "Remote project",
    memberProjectRefs: [remoteRef],
  };
  await screen.rerender(<Navigation projects={[project, remote]} />);
  await expect
    .element(page.getByText("Linked projects aren't available here."))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Open Remote project" }).first())
    .toBeVisible();
});
