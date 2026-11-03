import type { PersonalAgent, PersonalAgentMethod, PersonalAgentProvider } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { activePersonalAgentRun } from "@t3tools/shared/personalAgents";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { PersonalAgentQuestionForm } from "./PersonalAgentQuestionForm";
import {
  PersonalAgentClient,
  safePersonalArtifactHTML,
  verifyPersonalArtifact,
  type PersonalArtifactPreview,
} from "./personalAgentClient";

const providerName = (provider: PersonalAgentProvider) =>
  provider === "codex" ? "Codex" : "Claude Code";
type Draft = {
  agentID?: string;
  name: string;
  instructions: string;
  provider: PersonalAgentProvider;
};
export function NativePersonalAgents({
  client: suppliedClient,
}: { client?: PersonalAgentClient } = {}) {
  const [client] = useState(() => suppliedClient ?? new PersonalAgentClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [open, setOpen] = useState(false);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PersonalArtifactPreview | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- Attach a presentation subscription; unmount never stops provider work.
  useEffect(() => {
    void client.connect();
    return () => client.disconnect();
  }, [client]);
  if (!state.hello) return null;
  const snapshot = state.snapshot;
  const selected = snapshot?.agents.find((agent) => agent.id === selectedID) ?? snapshot?.agents[0];
  const disabled = !state.connected || state.busy || snapshot?.revoked === true;
  const runs = snapshot?.runs.filter((run) => run.agentID === selected?.id) ?? [];
  const runIDs = new Set(runs.map((run) => run.id));
  const attention = snapshot?.attention.filter((item) => runIDs.has(item.runID)) ?? [];
  const artifacts = snapshot?.artifacts.filter((item) => runIDs.has(item.runID)) ?? [];
  const edit = (agent: PersonalAgent) =>
    setDraft({
      agentID: agent.id,
      name: agent.name,
      instructions: agent.instructions,
      provider: agent.provider,
    });
  const act = async (method: PersonalAgentMethod, params: Record<string, unknown>) => {
    try {
      await client.command(method, params);
      return true;
    } catch {
      return false;
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Agents
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Personal agents</DialogTitle>
            <DialogDescription>
              Your TexOS agents, conversations, and ongoing work.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3 px-6 pb-3 text-sm" aria-live="polite">
            <span>
              {state.connected ? "Connected to TexOS" : "Disconnected · work may continue"}
            </span>
            {state.hello.mode === "fake" ? (
              <strong className="text-warning-foreground">Test mode · simulated providers</strong>
            ) : null}
            {snapshot?.revoked ? <span>Access revoked for this workspace</span> : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={state.busy}
              onClick={() => void client.refresh()}
            >
              Refresh state
            </Button>
          </div>
          {state.problem ? (
            <p role="alert" className="px-6 pb-3 text-sm text-destructive">
              {state.problem}
            </p>
          ) : null}
          <div className="grid min-h-0 grid-cols-1 gap-5 overflow-auto px-6 pb-6 md:grid-cols-[14rem_1fr]">
            <aside className="space-y-3" aria-label="Agent roster">
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || (snapshot?.agents.length ?? 0) >= 16}
                onClick={() => setDraft({ name: "", instructions: "", provider: "codex" })}
              >
                Create agent
              </Button>
              {snapshot?.agents.map((agent) => (
                <div key={agent.id}>
                  <Button
                    variant={selected?.id === agent.id ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => {
                      setSelectedID(agent.id);
                      setPreview(null);
                      setPreviewProblem(null);
                    }}
                  >
                    {agent.name}
                  </Button>
                  <p className="px-2 text-xs text-muted-foreground">
                    {providerName(agent.provider)}
                  </p>
                </div>
              ))}
              {snapshot?.agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Create your first agent to start a persistent conversation.
                </p>
              ) : null}
            </aside>
            <main className="min-w-0 space-y-4">
              {draft ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(
                      draft.agentID ? "agents.update" : "agents.create",
                      draft.agentID
                        ? {
                            agentID: draft.agentID,
                            name: draft.name,
                            instructions: draft.instructions,
                          }
                        : {
                            name: draft.name,
                            instructions: draft.instructions,
                            provider: draft.provider,
                          },
                    ).then((saved) => {
                      if (saved) setDraft(null);
                    });
                  }}
                >
                  <h3 className="font-medium">{draft.agentID ? "Edit agent" : "New agent"}</h3>
                  <label className="block space-y-1 text-sm">
                    Name
                    <Input
                      value={draft.name}
                      maxLength={120}
                      required
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    />
                  </label>
                  {!draft.agentID ? (
                    <div className="space-y-1 text-sm">
                      <span>Harness</span>
                      <Select
                        value={draft.provider}
                        onValueChange={(value) => {
                          if (value === "codex" || value === "claudeCode")
                            setDraft({ ...draft, provider: value });
                        }}
                      >
                        <SelectTrigger aria-label="Agent harness">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="codex">Codex</SelectItem>
                          <SelectItem value="claudeCode">Claude Code</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <label className="block space-y-1 text-sm">
                    Instructions
                    <Textarea
                      value={draft.instructions}
                      maxLength={8192}
                      onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">Changes apply to future turns.</p>
                  <div className="flex gap-2">
                    <Button size="sm" type="submit" disabled={disabled || !draft.name.trim()}>
                      Save agent
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : selected ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-medium">{selected.name}</h3>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => edit(selected)}
                    >
                      Edit agent
                    </Button>
                  </div>
                  <div
                    className="max-h-72 space-y-3 overflow-auto"
                    role="log"
                    aria-label={`${selected.name} conversation`}
                  >
                    {snapshot?.messages
                      .filter((message) => message.conversationID === selected.conversationID)
                      .map((message) => (
                        <div key={message.id} className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {message.role === "assistant"
                              ? selected.name
                              : message.role === "user"
                                ? "You"
                                : "TexOS"}
                          </p>
                          <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
                        </div>
                      ))}
                  </div>
                  <div className="space-y-2" aria-label="Agent work">
                    {runs
                      .slice()
                      .reverse()
                      .slice(0, 8)
                      .map((run) => (
                        <div key={run.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <span>
                            {run.status === "needsReconciliation"
                              ? "Outcome needs inspection"
                              : run.status.replaceAll(/([A-Z])/g, " $1").toLowerCase()}
                          </span>
                          {run.error ? <span className="text-destructive">{run.error}</span> : null}
                          {activePersonalAgentRun(run.status) && run.status !== "stopping" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled}
                              onClick={() => void act("agents.stop", { runID: run.id })}
                            >
                              Stop
                            </Button>
                          ) : null}
                          {run.status === "needsReconciliation" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled}
                              onClick={() => void act("agents.reconcile", { runID: run.id })}
                            >
                              Inspect outcome
                            </Button>
                          ) : null}
                        </div>
                      ))}
                  </div>
                  {attention.map((item) => (
                    <div key={item.id} className="space-y-2 rounded-lg border p-3">
                      <p className="text-sm">
                        {item.tool}: {item.description}
                      </p>
                      {item.kind === "question" ? (
                        <PersonalAgentQuestionForm
                          attention={item}
                          disabled={disabled || !state.hello?.capabilities.includes("questions")}
                          onRespond={(answers) =>
                            act("agents.respond", { attentionID: item.id, answers })
                          }
                        />
                      ) : (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={disabled || item.answerable !== true}
                            onClick={() =>
                              void act("agents.answer", { attentionID: item.id, allow: true })
                            }
                          >
                            Allow once
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={disabled || item.answerable !== true}
                            onClick={() =>
                              void act("agents.answer", { attentionID: item.id, allow: false })
                            }
                          >
                            Decline
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const submitted = text;
                      void act("agents.submit", { agentID: selected.id, text: submitted }).then(
                        (sent) => {
                          if (sent) setText((current) => (current === submitted ? "" : current));
                        },
                      );
                    }}
                  >
                    <Textarea
                      aria-label={`Message ${selected.name}`}
                      placeholder={`Message ${selected.name}`}
                      value={text}
                      maxLength={8192}
                      disabled={snapshot?.revoked}
                      onChange={(event) => setText(event.target.value)}
                    />
                    <Button size="sm" type="submit" disabled={disabled || !text.trim()}>
                      {runs.some((run) => activePersonalAgentRun(run.status))
                        ? "Queue message"
                        : "Send"}
                    </Button>
                  </form>
                  {artifacts.length ? (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Results</h4>
                      <div className="flex flex-wrap gap-2">
                        {artifacts.map((artifact) => (
                          <Button
                            key={artifact.id}
                            size="sm"
                            variant="outline"
                            disabled={disabled}
                            onClick={() => {
                              setPreviewProblem(null);
                              void client
                                .command("agents.artifact", { artifactID: artifact.id })
                                .then((value) => verifyPersonalArtifact(value, artifact.id))
                                .then(setPreview)
                                .catch((error: unknown) =>
                                  setPreviewProblem(
                                    error instanceof Error
                                      ? error.message
                                      : "Could not preview artifact.",
                                  ),
                                );
                            }}
                          >
                            {artifact.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {previewProblem ? (
                    <p role="alert" className="text-sm text-destructive">
                      {previewProblem}
                    </p>
                  ) : null}
                  {preview && artifacts.some((artifact) => artifact.id === preview.id) ? (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">{preview.name}</h4>
                      {preview.mimeType === "text/html" ? (
                        <iframe
                          title={preview.name}
                          sandbox=""
                          referrerPolicy="no-referrer"
                          className="h-72 w-full rounded-lg border bg-white"
                          srcDoc={safePersonalArtifactHTML(preview.content)}
                        />
                      ) : preview.mimeType === "image/png" ? (
                        <img
                          alt={preview.name}
                          className="max-h-96 max-w-full object-contain"
                          src={preview.content}
                        />
                      ) : (
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">
                          {preview.content}
                        </pre>
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Select or create an agent.</p>
              )}
              {snapshot?.history?.bounded ? (
                <p className="text-xs text-muted-foreground">
                  Recent history only: up to {snapshot.history.messageLimit} messages and{" "}
                  {snapshot.history.runLimit} runs, with text excerpts. Older originals remain saved
                  in TexOS.
                </p>
              ) : null}
            </main>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
