import * as Effect from "effect/Effect";

import {
  ExecutionBindingError,
  type ManagedCodexRestrictions,
  type PrivateNativeBindingSource,
} from "./executionBinding.ts";
import {
  decodeExecutionIntent,
  exact,
  type ExecutionConfiguration,
  type ExecutionObservationKey,
} from "./executionProtocol.ts";

type Retained = NonNullable<Effect.Success<ReturnType<PrivateNativeBindingSource["readRetained"]>>>;

const KEY_FIELDS = [
  "commandID",
  "envelopeDigest",
  "canonicalRunID",
  "canonicalAttemptID",
  "workerRequestID",
  "runtimeID",
  "childID",
  "t3ThreadID",
  "t3ProviderSessionID",
] as const;

const text = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  )
    throw new Error("invalidNativeBinding");
  return value;
};

const fields = (record: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.map((key) => [key, text(record[key])]));

const strings = (value: unknown, keys: ReadonlyArray<string>) =>
  fields(exact(value, [...keys]), keys);

/**
 * Shape only: `ExecutionBinding.resolve` still checks the answer against the receipt, the
 * account and the profile, so a wrong but well-formed binding is refused there.
 */
const decodeCodexRestrictions = (value: unknown): ManagedCodexRestrictions => {
  const wire = exact(value, [
    "chatgptWorkspaceID",
    "developerInstructions",
    "approvedInstructionSources",
  ]);
  const developerInstructions = wire.developerInstructions;
  const sources = wire.approvedInstructionSources;
  if (typeof developerInstructions !== "string" || !Array.isArray(sources) || sources.length > 8)
    throw new Error("invalidNativeBinding");
  return {
    chatgptWorkspaceID: text(wire.chatgptWorkspaceID),
    developerInstructions,
    approvedInstructionSources: sources.map((source) => {
      const fields = strings(source, ["path", "sha256"]);
      return { path: fields.path!, sha256: fields.sha256! };
    }),
  };
};

export function decodeNativeBinding(value: unknown): Retained {
  const wire = exact(value, [
    "admission",
    "connection",
    "account",
    "profile",
    "executable",
    "model",
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "codex")
      ? ["codex"]
      : []),
  ]);
  const admission = exact(wire.admission, [...KEY_FIELDS, "intent"]);
  const key = Object.fromEntries(
    KEY_FIELDS.map((name) => [name, text(admission[name])]),
  ) as unknown as ExecutionObservationKey;
  const connection = strings(wire.connection, [
    "revision",
    "connectionID",
    "executor",
    "provider",
    "modelID",
    "accountBindingID",
    "accountBindingGeneration",
    "runtimeProfileID",
    "runtimeProfileRevision",
  ]) as unknown as ExecutionConfiguration;
  const account = strings(wire.account, ["id", "generation", "route"]);
  if (account.route !== "cli-subscription") throw new Error("invalidNativeBinding");
  const profileWire = exact(wire.profile, [
    "id",
    "revision",
    "accountBindingID",
    "accountBindingGeneration",
    "homeDirectory",
    "profileDirectory",
    "environment",
  ]);
  const profile = fields(profileWire, [
    "id",
    "revision",
    "accountBindingID",
    "accountBindingGeneration",
    "homeDirectory",
    "profileDirectory",
  ]);
  const environment = profileWire.environment;
  if (
    typeof environment !== "object" ||
    environment === null ||
    Array.isArray(environment) ||
    Object.keys(environment).length > 8
  )
    throw new Error("invalidNativeBinding");
  const executable = strings(wire.executable, ["path", "sha256", "profileID", "profileRevision"]);
  const model = strings(wire.model, ["id", "provider"]);
  if (model.provider !== "codex" && model.provider !== "claudeCode")
    throw new Error("invalidNativeBinding");
  return {
    admission: { ...key, intent: decodeExecutionIntent(admission.intent) },
    connection,
    account: { id: account.id!, generation: account.generation!, route: "cli-subscription" },
    profile: {
      id: profile.id!,
      revision: profile.revision!,
      accountBindingID: profile.accountBindingID!,
      accountBindingGeneration: profile.accountBindingGeneration!,
    },
    executable: {
      path: executable.path!,
      sha256: executable.sha256!,
      profileID: executable.profileID!,
      profileRevision: executable.profileRevision!,
    },
    model: { id: model.id!, provider: model.provider },
    acquirePermittedProfile: Effect.succeed({
      profileID: profile.id!,
      profileRevision: profile.revision!,
      accountBindingID: profile.accountBindingID!,
      accountBindingGeneration: profile.accountBindingGeneration!,
      homeDirectory: profile.homeDirectory!,
      profileDirectory: profile.profileDirectory!,
      environment: { ...(environment as Record<string, string>) },
    }),
    ...(wire.codex === undefined ? {} : { codex: decodeCodexRestrictions(wire.codex) }),
  };
}

/** Reads each admission's binding from TexOS over the private execution channel. */
export function nativeBindingSource(
  read: (key: ExecutionObservationKey, signal: AbortSignal) => Promise<unknown>,
): PrivateNativeBindingSource {
  return {
    readRetained: (key) =>
      Effect.tryPromise({
        try: (signal) => read(key, signal).then(decodeNativeBinding),
        catch: () => new ExecutionBindingError({ code: "nativeBindingUnavailable" }),
      }),
  };
}
