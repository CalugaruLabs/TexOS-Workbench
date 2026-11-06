import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import type { ExecutionEndpointFactory, NativeBridge } from "./bridge.ts";
import { ExecutionBinding, makeExecutionBinding } from "./executionBinding.ts";
import { executionEndpoint, type PrivateExecutionEndpoint } from "./executionChannel.ts";
import { makeExecutionControl, type ExecutionControl } from "./executionControl.ts";
import { ManagedExecutionProvider, makeManagedExecutionProvider } from "./executionManaged.ts";
import { nativeBindingSource } from "./executionNativeBinding.ts";
import type { ExecutionChannelBinding } from "./executionProtocol.ts";
import { makeManagedExecutionTransports } from "./executionTransports.ts";
import { isNativeTexos } from "./profile.ts";

type ReadBinding = Parameters<ExecutionEndpointFactory>[1];
type BuildControl = (
  binding: ExecutionChannelBinding,
  readBinding: ReadBinding,
) => Promise<ExecutionControl["Service"]>;

/**
 * Waits for the server layer to supply the builder, so a hello that arrives during startup
 * is answered by the real control instead of being refused.
 */
export function lazyExecutionEndpoint(builder: Promise<BuildControl>): ExecutionEndpointFactory {
  return (binding, readBinding) => {
    const endpoint: Promise<PrivateExecutionEndpoint> = builder
      .then((build) => build(binding, readBinding))
      .then(executionEndpoint);
    return {
      handle: (request, authorize) => endpoint.then((ready) => ready.handle(request, authorize)),
      disconnect: () => endpoint.then((ready) => ready.disconnect()).catch(() => {}),
    };
  };
}

// One bridge per process (see `inheritedNativeBridge`), so one builder slot per process.
let supplyBuilder: ((build: BuildControl) => void) | undefined;
const builder = new Promise<BuildControl>((resolve) => {
  supplyBuilder = resolve;
});

/** Called where the native bridge is created, before any frame can be read from it. */
export function armNativeExecution(bridge: NativeBridge) {
  bridge.enableExecutionControl(lazyExecutionEndpoint(builder));
}

const makeControl = Effect.fn("NativeExecution.makeControl")(function* (
  binding: ExecutionChannelBinding,
  readBinding: ReadBinding,
) {
  const transports = yield* makeManagedExecutionTransports();
  const provider = yield* makeManagedExecutionProvider(transports).pipe(
    Effect.provideService(ExecutionBinding, makeExecutionBinding(nativeBindingSource(readBinding))),
  );
  return yield* makeExecutionControl(binding).pipe(
    Effect.provideService(ManagedExecutionProvider, provider),
  );
});

/** Native mode only: managed Codex runs through the stock owned transport, gated by TexOS. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!isNativeTexos()) return;
    const context =
      yield* Effect.context<
        Exclude<Effect.Services<ReturnType<typeof makeControl>>, Scope.Scope>
      >();
    const scope = yield* Effect.scope;
    supplyBuilder?.((binding, readBinding) =>
      makeControl(binding, readBinding).pipe(Scope.provide(scope), Effect.runPromiseWith(context)),
    );
  }),
);
