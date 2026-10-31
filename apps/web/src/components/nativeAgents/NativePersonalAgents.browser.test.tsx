import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { PersonalAgentSnapshot } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { NativePersonalAgents } from "./NativePersonalAgents";
import {
  PersonalAgentClient,
  safePersonalArtifactHTML,
  type PersonalAgentTransport,
} from "./personalAgentClient";
import "../../index.css";

function fixture(questionMode?: "answerable" | "stale") {
  const now = "2026-10-30T00:00:00Z";
  const snapshot: PersonalAgentSnapshot = {
    revision: 1,
    runtimeID: "synthetic-workbench-runtime",
    mode: "fake",
    revoked: false,
    agents: [
      {
        id: "codex-agent",
        name: "Builder",
        provider: "codex",
        instructions: "Build a small work brief.",
        conversationID: "codex-conversation",
        createdAt: now,
      },
      {
        id: "claude-agent",
        name: "Reviewer",
        provider: "claudeCode",
        instructions: "Review the resulting checklist.",
        conversationID: "claude-conversation",
        createdAt: now,
      },
    ],
    runs: [
      {
        id: "build-run",
        agentID: "codex-agent",
        taskID: "synthetic-task",
        conversationID: "codex-conversation",
        status: "completed",
        text: "Create the Work Brief",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "review-run",
        agentID: "claude-agent",
        taskID: "synthetic-task",
        conversationID: "claude-conversation",
        status: "waitingForApproval",
        text: "Review the Work Brief",
        createdAt: now,
        updatedAt: now,
      },
    ],
    messages: [
      {
        id: "user-message",
        conversationID: "codex-conversation",
        role: "user",
        text: "Make a checklist for handing off the Work Brief.",
        runID: "build-run",
        createdAt: now,
      },
      {
        id: "builder-message",
        conversationID: "codex-conversation",
        role: "assistant",
        text: "The checklist is ready. It covers the objective, owner, review, and next action.",
        runID: "build-run",
        createdAt: now,
      },
      {
        id: "review-message",
        conversationID: "claude-conversation",
        role: "assistant",
        text: "I’m ready to inspect the checklist. This synthetic request is waiting for your decision.",
        runID: "review-run",
        createdAt: now,
      },
    ],
    attention: [
      {
        id: "review-approval",
        runID: "review-run",
        tool: "read_file",
        description: "Read the synthetic Work Brief checklist",
        createdAt: now,
      },
    ],
    artifacts: [
      {
        id: "work-brief",
        runID: "build-run",
        name: "work-brief.html",
        relativePath: "results/work-brief.html",
        createdAt: now,
      },
    ],
    history: {
      bounded: true,
      totalRuns: 2,
      totalMessages: 3,
      runLimit: 100,
      messageLimit: 100,
      textLimit: 4096,
    },
  };
  if (questionMode) {
    snapshot.runs[1]!.status = questionMode === "stale" ? "needsReconciliation" : "waitingForInput";
    snapshot.attention = [
      {
        id: "direction-request",
        runID: "review-run",
        tool: "request_user_input",
        description: "Decide the next step",
        createdAt: now,
        kind: "question",
        isBlocking: true,
        answerable: questionMode === "answerable",
        questions: [
          {
            id: "direction",
            header: "Direction",
            question: "How should I proceed?",
            options: [
              { label: "Small pilot", description: "Keep the first step bounded." },
              { label: "Full rollout", description: "Expand the scope." },
            ],
          },
          { id: "constructor", header: "Next action", question: "What should I do first?" },
        ],
      },
    ];
  }
  const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let serial = 0;
  const stream: ReturnType<PersonalAgentTransport["events"]> = {
    onopen: null,
    onmessage: null,
    onerror: null,
    close() {},
  };
  const client = new PersonalAgentClient({
    uuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
    events: () => stream,
    async command(method, params) {
      commands.push({ method, params });
      if (method === "agents.hello")
        return {
          protocolVersion: 2,
          personalOnly: true,
          runtimeID: snapshot.runtimeID,
          mode: "fake",
          capabilities: ["agents.v2", "queue", "permissions", "events", "questions"],
        };
      if (method === "agents.snapshot") return structuredClone(snapshot);
      if (method === "agents.artifact") {
        const html =
          "<!doctype html><html><body><h1>Work Brief</h1><p>Synthetic component fixture</p><ul><li>Confirm objective</li><li>Assign owner</li><li>Review checklist</li><li>Retain next action</li></ul></body></html>";
        const bytes = new TextEncoder().encode(html);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return {
          id: "work-brief",
          name: "work-brief.html",
          mimeType: "text/html",
          base64: btoa(html),
          sha256: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        };
      }
      snapshot.revision += 1;
      if (method === "agents.submit")
        snapshot.runs.push({
          id: `queued-${serial}`,
          agentID: String(params.agentID),
          taskID: "follow-up",
          conversationID: "codex-conversation",
          status: "queued",
          text: String(params.text),
          createdAt: now,
          updatedAt: now,
        });
      if (method === "agents.answer" || method === "agents.respond") {
        snapshot.attention = [];
        snapshot.runs[1]!.status = "completed";
      }
      if (method === "agents.stop") {
        const run = snapshot.runs.find((item) => item.id === params.runID);
        if (run) run.status = "stopped";
      }
      if (method === "agents.update") {
        const agent = snapshot.agents.find((item) => item.id === params.agentID);
        if (agent) agent.name = String(params.name);
      }
      return { snapshot: structuredClone(snapshot) };
    },
  });
  return { client, commands };
}

