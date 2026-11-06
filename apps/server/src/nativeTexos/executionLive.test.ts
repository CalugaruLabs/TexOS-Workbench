import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ExecutionControl } from "./executionControl.ts";
import { lazyExecutionEndpoint } from "./executionLive.ts";
import { syntheticBinding, syntheticRequest } from "./execution.testkit.ts";

describe("native execution startup", () => {
  it("a hello that arrives before the server layer is answered once the control exists", async () => {
    let supply: ((build: never) => void) | undefined;
    const builder = new Promise<never>((resolve) => {
      supply = resolve;
    });
    const seen: Array<string> = [];
    const endpoint = lazyExecutionEndpoint(builder)(syntheticBinding, async () => null);
    const answer = endpoint.handle(
      syntheticRequest("execution.hello", { capabilities: [] }) as never,
    );
    const control = {
      handle: (request: { readonly method: string }) =>
        Effect.sync(() => {
          seen.push(request.method);
          return { capabilities: [] };
        }),
      disconnect: Effect.void,
    } as unknown as ExecutionControl["Service"];
    supply!((async (binding: unknown) => {
      expect(binding).toEqual(syntheticBinding);
      return control;
    }) as never);
    await expect(answer).resolves.toEqual({ capabilities: [] });
    expect(seen).toEqual(["execution.hello"]);
    await endpoint.disconnect();
  });

  it("a control that cannot be built refuses requests and still disconnects", async () => {
    const endpoint = lazyExecutionEndpoint(
      Promise.resolve(() => Promise.reject(new Error("unavailable"))),
    )(syntheticBinding, async () => null);
    await expect(
      endpoint.handle(syntheticRequest("execution.hello", { capabilities: [] }) as never),
    ).rejects.toThrow("unavailable");
    await expect(endpoint.disconnect()).resolves.toBeUndefined();
  });
});
