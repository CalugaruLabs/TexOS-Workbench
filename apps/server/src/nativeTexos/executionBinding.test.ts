import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  makeExecutionBinding,
  ExecutionBindingError,
  executionObservationKey,
  type PrivateNativeBindingSource,
} from "./executionBinding.ts";
import { executionEnvelope } from "./executionProtocol.ts";
import type { ExecutionReceipt } from "./executionReceipts.ts";
import { syntheticIntent } from "./execution.testkit.ts";

function fixture() {
  const intent = syntheticIntent("/synthetic/repository");
  const receipt: ExecutionReceipt = {
    intent,
    envelopeDigest: executionEnvelope(intent).digest,
    runtimeID: "runtime",
    childID: "child",
    t3ThreadID: "thread",
    t3ProviderSessionID: "session",
    phase: "running",
    mappings: {},
    drained: false,
  };
  let reads = 0;
  let accesses = 0;
  const retained = {
    admission: { ...executionObservationKey(receipt), intent },
    connection: { ...intent.configuration },
    account: {
      id: intent.configuration.accountBindingID,
      generation: "1",
      route: "cli-subscription" as const,
    },
    profile: {
      id: intent.configuration.runtimeProfileID,
      revision: "1",
      accountBindingID: intent.configuration.accountBindingID,
      accountBindingGeneration: "1",
    },
    executable: {
      path: "/synthetic/bin/codex",
      sha256: "1".repeat(64),
      profileID: intent.configuration.runtimeProfileID,
      profileRevision: "1",
    },
    model: { id: intent.configuration.modelID, provider: intent.configuration.provider },
    acquirePermittedProfile: Effect.sync(() => {
      accesses++;
      return {
        profileID: intent.configuration.runtimeProfileID,
        profileRevision: "1",
        accountBindingID: intent.configuration.accountBindingID,
        accountBindingGeneration: "1",
        homeDirectory: "/synthetic/home",
        profileDirectory: "/synthetic/profile",
        environment: {},
      };
    }),
  };
  const source: PrivateNativeBindingSource = {
    readRetained: () =>
      Effect.sync(() => {
        reads++;
        return retained;
      }),
  };
  return { receipt, retained, source, counts: () => ({ reads, accesses }) };
}

describe("private retained execution binding", () => {
  it.effect(
    "constructs without reads; requires independent profile access after exact retained admission",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const binding = makeExecutionBinding(f.source);
        assert.deepEqual(f.counts(), { reads: 0, accesses: 0 });
        const resolved = yield* binding.resolve(f.receipt);
        assert.deepEqual(f.counts(), { reads: 1, accesses: 1 });
        assert.equal(resolved.configuration.modelID, f.receipt.intent.configuration.modelID);
        assert.equal(resolved.profile.profileID, f.retained.profile.id);
        assert.equal(resolved.executablePath, f.retained.executable.path);
        assert.isTrue(Object.isFrozen(resolved.profile.environment));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "renderer-shaped IDs and qualified flags cannot replace an absent private supplier",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const binding = makeExecutionBinding();
        assert.isFalse(binding.available);
        const rendererShaped = {
          ...f.receipt,
          qualified: true,
          profilePath: "/synthetic/profile",
          displayName: "Codex",
        };
        const error = yield* binding.resolve(rendererShaped).pipe(Effect.flip);
        assert.equal(error.code, "privateBindingUnavailable");
        assert.deepEqual(f.counts(), { reads: 0, accesses: 0 });
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "digest",
    "child",
    "attempt",
    "authority",
    "connection",
    "account",
    "generation",
    "profile",
    "executable",
    "model",
    "tokenRoute",
  ] as const)("denies retained %s mismatch before profile access", (kind) =>
    Effect.gen(function* () {
      const f = fixture();
      switch (kind) {
        case "digest":
          f.retained.admission.envelopeDigest = "f".repeat(64);
          break;
        case "child":
          f.retained.admission.childID = "other-child";
          break;
        case "attempt":
          f.retained.admission.canonicalAttemptID = "other-attempt";
          break;
        case "authority":
          f.retained.admission.intent = {
            ...f.receipt.intent,
            scope: { ...f.receipt.intent.scope, authorityID: "other-authority" },
          };
          break;
        case "connection":
          f.retained.connection.connectionID = "other-connection";
          break;
        case "account":
          f.retained.account.id = "other-account";
          break;
        case "generation":
          f.retained.account.generation = "2";
          break;
        case "profile":
          f.retained.profile.revision = "2";
          break;
        case "executable":
          f.retained.executable.path = "codex";
          break;
        case "model":
          f.retained.model.id = "fallback-model";
          break;
        case "tokenRoute":
          Object.assign(f.retained.account, { route: "t3-managed-token-sharing" });
          break;
      }
      const error = yield* makeExecutionBinding(f.source).resolve(f.receipt).pipe(Effect.flip);
      assert.instanceOf(error, ExecutionBindingError);
      assert.equal(f.counts().accesses, 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "NODE_OPTIONS",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])("rejects profile environment injection %s", (name) =>
    Effect.gen(function* () {
      const f = fixture();
      const original = yield* f.retained.acquirePermittedProfile;
      f.retained.acquirePermittedProfile = Effect.succeed({
        ...original,
        environment: { [name]: "synthetic-forbidden" },
      });
      const error = yield* makeExecutionBinding(f.source).resolve(f.receipt).pipe(Effect.flip);
      assert.equal(error.code, "profileAccessMismatch");
    }).pipe(Effect.scoped),
  );
});
