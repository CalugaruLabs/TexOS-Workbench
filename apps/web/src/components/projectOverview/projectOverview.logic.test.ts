import { EnvironmentId, ProjectId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { groupProjectOverviewThreads } from "./projectOverview.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const projectRefs = [{ environmentId, projectId }];

function thread(id: string, overrides: ThreadFixtureOverrides = {}) {
  return makeThreadFixture({
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    updatedAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  });
}

function titles(threads: ReadonlyArray<{ readonly thread: { readonly title: string } }>) {
  return threads.map((entry) => entry.thread.title);
}

describe("groupProjectOverviewThreads", () => {
  it("sorts a project's threads into needs-you, working, review and earlier", () => {
    const sections = groupProjectOverviewThreads(
      [
        thread("approval", { hasPendingApprovals: true }),
        thread("question", { hasPendingUserInput: true }),
        thread("running", {
          runtime: {
            status: "running",
            activeRunId: RunId.make("run-1"),
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            providerName: "Claude",
            lastError: null,
            updatedAt: "2026-10-27T10:00:00.000Z",
          },
        }),
        thread("finished", {
          lastVisitedAt: "2026-10-27T09:00:00.000Z",
          latestRun: {
            runId: RunId.make("run-2"),
            status: "completed",
            requestedAt: "2026-10-27T09:10:00.000Z",
            startedAt: "2026-10-27T09:10:00.000Z",
            completedAt: "2026-10-27T09:30:00.000Z",
            assistantMessageId: null,
          },
        }),
        thread("idle"),
      ],
      projectRefs,
    );

    expect(titles(sections["needs-you"])).toEqual(["approval", "question"]);
    expect(titles(sections.working)).toEqual(["running"]);
    expect(titles(sections.review)).toEqual(["finished"]);
    expect(titles(sections.earlier)).toEqual(["idle"]);
  });

  it("puts pinned threads first whatever their state, so a main chat stays on top", () => {
    const sections = groupProjectOverviewThreads(
      [
        thread("main chat", { pinnedAt: "2026-10-27T10:00:00.000Z", hasPendingUserInput: true }),
        thread("question", { hasPendingUserInput: true }),
      ],
      projectRefs,
    );

    expect(titles(sections.pinned)).toEqual(["main chat"]);
    expect(sections.pinned[0]?.pill?.label).toBe("Awaiting Input");
    expect(titles(sections["needs-you"])).toEqual(["question"]);
  });

  it("keeps only live threads of the project's member folders, newest first", () => {
    const sections = groupProjectOverviewThreads(
      [
        thread("older", { updatedAt: "2026-10-27T08:00:00.000Z" }),
        thread("newer", { updatedAt: "2026-10-27T11:00:00.000Z" }),
        thread("other project", { projectId: ProjectId.make("project-2") }),
        thread("archived", { archivedAt: "2026-10-27T10:00:00.000Z" }),
        thread("deleted", { deletedAt: "2026-10-27T10:00:00.000Z" }),
      ],
      projectRefs,
    );

    expect(titles(sections.earlier)).toEqual(["newer", "older"]);
    expect(Object.values(sections).flat()).toHaveLength(2);
  });
});
