import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

const denied = (operation: string) =>
  Effect.fail(
    new OpenCodeRuntime.OpenCodeRuntimeError({
      operation,
      detail: "OpenCode execution is unavailable in native TexOS presentation.",
    }),
  );
const layerNative = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntime.OpenCodeRuntime.of({
    startOpenCodeServerProcess: () => denied("start"),
    connectToOpenCodeServer: () => denied("connect"),
    runOpenCodeCommand: () => denied("command"),
    createOpenCodeSdkClient: () => {
      throw new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "create-sdk-client",
        detail: "OpenCode SDK access is unavailable in native TexOS presentation.",
      });
    },
    loadOpenCodeInventory: () => denied("inventory"),
    loadOpenCodeSkills: () => denied("skills"),
    loadInventoryFromCli: () => denied("cli-inventory"),
    loadSkillsFromCli: () => denied("cli-skills"),
  }),
);

// Gate the whole dependency layer: an unused provided ledger still probes ps
// during construction, before the native registry can bypass SDK execution.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    if (env.T3CODE_TEXOS_NATIVE_BRIDGE === "1") return layerNative;
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
