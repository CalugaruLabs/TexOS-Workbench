import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WORKSPACE_ITEM_STATUSES,
  type EnvironmentId,
  type ProjectId,
  type WorkspaceArea,
  type WorkspaceItem,
  type WorkspaceItemKind,
  type WorkspaceLocation,
  type WorkspaceThreadFiling,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  CheckSquareIcon,
  InboxIcon,
  LayersIcon,
  LightbulbIcon,
  MessageSquareIcon,
  PlusIcon,
  ScaleIcon,
} from "lucide-react";
import { useState, type FormEvent } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useQuietThreadShells } from "../../state/entities";
import { useWorkspace, useWorkspaceItemCommands } from "../../hooks/useWorkspace";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  groupWorkspaceItems,
  isClosed,
  itemPrompt,
  locationLabel,
  type WorkspaceFilter,
} from "./workspace.logic";

const KIND_LABEL: Record<WorkspaceItemKind, string> = {
  idea: "Idea",
  task: "Task",
  decision: "Decision",
};
const KIND_ICON = { idea: LightbulbIcon, task: CheckSquareIcon, decision: ScaleIcon } as const;
const KIND_ITEMS = { all: "Everything", idea: "Ideas", task: "Tasks", decision: "Decisions" };

const locationKey = (location: WorkspaceLocation) =>
  location._tag === "Inbox"
    ? "inbox"
    : location._tag === "Area"
      ? `area:${location.areaId}`
      : `project:${location.projectId}`;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

interface WorkspaceContext {
  readonly environmentId: EnvironmentId;
  readonly areas: ReadonlyArray<WorkspaceArea>;
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
  readonly projectFor: (projectId: ProjectId) => SidebarProjectSnapshot | undefined;
  readonly commands: ReturnType<typeof useWorkspaceItemCommands>;
}

