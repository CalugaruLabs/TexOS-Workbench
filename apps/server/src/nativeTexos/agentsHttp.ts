import * as Crypto from "effect/Crypto";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type PersonalAgentSnapshot,
} from "@t3tools/contracts";
import { decodePersonalAgentCommand } from "@t3tools/shared/personalAgents";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { inheritedNativeBridge } from "./bridge.ts";
import { isNativeTexos } from "./profile.ts";

const refuse = () => HttpServerResponse.text("Personal agents are unavailable.", { status: 404 });
const unavailable = () =>
  HttpServerResponse.text(
    "Native admission is unavailable; refresh state before submitting again.",
    { status: 503 },
  );
const authErrors = {
  EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
  EnvironmentInternalError: HttpServerRespondable.toResponse,
  EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
};
export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add(
      "POST",
      "/api/texos/agents",
      Effect.gen(function* () {
        if (!isNativeTexos()) return refuse();
        yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const value = yield* request.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(65536)),
          Effect.orElseSucceed(() => null),
        );
        const command = yield* Effect.try({
          try: () => decodePersonalAgentCommand(value),
          catch: () => "invalid" as const,
        }).pipe(Effect.orElseSucceed(() => null));
        if (!command)
          return HttpServerResponse.text("Invalid personal agent command.", { status: 400 });
        return yield* Effect.tryPromise({
          try: () => inheritedNativeBridge().callAgents(command),
          catch: () => "unavailable" as const,
        }).pipe(
          Effect.flatMap((response) => HttpServerResponse.json(response)),
          Effect.orElseSucceed(unavailable),
        );
      }).pipe(Effect.catchTags(authErrors)),
    );
    yield* router.add(
      "GET",
      "/api/texos/agents/events",
      Effect.gen(function* () {
        if (!isNativeTexos()) return refuse();
        yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
        const bridge = inheritedNativeBridge();
        const ready = yield* Effect.tryPromise({
          try: () => bridge.agentsReady(),
          catch: () => "unavailable" as const,
        }).pipe(Effect.orElseSucceed(() => null));
        if (!ready) return unavailable();
        const crypto = yield* Crypto.Crypto;
        const snapshots = Stream.callback<PersonalAgentSnapshot>(
          (queue) =>
            Effect.gen(function* () {
              let latestRevision = -1;
              const offer = (snapshot: PersonalAgentSnapshot) => {
                if (snapshot.revision < latestRevision) return;
                latestRevision = snapshot.revision;
                Queue.offerUnsafe(queue, snapshot);
              };
              const detach = bridge.onAgentEvent((event) => {
                offer(event.snapshot);
              });
              const disconnect = bridge.onDisconnect(() => {
                Queue.endUnsafe(queue);
              });
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  detach();
                  disconnect();
                }),
              );
              const snapshotID = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
              const response = yield* Effect.tryPromise({
                try: () =>
                  bridge.callAgents({
                    id: snapshotID,
                    method: "agents.snapshot",
                    params: {},
                  }),
                catch: () => "unavailable" as const,
              }).pipe(Effect.orDie);
              if (!response.ok) {
                Queue.endUnsafe(queue);
                return;
              }
              offer(response.result as PersonalAgentSnapshot);
            }),
          { bufferSize: 1, strategy: "sliding" },
        );
        return HttpServerResponse.stream(
          snapshots.pipe(
            Stream.map((snapshot) => `data: ${JSON.stringify(snapshot)}\n\n`),
            Stream.encodeText,
          ),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
          },
        );
      }).pipe(Effect.catchTags(authErrors)),
    );
  }),
);
