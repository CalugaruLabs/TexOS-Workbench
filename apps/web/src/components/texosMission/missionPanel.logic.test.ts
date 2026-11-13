import { describe, expect, it } from "vite-plus/test";

import { defaultMissionTab, missionChangesRevision } from "./missionPanel.logic";

const edit = (status: "running" | "completed" | "failed") => ({
  item: { type: "file_change", status },
});
const command = { item: { type: "command_execution", status: "completed" as const } };

describe("Mission panel", () => {
  it("opens on the timeline while running and on changes once it ended with files", () => {
    expect(defaultMissionTab([edit("completed")], "running")).toBe("timeline");
    expect(defaultMissionTab([edit("completed")], "completed")).toBe("changes");
    expect(defaultMissionTab([edit("failed")], "interrupted")).toBe("changes");
    expect(defaultMissionTab([command], "completed")).toBe("timeline");
    expect(defaultMissionTab([], "running")).toBe("timeline");
  });

  it("waits to choose until the run and an ended run's steps have arrived", () => {
    expect(defaultMissionTab([], null)).toBeNull();
    expect(defaultMissionTab([edit("completed")], null)).toBeNull();
    expect(defaultMissionTab([], "completed")).toBeNull();
  });

  it("re-reads the folder when an edit starts or lands and when the run moves, not otherwise", () => {
    const before = missionChangesRevision([edit("running")], "running");
    expect(missionChangesRevision([edit("running"), command], "running")).toBe(before);
    expect(missionChangesRevision([edit("completed")], "running")).not.toBe(before);
    expect(missionChangesRevision([edit("running"), edit("running")], "running")).not.toBe(before);
    expect(missionChangesRevision([edit("running")], "completed")).not.toBe(before);
  });
});
