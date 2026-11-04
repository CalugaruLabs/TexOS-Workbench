// @effect-diagnostics nodeBuiltinImport:off -- Owns only disposable repositories, SQLite files and child PIDs captured at spawn.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { executionEnvelope, type ExecutionIntent } from "./executionProtocol.ts";
import { syntheticIntent, syntheticAuthorization } from "./execution.testkit.ts";
import type { SyntheticDriverBootstrap } from "./executionDriver.testkit.ts";

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const launcher = NodePath.join(root, ".build-run/run-execution-driver");

interface ReceiptResult {
  readonly commandID: string;
  readonly canonicalRunID: string;
  readonly envelopeDigest: string;
  readonly runtimeID: string;
  readonly childID: string;
  readonly t3ThreadID: string;
  readonly t3ProviderSessionID: string;
  readonly phase: string;
  readonly mappings: { readonly nativeThreadID?: string; readonly nativeTurnID?: string };
}

class OwnedFixturePeer {
  readonly child: NodeChildProcess.ChildProcess;
  readonly exited: Promise<void>;
  private readonly sendPipe: NodeStream.Writable;
  private readonly binding: SyntheticDriverBootstrap["binding"];
  private readonly intent: ExecutionIntent;
  private readonly authorizationEpoch: number;
  private readonly pending = new Map<
    string,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private runtimeID: string | undefined;
  private admitted: ReceiptResult | undefined;
  private releaseAssociation: (() => void) | undefined;
  private readonly association = new Promise<void>((resolve) => {
    this.releaseAssociation = resolve;
  });
  private buffer = "";
  private stderr = "";

  constructor(
    bootstrapPath: string,
    bootstrap: SyntheticDriverBootstrap,
    intent: ExecutionIntent,
    authorizationEpoch: number,
  ) {
    this.binding = bootstrap.binding;
    this.intent = intent;
    this.authorizationEpoch = authorizationEpoch;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("TEXOS_")),
    );
    this.child = NodeChildProcess.spawn(launcher, ["--bootstrap", bootstrapPath], {
      cwd: bootstrap.repositoryRoot,
      env: environment,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    const send = this.child.stdio[3];
    const receive = this.child.stdio[4];
    if (!(send instanceof NodeStream.Writable) || !(receive instanceof NodeStream.Readable))
      throw new Error("fixturePipesUnavailable");
    this.sendPipe = send;
    receive.setEncoding("utf8");
    receive.on("data", (part: string) => {
      this.buffer += part;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const frame: Record<string, unknown> = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        if (frame.kind === "response") {
          const pending = this.pending.get(String(frame.id));
          if (!pending) throw new Error("unexpectedFixtureReply");
          this.pending.delete(String(frame.id));
          if (!frame.ok) {
            pending.reject(new Error("fixtureRequestRefused"));
            continue;
          }
          if (pending.method === "execution.hello")
            this.runtimeID = (frame.result as { runtimeID: string }).runtimeID;
          if (pending.method === "execution.admit") {
            this.admitted = frame.result as ReceiptResult;
            this.releaseAssociation?.();
          }
          pending.resolve(frame.result);
        } else {
          void this.authorize(frame).catch((error) => {
            for (const pending of this.pending.values()) pending.reject(error);
            this.child.kill("SIGTERM");
          });
        }
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8192);
    });
    this.exited = new Promise<void>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => {
        for (const pending of this.pending.values())
          pending.reject(new Error("fixtureChildExited"));
        if (code !== 0 && signal !== "SIGKILL" && signal !== "SIGTERM")
          reject(new Error("fixtureExit: " + this.stderr));
        else resolve();
      });
    });
  }

  private async authorize(frame: Record<string, unknown>) {
    assert.equal(frame.method, "execution.authorizeStart");
    await this.association;
    const saved = this.admitted!;
    const params = frame.params as Record<string, string>;
    assert.equal(params.commandID, this.intent.commandID);
    assert.equal(params.canonicalRunID, this.intent.canonicalRunID);
    assert.equal(params.envelopeDigest, executionEnvelope(this.intent).digest);
    assert.equal(params.runtimeID, this.runtimeID);
    for (const field of ["childID", "t3ThreadID", "t3ProviderSessionID"] as const)
      assert.equal(params[field], saved[field]);
    if (params.nativeThreadID !== undefined || params.providerThreadID !== undefined) {
      const stored = (await this.request("execution.status", {
        commandID: this.intent.commandID,
        envelopeDigest: executionEnvelope(this.intent).digest,
      })) as ReceiptResult;
      assert.equal(params.nativeThreadID, stored.mappings.nativeThreadID);
      assert.equal(
        params.providerThreadID,
        (stored.mappings as Record<string, string>).providerThreadID,
      );
    }
    const result = {
      ...syntheticAuthorization(this.intent, this.authorizationEpoch),
      runtimeID: saved.runtimeID,
      childID: saved.childID,
    };
    this.sendPipe.write(
      JSON.stringify({
        version: 2,
        namespace: "texos.execution",
        kind: "response",
        id: frame.id,
        ...this.binding,
        ok: true,
        result,
      }) + "\n",
    );
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = NodeCrypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.sendPipe.write(
        JSON.stringify({
          version: 2,
          namespace: "texos.execution",
          kind: "request",
          id,
          ...this.binding,
          method,
          params,
        }) + "\n",
      );
    });
  }

  async close() {
    this.sendPipe.end();
    await this.exited;
  }
  async kill() {
    this.child.kill("SIGKILL");
    await this.exited;
  }
}

async function fixture(holdAttempt = false) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "texos-owned-execution-"));
  const parent = await NodeFSP.realpath(directory);
  const repositoryRoot = NodePath.join(parent, "repo");
  await NodeFSP.mkdir(repositoryRoot);
  const template = NodePath.join(parent, "empty-template");
  await NodeFSP.mkdir(template);
  NodeChildProcess.execFileSync(
    "/usr/bin/git",
    ["init", "--quiet", `--template=${template}`, repositoryRoot],
    {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: "pipe",
    },
  );
  await NodeFSP.writeFile(NodePath.join(repositoryRoot, "answer.ts"), "export const answer = 0;\n");
  const stat = await NodeFSP.stat(repositoryRoot, { bigint: true });
  const seed = syntheticIntent(repositoryRoot);
  const intent = {
    ...seed,
    worktree: { ...seed.worktree, device: String(stat.dev), inode: String(stat.ino) },
  };
  const bootstrap: SyntheticDriverBootstrap = {
    binding: {
      authorityID: intent.scope.authorityID,
      hostID: intent.scope.hostID,
      hostGeneration: NodeCrypto.randomUUID(),
    },
    repositoryRoot,
    databasePath: NodePath.join(parent, "receipts.sqlite"),
    countersPath: NodePath.join(parent, "counters.json"),
    holdAttempt,
  };
  const path = NodePath.join(parent, "bootstrap.json");
  await NodeFSP.writeFile(path, JSON.stringify(bootstrap), { mode: 0o600 });
  return { parent, path, bootstrap, intent };
}

function receiptBarrier(
  bootstrap: SyntheticDriverBootstrap,
  predicate: (phase: string, mappings: Record<string, string>) => boolean,
) {
  let watcher: NodeFS.FSWatcher;
  let cancel: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (!NodeFS.existsSync(bootstrap.databasePath)) return;
      try {
        const db = new NodeSqlite.DatabaseSync(bootstrap.databasePath, { readOnly: true });
        try {
          const row = db
            .prepare("SELECT phase,mappings_json FROM native_execution_receipts LIMIT 1")
            .get() as { phase: string; mappings_json: string } | undefined;
          if (row && predicate(row.phase, JSON.parse(row.mappings_json))) {
            watcher.close();
            resolve();
          }
        } finally {
          db.close();
        }
      } catch {
        /* Schema creation and a writer's transaction may precede the next filesystem notification. */
      }
    };
    watcher = NodeFS.watch(NodePath.dirname(bootstrap.databasePath), check);
    cancel = () => {
      watcher.close();
      reject(new Error("fixtureReceiptBarrierCancelled"));
    };
    check();
  });
  return { promise, cancel: () => cancel?.() };
}

describe("owned fd3/fd4 controlled execution child", () => {
  it.live("edits once, replies through the private channel, and reopens without resubmission", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.promise(async () => {
        const data = await fixture();
        let peer: OwnedFixturePeer | undefined;
        const barrier = receiptBarrier(data.bootstrap, (phase) => phase === "attemptFinished");
        try {
          peer = new OwnedFixturePeer(data.path, data.bootstrap, data.intent, now);
          const hello = (await peer.request("execution.hello", {
            capabilities: ["texos.execution.authorize.v2"],
          })) as { runtimeID: string };
          const admitted = (await peer.request("execution.admit", data.intent)) as ReceiptResult;
          await barrier.promise;
          const params = {
            commandID: data.intent.commandID,
            envelopeDigest: executionEnvelope(data.intent).digest,
          };
          const result = (await peer.request("execution.status", params)) as ReceiptResult;
          assert.equal(result.phase, "attemptFinished");
          assert.equal(result.childID, admitted.childID);
          assert.equal(
            await NodeFSP.readFile(
              NodePath.join(data.bootstrap.repositoryRoot, "answer.ts"),
              "utf8",
            ),
            "export const answer = 42;\n",
          );
          assert.isString(result.mappings.nativeThreadID);
          assert.notEqual(result.t3ProviderSessionID, result.mappings.nativeThreadID);
          assert.deepEqual(await peer.request("execution.admit", data.intent), result);
          assert.deepEqual(
            JSON.parse(await NodeFSP.readFile(data.bootstrap.countersPath!, "utf8")),
            {
              factoryCalls: 1,
              edits: 1,
            },
          );
          await peer.close();
          peer = undefined;
          const bootstrap = {
            ...data.bootstrap,
            binding: { ...data.bootstrap.binding, hostGeneration: NodeCrypto.randomUUID() },
          };
          await NodeFSP.writeFile(data.path, JSON.stringify(bootstrap));
          peer = new OwnedFixturePeer(data.path, bootstrap, data.intent, now);
          const reopened = (await peer.request("execution.hello", {
            capabilities: ["texos.execution.authorize.v2"],
          })) as { runtimeID: string };
          assert.equal(reopened.runtimeID, hello.runtimeID);
          assert.deepEqual(await peer.request("execution.status", params), result);
          assert.deepEqual(
            JSON.parse(await NodeFSP.readFile(data.bootstrap.countersPath!, "utf8")),
            {
              factoryCalls: 1,
              edits: 1,
            },
          );
          await peer.close();
          peer = undefined;
        } finally {
          if (peer) await peer.kill();
          await NodeFSP.rm(data.parent, { recursive: true });
        }
      });
    }),
  );

  it.live(
    "an owned-child interruption retains uncertainty, mappings and counters without replay",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.promise(async () => {
          const data = await fixture(true);
          let peer: OwnedFixturePeer | undefined;
          const barrier = receiptBarrier(
            data.bootstrap,
            (phase, mappings) =>
              phase === "running" &&
              Boolean(mappings.nativeThreadID && mappings.nativeTurnID) &&
              NodeFS.existsSync(data.bootstrap.countersPath!) &&
              JSON.parse(NodeFS.readFileSync(data.bootstrap.countersPath!, "utf8")).edits === 1,
          );
          try {
            peer = new OwnedFixturePeer(data.path, data.bootstrap, data.intent, now);
            await peer.request("execution.hello", {
              capabilities: ["texos.execution.authorize.v2"],
            });
            const admitted = (await peer.request("execution.admit", data.intent)) as ReceiptResult;
            await barrier.promise;
            const params = {
              commandID: data.intent.commandID,
              envelopeDigest: executionEnvelope(data.intent).digest,
            };
            const running = (await peer.request("execution.status", params)) as ReceiptResult;
            assert.equal(running.phase, "running");
            await peer.kill();
            peer = undefined;
            const bootstrap = {
              ...data.bootstrap,
              binding: { ...data.bootstrap.binding, hostGeneration: NodeCrypto.randomUUID() },
            };
            await NodeFSP.writeFile(data.path, JSON.stringify(bootstrap));
            peer = new OwnedFixturePeer(data.path, bootstrap, data.intent, now);
            await peer.request("execution.hello", {
              capabilities: ["texos.execution.authorize.v2"],
            });
            const recovered = (await peer.request("execution.status", params)) as ReceiptResult;
            assert.equal(recovered.phase, "uncertain");
            assert.equal(recovered.childID, admitted.childID);
            assert.equal(recovered.runtimeID, running.runtimeID);
            assert.deepEqual(recovered.mappings, running.mappings);
            const unknown = await peer.request("execution.status", {
              commandID: NodeCrypto.randomUUID(),
              envelopeDigest: "a".repeat(64),
            });
            assert.propertyVal(unknown, "phase", "unknown");
            assert.deepEqual(
              JSON.parse(await NodeFSP.readFile(data.bootstrap.countersPath!, "utf8")),
              { factoryCalls: 1, edits: 1 },
            );
            await peer.close();
            peer = undefined;
          } finally {
            if (peer) await peer.kill();
            await NodeFSP.rm(data.parent, { recursive: true });
          }
        });
      }),
  );
});
