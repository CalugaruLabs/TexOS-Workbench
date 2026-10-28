import { resolveThreadStatusPill } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";
import {
  SECTION_BY_PILL,
  type ProjectOverviewThread,
} from "../projectOverview/projectOverview.logic";

const HOME_RECENT_LIMIT = 8;

export interface HomeSections<T extends SidebarThreadSummary> {
  readonly needsYou: ReadonlyArray<ProjectOverviewThread<T>>;
  readonly running: ReadonlyArray<ProjectOverviewThread<T>>;
  readonly recent: ReadonlyArray<ProjectOverviewThread<T>>;
}

export function groupHomeThreads<T extends SidebarThreadSummary>(
  threads: ReadonlyArray<T>,
): HomeSections<T> {
  const needsYou: Array<ProjectOverviewThread<T>> = [];
  const running: Array<ProjectOverviewThread<T>> = [];
  const recent: Array<ProjectOverviewThread<T>> = [];
  const live = threads
    .filter((thread) => thread.archivedAt === null && thread.deletedAt === null)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  for (const thread of live) {
    const pill = resolveThreadStatusPill({ thread });
    const section = pill === null ? null : SECTION_BY_PILL[pill.label];
    if (section === "needs-you") needsYou.push({ thread, pill });
    else if (section === "working") running.push({ thread, pill });
    else if (recent.length < HOME_RECENT_LIMIT) recent.push({ thread, pill });
  }
  return { needsYou, running, recent };
}

export function homeGreeting(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function homeSummary(needsYou: number, running: number): string {
  const parts = [
    needsYou === 0
      ? null
      : `${needsYou} ${needsYou === 1 ? "thread needs" : "threads need"} a look`,
    running === 0 ? null : `${running} running`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "Nothing needs you right now." : `${parts.join(", ")}.`;
}
