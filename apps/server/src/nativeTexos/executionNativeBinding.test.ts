import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { PrivateExecutionChannel } from "./executionChannel.ts";
import { decodeNativeBinding, nativeBindingSource } from "./executionNativeBinding.ts";
import {
  AUTHORIZATION_CAPABILITY,
  executionEnvelope,
  type ExecutionNativeRequest,
  type ExecutionObservationKey,
  type ExecutionWireResponse,
} from "./executionProtocol.ts";
import { syntheticBinding, syntheticIntent, syntheticRequest } from "./execution.testkit.ts";

const intent = syntheticIntent();
const key: ExecutionObservationKey = {
  commandID: intent.commandID,
  envelopeDigest: executionEnvelope(intent).digest,
  canonicalRunID: intent.canonicalRunID,
  canonicalAttemptID: "synthetic-attempt",
  workerRequestID: "synthetic-worker-request",
  runtimeID: "synthetic-runtime",
  childID: "synthetic-child",
  t3ThreadID: "synthetic-thread",
  t3ProviderSessionID: "synthetic-session",
};

const wire = () => ({
  admission: { ...key, intent },
  connection: {
    revision: "1",
    connectionID: "synthetic-connection",
    executor: "workbench",
    provider: "codex",
    modelID: "synthetic-model",
    accountBindingID: "synthetic-account",
    accountBindingGeneration: "1",
    runtimeProfileID: "synthetic-profile",
    runtimeProfileRevision: "1",
  },
  account: { id: "synthetic-account", generation: "1", route: "cli-subscription" },
  profile: {
    id: "synthetic-profile",
    revision: "1",
    accountBindingID: "synthetic-account",
    accountBindingGeneration: "1",
    homeDirectory: "/synthetic/home",
    profileDirectory: "/synthetic/home/.codex",
    environment: { CODEX_HOME: "/synthetic/home/.codex" },
  },
  executable: {
    path: "/synthetic/bin/codex",
    sha256: "0".repeat(64),
    profileID: "synthetic-profile",
    profileRevision: "1",
  },
  model: { id: "synthetic-model", provider: "codex" },
});

describe("native execution binding", () => {
  it.effect("decodes the binding TexOS retained for an admission", () =>
    Effect.gen(function* () {
      const binding = decodeNativeBinding(wire());
      assert.strictEqual(binding.admission.t3ThreadID, "synthetic-thread");
      assert.strictEqual(binding.executable.path, "/synthetic/bin/codex");
      const profile = yield* binding.acquirePermittedProfile;
      assert.deepStrictEqual(profile.environment, { CODEX_HOME: "/synthetic/home/.codex" });
    }),
  );

  it("refuses extra fields, a paid route, an unknown provider and a large environment", () => {
    const extra = wire();
    assert.throws(() => decodeNativeBinding({ ...extra, apiKey: "x" }));
    const paid = wire();
    assert.throws(() =>
      decodeNativeBinding({ ...paid, account: { ...paid.account, route: "api" } }),
    );
    const provider = wire();
    assert.throws(() =>
      decodeNativeBinding({ ...provider, model: { ...provider.model, provider: "other" } }),
    );
    const large = wire();
    const environment = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`K${index}`, "v"]),
    );
    assert.throws(() =>
      decodeNativeBinding({ ...large, profile: { ...large.profile, environment } }),
    );
  });

  it.live("reads the binding from TexOS over the private channel", () =>
    Effect.gen(function* () {
      const sent: Array<ExecutionWireResponse | ExecutionNativeRequest> = [];
      let answer: unknown = wire();
      const channel = new PrivateExecutionChannel(
        syntheticBinding,
        { handle: async () => ({ capabilities: [] }), disconnect: async () => {} },
        (frame) => {
          sent.push(frame);
          if (frame.kind !== "request") return;
          assert.strictEqual(frame.method, "execution.readBinding");
          assert.deepStrictEqual(frame.params, key);
          channel.receive({
            version: 2,
            namespace: "texos.execution",
            kind: "response",
            id: frame.id,
            ...syntheticBinding,
            ok: true,
            result: answer,
          });
        },
        () => {},
      );
      channel.receive(
        syntheticRequest("execution.hello", { capabilities: [AUTHORIZATION_CAPABILITY] }),
      );
      const source = nativeBindingSource((k, signal) => channel.readBinding(k, signal));
      const binding = yield* source.readRetained(key);
      assert.strictEqual(binding?.model.provider, "codex");
      answer = { ...wire(), model: { id: "m", provider: "other" } };
      const refused = yield* Effect.exit(source.readRetained(key));
      assert.isTrue(Exit.isFailure(refused));
      channel.close();
    }),
  );
});
