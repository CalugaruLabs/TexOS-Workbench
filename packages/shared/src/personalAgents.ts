import {
  PERSONAL_AGENT_METHODS,
  type PersonalAgentMethod,
  type PersonalAgentCommand,
  type PersonalAgentRunStatus,
  type PersonalAgentHello,
  type PersonalAgentSnapshot,
  type PersonalAgentHistoryPage,
  type PersonalAgentRunDetail,
  type PersonalAgentExecutionCapability,
  type PersonalAgentCanonicalTask,
  type PersonalAgentNativeDelegation,
  type PersonalAgentCanonicalTasks,
} from "@t3tools/contracts";
import { sha256 as hashSHA256 } from "@noble/hashes/sha2";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown, limit = 8192): value is string =>
  typeof value === "string" && value.length <= limit;
const questionString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && new TextEncoder().encode(value).length <= limit;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const optionalString = (value: unknown) => value === undefined || value === null || string(value);
const list = (value: unknown, limit: number, check: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every((item: unknown) => record(item) && check(item));
const identified = (item: Record<string, unknown>) => string(item.id) && string(item.createdAt);
const isExecutionCapability = (value: Record<string, unknown>) =>
  value.mode === "observeOnly"
    ? value.executionAvailable === false
    : (value.mode === "live" || value.mode === "fake") &&
      (value.executionAvailable === undefined || typeof value.executionAvailable === "boolean");
export const personalAgentExecutionAvailable = (value: PersonalAgentExecutionCapability) =>
  value.mode !== "observeOnly" && value.executionAvailable !== false;
export const isPersonalAgentExecutionMethod = (method: PersonalAgentMethod) =>
  ["agents.submit", "agents.stop", "agents.reconcile", "agents.answer", "agents.respond"].includes(
    method,
  );
const statuses = new Set<string>([
  "queued",
  "running",
  "waitingForApproval",
  "waitingForInput",
  "stopping",
  "stopped",
  "completed",
  "failed",
  "interrupted",
  "needsReconciliation",
]);
export const activePersonalAgentRun = (status: PersonalAgentRunStatus) =>
  [
    "queued",
    "running",
    "waitingForApproval",
    "waitingForInput",
    "stopping",
    "needsReconciliation",
  ].includes(status);
const isQuestionAttention = (value: Record<string, unknown>) => {
  if (value.kind === undefined)
    return value.answerable === undefined || typeof value.answerable === "boolean";
  if (
    value.kind !== "question" ||
    typeof value.isBlocking !== "boolean" ||
    typeof value.answerable !== "boolean" ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    new TextEncoder().encode(JSON.stringify(value.questions)).length > 8192
  )
    return false;
  const ids = new Set<string>();
  return list(value.questions, 4, (question) => {
    if (!questionString(question.id, 128) || !question.id || ids.has(question.id)) return false;
    ids.add(question.id);
    return (
      questionString(question.header, 128) &&
      questionString(question.question, 1024) &&
      (question.options === undefined ||
        list(
          question.options,
          8,
          (option) => questionString(option.label, 128) && questionString(option.description, 1024),
        ))
    );
  });
};
export function isPersonalAgentHello(value: unknown): value is PersonalAgentHello {
  return (
    record(value) &&
    value.protocolVersion === 2 &&
    value.personalOnly === true &&
    string(value.runtimeID) &&
    isExecutionCapability(value) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 64 &&
    value.capabilities.every((item: unknown) => string(item, 128)) &&
    value.capabilities.includes("agents.v2")
  );
}

const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const optionalReference = (value: unknown) => value === undefined || reference(value);
const timestamp = (value: unknown): value is number =>
  integer(value) && Number(value) <= 8_640_000_000_000_000;
const phase = (value: unknown) =>
  ["observed", "attemptStarted", "attemptEnded", "uncertain"].includes(String(value));
const provider = (value: unknown) => value === "codex" || value === "claudeCode";
const jsonBytes = (value: unknown) => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
};
const sha256 = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
// Delegation objects are flat, with fixed ASCII keys, references and integer/array values.
const delegationFingerprint = (value: Record<string, unknown>) =>
  Array.from(
    hashSHA256(
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        ),
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

function nativeDelegations(value: unknown, snapshot: Record<string, unknown>): boolean {
  if (value === undefined) return true;
  if (
    !record(value) ||
    value.derivedOnly !== true ||
    value.authority !== "nativeParent" ||
    value.completionVerified !== false ||
    snapshot.mode !== "observeOnly" ||
    snapshot.executionAvailable !== false ||
    snapshot.revoked !== false ||
    !record(value.history) ||
    value.history.bounded !== true ||
    value.history.limit !== 100 ||
    !integer(value.history.total) ||
    value.history.total > 4096 ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    value.history.returned !== value.items.length ||
    value.history.total < value.items.length ||
    !(value.nextBefore == null
      ? value.history.total === value.items.length
      : integer(value.nextBefore) &&
        value.nextBefore > 0 &&
        value.nextBefore === value.history.total - value.items.length)
  )
    return false;
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents.filter(record) : [];
  const runs = new Set<string>(),
    commands = new Set<string>(),
    children = new Set<string>();
  const runtimeRuns = new Set<string>();
  return value.items.every((item: unknown) => {
    if (!record(item) || !record(item.binding) || !record(item.observation)) return false;
    const b = item.binding,
      o = item.observation;
    if (
      Object.keys(b).some(
        (k) =>
          ![
            "agentID",
            "conversationID",
            "nativeProjectID",
            "nativeTaskID",
            "nativeRunID",
            "nativeCommandID",
            "nativeParentRunID",
            "childRunID",
            "runtimeID",
            "runtimeRunID",
            "providerID",
          ].includes(k),
      ) ||
      Object.keys(o).some(
        (k) =>
          ![
            "sequence",
            "phase",
            "observedAt",
            "providerSessionID",
            "providerTurnID",
            "artifactRefs",
          ].includes(k),
      ) ||
      ![
        "agentID",
        "conversationID",
        "nativeProjectID",
        "nativeTaskID",
        "nativeRunID",
        "nativeCommandID",
        "childRunID",
        "runtimeID",
        "runtimeRunID",
      ].every((k) => reference(b[k])) ||
      !optionalReference(b.nativeParentRunID) ||
      b.nativeParentRunID === b.nativeRunID ||
      !provider(b.providerID) ||
      !sha256(item.bindingFingerprint) ||
      !sha256(item.observationFingerprint) ||
      !integer(o.sequence) ||
      o.sequence < 1 ||
      !timestamp(o.observedAt) ||
      !phase(o.phase) ||
      !optionalReference(o.providerSessionID) ||
      !optionalReference(o.providerTurnID) ||
      !Array.isArray(o.artifactRefs) ||
      o.artifactRefs.length > 16 ||
      !o.artifactRefs.every(reference) ||
      new Set(o.artifactRefs).size !== o.artifactRefs.length
    )
      return false;
    const agent = agents.find((a) => a.id === b.agentID);
    if (
      !agent ||
      agent.conversationID !== b.conversationID ||
      (agent.projectID != null && agent.projectID !== b.nativeProjectID)
    )
      return false;
    if (
      delegationFingerprint(b) !== item.bindingFingerprint ||
      delegationFingerprint(o) !== item.observationFingerprint
    )
      return false;
    // Matching correlation fingerprints still never authorize UI actions.
    for (const [set, id] of [
      [runs, b.nativeRunID],
      [commands, b.nativeCommandID],
      [children, b.childRunID],
      [runtimeRuns, `${String(b.runtimeID)}|${String(b.runtimeRunID)}`],
    ] as const) {
      if (typeof id !== "string" || set.has(id)) return false;
      set.add(id);
    }
    return true;
  });
}

function canonicalTasks(value: unknown, snapshot: Record<string, unknown>): boolean {
  if (value === undefined) return true;
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !reference(value.projectionGeneration) ||
    !integer(value.revision) ||
    value.helperRuntimeID !== snapshot.runtimeID ||
    value.helperRevision !== snapshot.revision ||
    !timestamp(value.checkedAtMs) ||
    !["ready", "unavailable"].includes(String(value.state)) ||
    jsonBytes(value) > 65_536 ||
    !record(value.history) ||
    value.history.bounded !== true ||
    value.history.taskLimit !== 20 ||
    value.history.runLimit !== 40 ||
    typeof value.history.hasMore !== "boolean" ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    value.history.returnedTasks !== value.items.length ||
    ((value.state === "unavailable" || snapshot.revoked === true) && value.items.length !== 0)
  )
    return false;
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents.filter(record) : [];
  const taskIDs = new Set<string>(),
    commandIDs = new Set<string>();
  const runs = new Map<string, Record<string, unknown>>();
  let count = 0;
  for (const task of value.items as unknown[]) {
    if (
      !record(task) ||
      !["agentID", "conversationID", "nativeProjectID", "nativeTaskID"].every((k) =>
        reference(task[k]),
      ) ||
      typeof task.title !== "string" ||
      !task.title.trim() ||
      new TextEncoder().encode(task.title).length > 240 ||
      /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(task.title) ||
      !["todo", "working", "needsReview", "completionUnverified"].includes(
        String(task.displayStatus),
      ) ||
      !Array.isArray(task.runs) ||
      task.runs.length === 0 ||
      task.runs.length > 40
    )
      return false;
    const agent = agents.find((a) => a.id === task.agentID);
    if (
      !agent ||
      agent.conversationID !== task.conversationID ||
      (agent.projectID != null && agent.projectID !== task.nativeProjectID)
    )
      return false;
    const taskKey = `${String(task.agentID)}|${String(task.nativeTaskID)}`;
    if (taskIDs.has(taskKey)) return false;
    taskIDs.add(taskKey);
    for (const run of task.runs as unknown[]) {
      if (
        !record(run) ||
        !reference(run.nativeRunID) ||
        !reference(run.nativeCommandID) ||
        !optionalReference(run.nativeParentRunID) ||
        run.nativeParentRunID === run.nativeRunID ||
        !provider(run.providerID) ||
        !["root", "included", "outsideWindow"].includes(String(run.parentVisibility)) ||
        (run.parentVisibility === "root") !== (run.nativeParentRunID === undefined) ||
        ![
          "reserved",
          "dispatching",
          "acknowledged",
          "attemptFinished",
          "verified",
          "uncertain",
        ].includes(String(run.commandState)) ||
        !["unverified", "reviewed"].includes(String(run.resultReview)) ||
        (run.resultReview === "reviewed" && run.commandState !== "verified") ||
        !optionalReference(run.reportedChildRunID) ||
        runs.has(run.nativeRunID) ||
        commandIDs.has(run.nativeCommandID)
      )
        return false;
      if (run.attemptObservation !== undefined) {
        const o = run.attemptObservation;
        if (
          !record(o) ||
          !phase(o.phase) ||
          !integer(o.sequence) ||
          o.sequence < 1 ||
          !timestamp(o.observedAtMs)
        )
          return false;
      }
      if (run.executionBinding !== undefined) {
        const b = run.executionBinding;
        if (
          !record(b) ||
          !reference(b.runtimeID) ||
          !reference(b.runtimeRunID) ||
          !optionalReference(b.providerSessionID) ||
          !["current", "lastRecorded", "unknown"].includes(String(b.channelPresence))
        )
          return false;
      }
      if (run.providerAttempt !== undefined) {
        const p = run.providerAttempt;
        if (
          !record(p) ||
          !reference(p.threadID) ||
          !reference(p.sessionID) ||
          !optionalReference(p.turnID)
        )
          return false;
      }
      runs.set(run.nativeRunID, run);
      commandIDs.add(run.nativeCommandID);
      if (++count > 40) return false;
    }
  }
  for (const run of runs.values()) {
    if (run.nativeParentRunID === undefined) continue;
    if ((run.parentVisibility === "included") !== runs.has(String(run.nativeParentRunID)))
      return false;
    const visited = new Set<string>([String(run.nativeRunID)]);
    let parent: unknown = run.nativeParentRunID;
    while (typeof parent === "string" && runs.has(parent)) {
      if (visited.has(parent)) return false;
      visited.add(parent);
      parent = runs.get(parent)?.nativeParentRunID;
    }
  }
  return value.history.returnedRuns === count;
}

