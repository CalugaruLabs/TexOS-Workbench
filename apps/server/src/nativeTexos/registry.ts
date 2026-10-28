import { ProviderDriverKind, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { inheritedNativeBridge, type NativeBridge } from "./bridge.ts";
import { makeNativeAdapter } from "./adapter.ts";
import { NATIVE_LABEL, NATIVE_MODEL } from "./profile.ts";

class NativeBridgeHandshakeError extends Schema.TaggedError<NativeBridgeHandshakeError>()(
  "NativeBridgeHandshakeError",
  { cause: Schema.Defect() },
) {}

/** Constructed instead of SDK drivers/infrastructure, never on bridge failure as fallback. */
export const makeNativeRegistry = Effect.fn("makeNativeRegistry")(function* (bridge: NativeBridge) {
  const hello = yield* Effect.tryPromise({
    try: () => bridge.ready(),
    catch: (cause) => new NativeBridgeHandshakeError({ cause }),
  }).pipe(Effect.orDie);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const changes = yield* PubSub.unbounded<void>();
  const instances: ProviderInstance[] = hello.providers!.map((provider) => {
    const driver = ProviderDriverKind.make(provider === "claudeCode" ? "claudeAgent" : "codex");
    const instanceId = ProviderInstanceId.make(provider === "claudeCode" ? "claudeAgent" : "codex");
    const snapshot = {
      ...buildServerProvider({
        presentation: {
          displayName: `${provider === "codex" ? "Codex" : "Claude"} · native TexOS`,
          badgeLabel: NATIVE_LABEL,
          supportedRuntimeModes: ["approval-required"],
          showInteractionModeToggle: false,
          supportsConversationRollback: false,
        },
        enabled: true,
        checkedAt,
        models: [
          {
            slug: NATIVE_MODEL,
            name: "Native TexOS Settings",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown" },
          message:
            "Execution and subscription checks are performed by native TexOS on every send. Workbench has no provider credentials.",
        },
      }),
      instanceId,
      driver,
    };
    const denied =
      (
        operation:
          | "generateCommitMessage"
          | "generatePrContent"
          | "generateBranchName"
          | "generateThreadTitle"
          | "generateReviewGuide",
      ) =>
      () =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Auxiliary model generation is disabled in native TexOS presentation.",
          }),
        );
    return {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: `native-texos:${provider}` },
      displayName: snapshot.displayName,
      enabled: true,
      snapshot: {
        getSnapshot: Effect.succeed(snapshot),
        refresh: Effect.succeed(snapshot),
        streamChanges: Stream.never,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed({
            provider: driver,
            packageName: null,
            update: null,
            latestVersion: null,
          }),
      },
      orchestrationAdapter: makeNativeAdapter(provider, bridge),
      textGeneration: {
        generateCommitMessage: denied("generateCommitMessage"),
        generatePrContent: denied("generatePrContent"),
        generateBranchName: denied("generateBranchName"),
        generateThreadTitle: denied("generateThreadTitle"),
        generateReviewGuide: denied("generateReviewGuide"),
      },
    };
  });
  return ProviderInstanceRegistry.of({
    getInstance: Effect.fn("ProviderInstanceRegistry.getInstance")((id: ProviderInstanceId) =>
      Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    ),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(
  ProviderInstanceRegistry,
  Effect.gen(function* () {
    const bridge = yield* Effect.acquireRelease(Effect.sync(inheritedNativeBridge), (client) =>
      Effect.sync(() => client.close()),
    );
    return yield* makeNativeRegistry(bridge);
  }),
);
