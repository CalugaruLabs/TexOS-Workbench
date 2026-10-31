import {
  PERSONAL_AGENT_METHODS,
  type PersonalAgentMethod,
  type PersonalAgentCommand,
  type PersonalAgentRunStatus,
  type PersonalAgentHello,
  type PersonalAgentSnapshot,
} from "@t3tools/contracts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown, limit = 8192): value is string =>
  typeof value === "string" && value.length <= limit;
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
  if (value.kind === undefined) return true;
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
    if (!string(question.id, 128) || !question.id || ids.has(question.id)) return false;
    ids.add(question.id);
    return (
      string(question.header, 128) &&
      string(question.question, 1024) &&
      (question.options === undefined ||
        list(
          question.options,
          8,
          (option) => string(option.label, 128) && string(option.description, 1024),
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
    value.attention.filter((a: unknown) => record(a) && a.kind === "question").length <= 4 &&
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
  };
  if (
    Object.keys(params).some((key) => !keys[method].includes(key)) ||
    Object.entries(params).some(([key, item]) => {
      if (key === "allow") return typeof item !== "boolean";
      if (key === "answers")
        return (
          !record(item) ||
          Object.keys(item).length === 0 ||
          Object.keys(item).length > 4 ||
          Object.entries(item).some(
            ([id, answers]) =>
              !id ||
              id.length > 128 ||
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
