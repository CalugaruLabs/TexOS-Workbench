import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type SidebarWorkspaceArea,
} from "@t3tools/contracts/settings";
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
const career: SidebarWorkspaceArea = {
  id: "career",
  name: "Career",
  collapsed: false,
  projectRefs: [...project.memberProjectRefs],
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

function setup(areas: SidebarWorkspaceArea[] = []) {
  __resetClientSettingsPersistenceForTests();
  state.saved = {
    ...DEFAULT_CLIENT_SETTINGS,
    timestampFormat: "24-hour",
    sidebarWorkspaceAreas: areas,
  };
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
  expect(state.saved?.sidebarWorkspaceAreas).toEqual([
    expect.objectContaining({ name: "Career", projectRefs: project.memberProjectRefs }),
  ]);
  expect(state.saved?.timestampFormat).toBe("24-hour");

  await page.getByRole("button", { name: "Show chats in Alpha", exact: true }).first().click();
  expect(state.select).toHaveBeenCalledWith(project.projectKey);
  await page.getByRole("button", { name: "Show all project chats" }).click();
  expect(state.select).toHaveBeenLastCalledWith(null);

  await page.getByRole("button", { name: "Area Career", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Area Career", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await screen.unmount();
  __resetClientSettingsPersistenceForTests();
  await using _restored = await render(<Navigation />);
  await expect
    .element(page.getByRole("button", { name: "Area Career", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Area Career", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Show chats in Alpha" }).first())
    .toBeVisible();
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
  expect(state.saved?.sidebarWorkspaceAreas[0]?.name).toBe("Work");
  await page.getByRole("button", { name: "Remove area", exact: true }).click();
  await page.getByRole("button", { name: "Remove area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.saved?.sidebarWorkspaceAreas).toEqual([]);
  await expect.element(page.getByRole("button", { name: "Show chats in Alpha" })).toBeVisible();
  await page.getByRole("button", { name: "Add project to workspace" }).click();
  expect(state.addProject).toHaveBeenCalledOnce();
});

it("retains the draft when saving fails and allows retry without claiming it was saved", async () => {
  setup();
  state.persist.mockRejectedValueOnce(new Error("Storage is full"));
  await using _screen = await render(<Navigation />);
  await page.getByRole("button", { name: "Add area", exact: true }).click();
  await page.getByRole("textbox", { name: "Area name" }).fill("Career");
  await page.getByRole("button", { name: "Create area", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Storage is full");
  expect(state.saved?.sidebarWorkspaceAreas).toEqual([]);
  await expect.element(page.getByRole("textbox", { name: "Area name" })).toHaveValue("Career");
  await page.getByRole("button", { name: "Create area", exact: true }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(state.saved?.sidebarWorkspaceAreas).toHaveLength(1);
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
    .element(page.getByRole("button", { name: "Show chats in Project 9", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Show all projects in project list" }).click();
  await page.getByRole("button", { name: "Show chats in Project 9", exact: true }).click();
  expect(state.select).toHaveBeenLastCalledWith("group-9");
  await page.getByRole("button", { name: "Show fewer projects in project list" }).click();
  await expect
    .element(page.getByRole("button", { name: "Show chats in Project 9", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(page.getByRole("button", { name: "Show chats in Project 8", exact: true }))
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
  expect(state.saved?.sidebarWorkspaceAreas[0]?.projectRefs).toEqual([remoteRef]);

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
    .element(page.getByRole("button", { name: "Show chats in Remote project" }).first())
    .toBeVisible();
});
