import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  persistClientSettingsUpdate,
} from "../../hooks/useSettings";
import { WorkspaceBreadcrumb } from "../WorkspaceBreadcrumb";
import { SidebarProvider } from "../ui/sidebar";
import { WorkspaceAreaBreadcrumb } from "./WorkspaceAreaBreadcrumb";
import "../../index.css";

const state = vi.hoisted(() => ({
  groups: [] as { memberProjectRefs: { environmentId: string; projectId: string }[] }[],
}));
vi.mock("~/hooks/useSidebarProjectGroups", () => ({ useSidebarProjectGroups: () => state.groups }));

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

function setup() {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, sidebarWorkspaceAreas: [] });
  state.groups = [];
}

it("shows Area context for a linked workspace in the same logical project", async () => {
  setup();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarWorkspaceAreas: [
      { id: "career", name: "Career", projectRefs: [remote], collapsed: true },
    ],
  });
  state.groups = [{ memberProjectRefs: [local, remote] }];
  await using _screen = await render(<Header />);
  await expect
    .element(page.getByRole("button", { name: "Areas for Workbench: Career" }))
    .toBeVisible();
});

it("keeps unrelated environments separate and updates the visible Areas after reassignment", async () => {
  setup();
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarWorkspaceAreas: [
      { id: "remote", name: "Remote work", projectRefs: [remote], collapsed: false },
    ],
  });
  await using _screen = await render(<Header />);
  await expect
    .element(page.getByRole("button", { name: /Areas for Workbench/ }))
    .not.toBeInTheDocument();
  await act(async () => {
    await persistClientSettingsUpdate(
      (current) => ({
        ...current,
        sidebarWorkspaceAreas: [
          { id: "work", name: "Work", projectRefs: [local], collapsed: false },
          { id: "learning", name: "Learning", projectRefs: [local], collapsed: false },
        ],
      }),
      async () => undefined,
    );
  });
  await expect
    .element(page.getByRole("button", { name: "Areas for Workbench: Work, Learning" }))
    .toHaveTextContent("Work +1");
});
