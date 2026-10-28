import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { groupHomeThreads, homeGreeting, homeSummary } from "./home.logic";

const environmentId = EnvironmentId.make("environment-local");

function thread(id: string, projectId: string, overrides: ThreadFixtureOverrides = {}) {
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    title: id,
    updatedAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  });
}

describe("groupHomeThreads", () => {
  it("collects threads that need a look from every project, and keeps recent ones short", () => {
    const quiet = Array.from({ length: 10 }, (_, index) =>
      thread(`quiet-${index}`, "project-b", {
        updatedAt: `2026-10-27T09:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const sections = groupHomeThreads([
      thread("approval", "project-a", { hasPendingApprovals: true }),
      thread("question", "project-b", { hasPendingUserInput: true }),
      thread("archived", "project-a", {
        hasPendingApprovals: true,
        archivedAt: "2026-10-27T10:00:00.000Z",
      }),
      ...quiet,
    ]);

    expect(sections.needsYou.map((entry) => entry.thread.title).toSorted()).toEqual([
      "approval",
      "question",
    ]);
    expect(sections.recent.map((entry) => entry.thread.title)).toEqual(
      quiet
        .toReversed()
        .slice(0, 8)
        .map((entry) => entry.title),
    );
  });
});

describe("homeGreeting", () => {
  it("follows the time of day", () => {
    expect([2, 9, 14, 21].map(homeGreeting)).toEqual([
      "Working late",
      "Good morning",
      "Good afternoon",
      "Good evening",
    ]);
  });
});

describe("homeSummary", () => {
  it("says what needs attention, and says so when nothing does", () => {
    expect(homeSummary(0, 0)).toBe("Nothing needs you right now.");
    expect(homeSummary(1, 0)).toBe("1 thread needs a look.");
    expect(homeSummary(2, 3)).toBe("2 threads need a look, 3 running.");
  });
});
