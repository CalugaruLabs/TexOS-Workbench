import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as Workspace from "./Workspace.ts";

const layerTest = Workspace.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-test-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const user = { _tag: "User" } as const;
const auto = { _tag: "Auto" } as const;
const projectRef = {
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
};

// A second instance over the same state directory, as after a server restart.
const reopen = Effect.scoped(
  Layer.build(Layer.fresh(Workspace.layer)).pipe(
    Effect.map((context) => Context.get(context, Workspace.Workspace)),
  ),
);

it.layer(layerTest)("Workspace", (it) => {
  describe("filing", () => {
    it.effect("never lets automatic filing override where a person put something", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const area = yield* workspace.saveArea({ name: "Career", projectRefs: [] });
        const item = yield* workspace.createItem({ kind: "idea", title: "Portfolio site" }, auto);
        expect(item.filing.location).toEqual({ _tag: "Inbox" });

        const target = { _tag: "Item", itemId: item.id } as const;
        yield* workspace.file({ target, location: { _tag: "Area", areaId: area.id } }, user);
        yield* workspace.file({ target, location: { _tag: "Inbox" }, reason: "Unsure" }, auto);

        const filed = (yield* workspace.snapshot).items.find(
          (candidate) => candidate.id === item.id,
        );
        expect(filed?.filing).toMatchObject({
          location: { _tag: "Area", areaId: area.id },
          filedBy: user,
        });
      }),
    );

    it.effect("moves things filed in a removed area back to the Inbox", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const area = yield* workspace.saveArea({
          name: "Side projects",
          projectRefs: [projectRef],
        });
        const location = { _tag: "Area", areaId: area.id } as const;
        const item = yield* workspace.createItem(
          { kind: "task", title: "Renew domain", location },
          user,
        );
        const threadId = ThreadId.make("thread-area");
        yield* workspace.file({ target: { _tag: "Thread", threadId }, location }, user);

        yield* workspace.deleteArea(area.id);

        const snapshot = yield* workspace.snapshot;
        const inbox = { location: { _tag: "Inbox" }, reason: "Its area was removed." };
        expect(snapshot.items.find((candidate) => candidate.id === item.id)?.filing).toMatchObject(
          inbox,
        );
        expect(
          snapshot.threadFilings.find((entry) => entry.threadId === threadId)?.filing,
        ).toMatchObject(inbox);
      }),
    );

    it.effect("rejects a second area with the same name in any case", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        yield* workspace.saveArea({ name: "Health", projectRefs: [] });
        const error = yield* workspace
          .saveArea({ name: " health ", projectRefs: [] })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid");
      }),
    );

    it.effect("rejects filing into an area that doesn't exist", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const area = yield* workspace.saveArea({ name: "Temporary", projectRefs: [] });
        yield* workspace.deleteArea(area.id);
        const error = yield* workspace
          .createItem(
            { kind: "idea", title: "Lost", location: { _tag: "Area", areaId: area.id } },
            user,
          )
          .pipe(Effect.flip);
        expect(error.reason).toBe("not-found");
      }),
    );
  });

  describe("items", () => {
    it.effect("keeps each kind to its own states and marks a replaced decision", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const task = yield* workspace.createItem({ kind: "task", title: "Ship docs" }, user);
        expect(task.status).toBe("open");
        const wrong = yield* workspace
          .updateItem({ itemId: task.id, status: "kept" })
          .pipe(Effect.flip);
        expect(wrong.reason).toBe("invalid");

        const first = yield* workspace.createItem(
          { kind: "decision", title: "Docs waits for V2", status: "decided" },
          user,
        );
        yield* workspace.createItem(
          { kind: "decision", title: "Docs ships in V1", status: "decided", replacesId: first.id },
          user,
        );
        const replaced = (yield* workspace.snapshot).items.find((item) => item.id === first.id);
        expect(replaced?.status).toBe("replaced");
      }),
    );

    it.effect("keeps the workspace across a restart", () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Workspace;
        const area = yield* workspace.saveArea({ name: "TexOS", projectRefs: [projectRef] });
        const item = yield* workspace.createItem(
          { kind: "idea", title: "Import Granola", location: { _tag: "Area", areaId: area.id } },
          user,
        );

        const restarted = yield* reopen;
        const snapshot = yield* restarted.snapshot;
        expect(snapshot.areas).toContainEqual(area);
        expect(snapshot.items).toContainEqual(item);
      }),
    );

    it.effect("sets an unreadable workspace file aside instead of overwriting it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        yield* fileSystem.writeFileString(path.join(stateDir, "workspace.json"), "{not json");

        const restarted = yield* reopen;
        expect((yield* restarted.snapshot).items).toEqual([]);
        const names = yield* fileSystem.readDirectory(stateDir);
        expect(names.some((name) => name.startsWith("workspace.json.unreadable-"))).toBe(true);
      }),
    );
  });
});