it("shows native agents, verified results, approvals and follow-up without provider dispatch", async () => {
  const f = fixture();
  await page.viewport(1200, 900);
  // This component has no routing dependencies; its native transport is injected for synthetic proof.
  await using screen = await render(
    <div>
      <p>Synthetic Workbench component fixture · no provider execution</p>
      <NativePersonalAgents client={f.client} />
    </div>,
    { router: false },
  );
  await expect.element(screen.getByRole("button", { name: "Agents", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Agents", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Personal agents", exact: true }))
    .toBeVisible();
  await expect.element(page.getByText("Test mode · simulated providers")).toBeVisible();
  await page.getByRole("button", { name: "work-brief.html", exact: true }).click();
  await expect.element(page.getByTitle("work-brief.html")).toBeVisible();
  await page.screenshot({ path: "../../../../../.t3/personal-agents-results-fixture.png" });
  await act(async () => {
    const input = page.getByRole("textbox", { name: "Message Builder" });
    await input.click();
    await input.fill("Keep the same conversation and add a next action.");
  });
  expect(f.client.getSnapshot().connected).toBe(true);
  expect(f.client.getSnapshot().busy).toBe(false);
  await expect
    .element(page.getByRole("textbox", { name: "Message Builder" }))
    .toHaveValue("Keep the same conversation and add a next action.");
  await expect.element(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(page.getByText("queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.element(page.getByText("stopped", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reviewer", exact: true }).click();
  await expect
    .element(page.getByText("read_file: Read the synthetic Work Brief checklist"))
    .toBeVisible();
  await page.screenshot({ path: "../../../../../.t3/personal-agents-approval-fixture.png" });
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Allow once", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Edit agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Review partner");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Review partner", exact: true }))
    .toBeVisible();
  expect(f.commands.filter((command) => command.method === "agents.submit")).toEqual([
    {
      method: "agents.submit",
      params: { agentID: "codex-agent", text: "Keep the same conversation and add a next action." },
    },
  ]);
});

it("removes active content and navigation before loading an HTML result", () => {
  const document = new DOMParser().parseFromString(
    safePersonalArtifactHTML(
      '<script>alert(1)</script><a href="https://example.com">Open</a><img src="https://example.com/pixel" onerror="alert(1)"><form action="https://example.com"><input></form><meta http-equiv="refresh" content="0;url=https://example.com">',
    ),
    "text/html",
  );
  expect(document.querySelector("script,form,meta[http-equiv=refresh]")).toBeNull();
  expect(document.querySelector("a")?.hasAttribute("href")).toBe(false);
  expect(document.querySelector("img")?.hasAttribute("src")).toBe(false);
  expect(document.querySelector("img")?.hasAttribute("onerror")).toBe(false);
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("default-src 'none'");
});

it("submits choices and free-form answers to the same pending request", async () => {
  const f = fixture("answerable");
  await using screen = await render(<NativePersonalAgents client={f.client} />, { router: false });
  await screen.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Reviewer", exact: true }).click();
  await expect.element(page.getByText("Waiting for your answers", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Submit answers", exact: true }))
    .toBeDisabled();
  await page.getByRole("combobox", { name: "Choose Direction" }).click();
  await page.getByRole("option", { name: "Small pilot", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Answer Direction" }))
    .toHaveValue("Small pilot");
  await page
    .getByRole("textbox", { name: "Answer Next action" })
    .fill("Review the checklist first.");
  await expect
    .element(page.getByRole("button", { name: "Submit answers", exact: true }))
    .toBeEnabled();
  await page.screenshot({ path: "../../../../../.t3/personal-agents-question-fixture.png" });
  await page.getByRole("button", { name: "Submit answers", exact: true }).click();
  await expect.element(page.getByRole("form", { name: "Agent questions" })).not.toBeInTheDocument();
  expect(f.commands.filter((command) => command.method === "agents.respond")).toEqual([
    {
      method: "agents.respond",
      params: {
        attentionID: "direction-request",
        answers: {
          direction: ["Small pilot"],
          constructor: ["Review the checklist first."],
        },
      },
    },
  ]);
  expect(f.commands.some((command) => command.method === "agents.submit")).toBe(false);
});

it("retains stale questions as evidence and requires inspection instead of an answer", async () => {
  const f = fixture("stale");
  await using screen = await render(<NativePersonalAgents client={f.client} />, { router: false });
  await screen.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Reviewer", exact: true }).click();
  await expect
    .element(
      page.getByText(
        "This question can no longer receive an answer. Inspect the outcome before continuing.",
      ),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Submit answers", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect outcome", exact: true }).click();
  expect(f.commands.filter((command) => command.method === "agents.reconcile")).toEqual([
    { method: "agents.reconcile", params: { runID: "review-run" } },
  ]);
  expect(f.commands.some((command) => command.method === "agents.respond")).toBe(false);
});
