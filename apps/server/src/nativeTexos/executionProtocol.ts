// @effect-diagnostics nodeBuiltinImport:off -- Private wire validation and deterministic nonsecret envelope hashing.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

export const EXECUTION_NAMESPACE = "texos.execution";
export const EXECUTION_CAPABILITY = "texos.execution.controlled-codex.v2";
export const MANAGED_EXECUTION_CAPABILITY = "texos.execution.managed-cli.v2";
export const AUTHORIZATION_CAPABILITY = "texos.execution.authorize.v2";
export const EXECUTION_FRAME_BYTES = 64 * 1024;

export interface ExecutionScope {
  readonly authorityID: string;
  readonly installationID: string;
  readonly ownerID: string;
  readonly spaceID: string;
  readonly hostID: string;
  readonly clientID: string;
  readonly principalID: string;
  readonly projectID: string;
}

export interface ExecutionConfiguration {
  readonly revision: string;
  readonly connectionID: string;
  readonly executor: "t3";
  readonly provider: "codex" | "claudeCode";
  readonly modelID: string;
  readonly accountBindingID: string;
  readonly accountBindingGeneration: string;
  readonly runtimeProfileID: string;
  readonly runtimeProfileRevision: string;
}

export interface ExecutionIntent {
  readonly commandID: string;
  readonly canonicalRunID: string;
  readonly canonicalAttemptID: string;
  readonly workerRequestID: string;
  readonly scope: ExecutionScope;
  readonly worktree: {
    readonly id: string;
    readonly root: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly configuration: ExecutionConfiguration;
  readonly parent: { readonly agentID: string; readonly conversationID: string };
  readonly input: string;
}

export interface ExecutionChannelBinding {
  readonly authorityID: string;
  readonly hostID: string;
  readonly hostGeneration: string;
}

export interface ExecutionObservationKey {
  readonly commandID: string;
  readonly envelopeDigest: string;
  readonly canonicalRunID: string;
  readonly canonicalAttemptID: string;
  readonly workerRequestID: string;
  readonly runtimeID: string;
  readonly childID: string;
  readonly t3ThreadID: string;
  readonly t3ProviderSessionID: string;
}

// Observations are not independent acceptance or authority to release a Native lease.
export interface ManagedExecutionObservation {
  readonly key: ExecutionObservationKey;
  readonly outcome: "completed" | "failed" | "interrupted" | "unknown";
  readonly closeAndJoin: "observed" | "unknown";
  readonly transportAndParserDrain: "observed" | "unknown";
  readonly adapterEventDrain: "observed" | "unknown";
  readonly assistantCursor?: string;
}

interface Frame extends ExecutionChannelBinding {
  readonly version: 2;
  readonly namespace: typeof EXECUTION_NAMESPACE;
  readonly id: string;
}

export type ExecutionHostRequest = Frame & {
  readonly kind: "request";
} & (
    | { readonly method: "execution.hello"; readonly params: { readonly capabilities: string[] } }
    | { readonly method: "execution.admit"; readonly params: ExecutionIntent }
    | {
        readonly method: "execution.status" | "execution.stop";
        readonly params: { readonly commandID: string; readonly envelopeDigest: string };
      }
  );

export interface ExecutionAuthorizationRequest extends Frame {
  readonly kind: "request";
  readonly method: "execution.authorizeStart";
  readonly params: {
    readonly commandID: string;
    readonly canonicalRunID: string;
    readonly envelopeDigest: string;
    readonly runtimeID: string;
    readonly childID: string;
    readonly t3ThreadID: string;
    readonly t3ProviderSessionID: string;
    readonly providerThreadID?: string;
    readonly nativeThreadID?: string;
  };
}

export interface ExecutionBindingRequest extends Frame {
  readonly kind: "request";
  readonly method: "execution.readBinding";
  readonly params: ExecutionObservationKey;
}

export type ExecutionNativeRequest = ExecutionAuthorizationRequest | ExecutionBindingRequest;

export interface NativeExecutionAuthorization {
  readonly decisionID: string;
  readonly commandID: string;
  readonly canonicalRunID: string;
  readonly envelopeDigest: string;
  readonly runtimeID: string;
  readonly childID: string;
  readonly accountBindingGeneration: string;
  readonly currentConfigurationRevision: string;
  readonly expiresAtMs: number;
  readonly outcome: "allow" | "deny" | "unknown";
  readonly revoked: boolean;
  readonly noNewCharges: boolean;
  readonly checks: Readonly<
    Record<
      "permission" | "accountIdentity" | "runtime" | "capacity" | "billing" | "worktreeLease",
      "qualified" | "denied" | "unknown"
    >
  >;
}

export type ExecutionWireResponse = Frame &
  (
    | { readonly kind: "response"; readonly ok: true; readonly result: unknown }
    | { readonly kind: "response"; readonly ok: false; readonly error: { readonly code: string } }
  );

export class ExecutionProtocolError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutionProtocolError("invalidExecutionFrame");
  }
  return value as Record<string, unknown>;
}

