import { ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isTexosMissionId, texosMissionThreadId } from "@t3tools/shared/texosMission";
import { createFileRoute } from "@tanstack/react-router";

import ChatView from "../components/ChatView";
import { SidebarInset } from "../components/ui/sidebar";
import { useQuietThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

// TexOS opens this inside a Mission page: one attempt's coding view, read-only, no app chrome.
export const Route = createFileRoute("/embed/missions/$taskId/$attemptId")({
  loader: async ({ params }) =>
    isTexosMissionId(params.taskId) && isTexosMissionId(params.attemptId)
      ? await texosMissionThreadId(params.taskId, params.attemptId)
      : null,
  component: MissionCodingView,
});

function MissionCodingView() {
  const derivedThreadId = Route.useLoaderData();
  const threadId = derivedThreadId === null ? null : ThreadId.make(derivedThreadId);
  const environmentId = usePrimaryEnvironmentId();
  const threadRef =
    threadId !== null && environmentId !== null ? scopeThreadRef(environmentId, threadId) : null;
  const shell = useQuietThreadShell(threadRef);
  if (threadId === null) return <MissionNotice text="This mission link is not valid." />;
  if (threadRef === null || shell === null)
    return <MissionNotice text="The coding view appears once this attempt starts." />;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <ChatView
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        reserveTitleBarControlInset={false}
        embedded
      />
    </SidebarInset>
  );
}

function MissionNotice({ text }: { text: string }) {
  return (
    <main className="flex h-dvh items-center justify-center p-6 text-sm text-muted-foreground">
      {text}
    </main>
  );
}
