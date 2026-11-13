import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as CodexError from "./errors.ts";
import { JsonRpcId, JsonRpcResponseEnvelope } from "./_internal/shared.ts";
const isJsonRpcId = Schema.is(JsonRpcId);
const isJsonRpcResponseEnvelope = Schema.is(JsonRpcResponseEnvelope);
const isCodexAppServerError = Schema.is(CodexError.CodexAppServerError);
const MAX_BUFFERED_RAW_MESSAGES = 32;
// Bound JSONL lines before joining and parsing; the LF delimiter is excluded.
const MAX_INCOMING_MESSAGE_BYTES = 128 * 1024 * 1024;
const EXIT_STATUS_GRACE = "250 millis";

export interface CodexAppServerProtocolLogEvent {
  readonly direction: "incoming" | "outgoing";
  readonly stage: "raw" | "decoded" | "decode_failed";
  readonly payload: unknown;
}

export interface CodexAppServerIncomingNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerIncomingRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerPatchedProtocolOptions {
  readonly stdio: Stdio.Stdio;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  // Test override; production uses MAX_INCOMING_MESSAGE_BYTES.
  readonly maxIncomingMessageBytes?: number;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly onNotification?: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly onRequest?: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly onTermination?: (error: CodexError.CodexAppServerError) => Effect.Effect<void, never>;
  readonly observeOwnedInput?: boolean;
}

