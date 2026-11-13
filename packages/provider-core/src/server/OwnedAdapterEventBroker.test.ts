import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Broker from "@t3tools/provider-core/server/OwnedAdapterEventBroker";

const deadline = { timeout: "1 second" } as const;

const fixture = Effect.fn("OwnedEventBrokerTest.fixture")(function* () {
  const broker = yield* Broker.make<string>();
  const transport = Object.freeze({ ownedPipe: Object.freeze({}) });
  const generation = yield* broker.bindTransport(transport);
  const consumer = yield* broker.designateConsumer;
  const received: string[] = [];
  const pump = yield* consumer
    .consume((event) =>
      Effect.sync(() => {
        received.push(event);
      }),
    )
    .pipe(Effect.forkScoped);
  yield* consumer.started;
  return { broker, transport, generation, consumer, received, pump };
});

describe("owned adapter event prefix", () => {
  it.effect("a second consume attempt cannot take over or stop the designated handler", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.equal(
        (yield* f.broker.designateConsumer.pipe(Effect.flip)).reason,
        "consumerAlreadyDesignated",
      );
      let replacementCalls = 0;
      const error = yield* f.consumer
        .consume(() =>
          Effect.sync(() => {
            replacementCalls++;
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error.reason, "consumerStopped");
      yield* f.broker.withProducer(f.generation, (producer) => f.broker.emit(producer, "original"));
      yield* f.broker.closeRoots(f.generation);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(f.generation, fence, proof), { highWater: 1 });
      assert.deepEqual(f.received, ["original"]);
      assert.equal(replacementCalls, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancellation at consumer startup closes admission and cannot be restarted", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      const generation = yield* broker.bindTransport({});
      const consumer = yield* broker.designateConsumer;
      const pump = yield* consumer.consume(() => Effect.void).pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* Fiber.interrupt(pump);
      assert.equal((yield* broker.bindTransport({}).pipe(Effect.flip)).reason, "consumerStopped");
      assert.equal(
        (yield* broker.closeRoots(generation).pipe(Effect.flip)).reason,
        "handlerFailed",
      );
      assert.equal(
        (yield* consumer.consume(() => Effect.void).pipe(Effect.flip)).reason,
        "consumerStopped",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("an event-prefix receipt does not assert that the bound child has closed", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      let closeCalls = 0;
      const transport = Object.freeze({
        close: () => {
          closeCalls++;
        },
        childState: "running",
      });
      const generation = yield* broker.bindTransport(transport);
      const consumer = yield* broker.designateConsumer;
      yield* consumer.consume(() => Effect.void).pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* broker.closeRoots(generation);
      const fence = yield* broker.seal(generation, transport, deadline);
      const proof = yield* consumer.awaitPrefix(generation, fence, deadline);
      assert.deepEqual(yield* consumer.inspect(generation, fence, proof), { highWater: 0 });
      assert.equal(closeCalls, 0);
      assert.equal(transport.childState, "running");
    }).pipe(Effect.scoped),
  );

  it.effect("other-generation producers remain open while a finite prefix is acknowledged", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const peerTransport = {};
      const peer = yield* f.broker.bindTransport(peerTransport);
      yield* f.broker.withProducer(f.generation, (producer) => f.broker.emit(producer, "target"));
      yield* f.broker.closeRoots(f.generation);
      yield* f.broker.withProducer(peer, (producer) =>
        Effect.gen(function* () {
          yield* f.broker.emit(producer, "peer-before");
          const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
          const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
          assert.deepEqual(yield* f.consumer.inspect(f.generation, fence, proof), { highWater: 1 });
          yield* f.broker.emit(producer, "peer-after");
        }),
      );
      yield* f.broker.closeRoots(peer);
      const peerFence = yield* f.broker.seal(peer, peerTransport, deadline);
      const peerProof = yield* f.consumer.awaitPrefix(peer, peerFence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(peer, peerFence, peerProof), { highWater: 2 });
      assert.deepEqual(f.received, ["target", "peer-before", "peer-after"]);
    }).pipe(Effect.scoped),
  );

  it.effect("concurrent seal requests share one atomic capture and private marker", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.broker.closeRoots(f.generation);
      const [first, second] = yield* Effect.all(
        [
          f.broker.seal(f.generation, f.transport, deadline),
          f.broker.seal(f.generation, f.transport, deadline),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(first, second);
      const proof = yield* f.consumer.awaitPrefix(f.generation, first, deadline);
      assert.deepEqual(yield* f.consumer.inspect(f.generation, first, proof), { highWater: 0 });
      assert.deepEqual(f.received, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a pending producer deadline stays unknown after that producer finishes", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const producer = yield* f.broker
        .withProducer(f.generation, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* f.broker.closeRoots(f.generation);
      const sealing = yield* f.broker
        .seal(f.generation, f.transport, deadline)
        .pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      assert.equal((yield* Fiber.join(sealing)).reason, "producerTimeout");
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(producer);
      assert.equal(
        (yield* f.broker.seal(f.generation, f.transport, deadline).pipe(Effect.flip)).reason,
        "producerTimeout",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a proof cannot be transplanted to another generation or cloned", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const peerTransport = {};
      const peer = yield* f.broker.bindTransport(peerTransport);
      yield* f.broker.closeRoots(f.generation);
      yield* f.broker.closeRoots(peer);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      const peerFence = yield* f.broker.seal(peer, peerTransport, deadline);
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.equal(
        (yield* f.consumer.inspect(peer, peerFence, proof).pipe(Effect.flip)).reason,
        "unknownProof",
      );
      assert.equal(
        (yield* f.consumer
          .inspect(f.generation, fence, { ...proof } as Broker.OwnedEventPrefixProof)
          .pipe(Effect.flip)).reason,
        "unknownProof",
      );
      const peerProof = yield* f.consumer.awaitPrefix(peer, peerFence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(peer, peerFence, peerProof), { highWater: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("marker-shaped event data cannot forge the private ACK", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<{ readonly kind: string; readonly highWater: number }>();
      const transport = {};
      const generation = yield* broker.bindTransport(transport);
      const consumer = yield* broker.designateConsumer;
      const data = { kind: "fence", highWater: 999 };
      const received: unknown[] = [];
      yield* consumer
        .consume((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* broker.withProducer(generation, (producer) => broker.emit(producer, data));
      yield* broker.closeRoots(generation);
      const fence = yield* broker.seal(generation, transport, deadline);
      const proof = yield* consumer.awaitPrefix(generation, fence, deadline);
      assert.deepEqual(yield* consumer.inspect(generation, fence, proof), { highWater: 1 });
      assert.deepEqual(received, [data]);
    }).pipe(Effect.scoped),
  );
  it.effect("acknowledges a handler-completed prefix while the shared consumer stays open", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.broker.withProducer(f.generation, (producer) => f.broker.emit(producer, "first"));
      yield* f.broker.closeRoots(f.generation);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(f.generation, fence, proof), { highWater: 1 });
      assert.deepEqual(f.received, ["first"]);
      const peerTransport = Object.freeze({ ownedPipe: Object.freeze({}) });
      const peer = yield* f.broker.bindTransport(peerTransport);
      yield* f.broker.withProducer(peer, (producer) => f.broker.emit(producer, "peer-after-fence"));
      yield* f.broker.closeRoots(peer);
      const peerFence = yield* f.broker.seal(peer, peerTransport, deadline);
      const peerProof = yield* f.consumer.awaitPrefix(peer, peerFence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(peer, peerFence, peerProof), { highWater: 1 });
      assert.deepEqual(f.received, ["first", "peer-after-fence"]);
    }).pipe(Effect.scoped),
  );

  it.effect("root close permits owned continuations and registered forks before final seal", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const emitTail = yield* Deferred.make<void>();
      const childStarted = yield* Deferred.make<void>();
      const child = yield* f.broker.withProducer(f.generation, (parent) =>
        Effect.gen(function* () {
          yield* f.broker.emit(parent, "root");
          yield* f.broker.closeRoots(f.generation);
          yield* f.broker.continueProducer(parent, (continuation) =>
            f.broker.emit(continuation, "continuation"),
          );
          return yield* f.broker.forkProducer(parent, (producer) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(childStarted, undefined);
              yield* Deferred.await(emitTail);
              yield* f.broker.emit(producer, "fork-tail");
            }),
          );
        }),
      );
      yield* Deferred.await(childStarted);
      const sealing = yield* f.broker
        .seal(f.generation, f.transport, deadline)
        .pipe(Effect.forkScoped);
      const denied = yield* f.broker
        .withProducer(f.generation, () => Effect.die("new root must not run"))
        .pipe(Effect.flip);
      assert.equal(denied.reason, "rootsClosed");
      yield* Deferred.succeed(emitTail, undefined);
      yield* Fiber.join(child);
      const fence = yield* Fiber.join(sealing);
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(f.generation, fence, proof), { highWater: 3 });
      assert.deepEqual(f.received, ["root", "continuation", "fork-tail"]);
    }).pipe(Effect.scoped),
  );

  it.effect("a producer cannot join its own generation while holding a lease", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const error = yield* f.broker
        .withProducer(f.generation, () =>
          Effect.gen(function* () {
            yield* f.broker.closeRoots(f.generation);
            return yield* f.broker.seal(f.generation, f.transport, deadline);
          }),
        )
        .pipe(Effect.flip);
      assert.equal(error.reason, "joinWhileProducing");
    }).pipe(Effect.scoped),
  );

  it.effect("a held handler cannot ACK dequeue, and a timed-out fence cannot later resurrect", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      const transport = {};
      const generation = yield* broker.bindTransport(transport);
      const consumer = yield* broker.designateConsumer;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      yield* consumer
        .consume(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(finish);
            yield* Deferred.succeed(completed, undefined);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* broker.withProducer(generation, (producer) => broker.emit(producer, "held"));
      yield* Deferred.await(entered);
      yield* broker.closeRoots(generation);
      const fence = yield* broker.seal(generation, transport, deadline);
      const waiting = yield* consumer
        .awaitPrefix(generation, fence, deadline)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.await(waiting);
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(yield* Deferred.isDone(completed));
      yield* Deferred.succeed(finish, undefined);
      yield* Deferred.await(completed);
      const retry = yield* consumer.awaitPrefix(generation, fence, deadline).pipe(Effect.flip);
      assert.equal(retry.reason, "ackTimeout");
    }).pipe(Effect.scoped),
  );

  it.effect("handler failure never becomes a successful ACK", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      const transport = {};
      const generation = yield* broker.bindTransport(transport);
      const consumer = yield* broker.designateConsumer;
      const entered = yield* Deferred.make<void>();
      const failHandler = yield* Deferred.make<void>();
      const pump = yield* consumer
        .consume(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(failHandler)),
            Effect.andThen(Effect.fail("synthetic handler failure")),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* broker.withProducer(generation, (producer) => broker.emit(producer, "event"));
      yield* Deferred.await(entered);
      yield* broker.closeRoots(generation);
      const fence = yield* broker.seal(generation, transport, deadline);
      yield* Deferred.succeed(failHandler, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pump)));
      const error = yield* consumer.awaitPrefix(generation, fence, deadline).pipe(Effect.flip);
      assert.equal(error.reason, "handlerFailed");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "consumer interruption is unknown, including a marker already queued behind a held handler",
    () =>
      Effect.gen(function* () {
        const broker = yield* Broker.make<string>();
        const transport = {};
        const generation = yield* broker.bindTransport(transport);
        const consumer = yield* broker.designateConsumer;
        const entered = yield* Deferred.make<void>();
        const pump = yield* consumer
          .consume(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkScoped);
        yield* consumer.started;
        yield* broker.withProducer(generation, (producer) => broker.emit(producer, "event"));
        yield* Deferred.await(entered);
        yield* broker.closeRoots(generation);
        const fence = yield* broker.seal(generation, transport, deadline);
        yield* Fiber.interrupt(pump);
        assert.equal(
          (yield* consumer.awaitPrefix(generation, fence, deadline).pipe(Effect.flip)).reason,
          "handlerFailed",
        );
      }).pipe(Effect.scoped),
  );

  it.effect("interrupted ACK wait remains unknown after its handler completes", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      const transport = {};
      const generation = yield* broker.bindTransport(transport);
      const consumer = yield* broker.designateConsumer;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      yield* consumer
        .consume(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkScoped);
      yield* consumer.started;
      yield* broker.withProducer(generation, (producer) => broker.emit(producer, "event"));
      yield* Deferred.await(entered);
      yield* broker.closeRoots(generation);
      const fence = yield* broker.seal(generation, transport, deadline);
      const waiting = yield* consumer
        .awaitPrefix(generation, fence, deadline)
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust(1);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(finish, undefined);
      assert.equal(
        (yield* consumer.awaitPrefix(generation, fence, deadline).pipe(Effect.flip)).reason,
        "ackInterrupted",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("missing designated consumer cannot manufacture an empty-prefix proof", () =>
    Effect.gen(function* () {
      const broker = yield* Broker.make<string>();
      const transport = {};
      const generation = yield* broker.bindTransport(transport);
      yield* broker.closeRoots(generation);
      assert.equal(
        (yield* broker.seal(generation, transport, deadline).pipe(Effect.flip)).reason,
        "consumerMissing",
      );
    }),
  );

  it.effect("the opaque actual transport reference must match, even when labels match", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.equal(
        (yield* f.broker.bindTransport(f.transport).pipe(Effect.flip)).reason,
        "transportAlreadyBound",
      );
      yield* f.broker.closeRoots(f.generation);
      assert.equal(
        (yield* f.broker.seal(f.generation, { ...f.transport }, deadline).pipe(Effect.flip)).reason,
        "transportMismatch",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("forged and stale fence tokens cannot ACK a generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.broker.closeRoots(f.generation);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      const forged = Object.freeze({ ...fence }) as Broker.OwnedEventFence;
      assert.equal(
        (yield* f.consumer.awaitPrefix(f.generation, forged, deadline).pipe(Effect.flip)).reason,
        "fenceMismatch",
      );
      assert.equal(
        (yield* f.consumer.awaitPrefix(f.generation, fence, deadline).pipe(Effect.flip)).reason,
        "fenceMismatch",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a fence from another generation cannot authorize this generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const peerTransport = {};
      const peer = yield* f.broker.bindTransport(peerTransport);
      yield* f.broker.closeRoots(f.generation);
      yield* f.broker.closeRoots(peer);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      assert.equal(
        (yield* f.consumer.awaitPrefix(peer, fence, deadline).pipe(Effect.flip)).reason,
        "fenceMismatch",
      );
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.deepEqual(yield* f.consumer.inspect(f.generation, fence, proof), { highWater: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("another broker's consumer cannot ACK or inspect an owned fence", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const other = yield* fixture();
      yield* f.broker.closeRoots(f.generation);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      assert.equal(
        (yield* other.consumer.awaitPrefix(f.generation, fence, deadline).pipe(Effect.flip)).reason,
        "unknownGeneration",
      );
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.equal(
        (yield* other.consumer.inspect(f.generation, fence, proof).pipe(Effect.flip)).reason,
        "unknownProof",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("post-seal emission fails, latches, and invalidates later proof inspection", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const captured = yield* f.broker.withProducer(f.generation, (producer) =>
        Effect.succeed(producer),
      );
      yield* f.broker.closeRoots(f.generation);
      const fence = yield* f.broker.seal(f.generation, f.transport, deadline);
      const proof = yield* f.consumer.awaitPrefix(f.generation, fence, deadline);
      assert.equal(
        (yield* f.broker.emit(captured, "too late").pipe(Effect.flip)).reason,
        "postSealEmission",
      );
      assert.equal(
        (yield* f.consumer.inspect(f.generation, fence, proof).pipe(Effect.flip)).reason,
        "postSealEmission",
      );
      assert.deepEqual(f.received, []);
    }).pipe(Effect.scoped),
  );

  it.effect("producer failure and interruption cannot be hidden by lease finalizers", () =>
    Effect.gen(function* () {
      for (const interrupted of [false, true]) {
        const f = yield* fixture();
        const started = yield* Deferred.make<void>();
        if (interrupted) {
          const producer = yield* f.broker
            .withProducer(f.generation, () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(producer);
        } else {
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                f.broker.withProducer(f.generation, () =>
                  Effect.fail("synthetic producer failure"),
                ),
              ),
            ),
          );
        }
        assert.equal(
          (yield* f.broker.closeRoots(f.generation).pipe(Effect.flip)).reason,
          "producerFailed",
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("a registered fork cancelled at scheduling cannot leak a successful prefix", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.broker.withProducer(f.generation, (parent) =>
        Effect.gen(function* () {
          const child = yield* f.broker.forkProducer(parent, () => Effect.never);
          yield* Fiber.interrupt(child);
        }),
      );
      assert.equal(
        (yield* f.broker.closeRoots(f.generation).pipe(Effect.flip)).reason,
        "producerFailed",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a lease retained after its callback returns is stale", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const producer = yield* f.broker.withProducer(f.generation, (lease) => Effect.succeed(lease));
      assert.equal(
        (yield* f.broker
          .continueProducer(producer, () => Effect.die("must not run"))
          .pipe(Effect.flip)).reason,
        "staleProducer",
      );
    }).pipe(Effect.scoped),
  );
});
