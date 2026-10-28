import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import {
  AuthTerminalOperateScope,
  AuthOrchestrationReadScope,
  ThreadId,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { NativeBridge } from "./bridge.ts";
import { makeNativeRegistry } from "./registry.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
const original = process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
afterEach(() => {
  if (original === undefined) delete process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
  else process.env.T3CODE_TEXOS_NATIVE_BRIDGE = original;
});

const { PassThrough } = await vi.importActual<typeof import("node:stream")>("node:stream");

describe("native composition", () => {
  it.effect(
    "constructs only hello-authorized native routes, with no SDK/auth/maintenance/model helpers",
    () =>
      Effect.gen(function* () {
        const input = new PassThrough();
        const output = new PassThrough();
        const requests: string[] = [];
        output.on("data", (data) => {
          const request = JSON.parse(data.toString());
          requests.push(request.method);
          input.write(
            JSON.stringify({
              version: 1,
              kind: "response",
              id: request.id,
              ok: true,
              providers: ["codex", "claudeCode"],
            }) + "\n",
          );
        });
        const bridge = new NativeBridge(input, output, 1000);
        try {
          yield* Effect.gen(function* () {
            const registry = yield* makeNativeRegistry(bridge);
            const instances = yield* registry.listInstances;
            expect(instances.map((entry) => entry.instanceId)).toEqual(["codex", "claudeAgent"]);
            expect(yield* registry.getInstance(ProviderInstanceId.make("cursor"))).toBeUndefined();
            for (const instance of instances) {
              expect(instance.auth).toBeUndefined();
              expect(instance.consumeResetCredit).toBeUndefined();
              expect(instance.refreshModels).toBeUndefined();
              const snapshot = yield* instance.snapshot.getSnapshot;
              expect(snapshot.models.map((model) => model.slug)).toEqual(["native-settings"]);
              expect(snapshot.badgeLabel).toBe("Native TexOS execution in Workbench");
              expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
              const helper = instance.textGeneration;
              const deniedCalls: ReadonlyArray<
                Effect.Effect<unknown, import("@t3tools/contracts").TextGenerationError>
              > = [
                helper.generateCommitMessage(undefined as never),
                helper.generatePrContent(undefined as never),
                helper.generateBranchName(undefined as never),
                helper.generateThreadTitle(undefined as never),
                helper.generateReviewGuide(undefined as never),
              ];
              for (const denied of deniedCalls)
                expect((yield* Effect.exit(denied))._tag).toBe("Failure");
            }
            expect(requests).toEqual(["hello"]);
          });
        } finally {
          bridge.close();
        }
      }),
  );
  it.effect(
    "central middleware denies a fully scoped non-chat RPC before the handler; ordinary mode is preserved",
    () =>
      Effect.gen(function* () {
        const tested = [WS_METHODS.serverProbe, WS_METHODS.terminalClear] as const;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              (typeof tested)[number]
            > => !(tested as readonly string[]).includes(tag),
          ),
        );
        for (const embedded of [true, false]) {
          if (embedded) process.env.T3CODE_TEXOS_NATIVE_BRIDGE = "1";
          else delete process.env.T3CODE_TEXOS_NATIVE_BRIDGE;
          const handled: string[] = [];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* RpcTest.makeClient(group).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
                    group.toLayerHandler(WS_METHODS.terminalClear, () =>
                      Effect.sync(() => {
                        handled.push("clear");
                      }),
                    ),
                    RpcAuthorization.layer([AuthOrchestrationReadScope, AuthTerminalOperateScope]),
                  ),
                ),
              );
              expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
              const result = yield* Effect.exit(
                client[WS_METHODS.terminalClear]({
                  threadId: ThreadId.make("synthetic-thread"),
                  terminalId: "synthetic-terminal",
                }),
              );
              expect(result._tag).toBe(embedded ? "Failure" : "Success");
              expect(handled).toEqual(embedded ? [] : ["clear"]);
            }),
          );
        }
      }),
  );
});
