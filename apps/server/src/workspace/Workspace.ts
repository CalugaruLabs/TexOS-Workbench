import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  WorkspaceAreaId,
  WorkspaceError,
  WorkspaceItemId,
  WorkspaceSnapshot,
  type WorkspaceActor,
  type WorkspaceArea,
  type WorkspaceCreateItemInput,
  type WorkspaceFileInput,
  type WorkspaceFiling,
  type WorkspaceItem,
  type WorkspaceSaveAreaInput,
  type WorkspaceUpdateItemInput,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as WorkspaceState from "./WorkspaceState.ts";

const WorkspaceJson = Schema.fromJsonString(WorkspaceSnapshot);
const decodeWorkspace = Schema.decodeEffect(WorkspaceJson);
const encodeWorkspace = Schema.encodeEffect(WorkspaceJson);

const isWorkspaceError = Schema.is(WorkspaceError);

const storageError = (cause: unknown) =>
  new WorkspaceError({ message: "Could not access the workspace.", reason: "storage", cause });

export type WorkspaceFileRequest = WorkspaceFileInput & {
  readonly suggestion?: WorkspaceFiling["suggestion"];
};

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly snapshot: Effect.Effect<WorkspaceSnapshot>;
    readonly subscribe: Stream.Stream<WorkspaceSnapshot>;
    readonly saveArea: (
      input: WorkspaceSaveAreaInput,
    ) => Effect.Effect<WorkspaceArea, WorkspaceError>;
    readonly deleteArea: (areaId: WorkspaceAreaId) => Effect.Effect<void, WorkspaceError>;
    readonly createItem: (
      input: WorkspaceCreateItemInput,
      actor: WorkspaceActor,
    ) => Effect.Effect<WorkspaceItem, WorkspaceError>;
    readonly updateItem: (
      input: WorkspaceUpdateItemInput,
    ) => Effect.Effect<WorkspaceItem, WorkspaceError>;
    readonly deleteItem: (itemId: WorkspaceItemId) => Effect.Effect<void, WorkspaceError>;
    readonly file: (
      input: WorkspaceFileRequest,
      actor: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
  }
>()("t3/workspace/Workspace") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const target = path.join(stateDir, "workspace.json");
  const writes = yield* Semaphore.make(1);

  const initial = yield* fileSystem.readFileString(target).pipe(
    Effect.flatMap(decodeWorkspace),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed(WorkspaceState.EMPTY_WORKSPACE)
        : // Keep an unreadable file for recovery instead of overwriting it with an empty workspace.
          Effect.gen(function* () {
            const aside = `${target}.unreadable-${DateTime.toEpochMillis(yield* DateTime.now)}`;
            yield* Effect.logWarning("Workspace file could not be read; starting empty", {
              error,
              aside,
            });
            yield* fileSystem.rename(target, aside).pipe(Effect.ignore);
            return WorkspaceState.EMPTY_WORKSPACE;
          }),
    ),
  );
  const state = yield* SubscriptionRef.make(initial);

  const persist = Effect.fn("Workspace.persist")(function* (next: WorkspaceSnapshot) {
    const json = yield* encodeWorkspace(next);
    const temporary = `${target}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* fileSystem.writeFileString(temporary, json);
    yield* fileSystem.rename(temporary, target);
  });

  const newId = crypto.randomUUIDv4().pipe(Effect.mapError(storageError));

  // Runs one pure state transition, saves it, then tells subscribers.
  const mutate = <A>(
    transition: (
      current: WorkspaceSnapshot,
      now: string,
      id: string,
    ) => { readonly snapshot: WorkspaceSnapshot; readonly value: A },
  ) =>
    writes.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const now = DateTime.formatIso(yield* DateTime.now);
        const id = yield* newId;
        const { snapshot, value } = yield* Effect.try({
          try: () => transition(current, now, id),
          catch: (cause) => (isWorkspaceError(cause) ? cause : storageError(cause)),
        });
        if (snapshot !== current) {
          yield* persist(snapshot).pipe(Effect.mapError(storageError));
          yield* SubscriptionRef.set(state, snapshot);
        }
        return value;
      }),
    );

  return Workspace.of({
    snapshot: SubscriptionRef.get(state),
    subscribe: SubscriptionRef.changes(state),
    saveArea: Effect.fn("Workspace.saveArea")(function* (input) {
      return yield* mutate((current, now, id) => {
        const result = WorkspaceState.saveArea(current, input, WorkspaceAreaId.make(id), now);
        return { snapshot: result.snapshot, value: result.area };
      });
    }),
    deleteArea: Effect.fn("Workspace.deleteArea")(function* (areaId) {
      yield* mutate((current, now) => ({
        snapshot: WorkspaceState.deleteArea(current, areaId, now),
        value: undefined,
      }));
    }),
    createItem: Effect.fn("Workspace.createItem")(function* (input, actor) {
      return yield* mutate((current, now, id) => {
        const result = WorkspaceState.createItem(
          current,
          input,
          actor,
          WorkspaceItemId.make(id),
          now,
        );
        return { snapshot: result.snapshot, value: result.item };
      });
    }),
    updateItem: Effect.fn("Workspace.updateItem")(function* (input) {
      return yield* mutate((current, now) => {
        const result = WorkspaceState.updateItem(current, input, now);
        return { snapshot: result.snapshot, value: result.item };
      });
    }),
    deleteItem: Effect.fn("Workspace.deleteItem")(function* (itemId) {
      yield* mutate((current) => ({
        snapshot: WorkspaceState.deleteItem(current, itemId),
        value: undefined,
      }));
    }),
    file: Effect.fn("Workspace.file")(function* (input, actor) {
      yield* mutate((current, now) => ({
        snapshot: WorkspaceState.file(current, input, actor, now),
        value: undefined,
      }));
    }),
  });
});

export const layer = Layer.effect(Workspace, make);
