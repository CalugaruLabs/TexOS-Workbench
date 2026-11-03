import {
  PERSONAL_AGENT_METHODS,
  type PersonalAgentMethod,
  type PersonalAgentCommand,
  type PersonalAgentRunStatus,
  type PersonalAgentHello,
  type PersonalAgentSnapshot,
  type PersonalAgentHistoryPage,
  type PersonalAgentRunDetail,
} from "@t3tools/contracts";

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
    ["live", "fake"].includes(String(value.mode)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 64 &&
    value.capabilities.every((item: unknown) => string(item, 128)) &&
    value.capabilities.includes("agents.v2")
  );
}
export function isPersonalAgentSnapshot(value: unknown): value is PersonalAgentSnapshot {
  if (
    !record(value) ||
    !integer(value.revision) ||
    !string(value.runtimeID) ||
    !["live", "fake"].includes(String(value.mode)) ||
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
        )))
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
