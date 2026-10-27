import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  ProjectDoc,
  ProjectDocError,
  ProjectDocId,
  type ProjectDocAuthor,
  type ProjectDocDeleteInput,
  type ProjectDocListResult,
  type ProjectDocReadInput,
  type ProjectDocSaveInput,
  type ProjectId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";

const ProjectDocJson = Schema.fromJsonString(ProjectDoc);
const decodeDoc = Schema.decodeEffect(ProjectDocJson);
const encodeDoc = Schema.encodeEffect(ProjectDocJson);
const isDocId = Schema.is(ProjectDocId);

const storageError = (cause: unknown, docId?: ProjectDocId) =>
  new ProjectDocError({
    message: "Could not access project docs.",
    reason: "storage",
    ...(docId === undefined ? {} : { docId }),
    cause,
  });

const notFound = (docId: ProjectDocId) =>
  new ProjectDocError({ message: "The doc was not found.", reason: "not-found", docId });

export class ProjectDocs extends Context.Service<
  ProjectDocs,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ProjectDocListResult, ProjectDocError>;
    readonly subscribe: (
      projectId: ProjectId,
    ) => Stream.Stream<ProjectDocListResult, ProjectDocError>;
    readonly read: (input: ProjectDocReadInput) => Effect.Effect<ProjectDoc, ProjectDocError>;
    readonly save: (
      input: ProjectDocSaveInput,
      author: ProjectDocAuthor,
    ) => Effect.Effect<ProjectDoc, ProjectDocError>;
    readonly delete: (input: ProjectDocDeleteInput) => Effect.Effect<void, ProjectDocError>;
  }
>()("t3/project/ProjectDocs") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const writes = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<ProjectId>();

  const projectDir = (projectId: ProjectId) =>
    path.join(stateDir, "project-docs", encodeURIComponent(projectId));
  const docPath = (projectId: ProjectId, docId: ProjectDocId) =>
    path.join(projectDir(projectId), `${docId}.json`);

  const readDoc = Effect.fn("ProjectDocs.readDoc")(function* (
    projectId: ProjectId,
    docId: ProjectDocId,
  ) {
    const raw = yield* fileSystem.readFileString(docPath(projectId, docId)).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(
            error.reason._tag === "NotFound" ? notFound(docId) : storageError(error, docId),
          ),
      }),
    );
    return yield* decodeDoc(raw).pipe(Effect.mapError((cause) => storageError(cause, docId)));
  });

  const list: ProjectDocs["Service"]["list"] = Effect.fn("ProjectDocs.list")(function* (projectId) {
    const names = yield* fileSystem.readDirectory(projectDir(projectId)).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<ReadonlyArray<string>>([])
            : Effect.fail(storageError(error)),
      }),
    );
    const ids = names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter(isDocId);
    const docs = yield* Effect.forEach(ids, (docId) => readDoc(projectId, docId), {
      concurrency: 8,
    });
    return {
      projectId,
      docs: docs
        .map(({ markdown: _markdown, ...summary }) => summary)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  });

  const subscribe: ProjectDocs["Service"]["subscribe"] = (projectId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a write between the two still triggers a refresh.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list(projectId)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === projectId),
            Stream.mapEffect(() => list(projectId)),
          ),
        );
      }),
    );

  const read: ProjectDocs["Service"]["read"] = Effect.fn("ProjectDocs.read")(function* (input) {
    return yield* readDoc(input.projectId, input.docId);
  });

  const writeDoc = Effect.fn("ProjectDocs.writeDoc")(function* (doc: ProjectDoc) {
    const target = docPath(doc.projectId, doc.id);
    const temporary = `${target}.${yield* crypto.randomUUIDv4()}.tmp`;
    const json = yield* encodeDoc(doc);
    yield* fileSystem.makeDirectory(projectDir(doc.projectId), { recursive: true });
    yield* fileSystem.writeFileString(temporary, json);
    yield* fileSystem.rename(temporary, target);
  });

  const save: ProjectDocs["Service"]["save"] = Effect.fn("ProjectDocs.save")(
    function* (input, author) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const existing =
        input.docId === undefined ? undefined : yield* readDoc(input.projectId, input.docId);
      if (
        existing !== undefined &&
        input.baseRevision !== undefined &&
        input.baseRevision !== existing.revision
      ) {
        return yield* new ProjectDocError({
          message: "The doc changed since it was read. Read it again before saving.",
          reason: "conflict",
          docId: existing.id,
        });
      }
      const id =
        existing?.id ??
        ProjectDocId.make(
          yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => storageError(cause))),
        );
      const doc: ProjectDoc = {
        id,
        projectId: input.projectId,
        title: input.title,
        markdown: input.markdown,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        updatedBy: author,
        revision: (existing?.revision ?? 0) + 1,
      };
      yield* writeDoc(doc).pipe(Effect.mapError((cause) => storageError(cause, id)));
      yield* PubSub.publish(changes, input.projectId);
      return doc;
    },
    (effect) => writes.withPermit(effect),
  );

  const remove: ProjectDocs["Service"]["delete"] = Effect.fn("ProjectDocs.delete")(
    function* (input) {
      yield* readDoc(input.projectId, input.docId);
      yield* fileSystem
        .remove(docPath(input.projectId, input.docId))
        .pipe(Effect.mapError((cause) => storageError(cause, input.docId)));
      yield* PubSub.publish(changes, input.projectId);
    },
    (effect) => writes.withPermit(effect),
  );

  return ProjectDocs.of({ list, subscribe, read, save, delete: remove });
});

export const layer = Layer.effect(ProjectDocs, make);
