import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - Independent test-only digest implementation; no provider or I/O.
import * as NodeCrypto from "node:crypto";
import canonicalSnapshot from "../../contracts/test-fixtures/personal-agent-canonical-tasks.json" with { type: "json" };
import {
  decodePersonalAgentCommand,
  isPersonalAgentHello,
  isPersonalAgentSnapshot,
  isPersonalAgentHistoryPage,
  isPersonalAgentRunDetail,
  personalAgentCanonicalFreshness,
  personalAgentPlainLabel,
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
  it("preserves old snapshots while separating native tasks from ended attempts", () => {
    expect(isPersonalAgentSnapshot(snapshot)).toBe(true);
    expect(isPersonalAgentSnapshot(canonicalSnapshot)).toBe(true);
    const changed = structuredClone(canonicalSnapshot);
    changed.canonicalTasks.items[0]!.displayStatus = "completionUnverified";
    expect(isPersonalAgentSnapshot(changed)).toBe(true);
    expect(canonicalSnapshot.runs[0]!.status).toBe("completed");
    expect(canonicalSnapshot.canonicalTasks.items[0]!.displayStatus).toBe("working");
    expect(canonicalSnapshot.canonicalTasks.items[0]!.runs.map((run) => run.providerID)).toEqual([
      "codex",
      "claudeCode",
    ]);
  });
  it("rejects malformed, foreign or contradictory native presentation without inventing Done", () => {
    const mutations: Array<(value: typeof canonicalSnapshot) => void> = [
      (value) => {
        value.canonicalTasks.helperRuntimeID = "foreign";
      },
      (value) => {
        value.canonicalTasks.helperRevision = 2;
      },
      (value) => {
        value.canonicalTasks.revision = Number.MAX_SAFE_INTEGER + 1;
      },
      (value) => {
        value.canonicalTasks.checkedAtMs = Infinity;
      },
      (value) => {
        value.canonicalTasks.items[0]!.title = "\u202eSpoofed";
      },
      (value) => {
        value.canonicalTasks.items[0]!.title = "😀".repeat(61);
      },
      (value) => {
        value.canonicalTasks.items[0]!.displayStatus = "done";
      },
      (value) => {
        value.canonicalTasks.items[0]!.conversationID = "foreign";
      },
      (value) => {
        value.canonicalTasks.items[0]!.nativeProjectID = "foreign";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[0]!.resultReview = "reviewed";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[1]!.nativeCommandID = "command-codex";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[1]!.nativeRunID = "run-codex";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[1]!.parentVisibility = "root";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[1]!.nativeParentRunID = "run-claude";
      },
      (value) => {
        value.canonicalTasks.items[0]!.runs[1]!.nativeParentRunID = "missing";
      },
      (value) => {
        value.canonicalTasks.history.returnedRuns = 1;
      },
      (value) => {
        value.canonicalTasks.state = "unavailable";
      },
      (value) => {
        value.revoked = true;
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(canonicalSnapshot);
      mutate(value);
      expect(isPersonalAgentSnapshot(value)).toBe(false);
    }
    const withEmoji = structuredClone(canonicalSnapshot);
    withEmoji.canonicalTasks.items[0]!.title = "Build 👩🏽‍💻";
    expect(isPersonalAgentSnapshot(withEmoji)).toBe(true);
    expect(personalAgentPlainLabel("Builder\u202e\n")).toBe("Builder");
  });
  it("bounds the added native collection independently of the helper snapshot", () => {
    const value = structuredClone(canonicalSnapshot);
    const template = value.canonicalTasks.items[0]!.runs[0]!;
    const runs = Array.from({ length: 40 }, (_, index) => ({
      ...structuredClone(template),
      nativeRunID: `run-${String(index).padStart(3, "0")}-${"r".repeat(240)}`,
      nativeCommandID: `command-${String(index).padStart(3, "0")}-${"c".repeat(240)}`,
      reportedChildRunID: "d".repeat(256),
      providerAttempt: {
        threadID: "t".repeat(256),
        sessionID: "s".repeat(256),
        turnID: "u".repeat(256),
      },
      executionBinding: {
        runtimeID: "h".repeat(256),
        runtimeRunID: "e".repeat(256),
        channelPresence: "lastRecorded",
      },
    }));
    const oversized = {
      ...value,
      canonicalTasks: {
        ...value.canonicalTasks,
        items: [{ ...value.canonicalTasks.items[0]!, runs }],
        history: { ...value.canonicalTasks.history, returnedRuns: 40 },
      },
    };
    expect(
      new TextEncoder().encode(JSON.stringify(oversized.canonicalTasks)).length,
    ).toBeGreaterThan(65536);
    expect(isPersonalAgentSnapshot(oversized)).toBe(false);
  });
  it("validates R2 correlation digests with a separate Node digest oracle", () => {
    const binding = {
      agentID: "builder",
      conversationID: "conversation",
      nativeProjectID: "project",
      nativeTaskID: "canonical-task",
      nativeRunID: "run-codex",
      nativeCommandID: "command-codex",
      childRunID: "child",
      runtimeID: "execution-runtime",
      runtimeRunID: "executor-codex",
      providerID: "codex",
    };
    const observation = {
      sequence: 2,
      phase: "attemptEnded",
      observedAt: 1800000000000,
      artifactRefs: [],
    };
    const fingerprint = (value: object) =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify(value, Object.keys(value).sort()))
        .digest("hex");
    const item = {
      binding,
      observation,
      bindingFingerprint: fingerprint(binding),
      observationFingerprint: fingerprint(observation),
    };
    const nativeDelegations = {
      derivedOnly: true,
      authority: "nativeParent",
      completionVerified: false,
      items: [item],
      nextBefore: null,
      history: { bounded: true, total: 1, returned: 1, limit: 100 },
    };
    const value = {
      ...structuredClone(canonicalSnapshot),
      mode: "observeOnly",
      executionAvailable: false,
      nativeDelegations,
    };
    expect(isPersonalAgentSnapshot(value)).toBe(true);
    binding.nativeTaskID = "tampered";
    expect(isPersonalAgentSnapshot(value)).toBe(false);
    binding.nativeTaskID = "canonical-task";
    nativeDelegations.completionVerified = true;
    expect(isPersonalAgentSnapshot(value)).toBe(false);
  });
  it("requires an explicit read to establish a projection generation and rejects lower revisions", () => {
    const tasks = canonicalSnapshot.canonicalTasks;
    if (!isPersonalAgentSnapshot(canonicalSnapshot) || !canonicalSnapshot.canonicalTasks)
      throw new Error("Invalid fixture");
    const current = canonicalSnapshot.canonicalTasks;
    expect(personalAgentCanonicalFreshness(current, undefined, false)).toBe("readRequired");
    expect(personalAgentCanonicalFreshness(current, undefined, true)).toBe("accept");
    const cursor = { generation: current.projectionGeneration, revision: 2 };
    expect(personalAgentCanonicalFreshness(current, cursor, false)).toBe("stale");
    expect(personalAgentCanonicalFreshness({ ...current, revision: 3 }, cursor, false)).toBe(
      "accept",
    );
    expect(
      personalAgentCanonicalFreshness(
        { ...current, projectionGeneration: "projection-B" },
        cursor,
        false,
      ),
    ).toBe("readRequired");
    expect(tasks.revision).toBe(1);
  });
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
