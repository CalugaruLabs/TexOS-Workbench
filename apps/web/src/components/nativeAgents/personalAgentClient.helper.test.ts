// @effect-diagnostics nodeBuiltinImport:off - Explicit packaged software fixture with disposable storage and no provider execution.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { expect, it } from "vite-plus/test";
import type { PersonalAgentResponse } from "@t3tools/contracts";
import { PersonalAgentClient, type PersonalAgentTransport } from "./personalAgentClient";

const explicitPackage = process.env.WORKBENCH_TEST_PERSONAL_AGENTS_PACKAGE;

it.runIf(explicitPackage)(
  "negotiates the actual pinned observe-only helper through the Workbench client",
  async () => {
    const software = await NodeFSP.realpath(explicitPackage!);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(software, "manifest.json"), "utf8"),
    ) as {
      engineCommit: string;
      node: string;
      entrypoint: string;
      files: Record<string, string>;
    };
    expect(manifest.engineCommit).toBe("37d9fbda549225a7fd83be5d6a8cdfd6aba438de");
    expect(manifest.node).toBe("bin/node");
    expect(manifest.entrypoint).toBe("runtime/src/main.mjs");
    for (const [relative, digest] of Object.entries(manifest.files)) {
      expect(relative.split("/").every((part) => part && part !== "." && part !== "..")).toBe(true);
      expect(
        NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(NodePath.join(software, relative)))
          .digest("hex"),
      ).toBe(digest);
    }
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "texos-observe-workbench-")),
    );
    const authorityID = "synthetic-workbench-observation-" + NodeCrypto.randomUUID();
    const child = NodeChildProcess.spawn(
      NodePath.join(software, manifest.node),
      [
        NodePath.join(software, manifest.entrypoint),
        "--data-dir",
        root,
        "--authority",
        authorityID,
        "--observe-only",
      ],
      {
        cwd: root,
        env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const requests: string[] = [];
    const pending = new Map<
      string,
      { resolve: (response: PersonalAgentResponse) => void; reject: (error: Error) => void }
    >();
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        for (const request of pending.values())
          request.reject(new Error("Packaged helper exited before replying."));
        pending.clear();
        resolve(code);
      });
    });
    child.stderr.resume();
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const response = JSON.parse(line) as PersonalAgentResponse;
      if (response.kind !== "response") return;
      const request = pending.get(response.id);
      pending.delete(response.id);
      request?.resolve(response);
    });
    const events: ReturnType<PersonalAgentTransport["events"]> = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {},
    };
    const client = new PersonalAgentClient({
      uuid: NodeCrypto.randomUUID,
      events: () => events,
      async command(method, params, id) {
        requests.push(method);
        const response = await new Promise<PersonalAgentResponse>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(
            JSON.stringify({ version: 2, id, authorityID, method, params }) + "\n",
            (error) => {
              if (error) {
                pending.delete(id);
                reject(error);
              }
            },
          );
        });
        if (!response.ok) throw new Error(response.error.message);
        return response.result;
      },
    });
    try {
      await client.connect();
      expect(client.getSnapshot()).toMatchObject({
        connected: true,
        hello: { mode: "observeOnly", executionAvailable: false },
        snapshot: { mode: "observeOnly", executionAvailable: false, runs: [] },
      });
      await client.command("agents.create", {
        name: "Saved synthetic role",
        provider: "codex",
        instructions: "Keep this role available for inspection.",
      });
      const agent = client.getSnapshot().snapshot!.agents[0]!;
      expect(agent.name).toBe("Saved synthetic role");
      await expect(
        client.history({ collection: "messages", conversationID: agent.conversationID }),
      ).resolves.toMatchObject({ items: [], nextBefore: null });
      for (const method of [
        "agents.submit",
        "agents.stop",
        "agents.reconcile",
        "agents.answer",
        "agents.respond",
      ] as const)
        await expect(client.command(method, {})).rejects.toThrow("not enabled");
      await client.refresh();
      expect(client.getSnapshot()).toMatchObject({
        connected: true,
        snapshot: { runs: [], agents: [{ id: agent.id }] },
      });
      expect(requests).toEqual([
        "agents.hello",
        "agents.snapshot",
        "agents.create",
        "agents.history",
        "agents.snapshot",
      ]);
    } finally {
      client.disconnect();
      child.stdin.end();
      child.kill("SIGTERM");
      try {
        expect(await exit).toBe(0);
      } finally {
        lines.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  },
);
