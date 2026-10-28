import {
  EnvironmentId,
  ProjectId,
  WorkspaceAreaId,
  WorkspaceItemId,
  type WorkspaceItem,
  type WorkspaceLocation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupWorkspaceItems, itemPrompt } from "./workspace.logic";

const environmentId = EnvironmentId.make("local");
const health = ProjectId.make("health");
const loose = ProjectId.make("loose");
const area = {
  id: WorkspaceAreaId.make("personal"),
  name: "Personal",
  projectRefs: [{ environmentId, projectId: health }],
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
};
const otherMachine = {
  ...area,
  id: WorkspaceAreaId.make("remote"),
  name: "Remote",
  projectRefs: [{ environmentId: EnvironmentId.make("remote"), projectId: health }],
};

const item = (
  id: string,
  location: WorkspaceLocation,
  overrides: Partial<WorkspaceItem> = {},
): WorkspaceItem => ({
  id: WorkspaceItemId.make(id),
  kind: "task",
  title: id,
  body: "",
  status: "open",
  filing: { location, filedBy: { _tag: "Auto" }, reason: "", filedAt: "2026-10-28T10:00:00.000Z" },
  createdBy: { _tag: "Auto" },
  createdAt: "2026-10-28T10:00:00.000Z",
  updatedAt: "2026-10-28T10:00:00.000Z",
  ...overrides,
});

const all = { kind: "all", query: "", showClosed: false } as const;

describe("groupWorkspaceItems", () => {
  it("files items by area, including items in the area's projects on this machine only", () => {
    const view = groupWorkspaceItems(
      {
        areas: [area, otherMachine],
        threadFilings: [],
        items: [
          item("in-area", { _tag: "Area", areaId: area.id }),
          item("in-project", { _tag: "Project", projectId: health }),
          item("loose", { _tag: "Project", projectId: loose }),
          item("unsorted", { _tag: "Inbox" }),
        ],
      },
      environmentId,
      all,
    );
    expect(view.areas[0]?.items.map((entry) => entry.title)).toEqual(["in-area", "in-project"]);
    expect(view.areas[1]?.items).toEqual([]);
    expect(view.elsewhere.map((entry) => entry.title)).toEqual(["loose"]);
    expect(view.inbox.map((entry) => entry.title)).toEqual(["unsorted"]);
  });

  it("hides finished work unless asked, and lists open work before newer finished work", () => {
    const snapshot = {
      areas: [],
      threadFilings: [],
      items: [
        item("done", { _tag: "Inbox" }, { status: "done", updatedAt: "2026-10-28T12:00:00.000Z" }),
        item("open", { _tag: "Inbox" }),
        item("idea", { _tag: "Inbox" }, { kind: "idea", status: "new", body: "Granola import" }),
      ],
    };
    expect(
      groupWorkspaceItems(snapshot, environmentId, all).inbox.map((entry) => entry.title),
    ).toEqual(["open", "idea"]);
    expect(
      groupWorkspaceItems(snapshot, environmentId, { ...all, showClosed: true }).inbox.map(
        (entry) => entry.title,
      ),
    ).toEqual(["open", "idea", "done"]);
    expect(
      groupWorkspaceItems(snapshot, environmentId, {
        kind: "idea",
        query: "granola",
        showClosed: false,
      }).inbox.map((entry) => entry.title),
    ).toEqual(["idea"]);
  });
});

describe("itemPrompt", () => {
  it("turns an item into the opening message of a chat", () => {
    expect(itemPrompt({ kind: "task", title: "Renew domain", body: "Before Nov 3." })).toBe(
      "Work on this task: Renew domain\n\nBefore Nov 3.",
    );
    expect(itemPrompt({ kind: "idea", title: "Granola import", body: "" })).toBe(
      "Let's explore this idea: Granola import",
    );
  });
});