export const personalAgentCanonicalTaskStatus = (
  status: PersonalAgentCanonicalTask["displayStatus"],
) =>
  ({
    todo: "To do",
    working: "In progress",
    needsReview: "Needs review",
    completionUnverified: "Completion needs checking",
  })[status];
export const personalAgentAttemptPhaseLabel = (
  status: PersonalAgentNativeDelegation["observation"]["phase"],
) =>
  ({
    observed: "Attempt recorded",
    attemptStarted: "Last recorded: started",
    attemptEnded: "Attempt ended",
    uncertain: "Outcome unknown",
  })[status];

export interface PersonalAgentCanonicalCursor {
  generation: string;
  revision: number;
}
/** A fresh read may establish a generation; an unsolicited event cannot replace one. */
export function personalAgentCanonicalFreshness(
  next: PersonalAgentCanonicalTasks | undefined,
  previous: PersonalAgentCanonicalCursor | undefined,
  freshRead: boolean,
): "accept" | "absent" | "stale" | "readRequired" {
  if (!next) return "absent";
  if (previous?.generation === next.projectionGeneration)
    return next.revision < previous.revision ? "stale" : "accept";
  return freshRead ? "accept" : "readRequired";
}

export const personalAgentPlainLabel = (value: string) =>
  value.replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");