export interface CodexOwnedInputObservation {
  readonly finishInput: Effect.Effect<void>;
  readonly providerInput: (
    timeout: Duration.Input,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly inputEOF: (
    timeout: Duration.Input,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly parserDispatch: (
    timeout: Duration.Input,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

export interface CodexAppServerPatchedProtocol {
  readonly ownedInput?: CodexOwnedInputObservation;
  readonly incomingNotifications: Stream.Stream<CodexAppServerIncomingNotification>;
  readonly incomingRequests: Stream.Stream<CodexAppServerIncomingRequest>;
  readonly request: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
  readonly notify: (
    method: string,
    payload?: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respond: (
    requestId: string | number,
    result: unknown,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly respondError: (
    requestId: string | number,
    error: CodexError.CodexAppServerRequestError,
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
}

interface CodexAppServerPendingRequest {
  readonly deferred: Deferred.Deferred<unknown, CodexError.CodexAppServerError>;
  readonly method: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingRequest(value: unknown): value is CodexAppServerIncomingRequest {
  if (!isObject(value) || typeof value.method !== "string") {
    return false;
  }
  return isJsonRpcId(value.id);
}

function isIncomingNotification(value: unknown): value is CodexAppServerIncomingNotification {
  return isObject(value) && typeof value.method === "string" && !("id" in value);
}

function isIncomingResponse(value: unknown): value is typeof JsonRpcResponseEnvelope.Type {
  return isJsonRpcResponseEnvelope(value);
}

const encodeJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const encodeWireMessage = (
  message: Record<string, unknown>,
): Effect.Effect<string, CodexError.CodexAppServerProtocolParseError> =>
  encodeJsonString(message).pipe(
    Effect.map((encoded) => `${encoded}\n`),
    Effect.mapError((cause) => {
      const method = typeof message.method === "string" ? message.method : undefined;
      const requestId =
        typeof message.id === "string" || typeof message.id === "number"
          ? String(message.id)
          : undefined;
      return CodexError.CodexAppServerProtocolParseError.fromSchemaError(
        "encode-wire-message",
        cause,
        {
          ...(method === undefined ? {} : { method }),
          ...(requestId === undefined ? {} : { requestId }),
        },
      );
    }),
  );

const decodeWireMessage = (
  line: string,
): Effect.Effect<unknown, CodexError.CodexAppServerProtocolParseError> =>
  decodeJsonString(line).pipe(
    Effect.mapError((cause) =>
      CodexError.CodexAppServerProtocolParseError.fromSchemaError("decode-wire-message", cause),
    ),
  );

const normalizeIncomingError = (
  error: unknown,
  operation: CodexError.CodexAppServerTransportOperation,
): CodexError.CodexAppServerError =>
  isCodexAppServerError(error)
    ? error
    : new CodexError.CodexAppServerTransportError({
        operation,
        cause: error,
      });

const toProtocolMessage = (
  requestId: string | number,
  fields: {
    readonly result?: unknown;
    readonly error?: CodexError.CodexAppServerProtocolErrorShape;
  },
): { readonly [key: string]: unknown } => ({
  id: requestId,
  ...(fields.result !== undefined ? { result: fields.result } : {}),
  ...(fields.error !== undefined ? { error: fields.error } : {}),
});

export const makeCodexAppServerPatchedProtocol = Effect.fn("makeCodexAppServerPatchedProtocol")(
  function* (
    options: CodexAppServerPatchedProtocolOptions,
  ): Effect.fn.Return<CodexAppServerPatchedProtocol, never, Scope.Scope> {
    const protocolScope = yield* Scope.Scope;
    const requestHandlerScope = yield* Scope.fork(protocolScope, "parallel");
    const outgoing = yield* Queue.unbounded<string, Cause.Done<void>>();
    const incomingNotifications =
      yield* Queue.sliding<CodexAppServerIncomingNotification>(MAX_BUFFERED_RAW_MESSAGES);
    const incomingRequests =
      yield* Queue.sliding<CodexAppServerIncomingRequest>(MAX_BUFFERED_RAW_MESSAGES);
    const pending = yield* Ref.make(new Map<string, CodexAppServerPendingRequest>());
    const nextRequestId = yield* Ref.make(1);
    const maxIncomingMessageBytes = options.maxIncomingMessageBytes ?? MAX_INCOMING_MESSAGE_BYTES;
    const remainder: Array<string> = [];
    let remainderBytes = 0;
    const terminationHandled = yield* Ref.make(false);
    const terminationFailure = yield* Ref.make(Option.none<CodexError.CodexAppServerError>());
    const terminationSignal = yield* Deferred.make<void>();
    const activeRequestHandlers = yield* Ref.make(0);
    const owned =
      options.observeOwnedInput === true
        ? {
            eof: Deferred.makeUnsafe<void, CodexError.CodexAppServerError>(),
            handlersDone: Deferred.makeUnsafe<void, CodexError.CodexAppServerError>(),
            parsed: Deferred.makeUnsafe<void, CodexError.CodexAppServerError>(),
            written: Deferred.makeUnsafe<void, CodexError.CodexAppServerError>(),
            failure: undefined as CodexError.CodexAppServerError | undefined,
            handlers: 0,
            readerFinished: false,
          }
        : undefined;
    const failOwned = (error: CodexError.CodexAppServerError) => {
      if (owned) {
        owned.failure ??= error;
        for (const deferred of [owned.handlersDone, owned.parsed])
          Deferred.doneUnsafe(deferred, Effect.fail(owned.failure));
      }
      return owned?.failure ?? error;
    };
    const ownedError = (stage: string, cause: unknown) =>
      failOwned(
        new CodexError.CodexAppServerTransportError({
          operation: "read-input-stream",
          cause: { stage, cause },
        }),
      );
    const awaitOwned = (
      deferred: Deferred.Deferred<void, CodexError.CodexAppServerError>,
      timeout: Duration.Input,
    ) =>
      Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.suspend(() => {
              const error = ownedError(
                "owned-input-deadline",
                "Unobserved input/parser completion",
              );
              Deferred.doneUnsafe(deferred, Effect.fail(error));
              return Effect.fail(error);
            }),
        }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            const error = ownedError("owned-input-interrupted", "Observation interrupted");
            Deferred.doneUnsafe(deferred, Effect.fail(error));
          }),
        ),
      );

    const logProtocol = (event: CodexAppServerProtocolLogEvent) => {
      if (event.direction === "incoming" && !options.logIncoming) {
        return Effect.void;
      }
      if (event.direction === "outgoing" && !options.logOutgoing) {
        return Effect.void;
      }
      return (
        options.logger?.(event) ??
        Effect.logDebug("Codex App Server protocol event").pipe(Effect.annotateLogs({ event }))
      );
    };

    const failAllPending = (error: CodexError.CodexAppServerError) =>
      Ref.get(pending).pipe(
        Effect.flatMap((current) =>
          Effect.forEach([...current.values()], ({ deferred }) => Deferred.fail(deferred, error), {
            discard: true,
          }),
        ),
        Effect.andThen(Ref.set(pending, new Map())),
      );

    const handleTermination = (classify: () => Effect.Effect<CodexError.CodexAppServerError>) =>
      Ref.modify(terminationHandled, (handled) => {
        if (handled) {
          return [Effect.void, true] as const;
        }
        return [
          Effect.gen(function* () {
            const error = yield* classify();
            yield* Ref.set(terminationFailure, Option.some(error));
            yield* failAllPending(error);
            yield* Queue.end(outgoing);
            yield* Deferred.succeed(terminationSignal, undefined);
            yield* Scope.close(requestHandlerScope, Exit.void).pipe(
              Effect.forkIn(protocolScope, { startImmediately: true }),
              Effect.asVoid,
            );
            if (options.onTermination) {
              yield* options.onTermination(error);
            }
          }),
          true,
        ] as const;
      }).pipe(Effect.flatten);

    const offerOutgoing =
      /* Every protocol write reaches this helper; request spans cover the operation. */
      Effect.fnUntraced(function* (message: Record<string, unknown>) {
        const failure = yield* Ref.get(terminationFailure);
        if (Option.isSome(failure)) return yield* failure.value;

        yield* logProtocol({
          direction: "outgoing",
          stage: "decoded",
          payload: message,
        });
        const encoded = yield* encodeWireMessage(message);
        yield* logProtocol({
          direction: "outgoing",
          stage: "raw",
          payload: encoded,
        });
        const accepted = yield* Queue.offer(outgoing, encoded);
        if (!accepted) {
          const closed = yield* Ref.get(terminationFailure);
          return yield* Option.getOrElse(
            closed,
            () => new CodexError.CodexAppServerInputStreamEndedError({}),
          );
        }
      });

    const removePending = (requestId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(requestId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(requestId);
        return next;
      });

    const resolvePending = (
      requestId: string,
      handler: (pendingRequest: CodexAppServerPendingRequest) => Effect.Effect<void>,
    ) =>
      Ref.modify(pending, (current) => {
        const pendingRequest = current.get(requestId);
        if (!pendingRequest) {
          return [Effect.void, current] as const;
        }
        const next = new Map(current);
        next.delete(requestId);
        return [handler(pendingRequest), next] as const;
      }).pipe(Effect.flatten);

    const respond = (requestId: string | number, result: unknown) =>
      offerOutgoing(toProtocolMessage(requestId, { result }));

    const respondError = (
      requestId: string | number,
      error: CodexError.CodexAppServerRequestError,
    ) => offerOutgoing(toProtocolMessage(requestId, { error: error.toProtocolError() }));

    const handleResponse = (response: typeof JsonRpcResponseEnvelope.Type) => {
      const requestId = String(response.id);
      const protocolError = response.error;
      if (protocolError !== undefined) {
        return resolvePending(requestId, ({ deferred, method }) =>
          Deferred.fail(
            deferred,
            CodexError.CodexAppServerRequestError.fromProtocolError(
              protocolError,
              method,
              requestId,
            ),
          ),
        );
      }
      return resolvePending(requestId, ({ deferred }) =>
        Deferred.succeed(deferred, response.result),
      );
    };

    const handleRequest = (request: CodexAppServerIncomingRequest) =>
      Queue.offer(incomingRequests, request).pipe(
        Effect.flatMap(() => {
          const handler = options.onRequest;
          if (!handler) return Effect.void;

          return Ref.modify(activeRequestHandlers, (count) =>
            count >= MAX_BUFFERED_RAW_MESSAGES ? [false, count] : [true, count + 1],
          ).pipe(
            Effect.flatMap((accepted) => {
              if (!accepted) {
                return respondError(
                  request.id,
                  CodexError.CodexAppServerRequestError.overloaded(
                    "Too many Codex requests are already active.",
                  ),
                );
              }

              const work = handler(request).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    failOwned(error);
                  }),
                ),
                Effect.matchEffect({
                  onFailure: (error) =>
                    respondError(
                      request.id,
                      CodexError.CodexAppServerRequestError.fromAppServerError(
                        error,
                        request.method,
                      ),
                    ),
                  onSuccess: (result) => respond(request.id, result),
                }),
                Effect.ensuring(
                  Ref.update(activeRequestHandlers, (count) => Math.max(0, count - 1)),
                ),
                Effect.catch((error) =>
                  handleTermination(() => Effect.succeed(error)).pipe(
                    Effect.forkIn(protocolScope),
                    Effect.asVoid,
                  ),
                ),
              );
              if (!owned)
                return work.pipe(
                  Effect.forkIn(requestHandlerScope, { startImmediately: true }),
                  Effect.asVoid,
                );
              return Effect.uninterruptible(
                Effect.gen(function* () {
                  owned.handlers++;
                  const fiber = yield* work.pipe(
                    Effect.interruptible,
                    Effect.forkIn(requestHandlerScope),
                  );
                  fiber.addObserver((exit) => {
                    owned.handlers--;
                    if (Exit.isFailure(exit)) ownedError("owned-handler-failed", exit.cause);
                    if (owned.readerFinished && owned.handlers === 0)
                      Deferred.doneUnsafe(owned.handlersDone, Effect.void);
                  });
                }),
              );
            }),
          );
        }),
        Effect.asVoid,
      );

