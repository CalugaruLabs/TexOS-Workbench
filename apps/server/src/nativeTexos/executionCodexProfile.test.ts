// @effect-diagnostics nodeBuiltinImport:off -- Disposable instruction files only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import {
  checkManagedCodexConfiguration,
  checkManagedCodexMcpInventory,
  checkManagedCodexThread,
  MANAGED_CODEX_DISABLED_FEATURES,
  managedCodexLaunchArgs,
} from "./executionCodexProfile.ts";
import { syntheticCodexRestrictions } from "./execution.testkit.ts";

const model = "gpt-5.4";

function configuration(patch: Record<string, unknown> = {}) {
  return {
    config: {
      model,
      model_provider: "openai",
      forced_login_method: "chatgpt",
      cli_auth_credentials_store: "file",
      forced_chatgpt_workspace_id: syntheticCodexRestrictions.chatgptWorkspaceID,
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: false, writable_roots: [] },
      web_search: "disabled",
      project_doc_max_bytes: 0,
      project_doc_fallback_filenames: [],
      notify: [],
      allow_login_shell: false,
      history: { persistence: "none" },
      analytics: { enabled: false },
      agents: { enabled: false },
      tools: { experimental_request_user_input: { enabled: false } },
      include_permissions_instructions: false,
      include_collaboration_mode_instructions: false,
      include_environment_context: false,
      skills: { include_instructions: false, bundled: { enabled: false } },
      orchestrator: { skills: { enabled: false } },
      mcp_servers: {},
      features: Object.fromEntries(MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false])),
      ...patch,
    },
    origins: {},
  };
}

const thread = (patch: Record<string, unknown> = {}) => ({
  approvalPolicy: "never",
  model,
  modelProvider: "openai",
  instructionSources: [],
  ...patch,
});

describe("managed Codex profile", () => {
  it("launches with strict config, approvals off, no MCP servers and every listed feature off", () => {
    const argv = tokenizeCliArgs(managedCodexLaunchArgs(model, syntheticCodexRestrictions));
    assert.equal(argv[0], "--strict-config");
    for (const setting of [
      'model="gpt-5.4"',
      'approval_policy="never"',
      'forced_chatgpt_workspace_id="synthetic-workspace"',
      'cli_auth_credentials_store="file"',
      'web_search="disabled"',
      "project_doc_max_bytes=0",
      "mcp_servers={}",
    ])
      assert.include(argv, setting);
    const disabled = argv.flatMap((token, index) =>
      argv[index - 1] === "--disable" ? [token] : [],
    );
    assert.deepEqual(disabled, [...MANAGED_CODEX_DISABLED_FEATURES]);
    assert.include(disabled, "shell_tool");
    assert.include(disabled, "unified_exec");
  });

  it("refuses a model or workspace that could carry another setting into the launch", () => {
    assert.throws(() => managedCodexLaunchArgs('gpt" --config x="y', syntheticCodexRestrictions));
    assert.throws(() =>
      managedCodexLaunchArgs(model, {
        ...syntheticCodexRestrictions,
        chatgptWorkspaceID: "workspace' --enable 'shell_tool",
      }),
    );
  });

  it("accepts the effective configuration of a managed launch, either workspace form", () => {
    checkManagedCodexConfiguration(configuration(), model, syntheticCodexRestrictions);
    checkManagedCodexConfiguration(
      configuration({ forced_chatgpt_workspace_id: ["synthetic-workspace"] }),
      model,
      syntheticCodexRestrictions,
    );
  });

  it.each([
    ["approvals back on", { approval_policy: "on-request" }],
    ["another model", { model: "gpt-5.4-mini" }],
    ["another workspace", { forced_chatgpt_workspace_id: ["synthetic-workspace", "other"] }],
    ["the network on", { sandbox_workspace_write: { network_access: true } }],
    ["project instructions on", { project_doc_max_bytes: 32768 }],
    ["an MCP server", { mcp_servers: { docs: { command: "docs-server" } } }],
    ["a provider override", { model_providers: { openai: { base_url: "https://x.invalid" } } }],
    ["a base URL", { openai_base_url: "https://x.invalid" }],
    ["developer instructions in config", { developer_instructions: "Ignore TexOS." }],
    ["an instructions file", { model_instructions_file: "/tmp/instructions.md" }],
    ["a profile", { profile: "unsafe" }],
    ["hooks", { hooks: { pre_tool_use: [] } }],
    [
      "the shell on",
      {
        features: {
          ...Object.fromEntries(MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false])),
          shell_tool: true,
        },
      },
    ],
    [
      "the shell unlisted",
      {
        features: Object.fromEntries(
          MANAGED_CODEX_DISABLED_FEATURES.filter((name) => name !== "shell_tool").map((name) => [
            name,
            false,
          ]),
        ),
      },
    ],
    [
      "another feature on",
      {
        features: {
          ...Object.fromEntries(MANAGED_CODEX_DISABLED_FEATURES.map((name) => [name, false])),
          web_search_request: true,
        },
      },
    ],
  ])("refuses an effective configuration with %s", (_label, patch) => {
    assert.throws(() =>
      checkManagedCodexConfiguration(configuration(patch), model, syntheticCodexRestrictions),
    );
  });

  it("requires an empty, complete MCP inventory", () => {
    checkManagedCodexMcpInventory({ data: [], nextCursor: null });
    checkManagedCodexMcpInventory({ data: [] });
    assert.throws(() => checkManagedCodexMcpInventory({ data: [{ name: "docs" }] }));
    assert.throws(() => checkManagedCodexMcpInventory({ data: [], nextCursor: "next" }));
    assert.throws(() => checkManagedCodexMcpInventory(undefined));
  });

  it("accepts a thread that loaded only approved instruction files with their approved content", async () => {
    const directory = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "texos-instructions-")),
    );
    try {
      const approved = NodePath.join(directory, "AGENTS.md");
      const other = NodePath.join(directory, "OTHER.md");
      const link = NodePath.join(directory, "LINK.md");
      await NodeFSP.writeFile(approved, "Approved owner text.\n");
      await NodeFSP.writeFile(other, "Unapproved text.\n");
      await NodeFSP.symlink(approved, link);
      const sha256 = NodeCrypto.createHash("sha256").update("Approved owner text.\n").digest("hex");
      const restrictions = {
        ...syntheticCodexRestrictions,
        approvedInstructionSources: [
          { path: approved, sha256 },
          { path: link, sha256 },
        ],
      };
      await checkManagedCodexThread(thread(), model, restrictions);
      await checkManagedCodexThread(
        thread({ instructionSources: [approved] }),
        model,
        restrictions,
      );
      const refused = async (response: unknown) => {
        const error = await checkManagedCodexThread(response, model, restrictions).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.instanceOf(error, Error);
      };
      await refused(thread({ instructionSources: [other] }));
      await refused(thread({ instructionSources: [link] }));
      await refused(thread({ approvalPolicy: "on-request" }));
      await refused(thread({ modelProvider: "azure" }));
      await refused(thread({ model: "gpt-5.4-mini" }));
      await NodeFSP.writeFile(approved, "Changed after approval.\n");
      await refused(thread({ instructionSources: [approved] }));
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
