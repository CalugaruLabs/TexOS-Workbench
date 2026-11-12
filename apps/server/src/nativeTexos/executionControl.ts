import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  EXECUTION_CAPABILITY,
  MANAGED_EXECUTION_CAPABILITY,
  answerPage,
  decodeNativeAuthorization,
  executionEnvelope,
  type ExecutionChannelBinding,
  type ExecutionHostRequest,
  type ExecutionIntent,
  type ExecutionAuthorizationRequest,
} from "./executionProtocol.ts";
import * as Receipts from "./executionReceipts.ts";
import { validateExecutionWorktree } from "./executionWorktree.ts";
import { ManagedExecutionProvider } from "./executionManaged.ts";

export class ExecutionControlError extends Schema.TaggedError<ExecutionControlError>()(
  "ExecutionControlError",
  { code: Schema.String },
) {}

const isExecutionControlError = Schema.is(ExecutionControlError);

export type NativeStartAuthorizer = (
  input: ExecutionAuthorizationRequest["params"],
  signal: AbortSignal,
) => Promise<unknown>;

export interface ControlledExecutionAttempt {
  /** A drained run reports how it ended and its answer; without both it is uncertain. */
  readonly run: Effect.Effect<
    {
      readonly mappings: Receipts.ExecutionMappings;
      readonly drained: boolean;
      readonly finish?: Receipts.ExecutionFinish;
    },
    ExecutionControlError
  >;
  readonly stop: Effect.Effect<void, ExecutionControlError>;
}

// No production layer: the only implementation in this packet is an injected protocol fixture.
export class ControlledExecutionProvider extends Context.Service<
  ControlledExecutionProvider,
  {
    readonly mode: "controlled-codex";
    readonly create: (
      receipt: Receipts.ExecutionReceipt,
      beforeProviderStart: Effect.Effect<void, ExecutionControlError>,
      recordMappings: (
        patch: Receipts.ExecutionMappings,
      ) => Effect.Effect<void, ExecutionControlError>,
    ) => Effect.Effect<ControlledExecutionAttempt, ExecutionControlError>;
  }
>()("t3/nativeTexos/executionControl/ControlledExecutionProvider") {}

export function executionReceiptView(receipt: Receipts.ExecutionReceipt) {
  return {
    commandID: receipt.intent.commandID,
    canonicalRunID: receipt.intent.canonicalRunID,
    canonicalAttemptID: receipt.intent.canonicalAttemptID,
    workerRequestID: receipt.intent.workerRequestID,
    envelopeDigest: receipt.envelopeDigest,
    runtimeID: receipt.runtimeID,
    childID: receipt.childID,
    t3ThreadID: receipt.t3ThreadID,
    t3ProviderSessionID: receipt.t3ProviderSessionID,
    phase: receipt.phase,
    mappings: receipt.mappings,
    drained: receipt.drained,
    outcome: receipt.finish?.outcome ?? null,
    reconciliationRequired: receipt.phase === "uncertain",
  };
}

const stoppedBeforeStart: Receipts.ExecutionFinish = {
  outcome: "interrupted",
  answer: { text: "", truncated: false },
};

type ReceiptView = ReturnType<typeof executionReceiptView>;
export type ExecutionControlResult =
  | ReceiptView
  | (ReceiptView & { readonly answer: ReturnType<typeof answerPage> })
  | { readonly capabilities: readonly string[]; readonly runtimeID?: string }
  | {
      readonly commandID: string;
      readonly phase: "unknown";
      readonly reconciliationRequired: true;
    };

export class ExecutionControl extends Context.Service<
  ExecutionControl,
  {
    readonly handle: (
      request: ExecutionHostRequest,
      authorize?: NativeStartAuthorizer,
    ) => Effect.Effect<ExecutionControlResult, ExecutionControlError>;
    readonly awaitAttempt: (commandID: string) => Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
  }
>()("t3/nativeTexos/executionControl") {}

interface LiveAttempt {
  receipt: Receipts.ExecutionReceipt;
  stopRequested: boolean;
  factoryEntered: boolean;
  attempt: ControlledExecutionAttempt | undefined;
  fiber: Fiber.Fiber<void, never> | undefined;
}

