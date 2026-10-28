import { describe, expect, it, afterEach } from "@effect/vitest";
import {
  isNativeTexos,
  nativeCommandProblem,
  nativeHttpAllowed,
  nativeRpcAllowed,
  nativeStartupProblem,
  requireNativeSelection,
  markFreshPreviewThread,
  isFreshPreviewThread,
} from "./profile.ts";
const original = process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
const readFD = process.env.T3CODE_TEXOS_BRIDGE_READ_FD;
const writeFD = process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD;
afterEach(() => {
  if (readFD === undefined) delete process.env.T3CODE_TEXOS_BRIDGE_READ_FD;
  else process.env.T3CODE_TEXOS_BRIDGE_READ_FD = readFD;
  if (writeFD === undefined) delete process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD;
  else process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD = writeFD;
  if (original === undefined) delete process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
  else process.env.T3CODE_TEXOS_NATIVE_BRIDGE = original;
});
const send = {
  type: "message.dispatch",
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
  text: "hello",
  attachments: [],
  modelSelection: { instanceId: "codex", model: "native-settings" },
};
describe("bounded embedded profile", () => {
  it("is opt-in at process start, never inferred from an absent SDK", () => {
    delete process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
    expect(isNativeTexos()).toBe(false);
    process.env.T3CODE_TEXOS_NATIVE_BRIDGE = "1";
    expect(isNativeTexos()).toBe(true);
  });
  it("allows user text, denies context/history/queue and agent/scheduled requests", () => {
    expect(nativeCommandProblem(send)).toBeUndefined();
    for (const patch of [
      { context: { records: [] } },
      { attachments: [{}] },
      { createdBy: "agent" },
      { creationSource: "mcp" },
      { scheduledTaskId: "schedule" },
      { senderThreadId: "agent" },
      { dispatchMode: { type: "queue_after_active" } },
      { restartContinuationOfRunId: "run" },
      { idleCompaction: {} },
      { text: "🙂".repeat(2049) },
    ])
      expect(nativeCommandProblem({ ...send, ...patch })).toBeDefined();
    for (const type of [
      "thread.fork",
      "thread.merge_back",
      "thread.model-selection.set",
      "thread.runtime-mode.set",
      "runtime-request.respond",
      "queued-run.start",
      "delegated_task.request",
      "prepared-run.release",
    ])
      expect(nativeCommandProblem({ type })).toBeDefined();
  });
  it("denies arbitrary models/options and exposes only native-settings routes", () => {
    for (const instanceId of ["codex", "claudeAgent"])
      expect(() => requireNativeSelection({ instanceId, model: "native-settings" })).not.toThrow();
    for (const value of [
      { instanceId: "codex", model: "gpt-5.4" },
      { instanceId: "other", model: "native-settings" },
      { instanceId: "codex", model: "native-settings", options: {} },
    ])
      expect(() => requireNativeSelection(value)).toThrow();
  });
  it("denies terminal, shell, owner files, mutations, tools, credential and future RPCs", () => {
    expect(nativeRpcAllowed("orchestration.launchThread")).toBe(true);
    for (const method of [
      "terminal.create",
      "terminal.write",
      "shell.openInEditor",
      "filesystem.browse",
      "filesystem.getMetadata",
      "projects.readFile",
      "projects.writeFile",
      "projects.listEntries",
      "projects.ensureScratch",
      "vcs.createWorktree",
      "mcpApps.callTool",
      "provider.auth.start",
      "provider.consumeResetCredit",
      "server.updateSettings",
      "unknown.future",
    ])
      expect(nativeRpcAllowed(method)).toBe(false);
  });
  it("HTTP cannot bypass RPC via assets, MCP, file uploads or project mutations", () => {
    expect(nativeHttpAllowed("GET", "/ws")).toBe(true);
    expect(nativeHttpAllowed("POST", "/api/auth/browser-session")).toBe(true);
    expect(nativeHttpAllowed("GET", "/assets/client-abc.js")).toBe(true);
    expect(nativeHttpAllowed("GET", "/api/orchestration/threads/preview-id/bounded")).toBe(true);
    for (const path of [
      "/api/assets/token/private",
      "/mcp",
      "/oauth/mcp/token",
      "/api/projects/mutate",
      "/api/orchestration/threads/id/transcript",
      "/api/attachments/upload",
      "/%2e%2e/secret",
    ])
      expect(nativeHttpAllowed("GET", path)).toBe(false);
    expect(nativeHttpAllowed("POST", "/assets/client.js")).toBe(false);
  });
});

it("requires private descriptors, loopback, bundled assets and no owner-store/cwd bootstrap before startup", () => {
  const config = {
    baseDir: "/private/synthetic-workbench",
    devUrl: undefined,
    host: "127.0.0.1",
    autoBootstrapProjectFromCwd: false,
  };
  delete process.env.T3CODE_TEXOS_BRIDGE_READ_FD;
  expect(nativeStartupProblem(config)).toBeDefined();
  process.env.T3CODE_TEXOS_BRIDGE_READ_FD = "3";
  process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD = "4";
  expect(nativeStartupProblem(config)).toBeUndefined();
  for (const patch of [
    { baseDir: "/owner/.t3" },
    { baseDir: "/owner/Library/Application Support/com.calugaruos.texos.v4.daily-preview-v5" },
    { baseDir: "/owner/com.calugaruos.texos.v4.preview" },
    { devUrl: new URL("http://localhost:5173") },
    { host: "0.0.0.0" },
    { autoBootstrapProjectFromCwd: true },
  ])
    expect(nativeStartupProblem({ ...config, ...patch })).toBeDefined();
});

it("old projections are not implicitly admitted as fresh process-local threads", () => {
  const id = "synthetic-new-process-thread";
  expect(isFreshPreviewThread(id)).toBe(false);
  markFreshPreviewThread(id);
  expect(isFreshPreviewThread(id)).toBe(true);
  expect(isFreshPreviewThread("old-persisted-thread")).toBe(false);
});
