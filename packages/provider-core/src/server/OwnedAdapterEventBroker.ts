import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

declare const generationBrand: unique symbol;
declare const leaseBrand: unique symbol;
declare const fenceBrand: unique symbol;
declare const proofBrand: unique symbol;

export interface OwnedEventGeneration {
  readonly [generationBrand]: true;
}
export interface OwnedEventProducer {
  readonly [leaseBrand]: true;
}
export interface OwnedEventFence {
  readonly [fenceBrand]: true;
}
// Handler-completed prefix only; never process/input/parser/writer cessation or acceptance.
export interface OwnedEventPrefixProof {
  readonly [proofBrand]: true;
}

export class OwnedEventDrainUnknown extends Schema.TaggedError<OwnedEventDrainUnknown>()(
  "OwnedEventDrainUnknown",
  {
    reason: Schema.Literals([
      "unknownGeneration",
      "transportMismatch",
      "transportAlreadyBound",
      "rootsClosed",
      "staleProducer",
      "producerFailed",
      "joinWhileProducing",
      "rootsStillOpen",
      "producerTimeout",
      "postSealEmission",
      "consumerMissing",
      "consumerAlreadyDesignated",
      "consumerStopped",
      "handlerFailed",
      "ackTimeout",
      "ackInterrupted",
      "fenceMismatch",
      "unknownProof",
      "sequenceOverflow",
      "internalFailure",
    ]),
  },
) {}

const isOwnedEventDrainUnknown = Schema.is(OwnedEventDrainUnknown);

export interface OwnedEventDeadline {
  readonly timeout: Duration.Input;
}

