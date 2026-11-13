// @effect-diagnostics nodeBuiltinImport:off -- Reads only a folder TexOS admitted for a Mission, never a path a client names.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  TEXOS_MISSION_FILE_BYTES,
  TexosMissionFilesError,
  type TexosMissionFile,
  type TexosMissionFilesFailure,
  type TexosMissionListFilesInput,
  type TexosMissionListFilesResult,
  type TexosMissionReadFileInput,
  type TexosMissionReadFileResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTexosMissionId, texosMissionThreadId } from "@t3tools/shared/texosMission";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Receipts from "./executionReceipts.ts";
import { validateExecutionWorktree } from "./executionWorktree.ts";

export const MISSION_FILE_LIMITS = {
  files: 1000,
  entries: 5000,
  depth: 32,
  pathBytes: 4096,
  sniffBytes: 8192,
} as const;

// macOS refuses a link anywhere in the path with O_NOFOLLOW_ANY; Node does not export it.
export const missionReadFlags = (platform: NodeJS.Platform) =>
  NodeFS.constants.O_RDONLY |
  NodeFS.constants.O_NOFOLLOW |
  NodeFS.constants.O_NONBLOCK |
  (platform === "darwin" ? 0x20000000 : 0);

export class TexosMissionFiles extends Context.Service<
  TexosMissionFiles,
  {
    readonly list: (
      input: TexosMissionListFilesInput,
    ) => Effect.Effect<TexosMissionListFilesResult, TexosMissionFilesError>;
    readonly read: (
      input: TexosMissionReadFileInput,
    ) => Effect.Effect<TexosMissionReadFileResult, TexosMissionFilesError>;
  }
>()("t3/nativeTexos/missionFiles/TexosMissionFiles") {}

const fail = (failure: TexosMissionFilesFailure, message: string) =>
  new TexosMissionFilesError({ failure, message });

class Refused extends Error {
  readonly failure: TexosMissionFilesFailure;
  constructor(failure: TexosMissionFilesFailure) {
    super(failure);
    this.failure = failure;
  }
}

/** Walks the folder without following links; anything that isn't a plain file or folder is left out. */
export async function listMissionFolder(root: string): Promise<TexosMissionListFilesResult> {
  const files: TexosMissionFile[] = [];
  let omitted = 0;
  let visited = 0;
  const pending: Array<{ readonly relative: string; readonly depth: number }> = [
    { relative: "", depth: 0 },
  ];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    const path = NodePath.join(root, folder.relative);
    // Narrows, but cannot close, the window in which a folder is swapped for a link.
    if (
      folder.relative !== "" &&
      !(await NodeFSP.lstat(path).catch(() => undefined))?.isDirectory()
    ) {
      omitted++;
      continue;
    }
    const entries = await NodeFSP.readdir(path, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (visited >= MISSION_FILE_LIMITS.entries) {
        omitted++;
        continue;
      }
      visited++;
      const relative = folder.relative === "" ? entry.name : `${folder.relative}/${entry.name}`;
      if (entry.isDirectory() && folder.depth + 1 < MISSION_FILE_LIMITS.depth) {
        pending.push({ relative, depth: folder.depth + 1 });
        continue;
      }
      if (!entry.isFile() || files.length >= MISSION_FILE_LIMITS.files) {
        omitted++;
        continue;
      }
      const stat = await NodeFSP.lstat(NodePath.join(root, relative)).catch(() => undefined);
      if (!stat?.isFile()) {
        omitted++;
        continue;
      }
      files.push({
        path: relative,
        byteLength: stat.size,
        changedAtMs: Math.max(0, Math.trunc(stat.mtimeMs)),
      });
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, omitted };
}

/** A path the listing could have produced: relative, `/`-separated, no empty, `.` or `..` part. */
export function missionFileSegments(path: string): ReadonlyArray<string> | undefined {
  if (
    Buffer.byteLength(path) > MISSION_FILE_LIMITS.pathBytes ||
    path.includes("\0") ||
    path.startsWith("/")
  )
    return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return undefined;
  return segments;
}

export async function readMissionFile(
  root: string,
  rootDevice: string,
  path: string,
  flags: number,
): Promise<TexosMissionReadFileResult> {
  const segments = missionFileSegments(path);
  if (!segments) throw new Refused("invalidPath");
  const handle = await NodeFSP.open(NodePath.join(root, ...segments), flags).catch(() => {
    throw new Refused("notFound");
  });
  try {
    const stat = await handle.stat({ bigint: true });
    // A hard link is a plain file that can name something outside the folder.
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== rootDevice)
      throw new Refused("unreadable");
    const byteLength = Number(stat.size);
    if (byteLength > TEXOS_MISSION_FILE_BYTES) return { kind: "tooLarge", byteLength };
    const buffer = Buffer.alloc(byteLength);
    let read = 0;
    while (read < byteLength) {
      const { bytesRead } = await handle.read(buffer, read, byteLength - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, MISSION_FILE_LIMITS.sniffBytes).includes(0))
      return { kind: "binary", byteLength: read };
    return { kind: "text", contents: bytes.toString("utf8"), byteLength: read };
  } finally {
    await handle.close();
  }
}

const make = Effect.gen(function* () {
  const receipts = yield* Receipts.ExecutionReceipts;
  const flags = missionReadFlags(yield* HostProcess.Platform);

  const folder = Effect.fn("TexosMissionFiles.folder")(function* (
    input: Pick<TexosMissionListFilesInput, "taskId" | "attemptId">,
  ) {
    if (!isTexosMissionId(input.taskId) || !isTexosMissionId(input.attemptId))
      return yield* fail("invalidPath", "This Mission link is not valid.");
    const threadId = yield* Effect.tryPromise({
      try: () => texosMissionThreadId(input.taskId, input.attemptId),
      catch: () => fail("invalidPath", "This Mission link is not valid."),
    });
    const receipt = yield* receipts
      .getByThread(threadId)
      .pipe(Effect.mapError(() => fail("unavailable", "Mission records are unavailable.")));
    if (!receipt) return yield* fail("notFound", "This engine has no run for this Mission.");
    const tree = receipt.intent.worktree;
    yield* validateExecutionWorktree(tree).pipe(
      Effect.mapError(() => fail("folderChanged", "The Mission's folder is no longer there.")),
    );
    return tree;
  });

  const refused = (cause: unknown) =>
    cause instanceof Refused
      ? fail(cause.failure, "This file can't be shown.")
      : fail("unreadable", "The Mission's folder can't be read.");

  return TexosMissionFiles.of({
    list: Effect.fn("TexosMissionFiles.list")(function* (input) {
      const tree = yield* folder(input);
      return yield* Effect.tryPromise({ try: () => listMissionFolder(tree.root), catch: refused });
    }),
    read: Effect.fn("TexosMissionFiles.read")(function* (input) {
      const tree = yield* folder(input);
      return yield* Effect.tryPromise({
        try: () => readMissionFile(tree.root, tree.device, input.path, flags),
        catch: refused,
      });
    }),
  });
});

export const layer = Layer.effect(TexosMissionFiles, make);

/** Outside native mode there are no Missions, and no receipts store to build. */
export const layerUnavailable = Layer.succeed(
  TexosMissionFiles,
  TexosMissionFiles.of({
    list: Effect.fn("TexosMissionFiles.list")(function* () {
      return yield* fail("unavailable", "Missions run only inside TexOS.");
    }),
    read: Effect.fn("TexosMissionFiles.read")(function* () {
      return yield* fail("unavailable", "Missions run only inside TexOS.");
    }),
  }),
);
