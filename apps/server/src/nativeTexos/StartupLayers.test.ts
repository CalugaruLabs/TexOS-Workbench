import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as OpenCodeRuntimeLayer from "../provider/OpenCodeRuntimeLayer.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as StartupLayers from "./StartupLayers.ts";

it.effect(
  "native startup composition constructs no installer, SDK ledger, or telemetry supervisor and refuses operations",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const probes: string[] = [];
      const forbidden = (operation: string) => {
        probes.push(operation);
        return Effect.die(new Error("Unexpected native startup operation: " + operation));
      };
      const guardedFs: FileSystem.FileSystem = {
        ...fs,
        exists: () => forbidden("exists"),
        stat: () => forbidden("stat"),
        readDirectory: () => forbidden("readDirectory"),
        readFileString: () => forbidden("readFileString"),
        realPath: () => forbidden("realPath"),
        remove: () => forbidden("remove"),
        makeDirectory: () => forbidden("makeDirectory"),
      };
      const guardedSpawner = {
        ...spawner,
        spawn: () => forbidden("spawn"),
        string: () => forbidden("process.string"),
      };
      const built = yield* Layer.build(
        Layer.mergeAll(
          StartupLayers.layerInstallations,
          StartupLayers.layerTelemetry,
          OpenCodeRuntimeLayer.layer,
        ),
      ).pipe(
        Effect.provideService(HostProcess.Environment, {
          T3CODE_TEXOS_NATIVE_BRIDGE: "1",
          PATH: "/synthetic/provider-bin",
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(FileSystem.FileSystem, guardedFs),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guardedSpawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => forbidden("http")),
        ),
        Effect.provide(ModelManifest.layerTest),
        Effect.scoped,
      );
      const codex = Context.get(built, CodexInstallation.CodexInstallation);
      const antigravity = Context.get(built, AntigravityInstallation.AntigravityInstallation);
      for (const installer of [codex, antigravity]) {
        expect(yield* installer.state).toMatchObject({
          phase: "idle",
          canRemove: false,
          installedVersion: null,
          executablePath: null,
        });
        const denied: ReadonlyArray<
          Effect.Effect<
            unknown,
            | CodexInstallation.CodexInstallationError
            | AntigravityInstallation.AntigravityInstallationError,
            Scope.Scope
          >
        > = [
          installer.resolve(),
          installer.acquire(),
          installer.start,
          installer.cancel("synthetic-operation"),
          installer.remove(),
        ];
        for (const request of denied) {
          expect((yield* Effect.scoped(request).pipe(Effect.exit))._tag).toBe("Failure");
        }
        const states = yield* installer.changes.pipe(Stream.runCollect);
        expect(states).toHaveLength(1);
      }
      const telemetry = Context.get(built, NativeTelemetryClient.NativeTelemetryClient);
      const health = yield* telemetry.health;
      expect(health.status).toBe("unavailable");
      expect(health.restartCount).toBe(0);
      expect(Option.isNone(health.hello)).toBe(true);
      expect(yield* telemetry.retry).toBe(false);
      const unavailable: ReadonlyArray<
        Effect.Effect<unknown, NativeTelemetryClient.NativeTelemetryClientError>
      > = [
        telemetry.capabilities,
        telemetry.sampleNow,
        telemetry.processTable,
        telemetry.readHistory(1000),
        telemetry.setExternalProcesses([]),
      ];
      for (const request of unavailable) {
        expect((yield* Effect.exit(request))._tag).toBe("Failure");
      }
      expect(yield* telemetry.snapshots.pipe(Stream.runCollect)).toEqual([]);
      const subscription = yield* telemetry.subscribeHealth;
      expect(subscription.latest.status).toBe("unavailable");
      expect(yield* subscription.changes.pipe(Stream.runCollect)).toEqual([]);
      expect(probes).toEqual([]);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/synthetic/native", { prefix: "native-startup-guards-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
);
