import { afterEach, expect, it, vi } from "vite-plus/test";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { configureClientTracing } from "./clientTracing";

vi.mock("effect/ManagedRuntime", { spy: true });
vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: vi.fn(() => {
    throw new Error("Native presentation must not resolve a telemetry endpoint");
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([{}, { exportIntervalMs: 10 }])(
  "native presentation never constructs a tracing exporter or sends an export: %j",
  async (config) => {
    vi.stubEnv("VITE_TEXOS_NATIVE_PRESENTATION", "1");
    const makeRuntime = vi.spyOn(ManagedRuntime, "make").mockImplementation(() => {
      throw new Error("Native presentation must not create an exporter runtime");
    });
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Native presentation must not export browser telemetry");
    });
    vi.mocked(resolvePrimaryEnvironmentHttpUrl).mockClear();
    await configureClientTracing(config);
    await configureClientTracing(config);
    expect(resolvePrimaryEnvironmentHttpUrl).not.toHaveBeenCalled();
    expect(makeRuntime).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  },
);
