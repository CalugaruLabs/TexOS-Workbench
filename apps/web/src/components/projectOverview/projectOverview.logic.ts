import type { ScopedProjectRef } from "@t3tools/contracts";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";

export type ProjectOverviewSectionId = "pinned" | "needs-you" | "working" | "review" | "earlier";

export const PROJECT_OVERVIEW_SECTIONS: ReadonlyArray<{
  readonly id: ProjectOverviewSectionId;
  readonly title: string;
}> = [
  { id: "pinned", title: "Pinned" },
  { id: "needs-you", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "review", title: "Ready to review" },
  { id: "earlier", title: "Earlier" },
];

const SECTION_BY_PILL: Record<ThreadStatusPill["label"], ProjectOverviewSectionId> = {
  "Pending Approval": "needs-you",
  "Awaiting Input": "needs-you",
  "Guest Request": "needs-you",
  Failed: "needs-you",
  "Plan Ready": "needs-you",
  Working: "working",
  Connecting: "working",
  Waiting: "working",
  Completed: "review",
};

export interface ProjectOverviewThread<T extends SidebarThreadSummary = SidebarThreadSummary> {
  readonly thread: T;
  readonly pill: ThreadStatusPill | null;
}

export function groupProjectOverviewThreads<T extends SidebarThreadSummary>(
  threads: ReadonlyArray<T>,
  projectRefs: ReadonlyArray<ScopedProjectRef>,
): Record<ProjectOverviewSectionId, ReadonlyArray<ProjectOverviewThread<T>>> {
  const memberKeys = new Set(projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`));
  const sections: Record<ProjectOverviewSectionId, Array<ProjectOverviewThread<T>>> = {
    pinned: [],
    "needs-you": [],
    working: [],
    review: [],
    earlier: [],
  };
  const members = threads
    .filter(
      (thread) =>
        memberKeys.has(`${thread.environmentId}:${thread.projectId}`) &&
        thread.archivedAt === null &&
        thread.deletedAt === null,
    )
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  for (const thread of members) {
    const pill = resolveThreadStatusPill({ thread });
    const section =
      thread.pinnedAt !== null ? "pinned" : pill === null ? "earlier" : SECTION_BY_PILL[pill.label];
    sections[section].push({ thread, pill });
  }
  return sections;
}

export function projectMainChatBrief(projectName: string): string {
  return [
    `You're the main chat for the ${projectName} project.`,
    "When I ask for real work, start a separate thread for each task with `create_threads`, and pick the agent that fits best from `orchestrator_capabilities` (Claude Code, Codex, Cursor, Hermes or Factory Droid).",
    "Tell me which threads you started and on which agent, check on them with `t3_thread_list` and `t3_thread_read`, and summarize their results here.",
    "Answer quick questions yourself. What should we work on first?",
  ].join("\n\n");
}
