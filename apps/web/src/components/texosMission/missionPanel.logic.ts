import type { OrchestrationV2RunStatus, OrchestrationV2TurnItemStatus } from "@t3tools/contracts";

export type MissionPanelTab = "changes" | "terminal" | "timeline";

const ENDED: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const LIVE_ITEM: ReadonlySet<OrchestrationV2TurnItemStatus> = new Set([
  "idle",
  "pending",
  "running",
  "waiting",
]);

interface PanelItem {
  readonly item: { readonly type: string; readonly status: OrchestrationV2TurnItemStatus };
}

function missionRunEnded(status: OrchestrationV2RunStatus | null): boolean {
  return status !== null && ENDED.has(status);
}

function countFileEdits(items: ReadonlyArray<PanelItem>) {
  let edits = 0;
  let settled = 0;
  for (const { item } of items) {
    if (item.type !== "file_change") continue;
    edits++;
    if (!LIVE_ITEM.has(item.status)) settled++;
  }
  return { edits, settled };
}

/**
 * A running Mission shows what it is doing; one that ended with files shows what it left. Null
 * until both the run and, for an ended one, its steps have arrived: they come on separate streams.
 */
export function defaultMissionTab(
  items: ReadonlyArray<PanelItem>,
  status: OrchestrationV2RunStatus | null,
): MissionPanelTab | null {
  if (status === null) return null;
  if (!missionRunEnded(status)) return "timeline";
  if (items.length === 0) return null;
  return countFileEdits(items).edits > 0 ? "changes" : "timeline";
}

/** Moves whenever a file edit starts or lands, or the run moves: the only times the folder can differ. */
export function missionChangesRevision(
  items: ReadonlyArray<PanelItem>,
  status: OrchestrationV2RunStatus | null,
): string {
  const { edits, settled } = countFileEdits(items);
  return `${edits}:${settled}:${status ?? "none"}`;
}