export interface OwnedAdapterEventConsumer<A> {
  readonly started: Effect.Effect<void, OwnedEventDrainUnknown>;
  readonly consume: <E, R>(
    handler: (event: A) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<never, E | OwnedEventDrainUnknown, R>;
  readonly awaitPrefix: (
    generation: OwnedEventGeneration,
    fence: OwnedEventFence,
    deadline: OwnedEventDeadline,
  ) => Effect.Effect<OwnedEventPrefixProof, OwnedEventDrainUnknown>;
  readonly inspect: (
    generation: OwnedEventGeneration,
    fence: OwnedEventFence,
    proof: OwnedEventPrefixProof,
  ) => Effect.Effect<{ readonly highWater: number }, OwnedEventDrainUnknown>;
}

export interface OwnedAdapterEventBroker<A> {
  readonly bindTransport: (
    transport: object,
  ) => Effect.Effect<OwnedEventGeneration, OwnedEventDrainUnknown>;
  readonly withProducer: <B, E, R>(
    generation: OwnedEventGeneration,
    use: (producer: OwnedEventProducer) => Effect.Effect<B, E, R>,
  ) => Effect.Effect<B, E | OwnedEventDrainUnknown, R>;
  readonly continueProducer: <B, E, R>(
    parent: OwnedEventProducer,
    use: (producer: OwnedEventProducer) => Effect.Effect<B, E, R>,
  ) => Effect.Effect<B, E | OwnedEventDrainUnknown, R>;
  readonly forkProducer: <B, E, R>(
    parent: OwnedEventProducer,
    use: (producer: OwnedEventProducer) => Effect.Effect<B, E, R>,
  ) => Effect.Effect<
    Fiber.Fiber<B, E | OwnedEventDrainUnknown>,
    OwnedEventDrainUnknown,
    R | Scope.Scope
  >;
  readonly emit: (
    producer: OwnedEventProducer,
    event: A,
  ) => Effect.Effect<void, OwnedEventDrainUnknown>;
  readonly closeRoots: (
    generation: OwnedEventGeneration,
  ) => Effect.Effect<void, OwnedEventDrainUnknown>;
  readonly seal: (
    generation: OwnedEventGeneration,
    transport: object,
    deadline: OwnedEventDeadline,
  ) => Effect.Effect<OwnedEventFence, OwnedEventDrainUnknown>;
  readonly invalidate: (
    generation: OwnedEventGeneration,
  ) => Effect.Effect<void, OwnedEventDrainUnknown>;
  readonly designateConsumer: Effect.Effect<OwnedAdapterEventConsumer<A>, OwnedEventDrainUnknown>;
}

interface GenerationState {
  readonly transport: object;
  readonly leases: Set<OwnedEventProducer>;
  readonly idle: Deferred.Deferred<void, OwnedEventDrainUnknown>;
  closing: boolean;
  sealed: boolean;
  produced: number;
  fault: OwnedEventDrainUnknown | undefined;
  fence: FenceState | undefined;
}
interface LeaseState {
  readonly generation: GenerationState;
  active: boolean;
}
interface ConsumerState {
  readonly started: Deferred.Deferred<void, OwnedEventDrainUnknown>;
  running: boolean;
  used: boolean;
  stopped: boolean;
  readonly handled: Map<GenerationState, number>;
}
interface FenceState {
  readonly token: OwnedEventFence;
  readonly generation: GenerationState;
  readonly consumer: ConsumerState;
  readonly highWater: number;
  readonly ack: Deferred.Deferred<void, OwnedEventDrainUnknown>;
  acknowledged: boolean;
}

const CurrentProducers = Context.Reference<ReadonlyArray<OwnedEventProducer>>(
  "t3/provider-core/OwnedAdapterEventBroker/CurrentProducers",
  { defaultValue: () => [] },
);

// All state transitions and unbounded queue offers stay in synchronous atomic sections.
export const make = Effect.fn("OwnedAdapterEventBroker.make")(function* <A>(): Effect.fn.Return<
  OwnedAdapterEventBroker<A>
> {
  type Entry =
    | {
        readonly kind: "event";
        readonly generation: GenerationState;
        readonly sequence: number;
        readonly event: A;
      }
    | { readonly kind: "fence"; readonly fence: FenceState };
  const queue = yield* Queue.unbounded<Entry>();
  const generations = new WeakMap<OwnedEventGeneration, GenerationState>();
  const transports = new WeakMap<object, OwnedEventGeneration>();
  const leases = new WeakMap<OwnedEventProducer, LeaseState>();
  const fences = new WeakMap<OwnedEventFence, FenceState>();
  const proofs = new WeakMap<OwnedEventPrefixProof, FenceState>();
  const states = new Set<GenerationState>();
  let consumer: ConsumerState | undefined;

  const fault = (state: GenerationState, reason: OwnedEventDrainUnknown["reason"]) => {
    state.fault ??= new OwnedEventDrainUnknown({ reason });
    states.delete(state);
    Deferred.doneUnsafe(state.idle, Effect.fail(state.fault));
    if (state.fence && !state.fence.acknowledged)
      Deferred.doneUnsafe(state.fence.ack, Effect.fail(state.fault));
    return state.fault;
  };
  const requireGeneration = (token: OwnedEventGeneration) => {
    const state = generations.get(token);
    if (!state) throw new OwnedEventDrainUnknown({ reason: "unknownGeneration" });
    if (state.fault) throw state.fault;
    return state;
  };
  const requireProducer = (token: OwnedEventProducer) => {
    const lease = leases.get(token);
    if (!lease) throw new OwnedEventDrainUnknown({ reason: "staleProducer" });
    if (lease.generation.sealed) throw fault(lease.generation, "postSealEmission");
    if (lease.generation.fault) throw lease.generation.fault;
    if (!lease.active) throw fault(lease.generation, "staleProducer");
    return lease;
  };
  const atomic = <B>(body: () => B) =>
    Effect.try({
      try: body,
      catch: (error) =>
        isOwnedEventDrainUnknown(error)
          ? error
          : new OwnedEventDrainUnknown({ reason: "internalFailure" }),
    });
  const reserve = (state: GenerationState) => {
    const token = Object.freeze({}) as OwnedEventProducer;
    state.leases.add(token);
    leases.set(token, { generation: state, active: true });
    return token;
  };
  const finish = (token: OwnedEventProducer, success: boolean) => {
    const lease = leases.get(token)!;
    lease.active = false;
    lease.generation.leases.delete(token);
    if (!success) fault(lease.generation, "producerFailed");
    if (lease.generation.closing && lease.generation.leases.size === 0)
      Deferred.doneUnsafe(lease.generation.idle, Effect.void);
  };
  const runProducer = Effect.fn("OwnedAdapterEventBroker.runProducer")(function* <B, E, R>(
    token: OwnedEventProducer,
    use: (producer: OwnedEventProducer) => Effect.Effect<B, E, R>,
  ) {
    const parents = yield* CurrentProducers;
    return yield* Effect.suspend(() => use(token)).pipe(
      Effect.provideService(CurrentProducers, [...parents, token]),
    );
  });
  const stopConsumer = (state: ConsumerState) => {
    state.running = false;
    state.stopped = true;
    for (const generation of states)
      if (!generation.fence?.acknowledged) fault(generation, "handlerFailed");
  };

  return {
    bindTransport: Effect.fn("OwnedAdapterEventBroker.bindTransport")(function (transport) {
      return atomic(() => {
        if (typeof transport !== "object" || transport === null || transports.has(transport))
          throw new OwnedEventDrainUnknown({ reason: "transportAlreadyBound" });
        if (consumer?.stopped) throw new OwnedEventDrainUnknown({ reason: "consumerStopped" });
        const token = Object.freeze({}) as OwnedEventGeneration;
        const state: GenerationState = {
          transport,
          leases: new Set(),
          idle: Deferred.makeUnsafe(),
          closing: false,
          sealed: false,
          produced: 0,
          fault: undefined,
          fence: undefined,
        };
        generations.set(token, state);
        transports.set(transport, token);
        states.add(state);
        return token;
      });
    }),
    withProducer: Effect.fn("OwnedAdapterEventBroker.withProducer")(function* (generation, use) {
      return yield* Effect.acquireUseRelease(
        atomic(() => {
          const state = requireGeneration(generation);
          if (state.closing) throw new OwnedEventDrainUnknown({ reason: "rootsClosed" });
          return reserve(state);
        }),
        (token) => runProducer(token, use),
        (token, exit) => Effect.sync(() => finish(token, Exit.isSuccess(exit))),
      );
    }),
    continueProducer: Effect.fn("OwnedAdapterEventBroker.continueProducer")(
      function* (parent, use) {
        return yield* Effect.acquireUseRelease(
          atomic(() => reserve(requireProducer(parent).generation)),
          (token) => runProducer(token, use),
          (token, exit) => Effect.sync(() => finish(token, Exit.isSuccess(exit))),
        );
      },
    ),
    forkProducer: Effect.fn("OwnedAdapterEventBroker.forkProducer")(function* (parent, use) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const token = yield* atomic(() => reserve(requireProducer(parent).generation));
          const fiber = yield* runProducer(token, use).pipe(
            Effect.interruptible,
            Effect.forkScoped,
          );
          // A fiber can exit before its first instruction; observe exit before exposing it.
          fiber.addObserver((exit) => finish(token, Exit.isSuccess(exit)));
          return fiber;
        }),
      );
    }),
    emit: Effect.fn("OwnedAdapterEventBroker.emit")(function (producer, event) {
      return atomic(() => {
        const generation = requireProducer(producer).generation;
        if (generation.produced === Number.MAX_SAFE_INTEGER)
          throw fault(generation, "sequenceOverflow");
        Queue.offerUnsafe(queue, {
          kind: "event",
          generation,
          sequence: ++generation.produced,
          event,
        });
      });
    }),
    closeRoots: Effect.fn("OwnedAdapterEventBroker.closeRoots")(function (generation) {
      return atomic(() => {
        const state = requireGeneration(generation);
        state.closing = true;
        if (state.leases.size === 0) Deferred.doneUnsafe(state.idle, Effect.void);
      });
    }),
    seal: Effect.fn("OwnedAdapterEventBroker.seal")(function* (generation, transport, deadline) {
      const current = yield* CurrentProducers;
      const state = yield* atomic(() => {
        const value = requireGeneration(generation);
        if (value.transport !== transport) throw fault(value, "transportMismatch");
        if (!value.closing) throw new OwnedEventDrainUnknown({ reason: "rootsStillOpen" });
        if (
          current.some(
            (producer) =>
              leases.get(producer)?.generation === value && leases.get(producer)?.active,
          )
        )
          throw fault(value, "joinWhileProducing");
        if (!consumer?.running || consumer.stopped) throw fault(value, "consumerMissing");
        return value;
      });
      yield* Deferred.await(state.idle).pipe(
        Effect.timeout(deadline.timeout),
        Effect.mapError(() => fault(state, "producerTimeout")),
      );
      return yield* atomic(() => {
        if (state.fault) throw state.fault;
        if (!consumer?.running || consumer.stopped) throw fault(state, "consumerMissing");
        if (state.fence) return state.fence.token;
        state.sealed = true;
        const token = Object.freeze({}) as OwnedEventFence;
        const fence: FenceState = {
          token,
          generation: state,
          consumer,
          highWater: state.produced,
          ack: Deferred.makeUnsafe(),
          acknowledged: false,
        };
        state.fence = fence;
        fences.set(token, fence);
        Queue.offerUnsafe(queue, { kind: "fence", fence });
        return token;
      });
    }),
    invalidate: Effect.fn("OwnedAdapterEventBroker.invalidate")(function (generation) {
      return atomic(() => {
        fault(requireGeneration(generation), "producerFailed");
      });
    }),
    designateConsumer: atomic(() => {
      if (consumer) throw new OwnedEventDrainUnknown({ reason: "consumerAlreadyDesignated" });
      const state: ConsumerState = {
        started: Deferred.makeUnsafe(),
        running: false,
        used: false,
        stopped: false,
        handled: new Map(),
      };
      consumer = state;
      return {
        started: Deferred.await(state.started),
        consume: Effect.fn("OwnedAdapterEventBroker.consume")(function* (handler) {
          return yield* Effect.acquireUseRelease(
            atomic(() => {
              if (state.used) throw new OwnedEventDrainUnknown({ reason: "consumerStopped" });
              state.used = true;
              state.running = true;
              Deferred.doneUnsafe(state.started, Effect.void);
            }),
            () =>
              Effect.gen(function* () {
                for (;;) {
                  const entry = yield* Queue.take(queue);
                  if (entry.kind === "event") {
                    yield* Effect.uninterruptibleMask((restore) =>
                      restore(handler(entry.event)).pipe(
                        Effect.andThen(
                          Effect.sync(() => {
                            state.handled.set(entry.generation, entry.sequence);
                          }),
                        ),
                      ),
                    );
                  } else {
                    yield* atomic(() => {
                      const fence = entry.fence;
                      if (fence.generation.fault) return;
                      if (
                        fence.consumer !== state ||
                        (state.handled.get(fence.generation) ?? 0) !== fence.highWater
                      )
                        throw fault(fence.generation, "fenceMismatch");
                      fence.acknowledged = true;
                      states.delete(fence.generation);
                      state.handled.delete(fence.generation);
                      Deferred.doneUnsafe(fence.ack, Effect.void);
                    });
                  }
                }
              }),
            () => Effect.sync(() => stopConsumer(state)),
          );
        }),
        awaitPrefix: Effect.fn("OwnedAdapterEventBroker.awaitPrefix")(
          function* (generation, token, deadline) {
            const fence = yield* atomic(() => {
              const value = requireGeneration(generation);
              const saved = fences.get(token);
              if (!saved || saved.generation !== value || saved.consumer !== state)
                throw fault(value, "fenceMismatch");
              return saved;
            });
            yield* Deferred.await(fence.ack).pipe(
              Effect.timeout(deadline.timeout),
              Effect.mapError(() => fault(fence.generation, "ackTimeout")),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      fault(fence.generation, "ackInterrupted");
                    })
                  : Effect.void,
              ),
            );
            return yield* atomic(() => {
              if (fence.generation.fault) throw fence.generation.fault;
              if (!fence.acknowledged) throw fault(fence.generation, "fenceMismatch");
              const proof = Object.freeze({}) as OwnedEventPrefixProof;
              proofs.set(proof, fence);
              return proof;
            });
          },
        ),
        inspect: Effect.fn("OwnedAdapterEventBroker.inspect")(function (generation, token, proof) {
          return atomic(() => {
            const fence = proofs.get(proof);
            if (
              !fence ||
              fence.consumer !== state ||
              fence.generation !== requireGeneration(generation) ||
              fence.token !== token
            )
              throw new OwnedEventDrainUnknown({ reason: "unknownProof" });
            if (fence.generation.fault) throw fence.generation.fault;
            return { highWater: fence.highWater };
          });
        }),
      } satisfies OwnedAdapterEventConsumer<A>;
    }),
  } satisfies OwnedAdapterEventBroker<A>;
});
