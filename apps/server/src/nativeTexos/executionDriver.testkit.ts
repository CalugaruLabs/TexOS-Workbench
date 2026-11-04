// @effect-diagnostics nodeBuiltinImport:off -- Test-only owned fd3/fd4 child; all disk paths are explicitly quarantined fixture paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

import Migration from "../persistence/Migrations/070_NativeExecutionReceipts.ts";
import * as Receipts from "./executionReceipts.ts";
import { ControlledExecutionProvider, makeExecutionControl } from "./executionControl.ts";
import { executionEndpoint, PrivateExecutionChannel } from "./executionChannel.ts";
import {
  EXECUTION_FRAME_BYTES,
  exact,
  identifier,
  object,
  type ExecutionChannelBinding,
} from "./executionProtocol.ts";
import { makeControlledCodexFixture } from "./executionCodex.testkit.ts";

export interface SyntheticDriverBootstrap {
  readonly binding: ExecutionChannelBinding;
  readonly repositoryRoot: string;
  readonly databasePath: string;
  readonly countersPath?: string;
  readonly holdAttempt?: boolean;
}

class SyntheticExecutionDriverError extends Schema.TaggedError<SyntheticExecutionDriverError>()(
  "SyntheticExecutionDriverError",
  { code: Schema.String },
) {}

function inside(path: string, parent: string) {
  const relative = NodePath.relative(parent, path);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
}

function ownedRegular(path: string) {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== NodeProcess.getuid?.())
    throw new Error("fixtureFileNotOwnedRegular");
  return stat;
}

function outputPath(value: unknown, parent: string): string {
  if (
    typeof value !== "string" ||
    NodePath.resolve(value) !== value ||
    !inside(value, parent) ||
    value === parent
  )
    throw new Error("fixtureOutputOutsideParent");
  const directory = NodePath.dirname(value);
  if (NodeFS.realpathSync(directory) !== directory || !inside(directory, parent))
    throw new Error("fixtureOutputLinkedParent");
  if (NodeFS.existsSync(value)) ownedRegular(value);
  else {
    try {
      NodeFS.lstatSync(value);
      throw new Error("fixtureOutputLinkedLeaf");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  return value;
}

export function readSyntheticDriverBootstrap(path: string): SyntheticDriverBootstrap {
  const temporary = NodeFS.realpathSync(NodeOS.tmpdir());
  if (!NodePath.isAbsolute(path) || NodeFS.realpathSync(path) !== path || !inside(path, temporary))
    throw new Error("fixtureBootstrapNotPhysicalTemporaryFile");
  const parent = NodePath.dirname(path);
  const directory = NodeFS.lstatSync(parent);
  if (
    !directory.isDirectory() ||
    directory.uid !== NodeProcess.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("fixtureParentNotPrivate");
  if (ownedRegular(path).size > 8192) throw new Error("fixtureBootstrapTooLarge");
  const value = object(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  const allowed = ["binding", "repositoryRoot", "databasePath", "countersPath", "holdAttempt"];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !["binding", "repositoryRoot", "databasePath"].every((key) => Object.hasOwn(value, key))
  )
    throw new Error("invalidFixtureBootstrapFields");
  const binding = exact(value.binding, ["authorityID", "hostID", "hostGeneration"]);
  for (const entry of Object.values(binding)) identifier(entry);
  if (
    typeof value.repositoryRoot !== "string" ||
    NodeFS.realpathSync(value.repositoryRoot) !== value.repositoryRoot ||
    !inside(value.repositoryRoot, parent)
  )
    throw new Error("fixtureRepositoryOutsideParent");
  const repository = NodeFS.lstatSync(value.repositoryRoot);
  if (!repository.isDirectory() || repository.uid !== NodeProcess.getuid?.())
    throw new Error("fixtureRepositoryNotOwned");
  const git = NodeFS.lstatSync(NodePath.join(value.repositoryRoot, ".git"));
  if ((!git.isDirectory() && !git.isFile()) || git.uid !== NodeProcess.getuid?.())
    throw new Error("fixtureRepositoryNotGit");
  const databasePath = outputPath(value.databasePath, parent);
  const countersPath = Object.hasOwn(value, "countersPath")
    ? outputPath(value.countersPath, parent)
    : undefined;
  if ([databasePath, countersPath].includes(path) || databasePath === countersPath)
    throw new Error("fixturePathsOverlap");
  if (Object.hasOwn(value, "holdAttempt") && typeof value.holdAttempt !== "boolean")
    throw new Error("invalidFixtureHold");
  return {
    binding: Object.freeze({ ...binding }) as unknown as ExecutionChannelBinding,
    repositoryRoot: value.repositoryRoot,
    databasePath,
    ...(countersPath === undefined ? {} : { countersPath }),
    ...(value.holdAttempt === undefined ? {} : { holdAttempt: value.holdAttempt as boolean }),
  };
}

function fixtureCounters(path: string | undefined) {
  let values = { factoryCalls: 0, edits: 0 };
  if (path && NodeFS.existsSync(path)) {
    if (ownedRegular(path).size > 1024) throw new Error("fixtureCountersTooLarge");
    const previous = exact(JSON.parse(NodeFS.readFileSync(path, "utf8")), [
      "factoryCalls",
      "edits",
    ]);
    for (const value of Object.values(previous))
      if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error("invalidFixtureCounters");
    values = previous as typeof values;
  }
  const save = () => {
    if (!path) return;
    const temporary = path + "." + NodeCrypto.randomUUID() + ".tmp";
    const file = NodeFS.openSync(
      temporary,
      NodeFS.constants.O_WRONLY |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        NodeFS.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      NodeFS.writeFileSync(file, JSON.stringify(values) + "\n");
      NodeFS.fsyncSync(file);
    } finally {
      NodeFS.closeSync(file);
    }
    NodeFS.renameSync(temporary, path);
  };
  if (path && !NodeFS.existsSync(path)) save();
  return {
    factory: () => {
      values.factoryCalls++;
      save();
    },
    edit: () => {
      values.edits++;
      save();
    },
  };
}

export const runSyntheticExecutionDriver = Effect.fn("SyntheticExecutionDriver.run")(function* (
  bootstrap: SyntheticDriverBootstrap,
) {
  const counters = yield* Effect.sync(() => fixtureCounters(bootstrap.countersPath));
  const provider = yield* makeControlledCodexFixture({
    repositoryRoot: bootstrap.repositoryRoot,
    onFactory: counters.factory,
    onEdit: counters.edit,
    ...(bootstrap.holdAttempt === undefined ? {} : { holdAttempt: bootstrap.holdAttempt }),
  });
  const control = yield* makeExecutionControl(bootstrap.binding).pipe(
    Effect.provideService(ControlledExecutionProvider, provider),
  );
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const input = NodeFS.fstatSync(3).isSocket()
          ? new NodeNet.Socket({ fd: 3, readable: true, writable: false })
          : NodeFS.createReadStream("", { fd: 3, autoClose: true });
        const output = NodeFS.fstatSync(4).isSocket()
          ? new NodeNet.Socket({ fd: 4, readable: false, writable: true })
          : NodeFS.createWriteStream("", { fd: 4, autoClose: true });
        const implementation = executionEndpoint(control);
        let disconnection: Promise<void> | undefined;
        const endpoint = {
          handle: implementation.handle,
          disconnect: () => (disconnection ??= implementation.disconnect()),
        };
        let closed = false;
        let buffer = Buffer.alloc(0);
        const finish = (failed = false) => {
          if (closed) return;
          closed = true;
          channel.close();
          input.destroy();
          output.end();
          void endpoint
            .disconnect()
            .then(() => (failed ? reject(new Error("fixtureChannelRefused")) : resolve()), reject);
        };
        const channel = new PrivateExecutionChannel(
          bootstrap.binding,
          endpoint,
          (frame) => {
            const wire = Buffer.from(JSON.stringify(frame) + "\n");
            if (
              closed ||
              wire.length > EXECUTION_FRAME_BYTES ||
              output.writableLength + wire.length > 8 * EXECUTION_FRAME_BYTES
            )
              throw new Error("fixtureOutputLimit");
            output.write(wire);
          },
          () => finish(true),
        );
        input.on("data", (chunk: Buffer) => {
          if (closed) return;
          try {
            if (chunk.length > 8 * EXECUTION_FRAME_BYTES) throw new Error("fixtureInputLimit");
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
              const newline = buffer.indexOf(10);
              if (newline < 0) {
                if (buffer.length > EXECUTION_FRAME_BYTES) throw new Error("fixtureFrameLimit");
                break;
              }
              if (newline === 0 || newline > EXECUTION_FRAME_BYTES)
                throw new Error("fixtureFrameLimit");
              const wire = buffer.subarray(0, newline);
              buffer = buffer.subarray(newline + 1);
              channel.receive(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wire)));
            }
          } catch {
            finish(true);
          }
        });
        input.on("end", () => finish(buffer.length !== 0));
        input.on("error", () => finish(true));
        input.on("close", () => finish());
        output.on("error", () => finish(true));
      }),
    catch: () => new SyntheticExecutionDriverError({ code: "controlledFixtureTransportFailed" }),
  });
});

