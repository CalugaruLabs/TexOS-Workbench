import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProjectDocId, ProjectId, ThreadId } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectDocs from "./ProjectDocs.ts";

const layerTest = ProjectDocs.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-docs-test-" })),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-1");
const user = { _tag: "User" } as const;

it.layer(layerTest)("ProjectDocs", (it) => {
  describe("save and read", () => {
    it.effect("creates a doc, then edits it with the revision it was read at", () =>
      Effect.gen(function* () {
        const docs = yield* ProjectDocs.ProjectDocs;
        const created = yield* docs.save({ projectId, title: "Plan", markdown: "# Plan" }, user);
        expect(created.revision).toBe(1);

        const agent = { _tag: "Agent", threadId: ThreadId.make("thread-1") } as const;
        const edited = yield* docs.save(
          {
            projectId,
            docId: created.id,
            title: "Plan",
            markdown: "# Plan\n\nShip it.",
            baseRevision: 1,
          },
          agent,
        );

        const read = yield* docs.read({ projectId, docId: created.id });
        expect(read).toMatchObject({
          markdown: "# Plan\n\nShip it.",
          revision: 2,
          updatedBy: agent,
          createdAt: created.createdAt,
        });
        expect(edited).toEqual(read);
      }),
    );

    it.effect("rejects a save based on an older revision instead of overwriting", () =>
      Effect.gen(function* () {
        const docs = yield* ProjectDocs.ProjectDocs;
        const doc = yield* docs.save({ projectId, title: "Notes", markdown: "one" }, user);
        yield* docs.save(
          { projectId, docId: doc.id, title: "Notes", markdown: "two", baseRevision: 1 },
          user,
        );

        const stale = yield* docs
          .save(
            { projectId, docId: doc.id, title: "Notes", markdown: "three", baseRevision: 1 },
            user,
          )
          .pipe(Effect.flip);

        expect(stale.reason).toBe("conflict");
        expect((yield* docs.read({ projectId, docId: doc.id })).markdown).toBe("two");
      }),
    );

    it.effect("reports a missing doc as not found", () =>
      Effect.gen(function* () {
        const docs = yield* ProjectDocs.ProjectDocs;
        const missing = yield* docs
          .read({ projectId, docId: ProjectDocId.make("missing") })
          .pipe(Effect.flip);
        expect(missing.reason).toBe("not-found");
      }),
    );
  });

  describe("list and subscribe", () => {
    it.effect("lists only the project's docs and streams the list after each change", () =>
      Effect.gen(function* () {
        const docs = yield* ProjectDocs.ProjectDocs;
        const otherProject = ProjectId.make("project-subscribe");
        const lists = yield* Queue.unbounded<ReadonlyArray<string>>();
        yield* docs.subscribe(otherProject).pipe(
          Stream.runForEach((list) =>
            Queue.offer(
              lists,
              list.docs.map((doc) => doc.title),
            ),
          ),
          Effect.forkScoped,
        );
        // The first list arrives only once the subscription is listening.
        expect(yield* Queue.take(lists)).toEqual([]);

        const first = yield* docs.save(
          { projectId: otherProject, title: "First", markdown: "" },
          user,
        );
        expect(yield* Queue.take(lists)).toEqual(["First"]);

        yield* docs.delete({ projectId: otherProject, docId: first.id });
        expect(yield* Queue.take(lists)).toEqual([]);
      }),
    );
  });
});
