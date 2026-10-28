import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { projectBelongsToWorkspaceArea } from "@t3tools/client-runtime/state/workspace-areas";
import { Link } from "@tanstack/react-router";
import { LayersIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { cn } from "../../lib/utils";
import { useAllEnvironmentShellsBootstrapped, useQuietThreadShells } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { environmentPresentations } from "../../state/presentation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectDocsSection } from "../projectDocs/ProjectDocsSection";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  groupProjectOverviewThreads,
  PROJECT_OVERVIEW_SECTIONS,
  projectMainChatBrief,
  type ProjectOverviewThread,
} from "./projectOverview.logic";

export function ProjectOverviewPage({ projectKey }: { readonly projectKey: string }) {
  const project = useSidebarProjectGroups().find((group) => group.projectKey === projectKey);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Project breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>
                {project ? project.displayName : "Project"}
              </WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {project ? (
          <ProjectOverviewBody project={project} />
        ) : bootstrapped ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Project not found</EmptyTitle>
              <EmptyDescription>It may have been removed from this workspace.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </SidebarInset>
  );
}

export function useThreadAgentLabel() {
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  return (thread: SidebarThreadSummary) => {
    const provider = providersByEnvironment
      .get(thread.environmentId)
      ?.find((candidate) => candidate.instanceId === thread.providerInstanceId);
    return provider
      ? resolveProviderInstanceDisplayName(provider)
      : (thread.runtime?.providerName ?? thread.providerInstanceId);
  };
}

function ProjectOverviewBody({ project }: { readonly project: SidebarProjectSnapshot }) {
  const threads = useQuietThreadShells();
  const agentLabel = useThreadAgentLabel();
  const { areas } = useWorkspace();
  const handleNewThread = useNewThreadHandler();

  const sections = groupProjectOverviewThreads(threads, project.memberProjectRefs);
  const projectAreas = areas.filter((area) =>
    projectBelongsToWorkspaceArea(area, project.memberProjectRefs),
  );
  const total = Object.values(sections).reduce((sum, list) => sum + list.length, 0);
  const projectRef = scopeProjectRef(project.environmentId, project.id);

  const startMainChat = async () => {
    const opened = await handleNewThread(projectRef);
    if (opened === null) return;
    useComposerDraftStore
      .getState()
      .setPrompt(opened.draftId, projectMainChatBrief(project.displayName));
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer>
        <div className="flex items-start gap-3">
          <ProjectFavicon project={project} className="mt-1 size-5" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold">{project.displayName}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>
                {total} {total === 1 ? "thread" : "threads"}
              </span>
              {projectAreas.map((area) => (
                <span key={area.id} className="inline-flex items-center gap-1">
                  <LayersIcon aria-hidden className="size-3.5" />
                  {area.name}
                </span>
              ))}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void startMainChat()}>
            <MessagesSquareIcon className="size-4" />
            Start main chat
          </Button>
          <Button size="sm" onClick={() => void handleNewThread(projectRef)}>
            <PlusIcon className="size-4" />
            New thread
          </Button>
        </div>

        <ProjectDocsSection
          projectKey={project.projectKey}
          environmentId={project.environmentId}
          projectId={project.id}
        />

        {total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No threads yet. Start a main chat to plan the work and hand tasks to any of your agents,
            or start a thread yourself.
          </p>
        ) : (
          <>
            {sections.pinned.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Pin a thread from its menu to keep it at the top as this project's main chat.
              </p>
            ) : null}
            {PROJECT_OVERVIEW_SECTIONS.map((section) =>
              sections[section.id].length === 0 ? null : (
                <section key={section.id} aria-labelledby={`project-overview-${section.id}`}>
                  <h2
                    id={`project-overview-${section.id}`}
                    className="mb-2 text-xs font-medium text-muted-foreground"
                  >
                    {section.title} · {sections[section.id].length}
                  </h2>
                  <ul className="flex flex-col divide-y rounded-lg border">
                    {sections[section.id].map((entry) => (
                      <OverviewThreadRow
                        key={`${entry.thread.environmentId}:${entry.thread.id}`}
                        entry={entry}
                        agent={agentLabel(entry.thread)}
                      />
                    ))}
                  </ul>
                </section>
              ),
            )}
          </>
        )}
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

export function OverviewThreadRow({
  entry,
  agent,
  projectName,
}: {
  readonly entry: ProjectOverviewThread;
  readonly agent: string;
  readonly projectName?: string | undefined;
}) {
  const { thread, pill } = entry;
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
        className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden sm:px-4"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            pill ? pill.dotClass : "bg-muted-foreground/40",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
        {projectName ? (
          <span className="hidden max-w-40 truncate text-xs text-muted-foreground sm:inline">
            {projectName}
          </span>
        ) : null}
        {pill ? <span className={cn("text-xs", pill.colorClass)}>{pill.label}</span> : null}
        <span className="max-w-32 truncate text-xs text-muted-foreground">{agent}</span>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {formatRelativeTimeLabel(thread.updatedAt)}
        </span>
      </Link>
    </li>
  );
}