export function withoutPersonalAgentCanonicalTasks(
  snapshot: PersonalAgentSnapshot,
): PersonalAgentSnapshot {
  const visible = { ...snapshot };
  delete visible.canonicalTasks;
  return visible;
}

export function isPersonalAgentSnapshot(value: unknown): value is PersonalAgentSnapshot {
  if (
    !record(value) ||
    !integer(value.revision) ||
    !string(value.runtimeID) ||
    !isExecutionCapability(value) ||
    typeof value.revoked !== "boolean"
  )
    return false;
  const history = value.history;
  return (
    list(
      value.agents,
      16,
      (a) =>
        identified(a) &&
        string(a.name, 200) &&
        ["codex", "claudeCode"].includes(String(a.provider)) &&
        string(a.instructions) &&
        optionalString(a.projectID) &&
        string(a.conversationID),
    ) &&
    list(
      value.runs,
      100,
      (r) =>
        identified(r) &&
        string(r.agentID) &&
        string(r.taskID) &&
        string(r.conversationID) &&
        statuses.has(String(r.status)) &&
        string(r.text, 4096) &&
        optionalString(r.error) &&
        string(r.updatedAt),
    ) &&
    list(
      value.messages,
      100,
      (m) =>
        identified(m) &&
        string(m.conversationID) &&
        ["user", "assistant", "system"].includes(String(m.role)) &&
        string(m.text, 8192) &&
        optionalString(m.runID),
    ) &&
    list(
      value.attention,
      16,
      (a) =>
        identified(a) &&
        string(a.runID) &&
        string(a.tool) &&
        string(a.description) &&
        isQuestionAttention(a),
    ) &&
    Array.isArray(value.attention) &&
    value.attention.filter(
      (a: unknown) => record(a) && a.kind === "question" && a.answerable === true,
    ).length <= 4 &&
    list(
      value.artifacts,
      100,
      (a) => identified(a) && string(a.runID) && string(a.name) && string(a.relativePath),
    ) &&
    (history === undefined ||
      (record(history) &&
        history.bounded === true &&
        ["totalRuns", "totalMessages", "runLimit", "messageLimit", "textLimit"].every((key) =>
          integer(history[key]),
        ))) &&
    nativeDelegations(value.nativeDelegations, value) &&
    canonicalTasks(value.canonicalTasks, value)
  );
}
const readSnapshot = (value: Record<string, unknown>) => ({
  revision: value.revision,
  runtimeID: value.runtimeID,
  mode: "live",
  revoked: false,
  agents: [],
  runs: [],
  messages: [],
  attention: [],
  artifacts: [],
});
const boundedText = (value: unknown, limit: number) =>
  typeof value === "string" && new TextEncoder().encode(JSON.stringify(value)).length <= limit;
