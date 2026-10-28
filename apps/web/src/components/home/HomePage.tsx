import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ArrowUpIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useQuietThreadShells } from "../../state/entities";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";
import { OverviewThreadRow, useThreadAgentLabel } from "../projectOverview/ProjectOverviewPage";
import type { ProjectOverviewThread } from "../projectOverview/projectOverview.logic";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { groupHomeThreads, homeGreeting, homeSummary } from "./home.logic";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

export function HomePage({
  projects,
}: {
  readonly projects: ReadonlyArray<SidebarProjectSnapshot>;
}) {
  const threads = useQuietThreadShells();
  const agentLabel = useThreadAgentLabel();
  const sections = groupHomeThreads(threads);
  const [now] = useState(() => new Date());

  const projectNameOf = (thread: SidebarThreadSummary) =>
    projects.find((project) =>
      project.memberProjectRefs.some(
        (ref) => ref.environmentId === thread.environmentId && ref.projectId === thread.projectId,
      ),
    )?.displayName;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Home breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>Home</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer>
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {DATE_FORMAT.format(now)}
              </p>
              <h1 className="mt-2 text-3xl font-semibold">{homeGreeting(now.getHours())}.</h1>
              <p className="mt-2 text-muted-foreground">
                {homeSummary(sections.needsYou.length, sections.running.length)}
              </p>
            </div>
            <HomeComposer projects={projects} />
            <HomeThreadSection
              id="needs-you"
              title="Needs a look"
              entries={sections.needsYou}
              agentLabel={agentLabel}
              projectNameOf={projectNameOf}
            />
            <HomeThreadSection
              id="running"
              title="Running"
              entries={sections.running}
              agentLabel={agentLabel}
              projectNameOf={projectNameOf}
            />
            <HomeThreadSection
              id="recent"
              title="Recent"
              entries={sections.recent}
              agentLabel={agentLabel}
              projectNameOf={projectNameOf}
            />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function HomeComposer({ projects }: { readonly projects: ReadonlyArray<SidebarProjectSnapshot> }) {
  const handleNewThread = useNewThreadHandler();
  const [prompt, setPrompt] = useState("");
  const [projectKey, setProjectKey] = useState(projects[0]?.projectKey ?? "");
  const [starting, setStarting] = useState(false);
  const project = projects.find((candidate) => candidate.projectKey === projectKey) ?? projects[0];

  const start = async () => {
    if (project === undefined || starting) return;
    setStarting(true);
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    setStarting(false);
    if (opened !== null && prompt.trim().length > 0) {
      useComposerDraftStore.getState().setPrompt(opened.draftId, prompt.trim());
    }
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <Textarea
        aria-label="What should we build or fix?"
        placeholder="What should we build or fix?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void start();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <div className="min-w-0 max-w-64">
          <Select
            value={project?.projectKey ?? ""}
            items={Object.fromEntries(
              projects.map((entry) => [entry.projectKey, entry.displayName]),
            )}
            onValueChange={(value) => {
              if (typeof value === "string") setProjectKey(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((entry) => (
                <SelectItem key={entry.projectKey} value={entry.projectKey}>
                  {entry.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <p className="hidden flex-1 text-xs text-muted-foreground sm:block">
          Pick the agent and mode on the next screen.
        </p>
        <Button type="submit" size="sm" disabled={project === undefined || starting}>
          <ArrowUpIcon className="size-4" />
          Start
        </Button>
      </div>
    </form>
  );
}

function HomeThreadSection({
  id,
  title,
  entries,
  agentLabel,
  projectNameOf,
}: {
  readonly id: string;
  readonly title: string;
  readonly entries: ReadonlyArray<ProjectOverviewThread>;
  readonly agentLabel: (thread: SidebarThreadSummary) => string;
  readonly projectNameOf: (thread: SidebarThreadSummary) => string | undefined;
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={`home-${id}`}>
      <h2 id={`home-${id}`} className="mb-2 text-xs font-medium text-muted-foreground">
        {title} · {entries.length}
      </h2>
      <ul className="flex flex-col divide-y rounded-lg border">
        {entries.map((entry) => (
          <OverviewThreadRow
            key={`${entry.thread.environmentId}:${entry.thread.id}`}
            entry={entry}
            agent={agentLabel(entry.thread)}
            projectName={projectNameOf(entry.thread)}
          />
        ))}
      </ul>
    </section>
  );
}
