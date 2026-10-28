import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import type { ProviderStatusKey } from "./providerStatus";

const REQUIRED_AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "hermes", label: "Hermes" },
  { id: "factory-droid", label: "Factory Droid" },
] as const;

export type RequiredAgentId = (typeof REQUIRED_AGENTS)[number]["id"];

export type RequiredAgentReadiness =
  | "connected"
  | "needs-sign-in"
  | "needs-attention"
  | "not-installed"
  | "unavailable"
  | "checking"
  | "off"
  | "not-set-up";

type ProviderStatusSnapshot = Pick<
  ServerProvider,
  "instanceId" | "driver" | "enabled" | "installed" | "status"
> & { readonly auth: Pick<ServerProvider["auth"], "status"> };

export interface RequiredAgentStatus {
  readonly id: RequiredAgentId;
  readonly label: string;
  readonly instanceId: ProviderInstanceId | null;
  readonly readiness: RequiredAgentReadiness;
}

// Better states win when one agent has several instances.
const READINESS_RANK: Record<RequiredAgentReadiness, number> = {
  connected: 0,
  "needs-sign-in": 1,
  "needs-attention": 2,
  "not-installed": 3,
  unavailable: 4,
  checking: 5,
  off: 6,
  "not-set-up": 7,
};

export const REQUIRED_AGENT_READINESS_PRESENTATION: Record<
  RequiredAgentReadiness,
  { readonly label: string; readonly status: ProviderStatusKey }
> = {
  connected: { label: "Connected", status: "ready" },
  "needs-sign-in": { label: "Needs sign-in", status: "warning" },
  "needs-attention": { label: "Needs attention", status: "warning" },
  "not-installed": { label: "Not installed", status: "warning" },
  unavailable: { label: "Unavailable", status: "error" },
  checking: { label: "Checking…", status: "neutral" },
  off: { label: "Turned off", status: "disabled" },
  "not-set-up": { label: "Not set up", status: "neutral" },
};

function readString(config: unknown, key: string): string | null {
  if (typeof config !== "object" || config === null) return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function executableName(commandPath: string | null): string | null {
  if (!commandPath) return null;
  const name = commandPath.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(exe|cmd)$/i, "").toLowerCase();
}

export function matchRequiredAgent(driver: string, config: unknown): RequiredAgentId | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  if (driver === "cursor") return "cursor";
  if (driver !== "acpRegistry") return null;
  const agentId = readString(config, "agentId");
  const executable = executableName(readString(config, "commandPath"));
  if (agentId === "factory-droid" || executable === "droid") return "factory-droid";
  if (agentId?.startsWith("hermes") || executable === "hermes" || executable === "hermes-acp") {
    return "hermes";
  }
  return null;
}

function readinessFromProvider(provider: ProviderStatusSnapshot): RequiredAgentReadiness {
  if (!provider.enabled) return "off";
  if (!provider.installed) return "not-installed";
  if (provider.auth.status === "unauthenticated") return "needs-sign-in";
  if (provider.status === "error") return "unavailable";
  if (provider.status === "warning") return "needs-attention";
  return "connected";
}

export function resolveRequiredAgents(
  providers: ReadonlyArray<ProviderStatusSnapshot>,
  instances: Readonly<Record<string, ProviderInstanceConfig>> | undefined,
): RequiredAgentStatus[] {
  const best = new Map<RequiredAgentId, Omit<RequiredAgentStatus, "label">>();
  const consider = (candidate: Omit<RequiredAgentStatus, "label">) => {
    const current = best.get(candidate.id);
    if (!current || READINESS_RANK[candidate.readiness] < READINESS_RANK[current.readiness]) {
      best.set(candidate.id, candidate);
    }
  };

  const reported = new Set<string>();
  for (const provider of providers) {
    reported.add(provider.instanceId);
    const id = matchRequiredAgent(provider.driver, instances?.[provider.instanceId]?.config);
    if (!id) continue;
    // A built-in agent that is off and never configured has no row to open in the provider list.
    if (!provider.enabled && !instances?.[provider.instanceId]) {
      consider({ id, instanceId: null, readiness: "not-set-up" });
    } else {
      consider({ id, instanceId: provider.instanceId, readiness: readinessFromProvider(provider) });
    }
  }
  for (const [instanceId, instance] of Object.entries(instances ?? {})) {
    if (reported.has(instanceId)) continue;
    const id = matchRequiredAgent(instance.driver, instance.config);
    if (id) {
      consider({
        id,
        instanceId: instanceId as ProviderInstanceId,
        readiness: instance.enabled === false ? "off" : "checking",
      });
    }
  }

  return REQUIRED_AGENTS.map((agent) => ({
    label: agent.label,
    ...(best.get(agent.id) ?? { id: agent.id, instanceId: null, readiness: "not-set-up" }),
  }));
}