export function WorkspacePage() {
  const { environmentId, workspace, areas } = useWorkspace();
  const projects = useSidebarProjectGroups();
  const [filter, setFilter] = useState<WorkspaceFilter>({
    kind: "all",
    query: "",
    showClosed: false,
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Workspace breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>Workspace</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <div>
              <h1 className="text-2xl font-semibold">Workspace</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ideas, tasks and decisions from your chats, filed where they belong.
              </p>
            </div>
            {environmentId === null || workspace === null ? (
              <p className="text-sm text-muted-foreground">Connecting to your workspace…</p>
            ) : (
              <WorkspaceBody
                filter={filter}
                onFilterChange={setFilter}
                context={{
                  environmentId,
                  areas,
                  projects,
                  projectFor: (projectId) =>
                    projects.find((project) =>
                      project.memberProjectRefs.some(
                        (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
                      ),
                    ),
                }}
                view={groupWorkspaceItems(workspace, environmentId, filter)}
                inboxChats={workspace.threadFilings.filter(
                  (entry) => entry.filing.location._tag === "Inbox",
                )}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function WorkspaceBody({
  filter,
  onFilterChange,
  context: partial,
  view,
  inboxChats,
}: {
  readonly filter: WorkspaceFilter;
  readonly onFilterChange: (filter: WorkspaceFilter) => void;
  readonly context: Omit<WorkspaceContext, "commands">;
  readonly view: ReturnType<typeof groupWorkspaceItems>;
  readonly inboxChats: ReadonlyArray<WorkspaceThreadFiling>;
}) {
  const commands = useWorkspaceItemCommands(partial.environmentId);
  const context = { ...partial, commands };
  const empty =
    inboxChats.length === 0 &&
    view.inbox.length === 0 &&
    view.elsewhere.length === 0 &&
    view.areas.every((entry) => entry.items.length === 0);

  return (
    <>
      {commands.canWrite ? <NewItemForm context={context} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-40">
          <Select
            value={filter.kind}
            items={KIND_ITEMS}
            onValueChange={(value) => {
              if (value === "all" || value === "idea" || value === "task" || value === "decision") {
                onFilterChange({ ...filter, kind: value });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label="Show">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(KIND_ITEMS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <Input
            aria-label="Search the workspace"
            placeholder="Search"
            size="sm"
            value={filter.query}
            onChange={(event) => onFilterChange({ ...filter, query: event.currentTarget.value })}
          />
        </div>
        <Label>
          <Checkbox
            checked={filter.showClosed}
            onCheckedChange={(checked) => onFilterChange({ ...filter, showClosed: checked })}
          />
          Show finished
        </Label>
      </div>
      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing here yet</EmptyTitle>
            <EmptyDescription>
              Ideas, tasks and decisions you or your agents save will show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <InboxChats filings={inboxChats} context={context} />
      <ItemSection
        id="inbox"
        icon={InboxIcon}
        title="Inbox"
        hint="Not sure where these belong yet. Move each one to its home."
        items={view.inbox}
        context={context}
      />
      {view.areas.map(({ area, items }) => (
        <ItemSection
          key={area.id}
          id={`area-${area.id}`}
          icon={LayersIcon}
          title={area.name}
          items={items}
          context={context}
        />
      ))}
      <ItemSection
        id="elsewhere"
        icon={LayersIcon}
        title="Projects outside an area"
        items={view.elsewhere}
        context={context}
      />
    </>
  );
}

function InboxChats({
  filings,
  context,
}: {
  readonly filings: ReadonlyArray<WorkspaceThreadFiling>;
  readonly context: WorkspaceContext;
}) {
  const threads = useQuietThreadShells();
  const { environmentId, areas, projectFor, commands } = context;
  const entries = filings.flatMap((entry) => {
    const thread = threads.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === entry.threadId,
    );
    return thread === undefined || thread.archivedAt !== null ? [] : [{ ...entry, thread }];
  });
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="workspace-inbox-chats">
      <h2
        id="workspace-inbox-chats"
        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <InboxIcon aria-hidden className="size-3.5" />
        Chats to file · {entries.length}
      </h2>
      <ul className="flex flex-col divide-y rounded-lg border">
        {entries.map(({ threadId, filing, thread }) => {
          const suggestion = filing.suggestion;
          const suggested =
            suggestion === undefined || suggestion.location._tag === "Inbox"
              ? undefined
              : locationLabel(
                  suggestion.location,
                  areas,
                  (projectId) => projectFor(projectId)?.displayName,
                );
          return (
            <li key={threadId} className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:px-4">
              <MessageSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
                  className="text-sm font-medium underline-offset-2 hover:underline"
                >
                  {thread.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {suggested !== undefined
                    ? `Maybe ${suggested}: ${suggestion?.reason}`
                    : suggestion?.newProjectName !== undefined
                      ? `Maybe a new project, "${suggestion.newProjectName}"`
                      : filing.reason}
                </p>
              </div>
              {commands.canWrite && suggestion !== undefined && suggested !== undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void commands
                      .file({
                        target: { _tag: "Thread", threadId },
                        location: suggestion.location,
                        reason: suggestion.reason,
                      })
                      .then((result) => reportFailure("Could not file the chat", result))
                  }
                >
                  File in {suggested}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NewItemForm({ context }: { readonly context: WorkspaceContext }) {
  const [kind, setKind] = useState<WorkspaceItemKind>("task");
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || title.trim().length === 0) return;
    setSaving(true);
    const result = await context.commands.createItem({ kind, title: title.trim() });
    setSaving(false);
    if (result._tag === "Success") setTitle("");
    reportFailure("Could not add the item", result);
  };

  return (
    <form
      className="flex items-center gap-2 rounded-xl border bg-card p-2"
      onSubmit={(event) => void add(event)}
    >
      <div className="w-36 shrink-0">
        <Select
          value={kind}
          items={KIND_LABEL}
          onValueChange={(value) => {
            if (value === "idea" || value === "task" || value === "decision") setKind(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="min-w-0 flex-1">
        <Input
          aria-label="New item"
          placeholder="Add an idea, task or decision. It lands in the Inbox."
          size="sm"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.currentTarget.value)}
        />
      </div>
      <Button type="submit" size="sm" disabled={saving || title.trim().length === 0}>
        <PlusIcon className="size-4" />
        Add
      </Button>
    </form>
  );
}

function ItemSection({
  id,
  icon: Icon,
  title,
  hint,
  items,
  context,
}: {
  readonly id: string;
  readonly icon: typeof InboxIcon;
  readonly title: string;
  readonly hint?: string;
  readonly items: ReadonlyArray<WorkspaceItem>;
  readonly context: WorkspaceContext;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={`workspace-${id}`}>
      <h2
        id={`workspace-${id}`}
        className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <Icon aria-hidden className="size-3.5" />
        {title} · {items.length}
      </h2>
      {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border">
        {items.map((item) => (
          <WorkspaceItemRow key={item.id} item={item} context={context} />
        ))}
      </ul>
    </section>
  );
}

function WorkspaceItemRow({
  item,
  context,
}: {
  readonly item: WorkspaceItem;
  readonly context: WorkspaceContext;
}) {
  const { environmentId, areas, projects, projectFor, commands } = context;
  const handleNewThread = useNewThreadHandler();
  const Icon = KIND_ICON[item.kind];
  const location = item.filing.location;
  const filedIn = locationLabel(location, areas, (projectId) => projectFor(projectId)?.displayName);
  const moveTargets = new Map<string, { readonly label: string; readonly to: WorkspaceLocation }>([
    ["inbox", { label: "Inbox", to: { _tag: "Inbox" } }],
    ...areas.map((area) => {
      const to: WorkspaceLocation = { _tag: "Area", areaId: area.id };
      return [locationKey(to), { label: area.name, to }] as const;
    }),
    ...projects.flatMap((project) =>
      project.memberProjectRefs
        .filter((ref) => ref.environmentId === environmentId)
        .map((ref) => {
          const to: WorkspaceLocation = { _tag: "Project", projectId: ref.projectId };
          return [locationKey(to), { label: project.displayName, to }] as const;
        }),
    ),
  ]);
  if (!moveTargets.has(locationKey(location))) {
    moveTargets.set(locationKey(location), { label: filedIn, to: location });
  }
  const statuses = WORKSPACE_ITEM_STATUSES[item.kind] as ReadonlyArray<WorkspaceItem["status"]>;

  const move = async (to: WorkspaceLocation) => {
    reportFailure(
      "Could not move the item",
      await commands.file({ target: { _tag: "Item", itemId: item.id }, location: to }),
    );
  };

  const startChat = async () => {
    const startIn =
      location._tag === "Project"
        ? projectFor(location.projectId)
        : location._tag === "Area"
          ? projects.find((project) =>
              areas
                .find((area) => area.id === location.areaId)
                ?.projectRefs.some((ref) =>
                  project.memberProjectRefs.some(
                    (member) =>
                      member.environmentId === ref.environmentId &&
                      member.projectId === ref.projectId,
                  ),
                ),
            )
          : undefined;
    const project = startIn ?? projects[0];
    if (project === undefined) return;
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    if (opened !== null)
      useComposerDraftStore.getState().setPrompt(opened.draftId, itemPrompt(item));
  };

  return (
    <li className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
      <Icon
        aria-label={KIND_LABEL[item.kind]}
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-start">
        <div className="min-w-0 flex-1">
          <p
            className={
              isClosed(item) ? "text-sm text-muted-foreground line-through" : "text-sm font-medium"
            }
          >
            {item.title}
          </p>
          {item.body.length > 0 ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.body}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {filedIn}
            {item.filing.reason.length > 0 ? ` · ${item.filing.reason}` : ""}
            {" · "}
            {formatRelativeTimeLabel(item.updatedAt)}
            {item.source ? (
              <>
                {" · "}
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams(
                    scopeThreadRef(environmentId, item.source.threadId),
                  )}
                  className="underline-offset-2 hover:underline"
                >
                  From a chat
                </Link>
              </>
            ) : null}
          </p>
        </div>
        {commands.canWrite ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div className="w-36">
              <Select
                value={item.status}
                items={Object.fromEntries(statuses.map((status) => [status, status]))}
                onValueChange={(value) => {
                  const status = statuses.find((candidate) => candidate === value);
                  if (status === undefined) return;
                  void commands
                    .updateItem({ itemId: item.id, status })
                    .then((result) => reportFailure("Could not update the item", result));
                }}
              >
                <SelectTrigger size="sm" aria-label={`Status of ${item.title}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {statuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {status}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="w-40">
              <Select
                value={locationKey(location)}
                items={Object.fromEntries(
                  [...moveTargets].map(([key, target]) => [key, target.label]),
                )}
                onValueChange={(value) => {
                  const target = typeof value === "string" ? moveTargets.get(value) : undefined;
                  if (target !== undefined && value !== locationKey(location)) void move(target.to);
                }}
              >
                <SelectTrigger size="sm" aria-label={`Move ${item.title}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {[...moveTargets].map(([value, target]) => (
                    <SelectItem key={value} value={value}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Start a chat about ${item.title}`}
              onClick={() => void startChat()}
            >
              <MessageSquareIcon className="size-4" />
              Chat
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
