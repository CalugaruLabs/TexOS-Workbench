/** Process-start capability, never a browser/settings toggle. */
export const isNativeTexos = () => process.env.T3CODE_TEXOS_NATIVE_BRIDGE === "1";
export const NATIVE_MODEL = "native-settings";
export const NATIVE_LABEL = "Native TexOS execution in Workbench";
export const nativeInstanceIds = ["codex", "claudeAgent"] as const;

export function requireNativeSelection(selection: { instanceId: string; model: string }) {
  if (
    !nativeInstanceIds.includes(selection.instanceId as (typeof nativeInstanceIds)[number]) ||
    selection.model !== NATIVE_MODEL ||
    Object.keys(selection).some((key) => key !== "instanceId" && key !== "model")
  ) {
    throw new Error(
      "Workbench uses the Codex/Claude route and model configured in native TexOS Settings.",
    );
  }
}

/** All filesystem, terminal, tools, provider setup and unknown future RPCs are denied. */
const allowedRpc = new Set([
  "server.probe",
  "server.getConfig",
  "server.getSettings",
  "server.getKeybindings",
  "subscribeServerConfig",
  "subscribeServerLifecycle",
  "server.reportClientActivity",
  "server.getBackgroundPolicy",
  "subscribeBackgroundPolicy",
  "subscribeAuthAccess",
  "projects.list",
  "projects.mutate",
  "orchestration.dispatchCommand",
  "orchestration.launchThread",
  "orchestration.subscribeShell",
  "orchestration.subscribeThread",
  "orchestration.getThreadProjection",
  "orchestration.getTurnItem",
]);
export const nativeRpcAllowed = (method: string) => allowedRpc.has(method);

export function nativeCommandProblem<T extends { type: string }>(command: T): string | undefined {
  const value = command as { type: string; [key: string]: unknown };
  try {
    switch (value.type) {
      case "thread.create":
        requireNativeSelection(
          value.modelSelection as Parameters<typeof requireNativeSelection>[0],
        );
        if (
          value.branch != null ||
          value.worktreePath != null ||
          value.importedNativeThread != null ||
          value.runtimeMode !== "approval-required" ||
          value.interactionMode !== "default" ||
          value.createdBy !== "user"
        )
          throw new Error("Only fresh native-settings chat threads are supported.");
        return;
      case "message.dispatch":
        if (value.modelSelection !== undefined)
          requireNativeSelection(
            value.modelSelection as Parameters<typeof requireNativeSelection>[0],
          );
        if (
          (value.dispatchMode as { type?: string })?.type !== "start_immediately" ||
          value.createdBy !== "user" ||
          !["web"].includes(String(value.creationSource)) ||
          !Array.isArray(value.attachments) ||
          value.attachments.length !== 0 ||
          typeof value.text !== "string" ||
          Buffer.byteLength(value.text) > 8192 ||
          !value.text.trim() ||
          value.text.trimStart().startsWith("/")
        ) {
          throw new Error("Only immediate bounded user text is supported.");
        }
        for (const key of [
          "titleSeed",
          "context",
          "guestMessageId",
          "scheduledTaskId",
          "senderThreadId",
          "idleCompaction",
          "sourcePlanRef",
          "restartContinuationOfRunId",
          "usageLimitContinuationOfRunId",
          "manualContinuationOfRunId",
          "usageLimitRecoveryRequestId",
          "delegatedCompletion",
          "notification",
          "deliveryIntent",
        ]) {
          if (value[key] !== undefined) throw new Error(`Unsupported native chat input: ${key}`);
        }
        return;
      case "thread.stop":
      case "thread.visit":
      case "thread.mark-unread":
        return;
      default:
        return `Unsupported in native TexOS chat preview: ${value.type}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid native chat input";
  }
}

export function nativeHttpAllowed(method: string, rawURL: string): boolean {
  let path: string;
  if (rawURL.includes("..") || rawURL.includes("\\") || /%(?:2e|2f|5c)/i.test(rawURL)) return false;
  try {
    path = new URL(rawURL, "http://127.0.0.1").pathname;
  } catch {
    return false;
  }
  if (method === "POST")
    return [
      "/api/auth/browser-session",
      "/api/auth/websocket-ticket",
      "/api/auth/websocket-ticket/rpc",
      "/oauth/token",
    ].includes(path);
  if (method !== "GET" && method !== "HEAD") return false;
  if (["/ws", "/api/auth/session", "/.well-known/t3/environment"].includes(path)) return true;
  // Normal client bootstrap reads this Space's authenticated projection, just
  // like the already-admitted orchestration.subscribeShell RPC. No tools/FS.
  if (path === "/api/orchestration/shell") return true;
  // Exact thread projection endpoints only; transcript/history/export remain denied.
  if (/^\/api\/orchestration\/threads\/[^/]+(?:\/bounded)?$/.test(path)) return true;
  if (
    path.startsWith("/api/") ||
    path.startsWith("/oauth/") ||
    path.startsWith("/mcp") ||
    path.startsWith("/.well-known/")
  )
    return false;
  // Existing static handler confines files to bundled client assets. No dev proxy or asset URLs.
  return !path.includes("..") && !path.includes("\\") && !/%(?:2e|2f|5c)/i.test(path);
}

/** Checked before opening the database or starting any service in embedded mode. */
export function nativeStartupProblem(config: {
  baseDir: string;
  devUrl: URL | undefined;
  host: string | undefined;
  autoBootstrapProjectFromCwd: boolean;
}): string | undefined {
  if (
    process.env.T3CODE_TEXOS_BRIDGE_READ_FD !== "3" ||
    process.env.T3CODE_TEXOS_BRIDGE_WRITE_FD !== "4"
  )
    return "Native TexOS requires private inherited fd3/fd4; SDK fallback is disabled.";
  if (config.devUrl !== undefined)
    return "Native TexOS presentation requires bundled web assets, not a development proxy.";
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host ?? ""))
    return "Native TexOS presentation requires an explicit loopback listener.";
  if (config.autoBootstrapProjectFromCwd) return "Native TexOS presentation forbids cwd bootstrap.";
  if (
    config.baseDir
      .split(/[/\\]/)
      .some(
        (segment) =>
          segment === ".t3" ||
          segment === "com.calugaruos.texos.v4.preview" ||
          segment === "daily-preview-v5" ||
          segment === "com.calugaruos.texos.v4.daily-preview-v5",
      )
  )
    return "Native TexOS presentation cannot use owner T3/native data stores.";
}

// Process-local admission to presentation threads; never recover or replay an old turn on startup.
const freshPreviewThreads = new Set<string>();
export const markFreshPreviewThread = (threadId: string) => {
  freshPreviewThreads.add(threadId);
};
export const isFreshPreviewThread = (threadId: string) => freshPreviewThreads.has(threadId);
