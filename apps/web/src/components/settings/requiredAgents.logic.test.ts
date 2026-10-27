import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchRequiredAgent, resolveRequiredAgents } from "./requiredAgents.logic";

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<{
    enabled: boolean;
    installed: boolean;
    status: "ready" | "warning" | "error" | "disabled";
    auth: "authenticated" | "unauthenticated" | "unknown";
  }> = {},
) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: overrides.enabled ?? true,
    installed: overrides.installed ?? true,
    status: overrides.status ?? "ready",
    auth: { status: overrides.auth ?? "authenticated" },
  } as const;
}

const hermesLocal = {
  driver: ProviderDriverKind.make("acpRegistry"),
  config: { source: "local", commandPath: "/opt/tools/bin/hermes", commandArgs: ["acp"] },
};
const droidRegistry = {
  driver: ProviderDriverKind.make("acpRegistry"),
  config: { agentId: "factory-droid" },
};

describe("required agents", () => {
  it("lists all five agents in a stable order, marking missing ones as not set up", () => {
    const agents = resolveRequiredAgents([provider("codex", "codex")], undefined);
    expect(agents.map((agent) => [agent.label, agent.readiness])).toEqual([
      ["Claude Code", "not-set-up"],
      ["Codex", "connected"],
      ["Cursor", "not-set-up"],
      ["Hermes", "not-set-up"],
      ["Factory Droid", "not-set-up"],
    ]);
  });

  it("recognizes Hermes and Factory Droid by their ACP command or registry entry only", () => {
    expect(matchRequiredAgent("acpRegistry", hermesLocal.config)).toBe("hermes");
    expect(matchRequiredAgent("acpRegistry", { source: "local", commandPath: "hermes-acp" })).toBe(
      "hermes",
    );
    expect(matchRequiredAgent("acpRegistry", droidRegistry.config)).toBe("factory-droid");
    expect(
      matchRequiredAgent("acpRegistry", { source: "local", commandPath: "C:\\bin\\droid.exe" }),
    ).toBe("factory-droid");
    expect(matchRequiredAgent("acpRegistry", { agentId: "gemini" })).toBeNull();
    expect(
      matchRequiredAgent("acpRegistry", { source: "local", commandPath: "hermesian" }),
    ).toBeNull();
    expect(matchRequiredAgent("grok", undefined)).toBeNull();
  });

  it("reports sign-in, install and failure states without calling them connected", () => {
    const agents = resolveRequiredAgents(
      [
        provider("claudeAgent", "claudeAgent", { auth: "unauthenticated" }),
        provider("cursor", "cursor", { installed: false }),
        provider("acpRegistry_hermes", "acpRegistry", { status: "warning", auth: "unknown" }),
        provider("acpRegistry_droid", "acpRegistry", { status: "error" }),
      ],
      { acpRegistry_hermes: hermesLocal, acpRegistry_droid: droidRegistry },
    );
    expect(Object.fromEntries(agents.map((agent) => [agent.id, agent.readiness]))).toEqual({
      claude: "needs-sign-in",
      codex: "not-set-up",
      cursor: "not-installed",
      hermes: "needs-attention",
      "factory-droid": "unavailable",
    });
  });

  it("offers set up, not open, for a built-in agent that is off and never configured", () => {
    const [cursor] = resolveRequiredAgents(
      [provider("cursor", "cursor", { enabled: false })],
      undefined,
    ).filter((agent) => agent.id === "cursor");
    expect(cursor).toMatchObject({ instanceId: null, readiness: "not-set-up" });

    const [saved] = resolveRequiredAgents([provider("cursor", "cursor", { enabled: false })], {
      cursor: { driver: ProviderDriverKind.make("cursor"), enabled: false },
    }).filter((agent) => agent.id === "cursor");
    expect(saved).toMatchObject({ instanceId: "cursor", readiness: "off" });
  });

  it("prefers the best instance of an agent and points at it", () => {
    const agents = resolveRequiredAgents(
      [
        provider("codex", "codex", { enabled: false }),
        provider("codex_work", "codex"),
        provider("codex_personal", "codex", { auth: "unauthenticated" }),
      ],
      undefined,
    );
    expect(agents.find((agent) => agent.id === "codex")).toMatchObject({
      instanceId: "codex_work",
      readiness: "connected",
    });
  });

  it("shows a saved instance the server has not reported yet as checking, or off when disabled", () => {
    const agents = resolveRequiredAgents([], {
      acpRegistry_hermes: hermesLocal,
      acpRegistry_droid: { ...droidRegistry, enabled: false },
    });
    expect(agents.find((agent) => agent.id === "hermes")).toMatchObject({
      instanceId: "acpRegistry_hermes",
      readiness: "checking",
    });
    expect(agents.find((agent) => agent.id === "factory-droid")?.readiness).toBe("off");
  });
});