export const makeExecutionControl = Effect.fn("ExecutionControl.make")(function* (
  expectedBinding: ExecutionChannelBinding,
) {
  const binding = Object.freeze({ ...expectedBinding });
  const receipts = yield* Receipts.ExecutionReceipts;
  const providerOption = yield* Effect.serviceOption(ControlledExecutionProvider);
  const controlled = Option.getOrUndefined(providerOption);
  const managed = Option.getOrUndefined(yield* Effect.serviceOption(ManagedExecutionProvider));
  const provider = controlled && managed ? undefined : (controlled ?? managed);
  const available =
    provider !== undefined && (provider.mode === "controlled-codex" || provider.available);
  const capability =
    provider?.mode === "controlled-codex" ? EXECUTION_CAPABILITY : MANAGED_EXECUTION_CAPABILITY;
  const scope = yield* Scope.Scope;
  const permit = yield* Semaphore.make(1);
  const live = new Map<string, LiveAttempt>();
  let closed = false;
  // Calling makeExecutionControl activates receipt recovery; provider construction alone does not.
  yield* receipts.recoverInterrupted;

  const current = Effect.fn("ExecutionControl.current")(function* (item: LiveAttempt) {
    const saved = yield* receipts.get(
      item.receipt.intent.commandID,
      item.receipt.envelopeDigest,
      binding.authorityID,
    );
    if (!saved) return yield* new ExecutionControlError({ code: "missingExecutionReceipt" });
    item.receipt = saved;
    return saved;
  });

  const gate = Effect.fn("ExecutionControl.authorizeStart")(
    function* (item: LiveAttempt, authorize: NativeStartAuthorizer) {
      if (closed || item.stopRequested)
        return yield* new ExecutionControlError({ code: "executionStopped" });
      const receipt = yield* current(item);
      if (!["starting", "running"].includes(receipt.phase))
        return yield* new ExecutionControlError({ code: "executionUncertain" });
      const providerThreadID = receipt.mappings.providerThreadID;
      const nativeThreadID = receipt.mappings.nativeThreadID;
      if ((providerThreadID === undefined) !== (nativeThreadID === undefined)) {
        return yield* new ExecutionControlError({ code: "executionThreadMappingIncomplete" });
      }
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          authorize(
            {
              commandID: receipt.intent.commandID,
              canonicalRunID: receipt.intent.canonicalRunID,
              envelopeDigest: receipt.envelopeDigest,
              runtimeID: receipt.runtimeID,
              childID: receipt.childID,
              t3ThreadID: receipt.t3ThreadID,
              t3ProviderSessionID: receipt.t3ProviderSessionID,
              ...(providerThreadID === undefined || nativeThreadID === undefined
                ? {}
                : { providerThreadID, nativeThreadID }),
            },
            signal,
          ),
        catch: () => new ExecutionControlError({ code: "nativeAuthorizationUnavailable" }),
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(
          () => new ExecutionControlError({ code: "nativeAuthorizationUnavailable" }),
        ),
      );
      const decision = yield* Effect.try({
        try: () => decodeNativeAuthorization(result),
        catch: () => new ExecutionControlError({ code: "nativeAuthorizationDenied" }),
      });
      const now = yield* Clock.currentTimeMillis;
      if (
        closed ||
        item.stopRequested ||
        decision.outcome !== "allow" ||
        decision.revoked ||
        !decision.noNewCharges ||
        decision.commandID !== receipt.intent.commandID ||
        decision.canonicalRunID !== receipt.intent.canonicalRunID ||
        decision.envelopeDigest !== receipt.envelopeDigest ||
        decision.expiresAtMs <= now ||
        decision.runtimeID !== receipt.runtimeID ||
        decision.childID !== receipt.childID ||
        decision.accountBindingGeneration !==
          receipt.intent.configuration.accountBindingGeneration ||
        BigInt(decision.currentConfigurationRevision) <
          BigInt(receipt.intent.configuration.revision) ||
        Object.values(decision.checks).some((check) => check !== "qualified")
      ) {
        return yield* new ExecutionControlError({ code: "nativeAuthorizationDenied" });
      }
      yield* validateExecutionWorktree(receipt.intent.worktree);
    },
    Effect.mapError((error) =>
      isExecutionControlError(error)
        ? error
        : new ExecutionControlError({ code: "executionStartDenied" }),
    ),
  );

  const run = Effect.fn("ExecutionControl.run")(
    function* (item: LiveAttempt, authorize: NativeStartAuthorizer) {
      const starting = yield* permit.withPermit(
        Effect.gen(function* () {
          const saved = yield* current(item);
          if (item.stopRequested || closed) {
            if (saved.phase === "stopping")
              item.receipt = yield* receipts.transition(saved, "stopped", {}, stoppedBeforeStart);
            return false;
          }
          item.receipt = yield* receipts.transition(saved, "starting");
          return true;
        }),
      );
      if (!starting) return;
      yield* gate(item, authorize);
      if (!provider || !available)
        return yield* new ExecutionControlError({ code: "executionUnavailable" });
      const recordMappings = Effect.fn("ExecutionControl.recordMappings")(
        function* (patch: Receipts.ExecutionMappings) {
          yield* permit.withPermit(
            Effect.gen(function* () {
              const saved = yield* current(item);
              if (saved.phase !== "running" && saved.phase !== "stopping")
                return yield* new ExecutionControlError({ code: "executionUncertain" });
              item.receipt = yield* receipts.transition(saved, saved.phase, patch);
            }),
          );
        },
        Effect.mapError(() => new ExecutionControlError({ code: "executionMappingRefused" })),
      );
      item.factoryEntered = true;
      item.attempt = yield* provider.create(item.receipt, gate(item, authorize), recordMappings);
      yield* permit.withPermit(
        Effect.gen(function* () {
          if (closed || item.stopRequested)
            return yield* new ExecutionControlError({ code: "executionStopped" });
          item.receipt = yield* receipts.transition(yield* current(item), "running");
        }),
      );
      yield* gate(item, authorize);
      const outcome = yield* item.attempt.run;
      yield* permit.withPermit(
        Effect.gen(function* () {
          const latest = yield* current(item);
          if (latest.phase === "uncertain") return;
          const finish = outcome.drained ? outcome.finish : undefined;
          item.receipt = yield* receipts.transition(
            latest,
            finish ? (latest.phase === "stopping" ? "stopped" : "attemptFinished") : "uncertain",
            outcome.mappings,
            finish,
          );
        }),
      );
    },
    (effect, item) =>
      effect.pipe(
        Effect.catchCause(() =>
          permit
            .withPermit(
              Effect.gen(function* () {
                const saved = yield* current(item);
                if (["attemptFinished", "stopped", "denied", "uncertain"].includes(saved.phase))
                  return;
                const phase = item.factoryEntered
                  ? "uncertain"
                  : item.stopRequested
                    ? "stopped"
                    : "denied";
                const predecessor =
                  phase === "stopped" && saved.phase !== "stopping"
                    ? yield* receipts.transition(saved, "stopping")
                    : saved;
                item.receipt = yield* receipts.transition(
                  predecessor,
                  phase,
                  {},
                  phase === "stopped" ? stoppedBeforeStart : undefined,
                );
              }),
            )
            .pipe(Effect.ignore),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (item.receipt.phase !== "uncertain" || !item.factoryEntered)
              live.delete(item.receipt.intent.commandID);
          }),
        ),
      ),
  );

  const handle = Effect.fn("ExecutionControl.handle")(
    function* (
      request: ExecutionHostRequest,
      authorize?: NativeStartAuthorizer,
    ): Effect.fn.Return<
      ExecutionControlResult,
      ExecutionControlError | Receipts.ExecutionReceiptError
    > {
      if (
        closed ||
        request.authorityID !== binding.authorityID ||
        request.hostID !== binding.hostID ||
        request.hostGeneration !== binding.hostGeneration
      ) {
        return yield* new ExecutionControlError({ code: "staleExecutionAuthority" });
      }
      if (request.method === "execution.hello")
        return available && authorize
          ? { capabilities: [capability], runtimeID: receipts.runtimeID }
          : { capabilities: [] };
      if (request.method !== "execution.admit") {
        const saved = yield* receipts.get(
          request.params.commandID,
          request.params.envelopeDigest,
          binding.authorityID,
        );
        if (!saved)
          return {
            commandID: request.params.commandID,
            phase: "unknown",
            reconciliationRequired: true,
          };
        if (
          request.method === "execution.stop" &&
          ["admitted", "starting", "running", "stopping", "uncertain"].includes(saved.phase)
        ) {
          const item = live.get(saved.intent.commandID);
          if (!item)
            return executionReceiptView(
              saved.phase === "uncertain" ? saved : yield* receipts.transition(saved, "uncertain"),
            );
          item.stopRequested = true;
          if (saved.phase !== "stopping" && saved.phase !== "uncertain")
            item.receipt = yield* receipts.transition(saved, "stopping");
          if (item.attempt)
            yield* item.attempt.stop.pipe(
              Effect.timeout("1 second"),
              Effect.ignore,
              Effect.forkIn(scope),
            );
          return executionReceiptView(item.receipt);
        }
        if (request.method === "execution.reconcile") {
          if (live.has(saved.intent.commandID))
            return yield* new ExecutionControlError({ code: "executionNotAbandonable" });
          return executionReceiptView(
            yield* receipts.abandon(
              saved.intent.commandID,
              saved.envelopeDigest,
              binding.authorityID,
              binding.hostGeneration,
            ),
          );
        }
        if (request.method === "execution.status") {
          const text =
            saved.finish?.answer.text ??
            (provider?.mode === "managed-cli-subscription"
              ? provider.answer(saved.intent.commandID)
              : undefined) ??
            "";
          return {
            ...executionReceiptView(saved),
            answer: answerPage(
              text,
              request.params.textOffset ?? 0,
              saved.finish !== undefined,
              saved.finish?.answer.truncated ?? false,
            ),
          };
        }
        return executionReceiptView(saved);
      }
      const envelope = yield* Effect.try({
        try: () => executionEnvelope(request.params),
        catch: () => new ExecutionControlError({ code: "invalidExecutionIntent" }),
      });
      const intent: ExecutionIntent = envelope.intent;
      if (
        intent.scope.authorityID !== binding.authorityID ||
        intent.scope.hostID !== binding.hostID
      )
        return yield* new ExecutionControlError({ code: "executionScopeMismatch" });
      const existing = yield* receipts.get(intent.commandID, envelope.digest, binding.authorityID);
      if (existing) return executionReceiptView(existing);
      if (!provider || !available || !authorize)
        return yield* new ExecutionControlError({ code: "executionUnavailable" });
      if (provider.mode === "controlled-codex" && intent.configuration.provider !== "codex")
        return yield* new ExecutionControlError({ code: "claudeCompletionUnsupported" });
      if (
        provider.mode === "managed-cli-subscription" &&
        !provider.supports(intent.configuration.provider)
      )
        return yield* new ExecutionControlError({ code: "managedRouteUnavailable" });
      if (live.size !== 0 || (yield* receipts.hasUnresolved))
        return yield* new ExecutionControlError({ code: "executionCapacityOccupied" });
      const admitted = yield* receipts.admit(intent, binding.hostGeneration);
      if (!admitted.created) return executionReceiptView(admitted.receipt);
      const item: LiveAttempt = {
        receipt: admitted.receipt,
        stopRequested: false,
        factoryEntered: false,
        attempt: undefined,
        fiber: undefined,
      };
      live.set(intent.commandID, item);
      item.fiber = yield* run(item, authorize).pipe(Effect.forkIn(scope));
      return executionReceiptView(admitted.receipt);
    },
    (effect) => permit.withPermit(effect),
    Effect.mapError((error) =>
      isExecutionControlError(error) ? error : new ExecutionControlError({ code: error.code }),
    ),
  );

  const disconnect = Effect.gen(function* () {
    closed = true;
    for (const item of live.values()) {
      item.stopRequested = true;
      yield* permit
        .withPermit(
          Effect.gen(function* () {
            const saved = yield* current(item).pipe(Effect.orElseSucceed(() => undefined));
            if (saved && ["admitted", "starting", "running", "stopping"].includes(saved.phase)) {
              item.receipt = yield* receipts.transition(saved, "uncertain");
            }
          }),
        )
        .pipe(Effect.ignore);
      if (item.attempt) yield* item.attempt.stop.pipe(Effect.timeout("1 second"), Effect.ignore);
      if (item.fiber) yield* Fiber.interrupt(item.fiber);
    }
  }).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => disconnect);
  return ExecutionControl.of({
    handle,
    awaitAttempt: Effect.fn("ExecutionControl.awaitAttempt")(function* (commandID) {
      const fiber = live.get(commandID)?.fiber;
      if (fiber) yield* Fiber.await(fiber);
    }),
    disconnect,
  });
});
