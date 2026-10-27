import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { FileTextIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { projectDocAuthorLabel } from "./projectDocs.logic";

export function ProjectDocsSection({
  projectKey,
  environmentId,
  projectId,
}: {
  readonly projectKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const docsQuery = useEnvironmentQuery(
    serverEnvironment.projectDocsLive({ environmentId, input: { projectId } }),
  );
  const canWrite = useAtomValue(serverEnvironment.saveProjectDoc.permissionAtom(environmentId));
  const saveDoc = useAtomCommand(serverEnvironment.saveProjectDoc, { label: "new project doc" });
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const docs = docsQuery.data?.docs ?? [];

  const createDoc = async () => {
    setCreating(true);
    const result = await saveDoc({
      environmentId,
      input: { projectId, title: "Untitled doc", markdown: "" },
    });
    setCreating(false);
    if (result._tag === "Success") {
      void navigate({
        to: "/project/$projectKey/docs/$docId",
        params: { projectKey, docId: result.value.id },
        search: { edit: true },
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not create the doc",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <section aria-labelledby="project-overview-docs">
      <div className="mb-2 flex items-center gap-2">
        <h2 id="project-overview-docs" className="flex-1 text-xs font-medium text-muted-foreground">
          Docs · {docs.length}
        </h2>
        {canWrite ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={creating}
            onClick={() => void createDoc()}
          >
            <PlusIcon className="size-3.5" />
            New doc
          </Button>
        ) : null}
      </div>
      {docsQuery.error !== null ? (
        <p className="text-sm text-destructive">Couldn't load docs: {docsQuery.error}</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No docs yet. Write one yourself, or ask any agent to write a plan, notes or a spec here.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border">
          {docs.map((doc) => (
            <li key={doc.id}>
              <Link
                to="/project/$projectKey/docs/$docId"
                params={{ projectKey, docId: doc.id }}
                className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden sm:px-4"
              >
                <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{doc.title}</span>
                <span className="max-w-40 truncate text-xs text-muted-foreground">
                  {projectDocAuthorLabel(doc.updatedBy)}
                </span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {formatRelativeTimeLabel(doc.updatedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