function driverProgram(bootstrap: SyntheticDriverBootstrap) {
  const setup = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      if (tables.length === 0) yield* Migration;
      else if (
        tables.length !== 2 ||
        tables.some(
          ({ name }) => !["native_execution_runtime", "native_execution_receipts"].includes(name),
        )
      )
        throw new Error("notControlledReceiptDatabase");
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`PRAGMA synchronous = FULL`;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: bootstrap.databasePath })));
  const runtime = Layer.mergeAll(
    Receipts.layer.pipe(Layer.provideMerge(setup)),
    IdAllocator.layer,
    McpProviderSessions.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return runSyntheticExecutionDriver(bootstrap).pipe(Effect.scoped, Effect.provide(runtime));
}

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = NodeProcess.argv.slice(2);
  if (args.length === 1 && args[0] === "--help")
    NodeProcess.stderr.write(
      "Controlled fixture only: --bootstrap /absolute/private-temporary/bootstrap.json; inherited fd3 read / fd4 write.\n",
    );
  else {
    try {
      if (args.length !== 2 || args[0] !== "--bootstrap" || !args[1])
        throw new Error("invalidFixtureArguments");
      if (
        ![3, 4].every((fd) => {
          const stat = NodeFS.fstatSync(fd);
          return stat.isFIFO() || stat.isSocket();
        })
      )
        throw new Error("fixtureRequiresPrivatePipes");
      const bootstrap = readSyntheticDriverBootstrap(args[1]);
      void Effect.runPromise(driverProgram(bootstrap)).catch(() => {
        NodeProcess.stderr.write("Controlled execution fixture failed.\n");
        NodeProcess.exit(1);
      });
    } catch {
      NodeProcess.stderr.write(
        "Controlled execution fixture refused bootstrap or private descriptors.\n",
      );
      NodeProcess.exit(1);
    }
  }
}
