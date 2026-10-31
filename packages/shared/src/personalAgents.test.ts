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
  it("retains recovered questions alongside new answerable work within the global attention limit", () => {
    const question = (index: number, answerable: boolean) => ({
      id: `request-${index}`,
      runID: `run-${index}`,
      tool: "request_user_input",
      description: "Synthetic recovery question",
      createdAt: "now",
      kind: "question",
      isBlocking: true,
      answerable,
      questions: [{ id: "direction", header: "Direction", question: "What next?" }],
    });
    const stale = Array.from({ length: 4 }, (_, index) => question(index, false));
    expect(isPersonalAgentSnapshot({ ...snapshot, attention: [...stale, question(4, true)] })).toBe(
      true,
    );
    expect(
      isPersonalAgentSnapshot({
        ...snapshot,
        attention: Array.from({ length: 5 }, (_, index) => question(index, true)),
      }),
    ).toBe(false);
    expect(
      isPersonalAgentSnapshot({
        ...snapshot,
        attention: Array.from({ length: 16 }, (_, index) => question(index, false)),
      }),
    ).toBe(true);
    expect(
      isPersonalAgentSnapshot({
        ...snapshot,
        attention: Array.from({ length: 17 }, (_, index) => question(index, false)),
      }),
    ).toBe(false);
  });
  it("uses UTF-8 byte boundaries for question fields and answer IDs", () => {
    const question = {
      id: "😀".repeat(32),
      header: "😀".repeat(32),
      question: "😀".repeat(256),
      options: [{ label: "😀".repeat(32), description: "😀".repeat(256) }],
    };
    const attention = {
      id: "request",
      runID: "run",
      tool: "request_user_input",
      description: "Synthetic UTF-8 boundary",
      createdAt: "now",
      kind: "question",
      isBlocking: true,
      answerable: true,
      questions: [question],
    };
    expect(isPersonalAgentSnapshot({ ...snapshot, attention: [attention] })).toBe(true);
    for (const invalid of [
      { ...question, id: "😀".repeat(33) },
      { ...question, header: "😀".repeat(33) },
      { ...question, header: "😀".repeat(65) },
      { ...question, question: "😀".repeat(257) },
      { ...question, options: [{ ...question.options[0], label: "😀".repeat(33) }] },
      { ...question, options: [{ ...question.options[0], description: "😀".repeat(257) }] },
    ])
      expect(
        isPersonalAgentSnapshot({
          ...snapshot,
          attention: [{ ...attention, questions: [invalid] }],
        }),
      ).toBe(false);
    const command = {
      id,
      method: "agents.respond",
      params: { attentionID: "request", answers: { [question.id]: ["Continue"] } },
    };
    expect(decodePersonalAgentCommand(command)).toEqual(command);
    expect(() =>
      decodePersonalAgentCommand({
        ...command,
        params: { attentionID: "request", answers: { ["😀".repeat(33)]: ["Continue"] } },
      }),
    ).toThrow();
  });
});
