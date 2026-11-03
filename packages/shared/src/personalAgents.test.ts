import { describe, expect, it } from "vite-plus/test";
import {
  decodePersonalAgentCommand,
  isPersonalAgentHello,
  isPersonalAgentSnapshot,
  isPersonalAgentHistoryPage,
  isPersonalAgentRunDetail,
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
  it("requires an explicit non-executing observation capability on hello and snapshot", () => {
    const hello = {
      protocolVersion: 2,
      personalOnly: true,
      runtimeID: "runtime",
      mode: "observeOnly",
      executionAvailable: false,
      capabilities: ["agents.v2", "events"],
    };
    expect(isPersonalAgentHello(hello)).toBe(true);
    expect(
      isPersonalAgentSnapshot({ ...snapshot, mode: "observeOnly", executionAvailable: false }),
    ).toBe(true);
    for (const executionAvailable of [undefined, null, true, "false", 0]) {
      expect(isPersonalAgentHello({ ...hello, executionAvailable })).toBe(false);
      expect(
        isPersonalAgentSnapshot({ ...snapshot, mode: "observeOnly", executionAvailable }),
      ).toBe(false);
    }
    for (const mode of ["live", "fake"]) {
      expect(isPersonalAgentHello({ ...hello, mode, executionAvailable: undefined })).toBe(true);
      expect(isPersonalAgentSnapshot({ ...snapshot, mode })).toBe(true);
      expect(isPersonalAgentSnapshot({ ...snapshot, mode, executionAvailable: "false" })).toBe(
        false,
      );
    }
  });
  it("admits bounded runtime history and run parameters without authority overrides", () => {
    for (const params of [
      { collection: "runs" },
      { collection: "artifacts", before: 0, limit: 50, conversationID: "c" },
    ])
      expect(decodePersonalAgentCommand({ id, method: "agents.history", params }).params).toEqual(
        params,
      );
    expect(
      decodePersonalAgentCommand({ id, method: "agents.run", params: { runID: "old" } }).method,
    ).toBe("agents.run");
    for (const params of [
      {},
      { collection: "sessions" },
      { collection: ["runs"] },
      { collection: "runs", before: -1 },
      { collection: "runs", before: 1.5 },
      { collection: "runs", limit: 0 },
      { collection: "runs", limit: 51 },
      { collection: "runs", conversationID: " " },
      { collection: "runs", conversationID: "😀".repeat(65) },
      { collection: "runs", authorityID: "other" },
    ])
      expect(() => decodePersonalAgentCommand({ id, method: "agents.history", params })).toThrow();
    for (const runID of ["", " ", "😀".repeat(65), 4])
      expect(() =>
        decodePersonalAgentCommand({ id, method: "agents.run", params: { runID } }),
      ).toThrow();
  });
  it("validates correlated bounded history pages and detail independently of snapshots", () => {
    const run = {
      id: "old",
      agentID: "a",
      taskID: "t",
      conversationID: "c",
      status: "completed",
      text: "retained",
      createdAt: "now",
      updatedAt: "now",
    };
    const page = {
      runtimeID: "runtime",
      revision: 2,
      collection: "runs",
      items: [run],
      nextBefore: 10,
    };
    const params = { collection: "runs", limit: 1, before: 11, conversationID: "c" };
    expect(isPersonalAgentHistoryPage(page, params)).toBe(true);
    for (const invalid of [
      { ...page, items: [run, run] },
      { ...page, collection: "messages" },
      { ...page, nextBefore: 11 },
      { ...page, nextBefore: -1 },
      { ...page, items: [{ ...run, conversationID: "foreign" }] },
      { ...page, items: [{ ...run, providerTurnID: "private" }] },
      { ...page, items: [{ ...run, text: "x".repeat(2048) }] },
    ])
      expect(isPersonalAgentHistoryPage(invalid, params)).toBe(false);
    const detail = {
      runtimeID: "runtime",
      revision: 2,
      run: { ...run, text: "x".repeat(8000) },
      attention: [],
      artifacts: [],
      totalAttention: 0,
      totalArtifacts: 0,
    };
    expect(isPersonalAgentRunDetail(detail, "old")).toBe(true);
    expect(isPersonalAgentRunDetail(detail, "foreign")).toBe(false);
    expect(
      isPersonalAgentRunDetail({ ...detail, run: { ...run, text: "x".repeat(16384) } }, "old"),
    ).toBe(false);
    expect(
      isPersonalAgentRunDetail({ ...detail, attention: [{ id: "bad", runID: "foreign" }] }, "old"),
    ).toBe(false);
    const artifact = {
      id: "artifact",
      runID: "old",
      name: "result.txt",
      relativePath: "artifacts/result.txt",
      createdAt: "now",
    };
    expect(
      isPersonalAgentHistoryPage(
        { ...page, collection: "artifacts", items: [artifact] },
        { ...params, collection: "artifacts" },
      ),
    ).toBe(true);
    expect(
      isPersonalAgentRunDetail({ ...detail, artifacts: [artifact], totalArtifacts: 0 }, "old"),
    ).toBe(false);
  });
  it("keeps legacy approval metadata readable but refuses a nonboolean answerable flag", () => {
    const approval = {
      id: "approval",
      runID: "r",
      tool: "read",
      description: "Read",
      createdAt: "now",
    };
    for (const value of [
      approval,
      { ...approval, answerable: true },
      { ...approval, answerable: false },
    ])
      expect(isPersonalAgentSnapshot({ ...snapshot, attention: [value] })).toBe(true);
    expect(
      isPersonalAgentSnapshot({ ...snapshot, attention: [{ ...approval, answerable: "true" }] }),
    ).toBe(false);
  });
  it("rejects overlapping cursors and permits skipped indices only for filtered history", () => {
    const items = ["first", "second"].map((id) => ({
      id,
      conversationID: "c",
      role: "assistant",
      text: "Retained message",
      createdAt: "now",
    }));
    const page = {
      runtimeID: "runtime",
      revision: 2,
      collection: "messages",
      items,
      nextBefore: 10,
    };
    const params = { collection: "messages", before: 11, limit: 2 };
    expect(isPersonalAgentHistoryPage(page, params)).toBe(false);
    expect(isPersonalAgentHistoryPage(page, { ...params, conversationID: "c" })).toBe(false);
    expect(isPersonalAgentHistoryPage({ ...page, nextBefore: 9 }, params)).toBe(true);
    expect(isPersonalAgentHistoryPage({ ...page, nextBefore: 7 }, params)).toBe(false);
    expect(
      isPersonalAgentHistoryPage({ ...page, nextBefore: 7 }, { ...params, conversationID: "c" }),
    ).toBe(true);
  });
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
