// @effect-diagnostics nodeBuiltinImport:off -- Reads only instruction files the binding names, after its checks.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import type { ManagedCodexRestrictions } from "./executionBinding.ts";

/**
 * The managed Codex profile mirrors TexOS's interim route (`CodexRestrictedStdioProfile` and
 * `CodexChatBridge.disabledFeatures`) except that a Mission may write inside its own folder.
 * The shell stays off: Codex starts each command in a new session, so a stopped run could
 * leave one running that no process-group check sees.
 */
export const MANAGED_CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "plugins",
  "remote_plugin",
  "apps",
  "enable_mcp_apps",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "hooks",
  "memories",
  "image_generation",
  "code_mode_host",
  "code_mode",
  "workspace_dependencies",
  "chronicle",
  "goals",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "auth_elicitation",
  "request_permissions_tool",
  "artifact",
  "shell_snapshot",
  "js_repl",
  "mentions_v2",
  "network_proxy",
  "remote_control",
  "personality",
  "token_budget",
  "current_time_reminder",
  "rollout_budget",
] as const;

type Setting = string | number | boolean | readonly [] | Readonly<Record<string, never>>;

const managedSettings = (
  model: string,
  workspaceID: string,
): ReadonlyArray<readonly [string, Setting]> => [
  ["model", model],
  ["model_provider", "openai"],
  ["forced_login_method", "chatgpt"],
  ["cli_auth_credentials_store", "file"],
  ["forced_chatgpt_workspace_id", workspaceID],
  ["approval_policy", "never"],
  ["sandbox_mode", "workspace-write"],
  ["sandbox_workspace_write.network_access", false],
  ["web_search", "disabled"],
  ["project_doc_max_bytes", 0],
  ["project_doc_fallback_filenames", []],
  ["notify", []],
  ["allow_login_shell", false],
  ["history.persistence", "none"],
  ["analytics.enabled", false],
  ["agents.enabled", false],
  ["tools.experimental_request_user_input.enabled", false],
  ["include_permissions_instructions", false],
  ["include_collaboration_mode_instructions", false],
  ["include_environment_context", false],
  ["skills.include_instructions", false],
  ["skills.bundled.enabled", false],
  ["orchestrator.skills.enabled", false],
  ["mcp_servers", {}],
];

/** Settings that add instructions, endpoints, tools or automation; none may be set. */
const UNSET_SETTINGS = [
  "apps",
  "apps_mcp_product_sku",
  "audio",
  "auto_review",
  "base_url",
  "browser_use",
  "chatgpt_base_url",
  "compact_prompt",
  "computer_use",
  "debug",
  "default_permissions",
  "desktop",
  "developer_instructions",
  "experimental_compact_prompt_file",
  "experimental_realtime_start_instructions",
  "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_backend_prompt",
  "experimental_realtime_ws_base_url",
  "experimental_realtime_ws_model",
  "experimental_realtime_ws_startup_context",
  "experimental_thread_config_endpoint",
  "experimental_thread_store",
  "experimental_thread_store_endpoint",
  "experimental_use_unified_exec_tool",
  "ghost_snapshot",
  "hooks",
  "include_apps_instructions",
  "instructions",
  "js_repl_node_module_dirs",
  "js_repl_node_path",
  "log_dir",
  "mcp_oauth_callback_port",
  "mcp_oauth_callback_url",
  "mcp_oauth_credentials_store",
  "memories",
  "model_catalog_json",
  "model_instructions_file",
  "notice",
  "openai_base_url",
  "oss_provider",
  "otel",
  "permissions",
  "plugins",
  "profile",
  "profiles",
  "project_root_markers",
  "realtime",
  "shell_environment_policy",
  "sqlite_home",
  "tool_suggest",
  "tui",
  "windows",
] as const;

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAXIMUM_INSTRUCTION_FILE_BYTES = 1024 * 1024;

const toml = (value: Setting): string =>
  typeof value === "string"
    ? `"${value}"`
    : Array.isArray(value)
      ? "[]"
      : typeof value === "object"
        ? "{}"
        : String(value);