    const handleNotification = (notification: CodexAppServerIncomingNotification) =>
      Queue.offer(incomingNotifications, notification).pipe(
        Effect.andThen(options.onNotification ? options.onNotification(notification) : Effect.void),
        // One bad notification costs the owned drain proof, not the reader or the turn.
        Effect.catch((error) => (owned ? Effect.sync(() => failOwned(error)) : Effect.fail(error))),
        Effect.asVoid,
      );

    const routeMessage = Effect.fnUntraced(function* (message: unknown) {
      if (Option.isSome(yield* Ref.get(terminationFailure))) return;
      if (isIncomingRequest(message)) return yield* handleRequest(message);
      if (isIncomingNotification(message)) return yield* handleNotification(message);
      if (isIncomingResponse(message)) return yield* handleResponse(message);
      return yield* CodexError.CodexAppServerProtocolParseError.fromUnroutableMessage(message);
    });

    const handleLine = (line: string): Effect.Effect<void, CodexError.CodexAppServerError> => {
      if (line.trim().length === 0) {
        return Effect.void;
      }
      return logProtocol({
        direction: "incoming",
        stage: "raw",
        payload: line,
      }).pipe(
        Effect.flatMap(() => decodeWireMessage(line)),
        Effect.tap((decoded) =>
          logProtocol({
            direction: "incoming",
            stage: "decoded",
            payload: decoded,
          }),
        ),
        Effect.tapErrorTag("CodexAppServerProtocolParseError", (error) =>
          logProtocol({
            direction: "incoming",
            stage: "decode_failed",
            payload: {
              operation: error.operation,
              ...(error.method === undefined ? {} : { method: error.method }),
              ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
              ...(error.issueCount === undefined ? {} : { issueCount: error.issueCount }),
              ...(error.issueKinds === undefined ? {} : { issueKinds: error.issueKinds }),
              ...(error.maximumPathDepth === undefined
                ? {}
                : { maximumPathDepth: error.maximumPathDepth }),
            },
          }),
        ),
        Effect.flatMap(routeMessage),
      );
    };

