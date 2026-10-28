import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/home/HomePage";
import { NoProjectsHero } from "../components/NoProjectsHero";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useSidebarProjectGroups } from "../hooks/useSidebarProjectGroups";
import { useAllEnvironmentShellsBootstrapped } from "../state/entities";
import { useEnvironments } from "../state/environments";

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();

  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }

  return <IndexHome />;
}

function IndexHome() {
  const projects = useSidebarProjectGroups();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();

  if (projects.length > 0) return <HomePage projects={projects} />;
  // A pending environment cannot prove the workspace is empty.
  return bootstrapped ? <NoProjectsHero /> : null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
