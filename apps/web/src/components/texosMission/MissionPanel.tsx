import type {
  OrchestrationV2TurnItem,
  ScopedThreadRef,
  TexosMissionFile,
  TexosMissionListFilesResult,
} from "@t3tools/contracts";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";

import ChatView from "../ChatView";
import { ReadOnlySourcePreview } from "../files/AttachmentFilePreview";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  useQuietThreadShell,
  useQuietThreadVisibleTurnItems,
  useThreadShell,
} from "../../state/entities";
import { useDebouncedValue, useTurnItemDetail } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { texosMissionFile, texosMissionFiles } from "../../state/texosMission";
import {
  defaultMissionTab,
  missionChangesRevision,
  type MissionPanelTab,
} from "./missionPanel.logic";

const TABS: ReadonlyArray<{ readonly value: MissionPanelTab; readonly label: string }> = [
  { value: "changes", label: "Changes" },
  { value: "terminal", label: "Terminal" },
  { value: "timeline", label: "Timeline" },
];

interface MissionRef {
  readonly threadRef: ScopedThreadRef;
  readonly taskId: string;
  readonly attemptId: string;
}

/** One Mission's coding view for TexOS: what the agent said, the files it wrote, its commands and its timeline. */
export function MissionPanel(props: MissionRef) {
  const status = useQuietThreadShell(props.threadRef)?.latestRun?.status ?? null;
  const items = useQuietThreadVisibleTurnItems(props.threadRef);
  const [chosen, setChosen] = useState<MissionPanelTab | null>(null);
  const tab = chosen ?? defaultMissionTab(items, status);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MissionLatestText threadRef={props.threadRef} />
      <nav
        className="flex shrink-0 items-center border-b border-border/60 px-3 py-2"
        aria-label="Mission views"
      >
        <ToggleGroup
          size="segmented"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            const picked = TABS.find((entry) => entry.value === next[0])?.value;
            if (picked) setChosen(picked);
          }}
        >
          {TABS.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </nav>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "changes" ? (
          <MissionChanges {...props} revision={missionChangesRevision(items, status)} />
        ) : tab === "terminal" ? (
          <MissionTerminal threadRef={props.threadRef} />
        ) : (
          <ChatView
            environmentId={props.threadRef.environmentId}
            threadId={props.threadRef.threadId}
            routeKind="server"
            reserveTitleBarControlInset={false}
            embedded
          />
        )}
      </div>
    </div>
  );
}

