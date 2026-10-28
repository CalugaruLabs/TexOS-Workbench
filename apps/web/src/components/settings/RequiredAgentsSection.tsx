import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsSection } from "./settingsLayout";
import { PROVIDER_STATUS_STYLES } from "./providerStatus";
import {
  REQUIRED_AGENT_READINESS_PRESENTATION,
  resolveRequiredAgents,
} from "./requiredAgents.logic";

export function RequiredAgentsSection({
  providers,
  instances,
  readOnly,
  onSetUp,
  onOpen,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly readOnly: boolean;
  readonly onSetUp: () => void;
  readonly onOpen: (instanceId: ProviderInstanceId) => void;
}) {
  const agents = resolveRequiredAgents(providers, instances);
  const connected = agents.filter((agent) => agent.readiness === "connected").length;

  return (
    <SettingsSection
      title="Your five agents"
      variant="plain"
      headerAction={
        <span className="text-xs text-muted-foreground">
          {connected} of {agents.length} connected
        </span>
      }
    >
      <SettingsGroup>
        {agents.map((agent) => {
          const presentation = REQUIRED_AGENT_READINESS_PRESENTATION[agent.readiness];
          const instanceId = agent.instanceId;
          return (
            <div
              key={agent.id}
              className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm sm:px-4"
            >
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  PROVIDER_STATUS_STYLES[presentation.status].dot,
                )}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{agent.label}</span>
              <span className="text-xs text-muted-foreground">{presentation.label}</span>
              {instanceId !== null ? (
                <Button
                  aria-label={`Open ${agent.label} settings`}
                  onClick={() => onOpen(instanceId)}
                  size="xs"
                  variant="outline"
                >
                  Open
                </Button>
              ) : !readOnly ? (
                <Button
                  aria-label={`Set up ${agent.label}`}
                  onClick={onSetUp}
                  size="xs"
                  variant="outline"
                >
                  Set up
                </Button>
              ) : null}
            </div>
          );
        })}
      </SettingsGroup>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Connected means this computer can reach the agent and its sign-in. It doesn't yet prove the
        agent can finish a task.
      </p>
    </SettingsSection>
  );
}