class ManagedCodexProfileError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** The launch arguments, as T3's settings string, that start Codex in the managed profile. */
export function managedCodexLaunchArgs(model: string, restrictions: ManagedCodexRestrictions) {
  if (!MODEL_ID.test(model) || !WORKSPACE_ID.test(restrictions.chatgptWorkspaceID))
    throw new ManagedCodexProfileError("invalidProfileValue");
  const argv = [
    "--strict-config",
    ...managedSettings(model, restrictions.chatgptWorkspaceID).flatMap(([key, value]) => [
      "--config",
      `${key}=${toml(value)}`,
    ]),
    ...MANAGED_CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
  ];
  // Every token is quoted whole, and the values above hold no single quote.
  const launchArgs = argv.map((token) => `'${token}'`).join(" ");
  const parsed = tokenizeCliArgs(launchArgs);
  if (parsed.length !== argv.length || parsed.some((token, index) => token !== argv[index]))
    throw new ManagedCodexProfileError("launchArgumentsChanged");
  return launchArgs;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const at = (config: Record<string, unknown>, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((value, key) => record(value)?.[key], config);

const settingMatches = (actual: unknown, expected: Setting) =>
  Array.isArray(expected)
    ? Array.isArray(actual) && actual.length === 0
    : typeof expected === "object"
      ? record(actual) !== undefined && Object.keys(record(actual)!).length === 0
      : actual === expected;

/**
 * Checks `config/read` (the effective configuration Codex will use) against the managed
 * profile: every value we set holds, no listed feature is on, and nothing that adds
 * instructions, endpoints, tools or MCP servers is configured.
 */
export function checkManagedCodexConfiguration(
  response: unknown,
  model: string,
  restrictions: ManagedCodexRestrictions,
) {
  const config = record(record(response)?.config);
  if (!config) throw new ManagedCodexProfileError("configurationUnreadable");
  for (const [key, expected] of managedSettings(model, restrictions.chatgptWorkspaceID)) {
    const actual = at(config, key);
    const matches =
      key === "forced_chatgpt_workspace_id" && Array.isArray(actual)
        ? actual.length === 1 && actual[0] === expected
        : settingMatches(actual, expected);
    if (!matches) throw new ManagedCodexProfileError(`setting:${key}`);
  }
  const features = record(config.features);
  if (!features) throw new ManagedCodexProfileError("featuresUnreadable");
  for (const feature of MANAGED_CODEX_DISABLED_FEATURES)
    if (features[feature] !== false) throw new ManagedCodexProfileError(`feature:${feature}`);
  for (const [feature, enabled] of Object.entries(features))
    if (enabled !== false && enabled !== null)
      throw new ManagedCodexProfileError(`feature:${feature}`);
  for (const key of UNSET_SETTINGS)
    if (config[key] !== undefined && config[key] !== null)
      throw new ManagedCodexProfileError(`setting:${key}`);
  const providers = config.model_providers;
  if (providers !== undefined && providers !== null && !settingMatches(providers, {}))
    throw new ManagedCodexProfileError("setting:model_providers");
}

/** `mcpServerStatus/list` must report no server at all. */
export function checkManagedCodexMcpInventory(response: unknown) {
  const page = record(response);
  if (
    !page ||
    !Array.isArray(page.data) ||
    page.data.length !== 0 ||
    (page.nextCursor !== undefined && page.nextCursor !== null)
  )
    throw new ManagedCodexProfileError("mcpServersPresent");
}

const sha256OfInstructionFile = async (path: string) => {
  if ((await NodeFSP.realpath(path)) !== path) throw new Error("linkedInstructionFile");
  const handle = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAXIMUM_INSTRUCTION_FILE_BYTES)
      throw new Error("instructionFileUnsupported");
    return NodeCrypto.createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
};

/**
 * Checks the `thread/start` reply: approvals off, the bound model on OpenAI, and every
 * instruction file Codex loaded one the owner approved, with the content they approved.
 */
export async function checkManagedCodexThread(
  response: unknown,
  model: string,
  restrictions: ManagedCodexRestrictions,
) {
  const thread = record(response);
  if (
    !thread ||
    thread.approvalPolicy !== "never" ||
    thread.model !== model ||
    thread.modelProvider !== "openai"
  )
    throw new ManagedCodexProfileError("threadSettingsChanged");
  // A Codex that doesn't report what it loaded can't prove it loaded nothing unapproved.
  const sources = thread.instructionSources;
  if (!Array.isArray(sources)) throw new ManagedCodexProfileError("instructionSourcesUnreadable");
  for (const source of sources) {
    const approved = restrictions.approvedInstructionSources.find(
      (candidate) => candidate.path === source,
    );
    if (!approved) throw new ManagedCodexProfileError("instructionSourceUnapproved");
    const actual = await sha256OfInstructionFile(approved.path).catch(() => undefined);
    if (actual !== approved.sha256) throw new ManagedCodexProfileError("instructionSourceChanged");
  }
}
