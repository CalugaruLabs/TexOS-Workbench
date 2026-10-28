import { createFileRoute } from "@tanstack/react-router";

import { ProjectDocPage } from "../components/projectDocs/ProjectDocPage";

export interface ProjectDocSearch {
  readonly edit?: boolean;
}

function ProjectDocRouteView() {
  const { projectKey, docId } = Route.useParams();
  const { edit } = Route.useSearch();
  return <ProjectDocPage projectKey={projectKey} docId={docId} startEditing={edit === true} />;
}

export const Route = createFileRoute("/_chat/project/$projectKey_/docs/$docId")({
  validateSearch: (raw: Record<string, unknown>): ProjectDocSearch =>
    raw.edit === true || raw.edit === "true" ? { edit: true } : {},
  component: ProjectDocRouteView,
});
