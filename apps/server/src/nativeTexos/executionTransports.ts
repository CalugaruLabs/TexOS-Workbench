import * as Effect from "effect/Effect";

import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  OwnedExecutionTransportError,
  type ManagedExecutionTransports,
} from "./executionManaged.ts";

// Seal has already waited for exit and EOF; these only re-read what it observed.
const SETTLED_OBSERVATION_TIMEOUT = "1 second";

/**
 * Codex through the stock app-server spawner, always in owned-input mode so the managed run can
 * seal it. Claude has no production transport yet, so a Claude admission stays unavailable.
 */
export const makeManagedExecutionTransports = Effect.fn("ManagedExecutionTransports.make")(
  function* () {
    const factory = yield* Codex.CodexAppServerClientFactory;
    const openOwned = factory.openOwned;
    const transports: ManagedExecutionTransports = {
      ...(openOwned
        ? {
            codex: {
              open: Effect.fn("ManagedExecutionTransports.openCodex")(function* (input) {
                const client = yield* openOwned({ ...input, observeOwnedInput: true }).pipe(
                  Effect.mapError(
                    () => new OwnedExecutionTransportError({ operation: "openCodex" }),
                  ),
                );
                const owned = client.ownedTransport;
                if (!owned)
                  return yield* new OwnedExecutionTransportError({
                    operation: "ownedTransportMissing",
                  });
                return {
                  client,
                  closeAndJoin: owned.childExit(SETTLED_OBSERVATION_TIMEOUT).pipe(
                    Effect.flatMap((code) =>
                      code === 0
                        ? Effect.void
                        : Effect.fail(new OwnedExecutionTransportError({ operation: "childExit" })),
                    ),
                    Effect.mapError(
                      () => new OwnedExecutionTransportError({ operation: "childExit" }),
                    ),
                  ),
                  transportAndParserDrain: owned.input
                    .parserDispatch(SETTLED_OBSERVATION_TIMEOUT)
                    .pipe(
                      Effect.andThen(owned.stderrEOF(SETTLED_OBSERVATION_TIMEOUT)),
                      Effect.mapError(
                        () => new OwnedExecutionTransportError({ operation: "parserDrain" }),
                      ),
                    ),
                };
              }),
            },
          }
        : {}),
    };
    return transports;
  },
);
