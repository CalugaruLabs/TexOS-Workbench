import {
  projectBelongsToWorkspaceArea,
  updateWorkspaceAreaProjectRefs,
} from "@t3tools/client-runtime/state/workspace-areas";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef, WorkspaceAreaId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  LayersIcon,
  PencilIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import {
  useMigrateDeviceAreas,
  useWorkspace,
  useWorkspaceAreaCommands,
} from "../../hooks/useWorkspace";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "../ui/sidebar";

interface WorkspaceNavigationProps {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedProjectKey: string | null;
  readonly onSelectProject: (projectKey: string | null) => void;
  readonly onAddProject: () => void;
}

interface AreaDraft {
  readonly id?: WorkspaceAreaId;
  readonly name: string;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error
    ? error.message
    : "Your organization could not be saved. Try again.";
}

export function SidebarWorkspaceNavigation({
  projects,
  selectedProjectKey,
  onSelectProject,
  onAddProject,
}: WorkspaceNavigationProps) {
  useMigrateDeviceAreas();
  const { environmentId, areas } = useWorkspace();
  const collapsedIds = useClientSettings((settings) => settings.sidebarCollapsedAreaIds);
  const hydrated = useClientSettingsHydrated();
  const [editor, setEditor] = useState<AreaDraft | null>(null);
  const [pendingAreaId, setPendingAreaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleArea = async (areaId: WorkspaceAreaId, collapsed: boolean) => {
    if (pendingAreaId !== null) return;
    setPendingAreaId(areaId);
    setError(null);
    const result = await settlePromise(() =>
      persistClientSettingsUpdate((current) => ({
        ...current,
        sidebarCollapsedAreaIds: collapsed
          ? current.sidebarCollapsedAreaIds.filter((id) => id !== areaId)
          : [...current.sidebarCollapsedAreaIds, areaId],
      })),
    );
    setPendingAreaId(null);
    if (result._tag === "Failure") setError(failureMessage(result));
  };

  return (
    <nav aria-label="Areas and projects">
      <SidebarGroup>
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs font-medium text-sidebar-muted-foreground">Areas</h2>
          <Button
            aria-label="Add area"
            disabled={environmentId === null}
            onClick={() => setEditor({ name: "", projectRefs: [] })}
            size="icon-xs"
            variant="ghost-muted"
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
        <SidebarMenu>
          {areas.map((area) => {
            const collapsed = collapsedIds.includes(area.id);
            const members = projects.filter((project) =>
              projectBelongsToWorkspaceArea(area, project.memberProjectRefs),
            );
            const unavailable = members.length === 0 && area.projectRefs.length > 0;
            return (
              <SidebarMenuItem key={area.id}>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <SidebarMenuButton
                      aria-label={`Area ${area.name}`}
                      aria-controls={`workspace-area-${area.id}`}
                      aria-expanded={!collapsed}
                      disabled={pendingAreaId !== null || !hydrated}
                      onClick={() => void toggleArea(area.id, collapsed)}
                      size="sm"
                    >
                      <LayersIcon aria-hidden />
                      <span>{area.name}</span>
                      <span className="ml-auto text-xs text-sidebar-muted-foreground">
                        {unavailable ? null : members.length}
                      </span>
                      {collapsed ? (
                        <ChevronRightIcon aria-hidden />
                      ) : (
                        <ChevronDownIcon aria-hidden />
                      )}
                    </SidebarMenuButton>
                  </div>
                  <Button
                    aria-label={`Edit area ${area.name}`}
                    disabled={pendingAreaId !== null}
                    onClick={() => setEditor(area)}
                    size="icon-xs"
                    variant="ghost-muted"
                  >
                    <PencilIcon aria-hidden />
                  </Button>
                </div>
                {!collapsed ? (
                  <SidebarMenuSub id={`workspace-area-${area.id}`}>
                    <WorkspaceProjectRows
                      projects={members}
                      selectedProjectKey={selectedProjectKey}
                      onSelectProject={onSelectProject}
                      label={area.name}
                      nested
                    />
                    {members.length === 0 ? (
                      <SidebarMenuSubItem>
                        {unavailable ? (
                          <p className="py-1 text-xs text-sidebar-muted-foreground">
                            Linked projects aren't available here.
                          </p>
                        ) : null}
                        <Button onClick={() => setEditor(area)} size="xs" variant="ghost-muted">
                          {unavailable ? "Manage projects" : "Choose projects"}
                        </Button>
                      </SidebarMenuSubItem>
                    ) : null}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        {areas.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
            Group projects into areas.
          </p>
        ) : null}
        {error ? (
          <p className="px-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </SidebarGroup>
      <SidebarGroup>
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs font-medium text-sidebar-muted-foreground">Projects</h2>
          <Button
            aria-label="Add project to workspace"
            onClick={onAddProject}
            size="icon-xs"
            variant="ghost-muted"
          >
            <PlusIcon aria-hidden />
          </Button>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-label="Show all project chats"
              isActive={selectedProjectKey === null}
              onClick={() => onSelectProject(null)}
              size="sm"
            >
              <FolderIcon aria-hidden />
              <span>All projects</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <WorkspaceProjectRows
            projects={projects}
            selectedProjectKey={selectedProjectKey}
            onSelectProject={onSelectProject}
            label="project list"
          />
        </SidebarMenu>
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-muted-foreground">
            Add a project to get started.
          </p>
        ) : null}
      </SidebarGroup>
      {editor && environmentId !== null ? (
        <WorkspaceAreaEditor
          key={editor.id ?? "new"}
          environmentId={environmentId}
          area={editor}
          projects={projects}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </nav>
  );
}

function WorkspaceProjectRows({
  projects,
  selectedProjectKey,
  onSelectProject,
  label,
  nested = false,
}: Pick<WorkspaceNavigationProps, "projects" | "selectedProjectKey" | "onSelectProject"> & {
  readonly label: string;
  readonly nested?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const preview = projects.slice(0, 6);
  const selected = projects.find((project) => project.projectKey === selectedProjectKey);
  const shown = showAll
    ? projects
    : selected && !preview.includes(selected)
      ? [...preview, selected]
      : preview;
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;

  return (
    <>
      {shown.map((project) => (
        <Item key={project.projectKey}>
          <SidebarMenuButton
            aria-label={`Open ${project.displayName}`}
            aria-current={selectedProjectKey === project.projectKey ? "page" : undefined}
            isActive={selectedProjectKey === project.projectKey}
            onClick={() => onSelectProject(project.projectKey)}
            size="sm"
            title={project.workspaceRoot}
          >
            <FolderIcon aria-hidden />
            <span>{project.displayName}</span>
          </SidebarMenuButton>
        </Item>
      ))}
      {(showAll ? projects.length > 6 : projects.length > shown.length) ? (
        <Item>
          <SidebarMenuButton
            aria-label={`${showAll ? "Show fewer" : "Show all"} projects in ${label}`}
            onClick={() => setShowAll(!showAll)}
            size="sm"
          >
            <ChevronDownIcon aria-hidden />
            <span>{showAll ? "Show fewer" : `Show ${projects.length - shown.length} more`}</span>
          </SidebarMenuButton>
        </Item>
      ) : null}
    </>
  );
}

function WorkspaceAreaEditor({
  environmentId,
  area,
  projects,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly area: AreaDraft;
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly onClose: () => void;
}) {
  const isNew = area.id === undefined;
  const { canWrite, saveArea, deleteArea } = useWorkspaceAreaCommands(environmentId);
  const [name, setName] = useState(area.name);
  const [projectRefs, setProjectRefs] = useState(area.projectRefs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  const finish = (result: AtomCommandResult<unknown, unknown>) => {
    setSaving(false);
    if (result._tag === "Success") onClose();
    else if (!isAtomCommandInterrupted(result)) setError(failureMessage(result));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    finish(
      await saveArea({ ...(area.id === undefined ? {} : { areaId: area.id }), name, projectRefs }),
    );
  };

  const remove = async () => {
    if (saving || area.id === undefined) return;
    setSaving(true);
    setError(null);
    finish(await deleteArea(area.id));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup showCloseButton={!saving}>
        <form onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>
              {confirmRemoval ? "Remove area?" : isNew ? "New area" : "Edit area"}
            </DialogTitle>
            <DialogDescription>
              {confirmRemoval
                ? "Your projects, chats and files will stay in All projects."
                : "Organize related projects together. Synced with your workspace."}
            </DialogDescription>
          </DialogHeader>
          {!confirmRemoval ? (
            <div className="grid gap-4 px-6 pb-5">
              <div className="grid gap-2">
                <Label htmlFor="workspace-area-name">Area name</Label>
                <Input
                  autoFocus
                  id="workspace-area-name"
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  placeholder="For example, Career or Personal"
                  disabled={saving}
                />
              </div>
              <fieldset disabled={saving} className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Projects in this area</legend>
                <div className="grid max-h-64 gap-2 overflow-y-auto">
                  {projects.map((project) => (
                    <Label key={project.projectKey}>
                      <Checkbox
                        checked={projectBelongsToWorkspaceArea(
                          { projectRefs },
                          project.memberProjectRefs,
                        )}
                        onCheckedChange={(checked) =>
                          setProjectRefs((current) =>
                            updateWorkspaceAreaProjectRefs(
                              current,
                              project.memberProjectRefs,
                              checked,
                            ),
                          )
                        }
                      />
                      <span className="min-w-0 truncate">{project.displayName}</span>
                    </Label>
                  ))}
                </div>
                {projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    You can add projects to this area later.
                  </p>
                ) : null}
              </fieldset>
              <p className="text-xs text-muted-foreground">
                A project can belong to more than one area. Its files stay where they are.
              </p>
            </div>
          ) : null}
          {error ? (
            <p className="px-6 pb-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            {!isNew && !confirmRemoval ? (
              <div className="mr-auto">
                <Button
                  disabled={saving}
                  onClick={() => setConfirmRemoval(true)}
                  type="button"
                  variant="ghost-muted"
                >
                  Remove area
                </Button>
              </div>
            ) : null}
            <Button
              disabled={saving}
              onClick={confirmRemoval ? () => setConfirmRemoval(false) : onClose}
              type="button"
              variant="outline"
            >
              {confirmRemoval ? "Keep area" : "Cancel"}
            </Button>
            {confirmRemoval ? (
              <Button
                disabled={saving}
                onClick={() => void remove()}
                type="button"
                variant="destructive"
              >
                {saving ? "Removing…" : "Remove area"}
              </Button>
            ) : (
              <Button disabled={saving || !canWrite || name.trim().length === 0} type="submit">
                {saving ? "Saving…" : isNew ? "Create area" : "Save area"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
