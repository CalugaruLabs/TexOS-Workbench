// @effect-diagnostics nodeBuiltinImport:off -- Test-only folders stand in for a Mission's own folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TEXOS_MISSION_FILE_BYTES } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { executionReceiptMigrations as Migration, syntheticIntent } from "./execution.testkit.ts";
import * as Receipts from "./executionReceipts.ts";
import {
  layer as missionFilesLayer,
  listMissionFolder,
  MISSION_FILE_LIMITS,
  missionFileSegments,
  missionReadFlags,
  readMissionFile as readWithFlags,
  TexosMissionFiles,
} from "./missionFiles.ts";

async function missionFolder() {
  const parent = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "texos-mission-files-")),
  );
  const root = NodePath.join(parent, "mission");
  await NodeFSP.mkdir(root);
  const stat = await NodeFSP.stat(root, { bigint: true });
  return { parent, root, device: String(stat.dev), inode: String(stat.ino) };
}

const readMissionFile = (root: string, device: string, path: string) =>
  readWithFlags(root, device, path, missionReadFlags("linux"));

const failureOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "none",
    (error: { failure?: string }) => error.failure ?? "other",
  );

describe("Mission folder listing", () => {
  it("lists plain files by relative path and leaves out links and special files", async () => {
    const { parent, root } = await missionFolder();
    await NodeFSP.mkdir(NodePath.join(root, "src"));
    await NodeFSP.writeFile(NodePath.join(root, "README.md"), "hello\n");
    await NodeFSP.writeFile(NodePath.join(root, "src", "app.ts"), "export {};\n");
    await NodeFSP.writeFile(NodePath.join(parent, "secret.txt"), "outside\n");
    await NodeFSP.symlink(NodePath.join(parent, "secret.txt"), NodePath.join(root, "link.txt"));
    await NodeFSP.symlink(parent, NodePath.join(root, "outside"));

    const listed = await listMissionFolder(root);

    assert.deepEqual(
      listed.files.map((file) => [file.path, file.byteLength]),
      [
        ["README.md", 6],
        ["src/app.ts", 11],
      ],
    );
    assert.equal(listed.omitted, 2);
  });

  it("stops at the file limit and counts what it left out", async () => {
    const { root } = await missionFolder();
    const extra = 3;
    for (let index = 0; index < MISSION_FILE_LIMITS.files + extra; index++)
      await NodeFSP.writeFile(NodePath.join(root, `f${String(index).padStart(5, "0")}`), "");

    const listed = await listMissionFolder(root);

    assert.equal(listed.files.length, MISSION_FILE_LIMITS.files);
    assert.equal(listed.omitted, extra);
  });
});

describe("Mission file reads", () => {
  it("accepts only relative paths the listing could produce", () => {
    assert.deepEqual(missionFileSegments("src/app.ts"), ["src", "app.ts"]);
    for (const path of ["/etc/passwd", "../x", "src/../../x", "a//b", "./a", "a/", "a\0b"])
      assert.isUndefined(missionFileSegments(path), path);
  });

  it("returns text, and names binary and oversized files without their bytes", async () => {
    const { root, device } = await missionFolder();
    await NodeFSP.writeFile(NodePath.join(root, "notes.txt"), "plain text\n");
    await NodeFSP.writeFile(NodePath.join(root, "image.bin"), Buffer.from([1, 0, 2]));
    await NodeFSP.writeFile(
      NodePath.join(root, "big.txt"),
      Buffer.alloc(TEXOS_MISSION_FILE_BYTES + 1, 97),
    );

    assert.deepEqual(await readMissionFile(root, device, "notes.txt"), {
      kind: "text",
      contents: "plain text\n",
      byteLength: 11,
    });
    assert.deepEqual(await readMissionFile(root, device, "image.bin"), {
      kind: "binary",
      byteLength: 3,
    });
    assert.deepEqual(await readMissionFile(root, device, "big.txt"), {
      kind: "tooLarge",
      byteLength: TEXOS_MISSION_FILE_BYTES + 1,
    });
  });

  it("refuses links, hard links, special files and bad paths", async () => {
    const { parent, root, device } = await missionFolder();
    await NodeFSP.writeFile(NodePath.join(parent, "secret.txt"), "outside\n");
    await NodeFSP.symlink(NodePath.join(parent, "secret.txt"), NodePath.join(root, "link.txt"));
    await NodeFSP.link(NodePath.join(parent, "secret.txt"), NodePath.join(root, "hard.txt"));
    await NodeFSP.mkdir(NodePath.join(root, "folder"));
    // A folder on the way that is a link, which O_NOFOLLOW alone would follow on Linux.
    await NodeFSP.symlink(parent, NodePath.join(root, "through"));

    assert.equal(await failureOf(readMissionFile(root, device, "link.txt")), "notFound");
    assert.equal(await failureOf(readMissionFile(root, device, "through/secret.txt")), "notFound");
    assert.equal(await failureOf(readMissionFile(root, device, "hard.txt")), "unreadable");
    assert.equal(await failureOf(readMissionFile(root, device, "folder")), "unreadable");
    assert.equal(await failureOf(readMissionFile(root, device, "../secret.txt")), "invalidPath");
    assert.equal(await failureOf(readMissionFile(root, device, "missing.txt")), "notFound");
  });
});

const receiptsLayer = Receipts.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(Migration).pipe(
      Layer.provideMerge(
        Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
  ),
);
const serviceLayer = missionFilesLayer.pipe(Layer.provideMerge(receiptsLayer));

describe("Mission files service", () => {
  it.effect("reads only the folder of a Mission this engine admitted", () =>
    Effect.gen(function* () {
      const folder = yield* Effect.promise(missionFolder);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(folder.root, "answer.md"), "done\n"),
      );
      const base = syntheticIntent(folder.root);
      const intent = {
        ...base,
        worktree: { ...base.worktree, device: folder.device, inode: folder.inode },
      };
      const receipts = yield* Receipts.ExecutionReceipts;
      yield* receipts.admit(intent, "generation-1");
      const files = yield* TexosMissionFiles;
      const mission = { taskId: intent.canonicalTaskID, attemptId: intent.canonicalAttemptID };

      const listed = yield* files.list(mission);
      assert.deepEqual(
        listed.files.map((file) => file.path),
        ["answer.md"],
      );
      assert.deepEqual(yield* files.read({ ...mission, path: "answer.md" }), {
        kind: "text",
        contents: "done\n",
        byteLength: 5,
      });

      const unknown = yield* Effect.flip(files.list({ taskId: "other", attemptId: "attempt" }));
      assert.equal(unknown.failure, "notFound");

      yield* Effect.promise(async () => {
        await NodeFSP.rename(folder.root, `${folder.root}-moved`);
        await NodeFSP.mkdir(folder.root);
      });
      const replaced = yield* Effect.flip(files.list(mission));
      assert.equal(replaced.failure, "folderChanged");
    }).pipe(Effect.provide(serviceLayer)),
  );
});
