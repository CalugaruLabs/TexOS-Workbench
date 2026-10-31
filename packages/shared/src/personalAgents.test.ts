import { describe, expect, it } from "vite-plus/test";
import {
  decodePersonalAgentCommand,
  isPersonalAgentHello,
  isPersonalAgentSnapshot,
} from "./personalAgents.ts";

const id = "00000000-0000-4000-8000-000000000001";
const snapshot = {
  revision: 1,
  runtimeID: "runtime",
  mode: "fake",
  revoked: false,
  agents: [],
  runs: [],
  messages: [],
  attention: [],
  artifacts: [],
};
describe("personal agents presentation contract", () => {
  it("accepts negotiated personal capability and bounded snapshots", () => {
    expect(
      isPersonalAgentHello({
        protocolVersion: 2,
        personalOnly: true,
        runtimeID: "runtime",
        mode: "fake",
        capabilities: ["agents.v2"],
      }),
    ).toBe(true);
    expect(
      isPersonalAgentHello({
        protocolVersion: 2,
        personalOnly: true,
        runtimeID: "runtime",
        mode: "fake",
        capabilities: ["browser"],
      }),
    ).toBe(false);
    expect(isPersonalAgentSnapshot(snapshot)).toBe(true);
    expect(
      isPersonalAgentSnapshot({
        ...snapshot,
        history: {
          bounded: true,
          totalRuns: 200,
          totalMessages: 300,
          runLimit: 100,
          messageLimit: 100,
          textLimit: 4096,
        },
      }),
    ).toBe(true);
    expect(isPersonalAgentSnapshot({ ...snapshot, runs: [{ id }] })).toBe(false);
    expect(
      isPersonalAgentSnapshot({ ...snapshot, messages: Array.from({ length: 101 }, () => ({})) }),
    ).toBe(false);
  });
  it("rejects authority overrides, execution paths, unknown operations, and malformed action parameters", () => {
    const command = { id, method: "agents.submit", params: { agentID: "agent", text: "Continue" } };
    expect(decodePersonalAgentCommand(command)).toEqual(command);
    for (const value of [
      { ...command, authorityID: "another-space" },
      { ...command, params: { ...command.params, workspacePath: "/private" } },
      { ...command, method: "agents.revoke" },
      { ...command, params: { agentID: "agent", text: " " } },
      { ...command, method: "agents.answer", params: { attentionID: "attention", allow: "true" } },
      {
        ...command,
        method: "agents.create",
        params: { name: "Agent", provider: "other", instructions: "" },
      },
    ])
      expect(() => decodePersonalAgentCommand(value)).toThrow();
  });
  it("validates bounded question metadata and single-answer response shapes", () => {
    const question = {
      id: "direction",
      header: "Direction",
      question: "Which direction should I take?",
      options: [{ label: "Pilot", description: "Start with a small pilot." }],
    };
    const attention = {
      id: "question-request",
      runID: "run",
      tool: "request_user_input",
      description: "Choose direction",
      createdAt: "now",
      kind: "question",
      isBlocking: true,
      answerable: true,
      questions: [question],
    };
    expect(isPersonalAgentSnapshot({ ...snapshot, attention: [attention] })).toBe(true);
    expect(
      isPersonalAgentSnapshot({ ...snapshot, attention: [{ ...attention, answerable: false }] }),
    ).toBe(true);
    for (const invalid of [
      { ...attention, answerable: undefined },
      { ...attention, questions: [] },
      { ...attention, questions: [question, question] },
      { ...attention, questions: [{ ...question, question: "x".repeat(1025) }] },
      {
        ...attention,
        questions: [{ ...question, options: Array.from({ length: 9 }, () => question.options[0]) }],
      },
    ])
      expect(isPersonalAgentSnapshot({ ...snapshot, attention: [invalid] })).toBe(false);
    const command = {
      id,
      method: "agents.respond",
      params: { attentionID: "question-request", answers: { direction: ["Pilot"] } },
    };
    expect(decodePersonalAgentCommand(command)).toEqual(command);
    for (const answers of [
      {},
      { direction: [] },
      { direction: ["a", "b"] },
      { direction: [""] },
      { direction: ["é".repeat(1025)] },
      { direction: "Pilot" },
    ])
      expect(() =>
        decodePersonalAgentCommand({
          ...command,
          params: { attentionID: "question-request", answers },
        }),
      ).toThrow();
  });
});
