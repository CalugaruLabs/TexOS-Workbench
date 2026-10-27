import type { ScopedProjectRef } from "@t3tools/contracts";

import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";

export type ProjectOverviewSectionId = "needs-you" | "working" | "review" | "earlier";

export const PROJECT_OVERVIEW_SECTIONS: ReadonlyArray<{
  readonly id: ProjectOverviewSectionId;
  readonly title: string;
}> = [
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
    sections[pill === null ? "earlier" : SECTION_BY_PILL[pill.label]].push({ thread, pill });
  }
  return sections;
}
