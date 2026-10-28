import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProjectDocId, type ProjectDoc } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Link, useNavigate } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { projectDocAuthorLabel } from "./projectDocs.logic";

export function ProjectDocPage({
  projectKey,
  docId,
  startEditing,
}: {
  readonly projectKey: string;
  readonly docId: string;
  readonly startEditing: boolean;
}) {
  const project = useSidebarProjectGroups().find((group) => group.projectKey === projectKey);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Doc breadcrumb" className="flex-1">
            <WorkspaceBreadcrumbItem>
              <Link to="/project/$projectKey" params={{ projectKey }}>
                <WorkspaceBreadcrumbText>
                  {project?.displayName ?? "Project"}
                </WorkspaceBreadcrumbText>
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <WorkspaceBreadcrumbText>Docs</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {project && isProjectDocId(docId) ? (
          <ProjectDocBody
            project={project}
            projectKey={projectKey}
            docId={docId}
            startEditing={startEditing}
          />
        ) : null}
      </div>
    </SidebarInset>
  );
}

const isProjectDocId = Schema.is(ProjectDocId);

interface Draft {
  readonly title: string;
  readonly markdown: string;
  readonly baseRevision: number;
}

function ProjectDocBody({
  project,
  projectKey,
  docId,
  startEditing,
}: {
  readonly project: SidebarProjectSnapshot;
  readonly projectKey: string;
  readonly docId: ProjectDocId;
  readonly startEditing: boolean;
}) {
  const environmentId = project.environmentId;
  const docQuery = useEnvironmentQuery(
    serverEnvironment.projectDoc({ environmentId, input: { projectId: project.id, docId } }),
  );
  const canWrite = useAtomValue(serverEnvironment.saveProjectDoc.permissionAtom(environmentId));
  const saveDoc = useAtomCommand(serverEnvironment.saveProjectDoc, { label: "save project doc" });
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const doc = docQuery.data;

  const edit = (from: ProjectDoc) =>
    setDraft({ title: from.title, markdown: from.markdown, baseRevision: from.revision });
  if (startEditing && draft === null && doc !== null && canWrite) {
    edit(doc);
    void navigate({
      to: "/project/$projectKey/docs/$docId",
      params: { projectKey, docId },
      search: {},
      replace: true,
    });
  }

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await saveDoc({
      environmentId,
      input: {
        projectId: project.id,
        docId,
        title: draft.title.trim() || "Untitled doc",
        markdown: draft.markdown,
        baseRevision: draft.baseRevision,
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setDraft(null);
      docQuery.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save the doc",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (doc === null) {
    return docQuery.error === null ? null : (
      <WorkspacePageContainer>
        <p className="text-sm text-destructive">Couldn't open this doc: {docQuery.error}</p>
      </WorkspacePageContainer>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer>
        {draft === null ? (
          <>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold break-words">{doc.title}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {projectDocAuthorLabel(doc.updatedBy)} · {formatRelativeTimeLabel(doc.updatedAt)}
                </p>
              </div>
              {canWrite ? (
                <Button size="sm" variant="outline" onClick={() => edit(doc)}>
                  <PencilIcon className="size-4" />
                  Edit
                </Button>
              ) : null}
            </div>
            {doc.markdown.trim().length === 0 ? (
              <p className="text-sm text-muted-foreground">This doc is empty.</p>
            ) : (
              <ChatMarkdown
                text={doc.markdown}
                cwd={project.workspaceRoot}
                environmentId={environmentId}
              />
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Doc title"
                className="flex-1"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
            {doc.revision > draft.baseRevision ? (
              <p className="text-sm text-warning-foreground">
                This doc changed while you were editing. Saving now won't overwrite it; copy your
                text, cancel, and edit again.
              </p>
            ) : null}
            <Textarea
              aria-label="Doc text"
              className="min-h-96"
              value={draft.markdown}
              placeholder="Write in markdown."
              onChange={(event) => setDraft({ ...draft, markdown: event.target.value })}
            />
          </>
        )}
      </WorkspacePageContainer>
    </ScrollArea>
  );
}