export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new ExecutionProtocolError("invalidExecutionFields");
  }
  return record;
}

export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim() !== value ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ExecutionProtocolError("invalidExecutionIdentity");
  }
}

function uuid(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new ExecutionProtocolError("invalidExecutionUUID");
  }
}

function revision(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  ) {
    throw new ExecutionProtocolError("invalidExecutionRevision");
  }
}

export function digestString(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ExecutionProtocolError("invalidExecutionDigest");
  }
}

export function decodeExecutionIntent(value: unknown): ExecutionIntent {
  const intent = exact(value, [
    "commandID",
    "canonicalRunID",
    "canonicalAttemptID",
    "workerRequestID",
    "scope",
    "worktree",
    "configuration",
    "parent",
    "input",
  ]);
  uuid(intent.commandID);
  for (const key of ["canonicalRunID", "canonicalAttemptID", "workerRequestID"])
    identifier(intent[key]);
  const scope = exact(intent.scope, [
    "authorityID",
    "installationID",
    "ownerID",
    "spaceID",
    "hostID",
    "clientID",
    "principalID",
    "projectID",
  ]);
  for (const entry of Object.values(scope)) identifier(entry);
  const tree = exact(intent.worktree, ["id", "root", "device", "inode"]);
  identifier(tree.id);
  if (
    typeof tree.root !== "string" ||
    Buffer.byteLength(tree.root) > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(tree.root) ||
    !NodePath.isAbsolute(tree.root) ||
    NodePath.resolve(tree.root) !== tree.root ||
    tree.root === NodePath.parse(tree.root).root
  ) {
    throw new ExecutionProtocolError("invalidExecutionWorktree");
  }
  for (const entry of [tree.device, tree.inode]) {
    if (typeof entry !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(entry)) {
      throw new ExecutionProtocolError("invalidExecutionWorktree");
    }
  }
  const configuration = exact(intent.configuration, [
    "revision",
    "connectionID",
    "executor",
    "provider",
    "modelID",
    "accountBindingID",
    "accountBindingGeneration",
    "runtimeProfileID",
    "runtimeProfileRevision",
  ]);
  if (
    configuration.executor !== "t3" ||
    !["codex", "claudeCode"].includes(String(configuration.provider))
  ) {
    throw new ExecutionProtocolError("unsupportedExecutionRoute");
  }
  for (const key of ["revision", "accountBindingGeneration", "runtimeProfileRevision"])
    revision(configuration[key]);
  for (const key of ["connectionID", "modelID", "accountBindingID", "runtimeProfileID"])
    identifier(configuration[key]);
  if (["default", "auto", "native-settings"].includes(String(configuration.modelID)))
    throw new ExecutionProtocolError("implicitExecutionModel");
  const parent = exact(intent.parent, ["agentID", "conversationID"]);
  identifier(parent.agentID);
  identifier(parent.conversationID);
  if (
    typeof intent.input !== "string" ||
    !intent.input.trim() ||
    Buffer.byteLength(intent.input) > 8192
  ) {
    throw new ExecutionProtocolError("invalidExecutionInput");
  }
  return intent as unknown as ExecutionIntent;
}