const publicRun = (value: Record<string, unknown>, textLimit: number) =>
  !("dispatchPhase" in value) &&
  !("providerTurnID" in value) &&
  boundedText(value.text, textLimit) &&
  isPersonalAgentSnapshot({
    ...readSnapshot({ revision: 0, runtimeID: "validation" }),
    runs: [{ ...value, text: "" }],
  });
const readEnvelope = (value: unknown): value is Record<string, unknown> =>
  record(value) &&
  string(value.runtimeID, 256) &&
  Boolean(value.runtimeID) &&
  integer(value.revision) &&
  new TextEncoder().encode(JSON.stringify(value)).length <= 980000;

export function isPersonalAgentHistoryPage(
  value: unknown,
  params: Record<string, unknown>,
): value is PersonalAgentHistoryPage {
  if (
    !readEnvelope(value) ||
    value.collection !== params.collection ||
    !Array.isArray(value.items) ||
    value.items.length > Number(params.limit ?? 20) ||
    value.items.length > 50 ||
    !(value.nextBefore === null || (integer(value.nextBefore) && value.nextBefore > 0)) ||
    (value.nextBefore !== null && value.items.length !== Number(params.limit ?? 20)) ||
    (params.before !== undefined && value.items.length > Number(params.before)) ||
    (params.before !== undefined &&
      value.nextBefore !== null &&
      (Number(value.nextBefore) + value.items.length > Number(params.before) ||
        (params.conversationID === undefined &&
          Number(value.nextBefore) + value.items.length !== Number(params.before))))
  )
    return false;
  const projection = { ...readSnapshot(value), [String(value.collection)]: value.items };
  if (value.collection === "runs") {
    if (!list(value.items, 50, (run) => publicRun(run, 2048))) return false;
  } else if (value.collection === "messages") {
    if (
      !isPersonalAgentSnapshot(projection) ||
      !list(value.items, 50, (message) => boundedText(message.text, 4096))
    )
      return false;
  } else if (value.collection === "artifacts") {
    if (!isPersonalAgentSnapshot(projection)) return false;
  } else return false;
  return (
    params.conversationID === undefined ||
    value.collection === "artifacts" ||
    value.items.every(
      (item: unknown) => record(item) && item.conversationID === params.conversationID,
    )
  );
}

