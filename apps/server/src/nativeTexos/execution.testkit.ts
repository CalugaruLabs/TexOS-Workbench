import type {
  ExecutionIntent,
  ExecutionChannelBinding,
  ExecutionHostRequest,
  NativeExecutionAuthorization,
} from "./executionProtocol.ts";
import { decodeExecutionHostRequest, executionEnvelope } from "./executionProtocol.ts";
import * as Effect from "effect/Effect";
import type { ManagedCodexRestrictions } from "./executionBinding.ts";
import Migration070 from "../persistence/Migrations/070_NativeExecutionReceipts.ts";
import Migration071 from "../persistence/Migrations/071_NativeExecutionOutcomes.ts";

/** The receipt tables as T3 builds them today. */
export const executionReceiptMigrations = Migration070.pipe(Effect.andThen(Migration071));

/** What TexOS fixes for a managed Codex run, with no owner instruction file approved. */
export const syntheticCodexRestrictions: ManagedCodexRestrictions = {
  chatgptWorkspaceID: "synthetic-workspace",
  developerInstructions: "Change files in the current folder only. Do not use the network.",
  approvedInstructionSources: [],
};

export const syntheticBinding: ExecutionChannelBinding = {
  authorityID: "synthetic-authority",
  hostID: "synthetic-host",
  hostGeneration: "generation-1",
};

export function syntheticIntent(root = "/synthetic/repository"): ExecutionIntent {
  return {
    commandID: "00000000-0000-4000-8000-000000000001",
    canonicalRunID: "canonical-run",
    canonicalTaskID: "canonical-task",
    canonicalAttemptID: "canonical-attempt",
    workerRequestID: "native-worker-request",
    scope: {
      authorityID: "synthetic-authority",
      installationID: "synthetic-installation",
      ownerID: "synthetic-owner",
      spaceID: "synthetic-space",
      hostID: "synthetic-host",
      clientID: "workspace",
      principalID: "synthetic-owner",
      projectID: "synthetic-project",
    },
    worktree: { id: "synthetic-worktree", root, device: "1", inode: "2" },
    configuration: {
      revision: "1",
      connectionID: "synthetic-connection",
      executor: "t3",
      provider: "codex",
      modelID: "gpt-5.4",
      accountBindingID: "synthetic-account",
      accountBindingGeneration: "1",
      runtimeProfileID: "controlled-fixture",
      runtimeProfileRevision: "1",
    },
    parent: { agentID: "synthetic-agent", conversationID: "synthetic-conversation" },
    input: "Write the synthetic answer.",
  };
}

export const unicodeCanonicalFixture = {
  input: "Synthetic café / 路径 / 😀 / e\u0301",
  utf8Bytes: 1029,
  digest: "2c5ff8a8aef30f912012daa4facb915c81bae286aa8edb67511c42fca9d83c59",
  json: `{"intent":{"canonicalAttemptID":"canonical-attempt","canonicalRunID":"canonical-run","canonicalTaskID":"canonical-task","commandID":"00000000-0000-4000-8000-000000000001","configuration":{"accountBindingGeneration":"1","accountBindingID":"synthetic-account","connectionID":"synthetic-connection","executor":"t3","modelID":"gpt-5.4","provider":"codex","revision":"1","runtimeProfileID":"controlled-fixture","runtimeProfileRevision":"1"},"input":"Synthetic café / 路径 / 😀 / e\u0301","parent":{"agentID":"synthetic-agent","conversationID":"synthetic-conversation"},"scope":{"authorityID":"synthetic-authority","clientID":"workspace","hostID":"synthetic-host","installationID":"synthetic-installation","ownerID":"synthetic-owner","principalID":"synthetic-owner","projectID":"synthetic-project","spaceID":"synthetic-space"},"workerRequestID":"native-worker-request","worktree":{"device":"1","id":"synthetic-worktree","inode":"2","root":"/synthetic/repository"}},"method":"execution.admit","namespace":"texos.execution","version":2}`,
} as const;

export function syntheticRequest(
  method: ExecutionHostRequest["method"],
  params: unknown,
  ordinal = 10,
): ExecutionHostRequest {
  return decodeExecutionHostRequest({
    version: 2,
    namespace: "texos.execution",
    kind: "request",
    id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    ...syntheticBinding,
    method,
    params,
  });
}

export function syntheticAuthorization(
  intent: ExecutionIntent,
  now: number,
): NativeExecutionAuthorization {
  return {
    decisionID: "00000000-0000-4000-8000-000000000009",
    commandID: intent.commandID,
    canonicalRunID: intent.canonicalRunID,
    envelopeDigest: executionEnvelope(intent).digest,
    runtimeID: "synthetic-runtime",
    childID: "synthetic-child",
    accountBindingGeneration: intent.configuration.accountBindingGeneration,
    currentConfigurationRevision: intent.configuration.revision,
    expiresAtMs: now + 60_000,
    outcome: "allow",
    revoked: false,
    noNewCharges: true,
    checks: {
      permission: "qualified",
      accountIdentity: "qualified",
      runtime: "qualified",
      capacity: "qualified",
      billing: "qualified",
      worktreeLease: "qualified",
    },
  };
}
