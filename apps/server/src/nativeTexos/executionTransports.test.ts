import { assert, describe, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeManagedExecutionTransports } from "./executionTransports.ts";

const transcript: CodexReplay.CodexAppServerReplayTranscript = {
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.144.0",
  scenario: "managed-transport-close",
  entries: [],
};

const replayFactory = (options: { readonly owned: boolean }) =>
  Codex.CodexAppServerClientFactory.of({
    open: () => Effect.die("Managed transport must not use the legacy open"),
    ...(options.owned
      ? {
          openOwned: (input) =>
            Effect.gen(function* () {
              assert.isTrue(input.observeOwnedInput);
              const driver = yield* CodexReplay.makeReplayDriver(transcript);
              const handle = yield* CodexReplay.makeReplayChildProcess(driver);
              const context = yield* Layer.build(
                CodexClient.layerChildProcess(handle, { observeOwnedInput: true }),
              );
              return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
            }).pipe(Effect.orDie),
        }
      : {}),
  });

const openInput = {} as Parameters<
  NonNullable<Codex.CodexAppServerClientFactoryShape["openOwned"]>
>[0];

describe("managed execution transports", () => {
  it.effect("Codex opens owned and observes exit and parser drain once input closes", () =>
    Effect.gen(function* () {
      const transports = yield* makeManagedExecutionTransports().pipe(
        Effect.provideService(Codex.CodexAppServerClientFactory, replayFactory({ owned: true })),
      );
      assert.ok(transports.codex);
      assert.isUndefined(transports.claude);
      const opened = yield* transports.codex.open(openInput, {} as never);
      assert.ok(opened.client.ownedTransport);
      yield* opened.client.ownedTransport.input.finishInput;
      yield* opened.closeAndJoin;
      yield* opened.transportAndParserDrain;
    }).pipe(Effect.scoped),
  );

  it.effect("a factory without owned input offers no Codex transport", () =>
    Effect.gen(function* () {
      const transports = yield* makeManagedExecutionTransports().pipe(
        Effect.provideService(Codex.CodexAppServerClientFactory, replayFactory({ owned: false })),
      );
      assert.isUndefined(transports.codex);
    }),
  );
});
