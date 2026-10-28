import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "../resourceTelemetry/ResourceMonitorBinary.ts";

const reason =
  "Unavailable in native TexOS presentation; native TexOS owns provider execution and host monitoring.";
const installState = (driver: string): ProviderInstallState => ({
  driver: ProviderDriverKind.make(driver),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion: null,
  executablePath: null,
  source: null,
  canRemove: false,
  message: reason,
});
const codexDenied = (operation: string) =>
  Effect.fail(new CodexInstallation.CodexInstallationError({ operation, detail: reason }));
const antigravityDenied = (operation: string) =>
  Effect.fail(
    new AntigravityInstallation.AntigravityInstallationError({ operation, detail: reason }),
  );

const layerNativeInstallations = Layer.mergeAll(
  Layer.succeed(
    CodexInstallation.CodexInstallation,
    CodexInstallation.CodexInstallation.of({
      managedDirectory: "",
      resolve: Effect.fn("nativeTexos.CodexInstallation.resolve")(() => codexDenied("resolve")),
      acquire: Effect.fn("nativeTexos.CodexInstallation.acquire")(() => codexDenied("acquire")),
      start: codexDenied("start"),
      cancel: Effect.fn("nativeTexos.CodexInstallation.cancel")(() => codexDenied("cancel")),
      remove: Effect.fn("nativeTexos.CodexInstallation.remove")(() => codexDenied("remove")),
      state: Effect.succeed(installState("codex")),
      changes: Stream.succeed(installState("codex")),
    }),
  ),
  Layer.succeed(
    AntigravityInstallation.AntigravityInstallation,
    AntigravityInstallation.AntigravityInstallation.of({
      managedDirectory: "",
      resolve: Effect.fn("nativeTexos.AntigravityInstallation.resolve")(() =>
        antigravityDenied("resolve"),
      ),
      acquire: Effect.fn("nativeTexos.AntigravityInstallation.acquire")(() =>
        antigravityDenied("acquire"),
      ),
      start: antigravityDenied("start"),
      cancel: Effect.fn("nativeTexos.AntigravityInstallation.cancel")(() =>
        antigravityDenied("cancel"),
      ),
      remove: Effect.fn("nativeTexos.AntigravityInstallation.remove")(() =>
        antigravityDenied("remove"),
      ),
      state: Effect.succeed(installState("antigravity")),
      changes: Stream.succeed(installState("antigravity")),
    }),
  ),
);

// Select BEFORE either installer constructs: no PATH probes, metadata reads,
// stale staging deletion, or provider health commands in native presentation.
export const layerInstallations = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    if (env.T3CODE_TEXOS_NATIVE_BRIDGE === "1") return layerNativeInstallations;
    return Layer.mergeAll(
      CodexInstallation.CodexInstallation.layer,
      AntigravityInstallation.AntigravityInstallation.layer,
    );
  }),
);

const telemetryDenied = Effect.fail(
  new NativeTelemetryClient.NativeTelemetryUnavailable({ reason }),
);
const health: NativeTelemetryClient.NativeTelemetryClientHealth = {
  status: "unavailable",
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.some(reason),
  restartCount: 0,
  sampleIntervalMs: 0,
};
const layerNativeTelemetry = Layer.succeed(
  NativeTelemetryClient.NativeTelemetryClient,
  NativeTelemetryClient.NativeTelemetryClient.of({
    capabilities: telemetryDenied,
    snapshots: Stream.empty,
    readHistory: Effect.fn("nativeTexos.telemetry.readHistory")(() => telemetryDenied),
    setExternalProcesses: Effect.fn("nativeTexos.telemetry.setExternalProcesses")(
      () => telemetryDenied,
    ),
    setHostPowerState: Effect.fn("nativeTexos.telemetry.setHostPowerState")(() => telemetryDenied),
    sampleNow: telemetryDenied,
    processTable: telemetryDenied,
    retry: Effect.succeed(false),
    health: Effect.succeed(health),
    subscribeHealth: Effect.succeed({ latest: health, changes: Stream.empty }),
  }),
);

// Analytics settings do not control the real client's supervisor. Native mode
// must never construct it or its binary resolver, even with no subscribers.
export const layerTelemetry = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    if (env.T3CODE_TEXOS_NATIVE_BRIDGE === "1") return layerNativeTelemetry;
    return NativeTelemetryClient.layer.pipe(Layer.provide(ResourceMonitorBinary.layer));
  }),
);
