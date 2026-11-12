// @effect-diagnostics nodeBuiltinImport:off -- Lexical checks only; no profile discovery or filesystem reads.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { ExecutionReceipt } from "./executionReceipts.ts";
import {
  executionEnvelope,
  type ExecutionConfiguration,
  type ExecutionIntent,
  type ExecutionObservationKey,
} from "./executionProtocol.ts";

export class ExecutionBindingError extends Schema.TaggedError<ExecutionBindingError>()(
  "ExecutionBindingError",
  { code: Schema.String },
) {}

export interface PermittedCliProfile {
  readonly profileID: string;
  readonly profileRevision: string;
  readonly accountBindingID: string;
  readonly accountBindingGeneration: string;
  readonly homeDirectory: string;
  readonly profileDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** What TexOS fixes for a managed Codex run: the login workspace and the instructions. */
export interface ManagedCodexRestrictions {
  readonly chatgptWorkspaceID: string;
  readonly developerInstructions: string;
  /** The instruction files the owner approved; Codex may load these and nothing else. */
  readonly approvedInstructionSources: ReadonlyArray<{
    readonly path: string;
    readonly sha256: string;
  }>;
}

// Supplied only by a future private Native admission/permission owner. There is no
// JSON decoder, renderer endpoint, default profile supplier, or production layer.
export interface PrivateNativeBindingSource {
  readonly readRetained: (key: ExecutionObservationKey) => Effect.Effect<
    | {
        readonly admission: ExecutionObservationKey & { readonly intent: ExecutionIntent };
        readonly connection: ExecutionConfiguration;
        readonly account: {
          readonly id: string;
          readonly generation: string;
          readonly route: "cli-subscription";
        };
        readonly profile: {
          readonly id: string;
          readonly revision: string;
          readonly accountBindingID: string;
          readonly accountBindingGeneration: string;
        };
        readonly executable: {
          readonly path: string;
          readonly sha256: string;
          readonly profileID: string;
          readonly profileRevision: string;
        };
        readonly model: {
          readonly id: string;
          readonly provider: ExecutionConfiguration["provider"];
        };
        readonly acquirePermittedProfile: Effect.Effect<
          PermittedCliProfile,
          ExecutionBindingError,
          Scope.Scope
        >;
        /** Present exactly when the provider is Codex. */
        readonly codex?: ManagedCodexRestrictions;
      }
    | undefined,
    ExecutionBindingError
  >;
}

export interface BoundCliExecution {
  readonly key: ExecutionObservationKey;
  readonly configuration: ExecutionConfiguration;
  readonly executablePath: string;
  readonly executableSHA256: string;
  readonly profile: PermittedCliProfile;
  readonly codex?: ManagedCodexRestrictions;
}

export function executionObservationKey(receipt: ExecutionReceipt): ExecutionObservationKey {
  return {
    commandID: receipt.intent.commandID,
    envelopeDigest: receipt.envelopeDigest,
    canonicalRunID: receipt.intent.canonicalRunID,
    canonicalAttemptID: receipt.intent.canonicalAttemptID,
    workerRequestID: receipt.intent.workerRequestID,
    runtimeID: receipt.runtimeID,
    childID: receipt.childID,
    t3ThreadID: receipt.t3ThreadID,
    t3ProviderSessionID: receipt.t3ProviderSessionID,
  };
}

const absolute = (path: string) =>
  NodePath.isAbsolute(path) && NodePath.normalize(path) === path && !path.includes("\0");
const environmentKeys = new Set(["PATH", "LANG", "LC_ALL", "TMPDIR"]);
const MAXIMUM_DEVELOPER_INSTRUCTION_BYTES = 8 * 1024;
const MAXIMUM_APPROVED_INSTRUCTION_SOURCES = 8;
const utf8 = new TextEncoder();

const validCodexRestrictions = (codex: ManagedCodexRestrictions | undefined) =>
  codex !== undefined &&
  /^[A-Za-z0-9_-]{1,256}$/.test(codex.chatgptWorkspaceID) &&
  typeof codex.developerInstructions === "string" &&
  codex.developerInstructions.trim().length > 0 &&
  !codex.developerInstructions.includes("\0") &&
  utf8.encode(codex.developerInstructions).length <= MAXIMUM_DEVELOPER_INSTRUCTION_BYTES &&
  Array.isArray(codex.approvedInstructionSources) &&
  codex.approvedInstructionSources.length <= MAXIMUM_APPROVED_INSTRUCTION_SOURCES &&
  new Set(codex.approvedInstructionSources.map((source) => source.path)).size ===
    codex.approvedInstructionSources.length &&
  codex.approvedInstructionSources.every(
    (source) => absolute(source.path) && /^[0-9a-f]{64}$/.test(source.sha256),
  );

export class ExecutionBinding extends Context.Service<
  ExecutionBinding,
  {
    readonly available: boolean;
    readonly resolve: (
      receipt: ExecutionReceipt,
    ) => Effect.Effect<BoundCliExecution, ExecutionBindingError, Scope.Scope>;
  }
>()("t3/nativeTexos/executionBinding") {}

export function makeExecutionBinding(
  source?: PrivateNativeBindingSource,
): ExecutionBinding["Service"] {
  return ExecutionBinding.of({
    available: source !== undefined,
    resolve: Effect.fn("ExecutionBinding.resolve")(function* (receipt) {
      if (!source) return yield* new ExecutionBindingError({ code: "privateBindingUnavailable" });
      const key = executionObservationKey(receipt);
      const saved = yield* source.readRetained(key);
      if (
        !saved ||
        Object.entries(key).some(([name, value]) => Reflect.get(saved.admission, name) !== value)
      )
        return yield* new ExecutionBindingError({ code: "nativeAdmissionMismatch" });
      const envelope = yield* Effect.try({
        try: () => executionEnvelope(saved.admission.intent),
        catch: () => new ExecutionBindingError({ code: "nativeAdmissionMismatch" }),
      });
      if (
        envelope.digest !== key.envelopeDigest ||
        envelope.json !== executionEnvelope(receipt.intent).json
      )
        return yield* new ExecutionBindingError({ code: "nativeAdmissionMismatch" });
      const expected = receipt.intent.configuration;
      if (
        Object.entries(expected).some(
          ([name, value]) => Reflect.get(saved.connection, name) !== value,
        ) ||
        saved.account.route !== "cli-subscription" ||
        saved.account.id !== expected.accountBindingID ||
        saved.account.generation !== expected.accountBindingGeneration ||
        saved.profile.id !== expected.runtimeProfileID ||
        saved.profile.revision !== expected.runtimeProfileRevision ||
        saved.profile.accountBindingID !== saved.account.id ||
        saved.profile.accountBindingGeneration !== saved.account.generation ||
        saved.model.id !== expected.modelID ||
        saved.model.provider !== expected.provider ||
        saved.executable.profileID !== saved.profile.id ||
        saved.executable.profileRevision !== saved.profile.revision ||
        !absolute(saved.executable.path) ||
        !/^[0-9a-f]{64}$/.test(saved.executable.sha256) ||
        !Effect.isEffect(saved.acquirePermittedProfile) ||
        (expected.provider === "codex"
          ? !validCodexRestrictions(saved.codex)
          : saved.codex !== undefined)
      )
        return yield* new ExecutionBindingError({ code: "retainedBindingMismatch" });
      const profile = yield* saved.acquirePermittedProfile;
      if (
        profile.profileID !== saved.profile.id ||
        profile.profileRevision !== saved.profile.revision ||
        profile.accountBindingID !== saved.account.id ||
        profile.accountBindingGeneration !== saved.account.generation ||
        !absolute(profile.homeDirectory) ||
        !absolute(profile.profileDirectory) ||
        Object.entries(profile.environment).some(
          ([name, value]) =>
            !environmentKeys.has(name) || typeof value !== "string" || value.includes("\0"),
        )
      )
        return yield* new ExecutionBindingError({ code: "profileAccessMismatch" });
      return {
        key: Object.freeze({ ...key }),
        configuration: Object.freeze({ ...expected }),
        executablePath: saved.executable.path,
        executableSHA256: saved.executable.sha256,
        profile: Object.freeze({
          ...profile,
          environment: Object.freeze({ ...profile.environment }),
        }),
        ...(saved.codex
          ? {
              codex: Object.freeze({
                chatgptWorkspaceID: saved.codex.chatgptWorkspaceID,
                developerInstructions: saved.codex.developerInstructions,
                approvedInstructionSources: Object.freeze(
                  saved.codex.approvedInstructionSources.map((source) =>
                    Object.freeze({ path: source.path, sha256: source.sha256 }),
                  ),
                ),
              }),
            }
          : {}),
      };
    }),
  });
}