function MissionLatestText({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const message = useThreadShell(threadRef)?.source.latestVisibleMessage ?? null;
  const text = message?.role === "assistant" ? message.text.trim() : "";
  return (
    <header className="shrink-0 border-b border-border/60 px-4 py-3 text-sm">
      {text ? (
        <p className="line-clamp-3 whitespace-pre-wrap">{text}</p>
      ) : (
        <p className="text-muted-foreground">The agent hasn't replied yet.</p>
      )}
    </header>
  );
}

function MissionChanges(props: MissionRef & { readonly revision: string }) {
  // A new revision is a new query; settle it briefly so a burst of edits is one read.
  const revision = useDebouncedValue(props.revision, 400);
  const listing = useEnvironmentQuery(
    texosMissionFiles({
      environmentId: props.threadRef.environmentId,
      input: { taskId: props.taskId, attemptId: props.attemptId, revision },
    }),
  );
  // Keeps the last listing on screen while the next revision loads.
  const [lastListing, setLastListing] = useState<TexosMissionListFilesResult | null>(null);
  if (listing.data !== null && listing.data !== lastListing) setLastListing(listing.data);
  const shown = listing.data ?? lastListing;
  const [openPath, setOpenPath] = useState<string | null>(null);

  if (openPath !== null)
    return (
      <MissionFileView
        {...props}
        path={openPath}
        file={shown?.files.find((file) => file.path === openPath) ?? null}
        onBack={() => setOpenPath(null)}
      />
    );
  if (shown === null) return <PanelLine text={listing.error ?? "Reading the Mission's files…"} />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {listing.error ? <PanelLine text={listing.error} /> : null}
      {shown.files.length === 0 ? (
        <PanelLine text="The Mission hasn't written any files yet." />
      ) : (
        <ul className="divide-y divide-border/60">
          {shown.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-accent/50"
                onClick={() => setOpenPath(file.path)}
              >
                <span className="shrink-0 text-xs font-medium text-diff-addition">New</span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatBytes(file.byteLength)}
                </span>
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {shown.omitted > 0 ? (
        <PanelLine
          text={`${shown.omitted} more ${shown.omitted === 1 ? "entry is" : "entries are"} not shown: links, special files, or past the list's limit.`}
        />
      ) : null}
    </div>
  );
}

function MissionFileView(
  props: MissionRef & {
    readonly path: string;
    readonly file: TexosMissionFile | null;
    readonly onBack: () => void;
  },
) {
  const { file } = props;
  const contents = useEnvironmentQuery(
    file === null
      ? null
      : texosMissionFile({
          environmentId: props.threadRef.environmentId,
          input: {
            taskId: props.taskId,
            attemptId: props.attemptId,
            path: file.path,
            revision: `${file.byteLength}:${file.changedAtMs}`,
          },
        }),
  );
  const result = contents.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button variant="ghost" size="compact" onClick={props.onBack}>
          <ArrowLeftIcon />
          Files
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{props.path}</span>
        {file ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatBytes(file.byteLength)}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file === null ? (
          <PanelLine text="This file is no longer in the Mission's folder." />
        ) : result === null ? (
          <PanelLine text={contents.error ?? "Reading the file…"} />
        ) : result.kind === "text" ? (
          <ReadOnlySourcePreview name={file.path} text={result.contents} />
        ) : result.kind === "binary" ? (
          <PanelLine text="This file isn't text, so it isn't shown here." />
        ) : (
          <PanelLine
            text={`This file is ${formatBytes(result.byteLength)}, too large to show here.`}
          />
        )}
      </div>
    </div>
  );
}

function MissionTerminal({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const items = useQuietThreadVisibleTurnItems(threadRef);
  const commands = items.flatMap((entry) =>
    entry.item.type === "command_execution" ? [{ ...entry, item: entry.item }] : [],
  );
  if (commands.length === 0) return <PanelLine text="The agent ran no commands." />;
  return (
    <ul className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto">
      {commands.map((entry) => (
        <MissionCommand
          key={entry.sourceItemId}
          threadRef={threadRef}
          sourceThreadId={entry.sourceThreadId}
          item={entry.item}
        />
      ))}
    </ul>
  );
}

function MissionCommand(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sourceThreadId: ScopedThreadRef["threadId"];
  readonly item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;
}) {
  const [open, setOpen] = useState(false);
  const fetches = open && turnItemNeedsDetailFetch(props.item);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId: props.threadRef.environmentId,
          threadId: props.sourceThreadId,
          itemId: props.item.id,
          revision: turnItemDetailRevision(props.item),
        }
      : null,
  );
  const fetched = detail.data?.item;
  const item = fetched?.type === props.item.type ? fetched : props.item;
  const output = turnItemOutputText(item);
  const failed = props.item.outputIndicatesFailure === true || (props.item.exitCode ?? 0) !== 0;
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-accent/50"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
        />
        <code className="min-w-0 flex-1 truncate font-mono text-xs">$ {props.item.input}</code>
        {failed ? <span className="shrink-0 text-xs text-destructive">Failed</span> : null}
      </button>
      {open ? (
        <pre className="max-h-80 overflow-auto bg-muted/40 px-4 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {output ??
            (fetches && item === props.item
              ? (detail.error ?? (detail.isPending ? "Loading output…" : "No output."))
              : "No output.")}
        </pre>
      ) : null}
    </li>
  );
}

function PanelLine({ text }: { readonly text: string }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{text}</p>;
}