export function isPersonalAgentRunDetail(
  value: unknown,
  runID: unknown,
): value is PersonalAgentRunDetail {
  if (
    !readEnvelope(value) ||
    !record(value.run) ||
    value.run.id !== runID ||
    !publicRun(value.run, 16384) ||
    !integer(value.totalAttention) ||
    !integer(value.totalArtifacts) ||
    !Array.isArray(value.attention) ||
    !Array.isArray(value.artifacts) ||
    !list(value.attention, 16, (item) => item.runID === runID) ||
    !list(value.artifacts, 50, (item) => item.runID === runID) ||
    value.totalAttention < value.attention.length ||
    value.totalArtifacts < value.artifacts.length
  )
    return false;
  return isPersonalAgentSnapshot({
    ...readSnapshot(value),
    attention: value.attention,
    artifacts: value.artifacts,
  });
}

export function decodePersonalAgentCommand(value: unknown): PersonalAgentCommand {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["id", "method", "params"].includes(key)) ||
    !string(value.id, 36) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
    !PERSONAL_AGENT_METHODS.includes(value.method as PersonalAgentMethod) ||
    !record(value.params)
  )
    throw new Error("Invalid personal agent command.");
  const params = value.params;
  const method = value.method as PersonalAgentMethod;
  const keys: Record<PersonalAgentMethod, string[]> = {
    "agents.hello": [],
    "agents.snapshot": [],
    "agents.create": ["name", "provider", "instructions", "projectID"],
    "agents.update": ["agentID", "name", "instructions"],
    "agents.submit": ["agentID", "text", "taskID"],
    "agents.stop": ["runID"],
    "agents.answer": ["attentionID", "allow"],
    "agents.respond": ["attentionID", "answers"],
    "agents.reconcile": ["runID"],
    "agents.artifact": ["artifactID"],
    "agents.history": ["collection", "before", "limit", "conversationID"],
    "agents.run": ["runID"],
  };
  if (
    Object.keys(params).some((key) => !keys[method].includes(key)) ||
    Object.entries(params).some(([key, item]) => {
      if (method === "agents.history") {
        if (key === "before") return !integer(item);
        if (key === "limit") return !integer(item) || item < 1 || item > 50;
        if (key === "collection")
          return typeof item !== "string" || !["runs", "messages", "artifacts"].includes(item);
        if (key === "conversationID") return !questionString(item, 256) || !item.trim();
      }
      if (method === "agents.run") return !questionString(item, 256) || !item.trim();
      if (key === "allow") return typeof item !== "boolean";
      if (key === "answers")
        return (
          !record(item) ||
          Object.keys(item).length === 0 ||
          Object.keys(item).length > 4 ||
          Object.entries(item).some(
            ([id, answers]) =>
              !id ||
              !questionString(id, 128) ||
              !Array.isArray(answers) ||
              answers.length !== 1 ||
              !string(answers[0]) ||
              !answers[0].trim() ||
              new TextEncoder().encode(answers[0]).length > 2048,
          )
        );
      return !string(item);
    })
  )
    throw new Error("Invalid personal agent parameters.");
  const required: Record<PersonalAgentMethod, string[]> = {
    "agents.hello": [],
    "agents.snapshot": [],
    "agents.create": ["name", "provider", "instructions"],
    "agents.update": ["agentID"],
    "agents.submit": ["agentID", "text"],
    "agents.stop": ["runID"],
    "agents.answer": ["attentionID", "allow"],
    "agents.respond": ["attentionID", "answers"],
    "agents.reconcile": ["runID"],
    "agents.artifact": ["artifactID"],
    "agents.history": ["collection"],
    "agents.run": ["runID"],
  };
  if (
    required[method].some((key) => params[key] === undefined) ||
    (method === "agents.create" && !["codex", "claudeCode"].includes(String(params.provider))) ||
    (["agents.create", "agents.submit"].includes(method) &&
      !String(params[method === "agents.create" ? "name" : "text"]).trim())
  )
    throw new Error("Missing personal agent parameters.");
  return { id: value.id, method, params };
}
