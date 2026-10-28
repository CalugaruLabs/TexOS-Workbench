import { createFileRoute } from "@tanstack/react-router";

import { WorkspacePage } from "../components/workspace/WorkspacePage";

export const Route = createFileRoute("/_chat/workspace")({
  component: WorkspacePage,
});
