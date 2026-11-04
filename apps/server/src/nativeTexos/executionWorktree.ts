// @effect-diagnostics nodeBuiltinImport:off -- Checks only the explicitly admitted directory; never discovers a workspace or home.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ExecutionIntent } from "./executionProtocol.ts";

export class ExecutionWorktreeError extends Schema.TaggedError<ExecutionWorktreeError>()(
  "ExecutionWorktreeError",
  {},
) {}

export const validateExecutionWorktree = Effect.fn("ExecutionWorktree.validate")(function* (
  tree: ExecutionIntent["worktree"],
) {
  yield* Effect.tryPromise({
    try: async () => {
      const handles: Array<Awaited<ReturnType<typeof NodeFSP.open>>> = [];
      try {
        const root = NodePath.parse(tree.root).root;
        let current = root;
        for (const segment of tree.root.slice(root.length).split(NodePath.sep)) {
          current = NodePath.join(current, segment);
          const handle = await NodeFSP.open(
            current,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
          );
          handles.push(handle);
          const before = await handle.stat({ bigint: true });
          const atPath = await NodeFSP.lstat(current, { bigint: true });
          if (
            !before.isDirectory() ||
            !atPath.isDirectory() ||
            before.dev !== atPath.dev ||
            before.ino !== atPath.ino
          ) {
            throw new Error("changedExecutionDirectory");
          }
        }
        const held = handles.at(-1);
        if (!held || (await NodeFSP.realpath(tree.root)) !== tree.root)
          throw new Error("linkedExecutionDirectory");
        const physical = await held.stat({ bigint: true });
        const atPath = await NodeFSP.lstat(tree.root, { bigint: true });
        if (
          String(physical.dev) !== tree.device ||
          String(physical.ino) !== tree.inode ||
          physical.dev !== atPath.dev ||
          physical.ino !== atPath.ino
        )
          throw new Error("changedExecutionDirectory");
      } finally {
        await Promise.all(handles.map((handle) => handle.close()));
      }
    },
    catch: () => new ExecutionWorktreeError(),
  });
});
