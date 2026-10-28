import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as OpenCodeRuntimeLayer from "./OpenCodeRuntimeLayer.ts";

it.effect(
  "native server composition never constructs the OpenCode ledger or runs its owner ps probe",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let probes = 0;
      const guarded = {
        ...spawner,
        string: () => {
          probes += 1;
          return Effect.die(
            new Error("Native presentation must not inspect OpenCode owner processes"),
          );
        },
      };
      const built = yield* Layer.build(OpenCodeRuntimeLayer.layer).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guarded),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { T3CODE_TEXOS_NATIVE_BRIDGE: "1" }),
        Effect.provide(
          ServerConfig.layerTest("/synthetic/native", { prefix: "native-opencode-layer-" }),
        ),
        Effect.scoped,
      );
      expect(probes).toBe(0);
      const runtime = Context.get(built, OpenCodeRuntime.OpenCodeRuntime);
      const denied: ReadonlyArray<
        Effect.Effect<unknown, OpenCodeRuntime.OpenCodeRuntimeError, Scope.Scope>
      > = [
        runtime.startOpenCodeServerProcess({
          binaryPath: "/synthetic/opencode",
          directory: "/synthetic",
        }),
        runtime.connectToOpenCodeServer({
          binaryPath: "/synthetic/opencode",
          directory: "/synthetic",
        }),
        runtime.runOpenCodeCommand({ binaryPath: "/synthetic/opencode", args: ["--version"] }),
        runtime.loadInventoryFromCli({ binaryPath: "/synthetic/opencode", cwd: "/synthetic" }),
        runtime.loadSkillsFromCli({ binaryPath: "/synthetic/opencode", cwd: "/synthetic" }),
      ];
      for (const request of denied)
        expect((yield* Effect.scoped(request).pipe(Effect.exit))._tag).toBe("Failure");
      const createDeniedSdk = () =>
        runtime.createOpenCodeSdkClient({
          baseUrl: "http://127.0.0.1:1",
          directory: "/synthetic",
        });
      expect(createDeniedSdk).toThrow(OpenCodeRuntime.OpenCodeRuntimeError);
      expect(createDeniedSdk).toThrow(
        expect.objectContaining({
          operation: "create-sdk-client",
          detail: "OpenCode SDK access is unavailable in native TexOS presentation.",
        }),
      );
      expect(probes).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer)),
);