    const inputText = owned
      ? Stream.unwrap(
          Effect.sync(() => {
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const decode = (chunk?: Uint8Array) =>
              Effect.try({
                try: () =>
                  chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true }),
                catch: (cause) => ownedError("owned-input-utf8", cause),
              });
            return options.stdio.stdin.pipe(
              Stream.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Deferred.succeed(owned.eof, undefined)
                  : Effect.sync(() => {
                      const error = ownedError("owned-input-failed", exit.cause);
                      Deferred.doneUnsafe(owned.eof, Effect.fail(error));
                    }),
              ),
              Stream.mapEffect(decode),
              Stream.concat(Stream.fromEffect(decode())),
            );
          }),
        )
      : options.stdio.stdin.pipe(
          Stream.interruptWhen(Deferred.await(terminationSignal)),
          Stream.decodeText(),
        );
    yield* inputText.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (chunk) {
          let start = 0;
          while (start < chunk.length) {
            const newline = chunk.indexOf("\n", start);
            const fragment = chunk.slice(start, newline === -1 ? chunk.length : newline);
            // decodeText holds back split UTF-8 sequences, so fragment byte sums are exact.
            remainderBytes += Buffer.byteLength(fragment, "utf8");
            if (remainderBytes > maxIncomingMessageBytes) {
              remainder.length = 0;
              return yield* new CodexError.CodexAppServerTransportError({
                operation: "read-input-stream",
                cause: new Error(`Incoming message exceeded ${maxIncomingMessageBytes} bytes.`),
              });
            }
            remainder.push(fragment);
            if (newline === -1) break;
            const line = remainder.join("").replace(/\r$/, "");
            remainder.length = 0;
            remainderBytes = 0;
            yield* handleLine(line);
            start = newline + 1;
          }
        }),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          handleTermination(() =>
            Effect.succeed(failOwned(normalizeIncomingError(error, "read-input-stream"))),
          ),
        onSuccess: () =>
          Effect.sync(() => {
            const line = remainder.join("");
            remainder.length = 0;
            return line;
          }).pipe(
            Effect.flatMap(handleLine),
            Effect.matchEffect({
              onFailure: (error) => handleTermination(() => Effect.succeed(failOwned(error))),
              onSuccess: Effect.fn("CodexAppServerProtocol.settleOwnedReader")(function* () {
                if (owned) {
                  owned.readerFinished = true;
                  if (owned.handlers === 0) Deferred.doneUnsafe(owned.handlersDone, Effect.void);
                  yield* Deferred.await(owned.handlersDone);
                  if (owned.failure) return yield* owned.failure;
                }
                yield* handleTermination(() => {
                  const ended = new CodexError.CodexAppServerInputStreamEndedError({});
                  // Node ends stdout before it reports the exit of a crashed process, so
                  // wait briefly for the exit status. stdout can also close while the
                  // process keeps running, so the wait must not hang pending requests.
                  return options.terminationError === undefined
                    ? Effect.succeed(ended)
                    : options.terminationError.pipe(
                        Effect.timeoutOrElse({
                          duration: EXIT_STATUS_GRACE,
                          orElse: () => Effect.succeed(ended),
                        }),
                      );
                });
                if (owned) Deferred.doneUnsafe(owned.parsed, Effect.void);
              }),
            }),
          ),
      }),
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Effect.sync(() => {
              ownedError("owned-reader-interrupted", exit.cause);
            })
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(options.stdio.stdout()),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (!owned) return;
          if (Exit.isFailure(exit))
            Deferred.doneUnsafe(
              owned.written,
              Effect.fail(ownedError("owned-provider-input-failed", exit.cause)),
            );
          else Deferred.doneUnsafe(owned.written, Effect.void);
        }),
      ),
      Effect.forkScoped,
    );

    const request = Effect.fn("CodexAppServerProtocol.request")(function* (
      method: string,
      payload?: unknown,
    ) {
      const requestId = yield* Ref.modify(
        nextRequestId,
        (current) => [current, current + 1] as const,
      );
      const deferred = yield* Deferred.make<unknown, CodexError.CodexAppServerError>();
      yield* Ref.update(pending, (current) =>
        new Map(current).set(String(requestId), { deferred, method }),
      );
      yield* offerOutgoing({
        id: requestId,
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      }).pipe(Effect.tapError(() => removePending(String(requestId))));
      return yield* Deferred.await(deferred).pipe(
        Effect.onInterrupt(() => removePending(String(requestId))),
      );
    });

    const notify = (method: string, payload?: unknown) =>
      offerOutgoing({
        method,
        ...(payload !== undefined ? { params: payload } : {}),
      });

    return {
      ...(owned
        ? {
            ownedInput: {
              finishInput: Queue.end(outgoing).pipe(Effect.asVoid),
              providerInput: (timeout: Duration.Input) => awaitOwned(owned.written, timeout),
              inputEOF: (timeout: Duration.Input) => awaitOwned(owned.eof, timeout),
              parserDispatch: (timeout: Duration.Input) => awaitOwned(owned.parsed, timeout),
            },
          }
        : {}),
      incomingNotifications: Stream.fromQueue(incomingNotifications),
      incomingRequests: Stream.fromQueue(incomingRequests),
      request,
      notify,
      respond,
      respondError,
    } satisfies CodexAppServerPatchedProtocol;
  },
);
