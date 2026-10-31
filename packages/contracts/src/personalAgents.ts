export type PersonalAgentProvider = "codex" | "claudeCode";
export type PersonalAgentRunStatus =
  | "queued"
  | "running"
  | "waitingForApproval"
  | "waitingForInput"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed"
  | "interrupted"
  | "needsReconciliation";
export interface PersonalAgent {
  id: string;
  name: string;
  provider: PersonalAgentProvider;
  instructions: string;
  projectID?: string | null;
  conversationID: string;
  createdAt: string;
}
export interface PersonalAgentRun {
  id: string;
  agentID: string;
  taskID: string;
  conversationID: string;
  status: PersonalAgentRunStatus;
  text: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PersonalAgentQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
}
export type PersonalAgentAttention = {
  id: string;
  runID: string;
  tool: string;
  description: string;
  createdAt: string;
} & (
  | { kind?: undefined }
  | {
      kind: "question";
      questions: PersonalAgentQuestion[];
      isBlocking: boolean;
      answerable: boolean;
    }
);
export interface PersonalAgentSnapshot {
  revision: number;
  runtimeID: string;
  mode: "live" | "fake";
  revoked: boolean;
  agents: PersonalAgent[];
  runs: PersonalAgentRun[];
  messages: Array<{
    id: string;
    conversationID: string;
    role: "user" | "assistant" | "system";
    text: string;
    runID?: string | null;
    createdAt: string;
  }>;
  attention: PersonalAgentAttention[];
  artifacts: Array<{
    id: string;
    runID: string;
    name: string;
    relativePath: string;
    createdAt: string;
  }>;
  history?: {
    bounded: true;
    totalRuns: number;
    totalMessages: number;
    runLimit: number;
    messageLimit: number;
    textLimit: number;
  };
}
export interface PersonalAgentHello {
  protocolVersion: 2;
  personalOnly: true;
  runtimeID: string;
  mode: "live" | "fake";
  capabilities: string[];
}
export const PERSONAL_AGENT_METHODS = [
  "agents.hello",
  "agents.snapshot",
  "agents.create",
  "agents.update",
  "agents.submit",
  "agents.stop",
  "agents.answer",
  "agents.respond",
  "agents.reconcile",
  "agents.artifact",
] as const;
export type PersonalAgentMethod = (typeof PERSONAL_AGENT_METHODS)[number];
export interface PersonalAgentCommand {
  id: string;
  method: PersonalAgentMethod;
  params: Record<string, unknown>;
}
export interface PersonalAgentEvent {
  version: 2;
  kind: "event";
  authorityID: string;
  sequence: number;
  event: "snapshot";
  snapshot: PersonalAgentSnapshot;
}
export type PersonalAgentResponse =
  | { version: 2; kind: "response"; id: string; ok: true; result: unknown }
  | {
      version: 2;
      kind: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };
