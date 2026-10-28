import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
  type WorkspaceLocation,
  type WorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Workspace from "./Workspace.ts";

// A back-and-forth becomes one pass: wait this long after a turn before reading the chat.
const QUIET_PERIOD = "2 minutes";
const MAX_CONVERSATION_CHARS = 12_000;

const Cursors = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeCursors = Schema.decodeEffect(Cursors);
const encodeCursors = Schema.encodeEffect(Cursors);

const normalizeTitle = (title: string) => title.trim().toLowerCase().replace(/\s+/gu, " ");

function newMessagesSince(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  cursor: MessageId | undefined,
) {
  const settled = messages.filter(
    (message) => !message.streaming && (message.role === "user" || message.role === "assistant"),
  );
  const index = cursor === undefined ? -1 : settled.findIndex((message) => message.id === cursor);
  return settled.slice(index + 1);
}

function formatConversation(messages: ReadonlyArray<OrchestrationV2ConversationMessage>) {
  const text = messages
    .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${message.text.trim()}`)
    .join("\n\n");
  return text.length <= MAX_CONVERSATION_CHARS ? text : text.slice(-MAX_CONVERSATION_CHARS);
}

export class WorkspaceAutoFiler extends Context.Service<
  WorkspaceAutoFiler,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Reads what is new in one thread, saves its items and files it if it has no home yet. */
    readonly fileThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/workspace/WorkspaceAutoFiler") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const workspace = yield* Workspace.Workspace;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const cursorPath = path.join(stateDir, "workspace-extraction.json");

  const cursors = yield* Ref.make(
    yield* fileSystem.readFileString(cursorPath).pipe(
      Effect.flatMap(decodeCursors),
      Effect.orElseSucceed((): Record<string, string> => ({})),
    ),
  );

  const saveCursor = Effect.fn("WorkspaceAutoFiler.saveCursor")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const next = yield* Ref.updateAndGet(cursors, (current) => ({
      ...current,
      [threadId]: messageId,
    }));
    const temporary = `${cursorPath}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* fileSystem.writeFileString(temporary, yield* encodeCursors(next));
    yield* fileSystem.rename(temporary, cursorPath);
  });

  const placesFor = Effect.fn("WorkspaceAutoFiler.placesFor")(function* (
    snapshot: WorkspaceSnapshot,
    scratchRoot: Option.Option<string>,
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    const rows = yield* projects.list();
    const places = new Map<
      string,
      { readonly name: string; readonly location: WorkspaceLocation }
    >();
    for (const area of snapshot.areas) {
      places.set(`area:${area.id}`, {
        name: `Area "${area.name}"`,
        location: { _tag: "Area", areaId: area.id },
      });
    }
    for (const row of rows) {
      if (row.deletedAt !== null) continue;
      if (Option.isSome(scratchRoot) && row.workspaceRoot === scratchRoot.value) continue;
      const areas = snapshot.areas
        .filter((area) =>
          area.projectRefs.some(
            (ref) => ref.environmentId === environmentId && ref.projectId === row.projectId,
          ),
        )
        .map((area) => area.name);
      places.set(`project:${row.projectId}`, {
        name: `Project "${row.title}"${areas.length > 0 ? ` in ${areas.join(", ")}` : ""}`,
        location: { _tag: "Project", projectId: row.projectId },
      });
    }
    return places;
  });

  const fileThread: WorkspaceAutoFiler["Service"]["fileThread"] = Effect.fn(
    "WorkspaceAutoFiler.fileThread",
  )(
    function* (threadId) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.workspaceAutoExtract) return;
      const records = yield* threads.getThreadRecords(threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      });
      if (records.thread.deletedAt !== null) return;
      const fresh = newMessagesSince(
        records.messages,
        (yield* Ref.get(cursors))[threadId] as MessageId | undefined,
      );
      const last = fresh.at(-1);
      if (last === undefined) return;

      const project = yield* projects.get(records.thread.projectId);
      if (Option.isNone(project)) return;
      const scratchRoot = yield* folders.scratchRoot;
      const isScratch =
        Option.isSome(scratchRoot) && project.value.workspaceRoot === scratchRoot.value;
      const snapshot = yield* workspace.snapshot;
      const current = snapshot.threadFilings.find((entry) => entry.threadId === threadId)?.filing;
      // Only a thread without a project needs a home, and only until someone chose one.
      const needsHome =
        isScratch &&
        (current === undefined ||
          (current.filedBy._tag === "Auto" && current.location._tag === "Inbox"));
      const places = needsHome ? yield* placesFor(snapshot, scratchRoot) : undefined;

      const result = yield* textGeneration.generateWorkspaceItems({
        cwd: records.thread.worktreePath ?? project.value.workspaceRoot,
        threadTitle: records.thread.title,
        conversation: formatConversation(fresh),
        saved: snapshot.items.map((item) => item.title).slice(-200),
        ...(places === undefined
          ? {}
          : { places: [...places].map(([id, place]) => ({ id, name: place.name })) }),
        modelSelection: resolveProjectSettings(settings, records.thread.projectId).settings
          .textGenerationModelSelection,
      });

      let home: WorkspaceLocation = isScratch
        ? (current?.location ?? { _tag: "Inbox" })
        : { _tag: "Project", projectId: records.thread.projectId };
      if (places !== undefined && result.filing !== null) {
        const pick = result.filing.placeId === null ? undefined : places.get(result.filing.placeId);
        const reason = result.filing.reason.trim().slice(0, 300);
        const target = { _tag: "Thread", threadId } as const;
        if (pick !== undefined && result.filing.confident) {
          home = pick.location;
          yield* workspace.file({ target, location: home, reason }, { _tag: "Auto" });
        } else {
          const newProjectName = result.filing.newProjectName?.trim().slice(0, 80);
          yield* workspace.file(
            {
              target,
              location: { _tag: "Inbox" },
              reason: "Not sure where this belongs.",
              ...(pick === undefined && !newProjectName
                ? {}
                : {
                    suggestion: {
                      location: pick?.location ?? { _tag: "Inbox" },
                      ...(newProjectName ? { newProjectName } : {}),
                      reason,
                    },
                  }),
            },
            { _tag: "Auto" },
          );
        }
      }

      const known = new Set(
        snapshot.items.map((item) => `${item.kind}:${normalizeTitle(item.title)}`),
      );
      for (const extracted of result.items) {
        const title = extracted.title.trim().slice(0, 200);
        const key = `${extracted.kind}:${normalizeTitle(title)}`;
        if (title.length === 0 || known.has(key)) continue;
        known.add(key);
        const quote = extracted.quote.trim().slice(0, 500);
        yield* workspace.createItem(
          {
            kind: extracted.kind,
            title,
            body: extracted.body.trim().slice(0, 4_000),
            location: home,
            reason: `From "${records.thread.title}".`.slice(0, 300),
            source: { threadId, messageId: last.id, ...(quote.length > 0 ? { quote } : {}) },
            ...(extracted.kind === "decision" ? { status: "decided" as const } : {}),
          },
          { _tag: "Auto" },
        );
      }
      yield* saveCursor(threadId, last.id);
    },
    Effect.catchCause((cause) => Effect.logWarning("Workspace filing skipped a thread", { cause })),
  );

  const worker = yield* makeDrainableWorker(fileThread);

  const start: WorkspaceAutoFiler["Service"]["start"] = Effect.fn("WorkspaceAutoFiler.start")(
    function* () {
      const scope = yield* Effect.scope;
      // Each finished turn restarts its thread's wait; only the wait is cancelled, never a pass.
      const waiting = new Map<ThreadId, Fiber.Fiber<void>>();
      const schedule = Effect.fn("WorkspaceAutoFiler.schedule")(function* (threadId: ThreadId) {
        const previous = waiting.get(threadId);
        if (previous !== undefined) yield* Fiber.interrupt(previous);
        const fiber = yield* Effect.sleep(QUIET_PERIOD).pipe(
          Effect.andThen(Effect.sync(() => waiting.delete(threadId))),
          Effect.andThen(worker.enqueue(threadId)),
          Effect.forkIn(scope),
        );
        waiting.set(threadId, fiber);
      });
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "run.updated" && event.payload.status === "completed"
            ? schedule(event.threadId)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Workspace filing stopped listening", { cause }),
          ),
        ),
      );
    },
  );

  return WorkspaceAutoFiler.of({ start, fileThread, drain: worker.drain });
});

export const layer = Layer.effect(WorkspaceAutoFiler, make);