export function decodeExecutionHostRequest(value: unknown): ExecutionHostRequest {
  const frame = exact(value, [
    "version",
    "namespace",
    "kind",
    "id",
    "authorityID",
    "hostID",
    "hostGeneration",
    "method",
    "params",
  ]);
  if (frame.version !== 2 || frame.namespace !== EXECUTION_NAMESPACE || frame.kind !== "request") {
    throw new ExecutionProtocolError("invalidExecutionDirection");
  }
  uuid(frame.id);
  for (const key of ["authorityID", "hostID", "hostGeneration"]) identifier(frame[key]);
  switch (frame.method) {
    case "execution.hello": {
      const params = exact(frame.params, ["capabilities"]);
      if (
        !Array.isArray(params.capabilities) ||
        params.capabilities.length > 4 ||
        params.capabilities.some((entry) => entry !== AUTHORIZATION_CAPABILITY) ||
        new Set(params.capabilities).size !== params.capabilities.length
      ) {
        throw new ExecutionProtocolError("invalidExecutionCapabilities");
      }
      break;
    }
    case "execution.admit":
      decodeExecutionIntent(frame.params);
      break;
    case "execution.status":
    case "execution.stop": {
      const params = exact(frame.params, ["commandID", "envelopeDigest"]);
      uuid(params.commandID);
      digestString(params.envelopeDigest);
      break;
    }
    default:
      throw new ExecutionProtocolError("unsupportedExecutionMethod");
  }
  return frame as unknown as ExecutionHostRequest;
}

export function decodeNativeAuthorization(value: unknown): NativeExecutionAuthorization {
  const result = exact(value, [
    "decisionID",
    "commandID",
    "canonicalRunID",
    "envelopeDigest",
    "runtimeID",
    "childID",
    "accountBindingGeneration",
    "currentConfigurationRevision",
    "expiresAtMs",
    "outcome",
    "revoked",
    "noNewCharges",
    "checks",
  ]);
  uuid(result.decisionID);
  uuid(result.commandID);
  identifier(result.canonicalRunID);
  digestString(result.envelopeDigest);
  identifier(result.runtimeID);
  identifier(result.childID);
  revision(result.accountBindingGeneration);
  revision(result.currentConfigurationRevision);
  if (
    !Number.isSafeInteger(result.expiresAtMs) ||
    Number(result.expiresAtMs) <= 0 ||
    !["allow", "deny", "unknown"].includes(String(result.outcome)) ||
    typeof result.revoked !== "boolean" ||
    typeof result.noNewCharges !== "boolean"
  ) {
    throw new ExecutionProtocolError("invalidNativeAuthorization");
  }
  const checks = exact(result.checks, [
    "permission",
    "accountIdentity",
    "runtime",
    "capacity",
    "billing",
    "worktreeLease",
  ]);
  if (
    Object.values(checks).some(
      (entry) => !["qualified", "denied", "unknown"].includes(String(entry)),
    )
  ) {
    throw new ExecutionProtocolError("invalidNativeAuthorization");
  }
  return result as unknown as NativeExecutionAuthorization;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJSON(entry)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ExecutionProtocolError("invalidExecutionValue");
  return encoded;
}

// Transport correlation IDs/generations are excluded; Native mirrors this explicit semantic envelope.
export function executionEnvelope(value: unknown): {
  readonly intent: ExecutionIntent;
  readonly json: string;
  readonly digest: string;
} {
  const intent = decodeExecutionIntent(value);
  const json = canonicalJSON({
    version: 2,
    namespace: EXECUTION_NAMESPACE,
    method: "execution.admit",
    intent,
  });
  const copy = decodeExecutionIntent(JSON.parse(json).intent);
  Object.freeze(copy.scope);
  Object.freeze(copy.worktree);
  Object.freeze(copy.configuration);
  Object.freeze(copy.parent);
  Object.freeze(copy);
  return {
    intent: copy,
    json,
    digest: NodeCrypto.createHash("sha256").update(json, "utf8").digest("hex"),
  };
}
