import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

// Gate the whole dependency layer: an unused provided ledger still probes ps
// during construction, before the native registry can bypass SDK execution.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    if (env.T3CODE_TEXOS_NATIVE_BRIDGE === "1") return Layer.empty;
    return OpenCodeRuntime.layer.pipe(
      Layer.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
          }),
        ),
      ),
    );
  }),
);
