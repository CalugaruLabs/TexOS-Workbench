// @effect-diagnostics nodeBuiltinImport:off - Private inherited Node descriptors and opaque UUIDs; no provider subprocess.
import * as NodeCrypto from "node:crypto";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as P from "@t3tools/provider-core/server/ProviderAdapter";
import { NativeBridge, type NativeEvent, type NativeProvider } from "./bridge.ts";
import { requireNativeSelection } from "./profile.ts";

export const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
};

export function validateNativePolicy(input: {
  modelSelection: P.ProviderAdapterV2TurnInput["modelSelection"];
  runtimePolicy: P.ProviderAdapterV2RuntimePolicy;
}) {
  requireNativeSelection(input.modelSelection);
  const policy = input.runtimePolicy;
  if (
    policy.cwd !== null ||
    policy.runtimeMode !== "approval-required" ||
    policy.interactionMode !== "default" ||
    policy.approvalPolicy !== undefined ||
    policy.sandboxPolicy !== undefined ||
    policy.reasoningEffort !== undefined
  )
    throw new Error("Native Settings own model and permissions; T3 overrides are unsupported.");
}

/** A projection adapter; it owns no provider engine, credentials, or native history. */
export function makeNativeAdapter(
  provider: NativeProvider,
  bridge: NativeBridge,
): P.ProviderAdapterV2["Service"] {
  const driver = ProviderDriverKind.make(provider === "claudeCode" ? "claudeAgent" : "codex");
  const instanceId = ProviderInstanceId.make(provider === "claudeCode" ? "claudeAgent" : "codex");
  return P.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("NativeTexChat.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("NativeTexChat.planSelectionTransition")(() =>
      Effect.fail(
        new P.ProviderAdapterCapabilitiesError({
          driver,
          cause: "Native route changes require a fresh conversation.",
        }),
      ),
    ),
    openSession: Effect.fn("NativeTexChat.openSession")(function* (
      input: P.ProviderAdapterV2OpenSessionInput,
    ) {
      yield* Effect.try({
        try: () => {
          validateNativePolicy(input);
          if (input.modelSelection.instanceId !== instanceId)
            throw new Error("Native provider binding mismatch.");
          if (input.resumeFromSession || input.initialNativeThreadId)
            throw new Error("Native history resume is unsupported.");
        },
        catch: (cause) =>
          new P.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () => bridge.ready(),
        catch: (cause) =>
          new P.ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause,
          }),
      });
      const events = yield* Queue.unbounded<P.ProviderAdapterV2Event>();
      const emit = (event: P.ProviderAdapterV2Event) => {
        Queue.offerUnsafe(events, event);
      };
      yield* Effect.addFinalizer(() => Queue.shutdown(events).pipe(Effect.asVoid));
      const now = yield* DateTime.now;
      let thread: OrchestrationV2ProviderThread | undefined;
      let handle: string | undefined;
      type ActiveNativeTurn = {
        input: P.ProviderAdapterV2TurnInput;
        turn: OrchestrationV2ProviderTurn;
        message: OrchestrationV2ConversationMessage;
        nativeTurn?: string;
        stopRequested: boolean;
        stopPromise?: Promise<void>;
        buffered: NativeEvent[];
      };
      let active: ActiveNativeTurn | undefined;
      const attempts = new Set<string>();
      const turns: OrchestrationV2ProviderTurn[] = [];
      const messages: OrchestrationV2ConversationMessage[] = [];
      let broken = false;
      let creating = false;
      const unsupported = (operation: string) =>
        Effect.fail(
          new P.ProviderAdapterCapabilitiesError({
            driver,
            cause: `Unsupported native preview operation: ${operation}`,
          }),
        );
      const bound = (candidate: OrchestrationV2ProviderThread) => {
        if (
          !thread ||
          candidate.id !== thread.id ||
          candidate.appThreadId !== thread.appThreadId ||
          candidate.providerInstanceId !== instanceId ||
          candidate.driver !== driver ||
          candidate.providerSessionId !== input.providerSessionId ||
          !handle ||
          broken
        )
          throw new Error("Unknown or disconnected fresh native conversation.");
      };
      const forwardStop = (turn: ActiveNativeTurn): Promise<void> => {
        if (!turn.nativeTurn) return Promise.resolve();
        if (!turn.stopPromise) {
          turn.stopPromise = bridge
            .call({ method: "turn.stop", handle: handle!, turnID: turn.nativeTurn })
            .then(() => undefined)
            .catch((error: unknown) => {
              // No retry with an unknown Stop outcome: native learns channel loss and owns settlement.
              bridge.close();
              throw error;
            });
        }
        return turn.stopPromise;
      };
      const consume = (event: NativeEvent) => {
        if (!active || event.handle !== handle) return;
        if (!active.nativeTurn) {
          if (active.buffered.length >= 256) {
            broken = true;
            bridge.close();
            return;
          }
          active.buffered.push(event);
          return;
        }
        if (event.turnID !== active.nativeTurn) {
          broken = true;
          bridge.close();
          return;
        }
        const timestamp = DateTime.nowUnsafe();
        if (event.phase === "text") {
          active.message = {
            ...active.message,
            text: active.message.text + (event.text ?? ""),
            updatedAt: timestamp,
          };
          if (Buffer.byteLength(active.message.text) > 1024 * 1024) {
            broken = true;
            bridge.close();
            return;
          }
          emit({ type: "message.updated", driver, message: active.message });
        }
        if (["completed", "failed", "interrupted", "uncertain"].includes(event.phase)) {
          const uncertain = event.phase === "uncertain";
          const failed = event.phase === "failed" || uncertain;
          active.message = { ...active.message, streaming: false, updatedAt: timestamp };
          active.turn = {
            ...active.turn,
            status: failed ? "failed" : event.phase === "completed" ? "completed" : "interrupted",
            completedAt: timestamp,
          };
          messages.push(active.message);
          turns.push(active.turn);
          emit({ type: "message.updated", driver, message: active.message });
          emit({ type: "provider_turn.updated", driver, providerTurn: active.turn });
          const terminal = {
            type: "turn.terminal" as const,
            driver,
            providerThreadId: active.turn.providerThreadId,
            providerTurnId: active.turn.id,
            runOrdinal: active.input.runOrdinal,
            threadDisposition: uncertain ? ("broken" as const) : ("reusable" as const),
          };
          if (failed)
            emit({
              ...terminal,
              status: "failed",
              failureItemOrdinal: 1,
              failure: {
                class: uncertain ? "transport_error" : "provider_error",
                message: (
                  event.problem ??
                  (uncertain
                    ? "Native execution outcome uncertain; automatic retry disabled."
                    : "Native TexOS response failed.")
                ).slice(0, 4096),
                code: null,
                retryable: false,
              },
            });
          else
            emit({
              ...terminal,
              status: event.phase === "completed" ? "completed" : "interrupted",
              failure: null,
            });
          if (uncertain) broken = true;
          active = undefined;
        }
      };
      const removeEvent = bridge.onEvent(consume);
      const removeClose = bridge.onDisconnect(() => {
        broken = true;
        if (active) {
          // No fabricated success/cancellation after EOF. Settle the T3 projection as uncertain failure.
          active.nativeTurn ??= NodeCrypto.randomUUID();
          consume({
            version: 1,
            kind: "event",
            provider,
            handle: handle!,
            turnID: active.nativeTurn,
            sequence: 0,
            phase: "uncertain",
            problem: "Native bridge disconnected; actual execution outcome is uncertain.",
          });
        }
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removeEvent();
          removeClose();
        }),
      );
      const runtime: P.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/__texos_native_preview__",
          model: "native-settings",
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: (request) =>
          Effect.tryPromise({
            try: async () => {
              validateNativePolicy(request);
              if (request.modelSelection.instanceId !== instanceId || creating || broken)
                throw new Error("Native session is unavailable or provider binding changed.");
              if (thread) {
                if (
                  request.existingProviderThread?.id !== thread.id ||
                  thread.appThreadId !== request.threadId
                )
                  throw new Error("One fresh native handle per logical session.");
                return thread;
              }
              const existing = request.existingProviderThread;
              if (
                existing &&
                (existing.appThreadId !== request.threadId ||
                  existing.nativeThreadRef !== null ||
                  existing.forkedFrom !== null ||
                  (existing.lastRunOrdinal !== null && existing.lastRunOrdinal !== 1))
              )
                throw new Error("History import/resume is unsupported.");
              creating = true;
              const result = await bridge.call({ method: "conversation.create", provider });
              handle = result.handle!;
              const timestamp = DateTime.nowUnsafe();
              thread = {
                id:
                  existing?.id ?? ProviderThreadId.make(`native-texos:${NodeCrypto.randomUUID()}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: request.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                contextUsage: null,
                nativeMetadata: null,
                goal: null,
                createdAt: timestamp,
                updatedAt: timestamp,
              };
              await bridge.call({ method: "events.subscribe", handle, afterSequence: 0 });
              creating = false;
              return thread;
            },
            catch: (cause) =>
              new P.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          }),
        resumeThread: () => unsupported("resume"),
        startTurn: (request) =>
          Effect.tryPromise({
            try: async () => {
              bound(request.providerThread);
              validateNativePolicy(request);
              if (
                request.threadId !== thread!.appThreadId ||
                request.appThread.id !== request.threadId ||
                request.modelSelection.instanceId !== instanceId ||
                request.appThread.branch !== null ||
                request.appThread.worktreePath !== null ||
                request.restartContinuationOfRunId ||
                request.appContext?.length ||
                request.message.attachments.length ||
                request.message.createdBy !== "user" ||
                request.message.scheduledTaskId ||
                request.message.senderThreadId
              )
                throw new Error("Only fresh native user text is supported.");
              if (
                active ||
                attempts.size > 0 ||
                request.runOrdinal !== 1 ||
                request.providerTurnOrdinal !== 1
              )
                throw new Error(
                  "One fresh turn per native handle. Start a new preview conversation.",
                );
              if (
                !request.message.text.trim() ||
                request.message.text.trimStart().startsWith("/") ||
                Buffer.byteLength(request.message.text) > 8192
              )
                throw new Error("Invalid native user text.");
              attempts.add(request.attemptId);
              const timestamp = DateTime.nowUnsafe();
              const turn: OrchestrationV2ProviderTurn = {
                id: ProviderTurnId.make(`native-texos:${request.attemptId}`),
                providerThreadId: request.providerThread.id,
                nodeId: request.rootNodeId,
                runAttemptId: request.attemptId,
                nativeTurnRef: null,
                ordinal: request.providerTurnOrdinal,
                status: "pending",
                startedAt: null,
                completedAt: null,
              };
              const message: OrchestrationV2ConversationMessage = {
                id: MessageId.make(`native-texos:${request.attemptId}`),
                threadId: request.threadId,
                runId: request.runId,
                nodeId: request.rootNodeId,
                role: "assistant",
                text: "",
                attachments: [],
                streaming: true,
                createdBy: "agent",
                creationSource: "provider",
                createdAt: timestamp,
                updatedAt: timestamp,
              };
              active = { input: request, turn, message, stopRequested: false, buffered: [] };
              const sending = active;
              // The pending projection exposes a correlatable Stop target without claiming native acceptance.
              emit({ type: "provider_turn.updated", driver, providerTurn: turn });
              // Only USER text is sent. The hosted ProviderTurnStartService supplies the unassembled persisted user message.
              try {
                const accepted = await bridge.call({
                  method: "message.send",
                  handle: handle!,
                  text: request.message.text,
                });
                if (!active) return;
                active.nativeTurn = accepted.turnID!;
                active.turn = {
                  ...active.turn,
                  status: "running",
                  startedAt: DateTime.nowUnsafe(),
                };
                emit({ type: "provider_turn.updated", driver, providerTurn: active.turn });
                const buffered = active.buffered;
                active.buffered = [];
                for (const event of buffered) consume(event);
                if (active === sending && sending.stopRequested) await forwardStop(sending);
              } catch (error) {
                active = undefined;
                broken = true;
                throw error;
              }
            },
            catch: (cause) =>
              new P.ProviderAdapterTurnStartError({
                driver,
                threadId: request.threadId,
                providerThreadId: request.providerThread.id,
                runId: request.runId,
                cause,
              }),
          }),
        interruptTurn: (request) =>
          Effect.tryPromise({
            try: async () => {
              bound(request.providerThread);
              if (!active || active.turn.id !== request.providerTurnId)
                throw new Error("No matching native turn to stop.");
              active.stopRequested = true;
              if (!active.nativeTurn) return; // Retained intent; forward exactly once after the accepted UUID arrives.
              // T3 normal Stop passes requestRuntimeRestart=true. It is only a hint here:
              // never restart a runtime; forward the exact native Stop and await native events.
              await forwardStop(active);
              // ACK is not terminal; native events remain the settlement authority.
            },
            catch: (cause) => new P.ProviderAdapterCapabilitiesError({ driver, cause }),
          }),
        steerTurn: () => unsupported("steer"),
        respondToRuntimeRequest: () => unsupported("runtime request"),
        readThreadSnapshot: (request) =>
          Effect.try({
            try: () => {
              bound(request.providerThread);
              return {
                providerThread: thread!,
                providerTurns: turns,
                messages,
                runtimeRequests: [],
              };
            },
            catch: (cause) => new P.ProviderAdapterCapabilitiesError({ driver, cause }),
          }),
        rollbackThread: () => unsupported("rollback"),
        forkThread: () => unsupported("fork"),
      };
      return runtime;
    }),
  });
}
