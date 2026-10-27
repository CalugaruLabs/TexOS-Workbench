import { createFileRoute } from "@tanstack/react-router";

import { ProjectOverviewPage } from "../components/projectOverview/ProjectOverviewPage";

function ProjectOverviewRouteView() {
  const { projectKey } = Route.useParams();
  return <ProjectOverviewPage projectKey={projectKey} />;
}

export const Route = createFileRoute("/_chat/project/$projectKey")({
  component: ProjectOverviewRouteView,
});
