import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Copy,
  FileDiff,
  Layers,
  Loader2,
  MessageSquare,
  Search,
  Terminal,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ipc } from "../../lib/codexIpc";
import {
  authoritativeCodexItem,
  commandOutputParts,
  mergeCodexTurnSnapshot,
  parseCodexJsonRecord,
  projectCodexTranscript,
  type CodexActivityKind,
  type CodexTranscriptActivity,
  type CodexTranscriptEntry,
} from "../../lib/codexTranscript";
import type {
  ApprovalResponse,
  CodexTurnEventRecord,
  CodexTurnSnapshot,
  ContentBlock,
  MessageStatus,
} from "../../types";
import MarkdownContent from "./MarkdownContent";
import { MessageBlocks } from "./MessageBlocks";

const LARGE_TEXT_PREVIEW_CHARS = 160_000;

interface CodexTurnTranscriptProps {
  messageId: string;
  blocks: ContentBlock[];
  status: MessageStatus;
  tokenUsage?: { input: number; output: number };
  workspaceRootPath?: string | null;
  refreshSequence: number;
  onApproval: (approvalId: string, response: ApprovalResponse) => void;
  onLoadActionOutput?: (actionId: string) => Promise<void>;
}

interface CodexTranscriptRendererProps {
  snapshot: CodexTurnSnapshot;
  status: MessageStatus;
  tokenUsage?: { input: number; output: number };
  legacyBlocks?: ContentBlock[];
  workspaceRootPath?: string | null;
  onApproval: (approvalId: string, response: ApprovalResponse) => void;
  loadError?: string | null;
}

function useCodexTurnSnapshot(
  messageId: string,
  refreshSequence: number,
  status: MessageStatus,
) {
  const [snapshot, setSnapshot] = useState<CodexTurnSnapshot | null>(null);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<CodexTurnSnapshot | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      queuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        queuedRef.current = false;
        const cursor = snapshotRef.current?.turn.lastSourceSequence ?? 0;
        const incoming = await ipc.getCodexTurnSnapshot(messageId, cursor);
        if (!mountedRef.current) return;
        if (incoming) {
          const merged = mergeCodexTurnSnapshot(snapshotRef.current, incoming);
          snapshotRef.current = merged;
          setSnapshot(merged);
        }
        setResolved(true);
        setError(null);
      } while (queuedRef.current);
    } catch (loadError) {
      if (mountedRef.current) {
        setResolved(true);
        setError(String(loadError));
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [messageId]);

  useEffect(() => {
    snapshotRef.current = null;
    setSnapshot(null);
    setResolved(false);
    setError(null);
    void refresh();
  }, [messageId, refresh]);

  useEffect(() => {
    if (
      refreshSequence > 0 &&
      refreshSequence <= (snapshotRef.current?.turn.lastSourceSequence ?? 0) &&
      status === "streaming"
    ) {
      return;
    }
    const timer = window.setTimeout(() => void refresh(), 55);
    return () => window.clearTimeout(timer);
  }, [refresh, refreshSequence, status]);

  useEffect(() => {
    if (status !== "streaming") return;
    const recoveryTimer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(recoveryTimer);
  }, [refresh, status]);

  return { snapshot, resolved, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function recordNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (isRecord(value)) {
    return recordString(value, "text", "content", "message") ?? prettyJson(value);
  }
  return value == null ? "" : String(value);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function CopyDetailButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="codex-native-copy"
      aria-label={label}
      title={label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
      })}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function ExpandableText({
  text,
  className = "",
  previewChars = LARGE_TEXT_PREVIEW_CHARS,
}: {
  text: string;
  className?: string;
  previewChars?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const truncated = text.length > previewChars;
  const visible = truncated && !showAll ? text.slice(0, previewChars) : text;
  return (
    <div className="codex-native-text-wrap">
      <pre className={`codex-native-pre ${className}`.trim()}>{visible}</pre>
      <CopyDetailButton text={text} label="Copy complete value" />
      {truncated && (
        <button
          type="button"
          className="codex-native-show-all"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll
            ? "Collapse large value"
            : `Show all ${formatCount(text.length)} characters`}
        </button>
      )}
    </div>
  );
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="codex-native-detail-section">
      <div className="codex-native-detail-label">{label}</div>
      {children}
    </section>
  );
}

function JsonSection({ label, value }: { label: string; value: unknown }) {
  return (
    <DetailSection label={label}>
      <ExpandableText text={prettyJson(value)} className="json" />
    </DetailSection>
  );
}

function DiffText({ diff }: { diff: string }) {
  const [showAll, setShowAll] = useState(false);
  const truncated = diff.length > LARGE_TEXT_PREVIEW_CHARS;
  const visible = truncated && !showAll ? diff.slice(0, LARGE_TEXT_PREVIEW_CHARS) : diff;
  return (
    <div className="codex-native-diff-wrap">
      <div className="codex-native-diff" role="region" aria-label="File diff">
        {visible.split(/\r?\n/).map((line, index) => {
          const kind = line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "delete"
              : line.startsWith("@@")
                ? "hunk"
                : "context";
          return <div key={`${index}:${line.slice(0, 18)}`} className={`codex-native-diff-line ${kind}`}>{line || " "}</div>;
        })}
      </div>
      <CopyDetailButton text={diff} label="Copy complete diff" />
      {truncated && (
        <button type="button" className="codex-native-show-all" onClick={() => setShowAll((current) => !current)}>
          {showAll ? "Collapse large diff" : `Show complete ${formatCount(diff.length)} character diff`}
        </button>
      )}
    </div>
  );
}

function CommandDetails({ activity }: { activity: CodexTranscriptActivity }) {
  const command = recordString(activity.payload, "command") ?? activity.title;
  const cwd = recordString(activity.payload, "cwd");
  const outputParts = commandOutputParts(activity);
  const exitCode = recordNumber(activity.payload, "exitCode", "exit_code");
  const commandActions = activity.payload.commandActions ?? activity.payload.command_actions;
  return (
    <>
      <DetailSection label="Command">
        <ExpandableText text={command} className="command" previewChars={Number.POSITIVE_INFINITY} />
      </DetailSection>
      {cwd && <DetailSection label="Working directory"><div className="codex-native-meta-value">{cwd}</div></DetailSection>}
      {commandActions !== undefined && <JsonSection label="Command actions" value={commandActions} />}
      <DetailSection label="Execution output">
        {outputParts.length > 0 ? outputParts.map((part, index) => (
          <div key={`${part.stream}:${index}`} className={`codex-native-output ${part.stream}`}>
            <span>{part.stream}</span>
            <ExpandableText text={part.content} />
          </div>
        )) : <div className="codex-native-empty-output">No output was emitted.</div>}
      </DetailSection>
      {exitCode !== null && <div className={`codex-native-exit ${exitCode === 0 ? "success" : "error"}`}>Exit code {exitCode}</div>}
    </>
  );
}

function FileChangeDetails({ activity }: { activity: CodexTranscriptActivity }) {
  const payloadChanges = Array.isArray(activity.payload.changes)
    ? activity.payload.changes.filter(isRecord)
    : [];
  const chunkChanges = activity.chunks
    .filter((chunk) => chunk.streamKind === "file_patch")
    .map((chunk) => ({
      ...parseCodexJsonRecord(chunk.metadataJson),
      diff: chunk.content,
    }));
  const changes = payloadChanges.length > 0 ? payloadChanges : chunkChanges;
  return (
    <>
      {changes.length > 0 ? changes.map((change, index) => {
        const path = recordString(change, "path") ?? `Change ${index + 1}`;
        const kind = recordString(change, "kind") ?? "update";
        const diff = recordString(change, "diff") ?? "";
        return (
          <section className="codex-native-file-change" key={`${path}:${index}`}>
            <header><span>{path}</span><small>{kind}</small></header>
            {diff ? <DiffText diff={diff} /> : <div className="codex-native-empty-output">No textual diff was emitted.</div>}
          </section>
        );
      }) : <div className="codex-native-empty-output">No file-change details were emitted.</div>}
    </>
  );
}

function ToolDetails({ activity }: { activity: CodexTranscriptActivity }) {
  const payload = activity.payload;
  const server = recordString(payload, "server");
  const tool = recordString(payload, "tool");
  const query = recordString(payload, "query");
  const progress = activity.chunks.filter((chunk) => chunk.streamKind === "mcp_progress").map((chunk) => chunk.content);
  return (
    <>
      {(server || tool) && (
        <DetailSection label="Tool">
          <div className="codex-native-meta-value">{[server, tool].filter(Boolean).join(" · ")}</div>
        </DetailSection>
      )}
      {query && <DetailSection label="Query"><ExpandableText text={query} previewChars={Number.POSITIVE_INFINITY} /></DetailSection>}
      {payload.action !== undefined && <JsonSection label="Search action" value={payload.action} />}
      {payload.arguments !== undefined && <JsonSection label="Arguments" value={payload.arguments} />}
      {typeof payload.prompt === "string" && <DetailSection label="Prompt"><ExpandableText text={payload.prompt} /></DetailSection>}
      {payload.appContext !== undefined && <JsonSection label="App context" value={payload.appContext} />}
      {payload.agentStatus !== undefined && <JsonSection label="Agent status" value={payload.agentStatus} />}
      {progress.length > 0 && <DetailSection label="Progress"><ExpandableText text={progress.join("\n")} /></DetailSection>}
      {payload.result !== undefined && <JsonSection label="Result" value={payload.result} />}
      {payload.contentItems !== undefined && <JsonSection label="Content" value={payload.contentItems} />}
      {payload.error !== undefined && <JsonSection label="Error" value={payload.error} />}
    </>
  );
}

function ReasoningDetails({ activity }: { activity: CodexTranscriptActivity }) {
  const summaryChunks = activity.chunks.filter((chunk) => chunk.streamKind === "reasoning_summary").map((chunk) => chunk.content).join("");
  const reasoningChunks = activity.chunks.filter((chunk) => chunk.streamKind === "reasoning").map((chunk) => chunk.content).join("");
  const summary = activity.completedPayload && Object.prototype.hasOwnProperty.call(activity.completedPayload, "summary")
    ? textValue(activity.completedPayload.summary)
    : summaryChunks || textValue(activity.payload.summary);
  const content = activity.completedPayload && Object.prototype.hasOwnProperty.call(activity.completedPayload, "content")
    ? textValue(activity.completedPayload.content)
    : reasoningChunks || textValue(activity.payload.content);
  const planChunks = activity.chunks.filter((chunk) => chunk.streamKind === "plan").map((chunk) => chunk.content).join("");
  const plan = activity.completedPayload && Object.prototype.hasOwnProperty.call(activity.completedPayload, "text")
    ? textValue(activity.completedPayload.text)
    : planChunks || recordString(activity.payload, "text") || "";
  return (
    <>
      {summary && <DetailSection label="Summary"><ExpandableText text={summary} /></DetailSection>}
      {content && <DetailSection label="Reasoning"><ExpandableText text={content} /></DetailSection>}
      {plan && <DetailSection label="Plan"><ExpandableText text={plan} /></DetailSection>}
      {!summary && !content && !plan && <div className="codex-native-empty-output">No textual details were emitted.</div>}
    </>
  );
}

function ActivityDetails({ activity }: { activity: CodexTranscriptActivity }) {
  return (
    <div className="codex-native-activity-details">
      {activity.activityKind === "command" && <CommandDetails activity={activity} />}
      {activity.activityKind === "file" && <FileChangeDetails activity={activity} />}
      {(activity.activityKind === "mcp" || activity.activityKind === "search") && <ToolDetails activity={activity} />}
      {(activity.activityKind === "reasoning" || activity.activityKind === "plan") && <ReasoningDetails activity={activity} />}
      {activity.activityKind === "diff" && <DiffText diff={recordString(activity.payload, "diff") ?? ""} />}
      {!["command", "file", "mcp", "search", "reasoning", "plan", "diff"].includes(activity.activityKind) && (
        <JsonSection label="Details" value={activity.payload} />
      )}
      <details className="codex-native-raw-item">
        <summary>{activity.itemId ? "Raw item lifecycle" : "Raw event parameters"}</summary>
        {activity.startedPayload && <JsonSection label="Started item" value={activity.startedPayload} />}
        {activity.completedPayload && <JsonSection label="Completed item (authoritative)" value={activity.completedPayload} />}
        {!activity.startedPayload && !activity.completedPayload && <ExpandableText text={prettyJson(activity.payload)} className="json" />}
      </details>
    </div>
  );
}

const activityIcons: Record<CodexActivityKind, LucideIcon> = {
  command: Terminal,
  file: FileDiff,
  mcp: Layers,
  search: Search,
  reasoning: Brain,
  plan: MessageSquare,
  agent: MessageSquare,
  image: MessageSquare,
  review: MessageSquare,
  compaction: Layers,
  diff: FileDiff,
  other: Circle,
};

function ActivityStatus({ activity }: { activity: CodexTranscriptActivity }) {
  if (activity.status === "running") return <Loader2 size={12} className="animate-spin codex-native-running" />;
  if (activity.status === "error") return <XCircle size={12} className="codex-native-error" />;
  if (activity.status === "done") return <CheckCircle2 size={12} />;
  return <Circle size={12} />;
}

function ActivityRow({ activity }: { activity: CodexTranscriptActivity }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = activityIcons[activity.activityKind];
  return (
    <div className={`codex-native-activity-row ${expanded ? "expanded" : ""}`} data-item-type={activity.itemType}>
      <button
        type="button"
        className="codex-native-activity-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight size={12} className={`codex-native-chevron ${expanded ? "open" : ""}`} />
        <Icon size={13} className="codex-native-activity-icon" />
        <span className="codex-native-activity-title" title={activity.title}>{activity.title}</span>
        {activity.subtitle && <span className="codex-native-activity-subtitle" title={activity.subtitle}>{activity.subtitle}</span>}
        <ActivityStatus activity={activity} />
        {activity.durationMs !== null && <span className="codex-native-duration">{formatDuration(activity.durationMs)}</span>}
      </button>
      {expanded && <ActivityDetails activity={activity} />}
    </div>
  );
}

function activityTypeBreakdown(activities: CodexTranscriptActivity[]): string {
  const labels: Record<CodexActivityKind, string> = {
    command: "cmd", file: "edit", mcp: "tool", search: "search", reasoning: "thought",
    plan: "plan", agent: "agent", image: "image", review: "review", compaction: "compact",
    diff: "diff", other: "other",
  };
  const counts = new Map<CodexActivityKind, number>();
  for (const activity of activities) counts.set(activity.activityKind, (counts.get(activity.activityKind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${labels[kind]}`).join(" · ");
}

function ActivityGroup({ activities }: { activities: CodexTranscriptActivity[] }) {
  const running = activities.some((activity) => activity.status === "running" || activity.status === "pending");
  const failures = activities.filter((activity) => activity.status === "error").length;
  const [expanded, setExpanded] = useState(true);
  const noun = activities.length === 1 ? "tool" : "tools";
  const summary = running ? `Using ${activities.length} ${noun}` : `Used ${activities.length} ${noun}`;
  return (
    <section className="codex-native-group">
      <button
        type="button"
        className="codex-native-group-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight size={13} className={`codex-native-chevron ${expanded ? "open" : ""}`} />
        <Layers size={14} />
        <span className="codex-native-group-title">{summary}</span>
        <span className="codex-native-group-breakdown">{activityTypeBreakdown(activities)}</span>
        {running
          ? <Loader2 size={13} className="animate-spin codex-native-running" />
          : failures > 0
            ? <AlertTriangle size={13} className="codex-native-error" />
            : <CheckCircle2 size={13} />}
      </button>
      {expanded && <div className="codex-native-group-body">{activities.map((activity) => <ActivityRow key={activity.id} activity={activity} />)}</div>}
    </section>
  );
}

type TranscriptSegment =
  | { kind: "message"; entry: Extract<CodexTranscriptEntry, { kind: "message" }> }
  | { kind: "activities"; entries: CodexTranscriptActivity[] };

function buildSegments(entries: CodexTranscriptEntry[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let activities: CodexTranscriptActivity[] = [];
  const flushActivities = () => {
    if (activities.length > 0) segments.push({ kind: "activities", entries: activities });
    activities = [];
  };
  for (const entry of entries) {
    if (entry.kind === "activity") activities.push(entry);
    else {
      flushActivities();
      segments.push({ kind: "message", entry });
    }
  }
  flushActivities();
  return segments;
}

function NativeEventRow({ event }: { event: CodexTurnEventRecord }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="codex-native-event-row">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <ChevronRight size={11} className={`codex-native-chevron ${expanded ? "open" : ""}`} />
        <span>{event.method}</span>
        <small>#{event.sourceSequence} · {event.eventKind}</small>
      </button>
      {expanded && (
        <div className="codex-native-event-body">
          {event.requestId && <div className="codex-native-meta-value">Request ID: {event.requestId}</div>}
          <ExpandableText text={event.paramsJson} className="json" />
        </div>
      )}
    </div>
  );
}

function NativeEventsDrawer({ events }: { events: CodexTurnEventRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="codex-native-events">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <ChevronRight size={11} className={`codex-native-chevron ${expanded ? "open" : ""}`} />
        Native events ({events.length})
      </button>
      {expanded && <div>{events.map((event) => <NativeEventRow key={event.id} event={event} />)}</div>}
    </section>
  );
}

function statusFromTurn(snapshot: CodexTurnSnapshot, messageStatus: MessageStatus) {
  const normalized = snapshot.turn.status.replace(/[_-]/g, "").toLowerCase();
  if (messageStatus === "streaming" || normalized === "inprogress" || normalized === "running") return "running";
  if (messageStatus === "error" || normalized === "failed" || normalized === "error") return "error";
  if (messageStatus === "interrupted" || normalized === "interrupted" || normalized === "cancelled") return "interrupted";
  return "completed";
}

function liveActivityLabel(
  entries: CodexTranscriptEntry[],
  events: CodexTurnEventRecord[],
  finalStatus: string,
  activePlanStep: string | null,
): string {
  if (finalStatus === "completed") return "Completed";
  if (finalStatus === "error") return "Failed";
  if (finalStatus === "interrupted") return "Interrupted";
  const active = [...entries].reverse().find((entry): entry is CodexTranscriptActivity => entry.kind === "activity" && entry.status === "running");
  if (active) {
    switch (active.activityKind) {
      case "command": return "Running command…";
      case "file": return "Applying changes…";
      case "search": return "Searching the web…";
      case "mcp": return "Using tool…";
      case "reasoning": return "Thinking…";
      case "plan": return "Updating plan…";
      default: return active.title;
    }
  }
  const latestMethod = events.at(-1)?.method.toLowerCase() ?? "";
  if (latestMethod.includes("requestapproval")) return "Waiting for approval…";
  if (latestMethod.includes("requestuserinput") || latestMethod.includes("elicitation")) return "Waiting for input…";
  if (latestMethod === "hook/started") return "Running hook…";
  if (latestMethod === "model/rerouted") return "Switching models…";
  if (latestMethod === "model/safetybuffering/updated") return "Verifying response…";
  return activePlanStep ?? "Still thinking…";
}

function TurnFooter({
  snapshot,
  entries,
  status,
  fallbackTokenUsage,
  usage,
  plan,
}: {
  snapshot: CodexTurnSnapshot;
  entries: CodexTranscriptEntry[];
  status: MessageStatus;
  fallbackTokenUsage?: { input: number; output: number };
  usage: ReturnType<typeof projectCodexTranscript>["usage"];
  plan: ReturnType<typeof projectCodexTranscript>["plan"];
}) {
  const finalStatus = statusFromTurn(snapshot, status);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (finalStatus !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [finalStatus]);
  const startedAt = snapshot.turn.startedAtMs ?? snapshot.turn.firstEventAtMs ?? now;
  const endedAt = snapshot.turn.completedAtMs ?? (finalStatus === "running" ? now : snapshot.turn.lastEventAtMs ?? now);
  const elapsed = Math.max(0, endedAt - startedAt);
  const tokens = usage?.turn.total ?? (fallbackTokenUsage ? fallbackTokenUsage.input + fallbackTokenUsage.output : null);
  const tokenTitle = usage
    ? [
        usage.turn.input !== null ? `${formatCount(usage.turn.input)} input` : null,
        usage.turn.cachedInput !== null ? `${formatCount(usage.turn.cachedInput)} cached input` : null,
        usage.turn.output !== null ? `${formatCount(usage.turn.output)} output` : null,
        usage.turn.reasoningOutput !== null ? `${formatCount(usage.turn.reasoningOutput)} reasoning` : null,
      ].filter(Boolean).join(" · ")
    : undefined;
  return (
    <footer className={`codex-native-footer ${finalStatus}`} aria-live="polite">
      {finalStatus === "running"
        ? <Loader2 size={13} className="animate-spin codex-native-running" />
        : finalStatus === "completed"
          ? <CheckCircle2 size={13} />
          : finalStatus === "error"
            ? <XCircle size={13} />
            : <AlertTriangle size={13} />}
      <span>{formatDuration(elapsed)}</span>
      {tokens !== null && <><span className="codex-native-separator">·</span><span title={tokenTitle}>{formatCount(tokens)} tokens</span></>}
      {plan && (
        <>
          <span className="codex-native-separator">·</span>
          <span>{plan.completed}/{plan.total} steps</span>
          <span className="codex-native-plan-bar" aria-label={`${plan.completed} of ${plan.total} plan steps completed`}>
            <span style={{ width: `${(plan.completed / plan.total) * 100}%` }} />
          </span>
        </>
      )}
      <span className="codex-native-separator">·</span>
      <span className="codex-native-live-label">{liveActivityLabel(entries, snapshot.events, finalStatus, plan?.activeStep ?? null)}</span>
    </footer>
  );
}

function supplementaryBlocks(blocks: ContentBlock[] | undefined): ContentBlock[] {
  return (blocks ?? []).filter((block) => {
    if (block.type === "approval" || block.type === "steer" || block.type === "error" || block.type === "attachment") return true;
    return block.type === "notice" && block.kind !== "turn_status";
  });
}

export function CodexTranscriptRenderer({
  snapshot,
  status,
  tokenUsage,
  legacyBlocks,
  workspaceRootPath,
  onApproval,
  loadError,
}: CodexTranscriptRendererProps) {
  const projection = useMemo(() => projectCodexTranscript(snapshot), [snapshot]);
  const segments = useMemo(() => buildSegments(projection.entries), [projection.entries]);
  const supplements = useMemo(() => supplementaryBlocks(legacyBlocks), [legacyBlocks]);
  return (
    <div className="codex-native-transcript" data-source-sequence={snapshot.turn.lastSourceSequence}>
      {segments.map((segment) => segment.kind === "activities" ? (
        <ActivityGroup key={`activities:${segment.entries[0]?.id ?? "empty"}`} activities={segment.entries} />
      ) : (
        <MarkdownContent
          key={segment.entry.id}
          content={segment.entry.text}
          streaming={segment.entry.streaming && status === "streaming"}
          className="prose codex-native-message"
          workspaceRootPath={workspaceRootPath}
        />
      ))}
      {supplements.length > 0 && (
        <div className="codex-native-supplements">
          <MessageBlocks
            blocks={supplements}
            messageRole="assistant"
            workspaceRootPath={workspaceRootPath}
            onApproval={onApproval}
          />
        </div>
      )}
      {loadError && <div className="codex-native-sync-warning"><AlertTriangle size={12} /> Transcript refresh failed: {loadError}</div>}
      <NativeEventsDrawer events={projection.events} />
      <TurnFooter
        snapshot={snapshot}
        entries={projection.entries}
        status={status}
        fallbackTokenUsage={tokenUsage}
        usage={projection.usage}
        plan={projection.plan}
      />
    </div>
  );
}

export function CodexTurnTranscript({
  messageId,
  blocks,
  status,
  tokenUsage,
  workspaceRootPath,
  refreshSequence,
  onApproval,
  onLoadActionOutput,
}: CodexTurnTranscriptProps) {
  const { snapshot, resolved, error } = useCodexTurnSnapshot(messageId, refreshSequence, status);
  if (!snapshot) {
    return (
      <div className={resolved ? undefined : "codex-native-loading"}>
        <MessageBlocks
          blocks={blocks}
          status={status}
          messageRole="assistant"
          workspaceRootPath={workspaceRootPath}
          onApproval={onApproval}
          onLoadActionOutput={onLoadActionOutput}
        />
      </div>
    );
  }
  return (
    <CodexTranscriptRenderer
      snapshot={snapshot}
      status={status}
      tokenUsage={tokenUsage}
      legacyBlocks={blocks}
      workspaceRootPath={workspaceRootPath}
      onApproval={onApproval}
      loadError={error}
    />
  );
}

export function codexItemPayloadForTest(snapshot: CodexTurnSnapshot, itemId: string) {
  const item = snapshot.items.find((candidate) => candidate.itemId === itemId);
  return item ? authoritativeCodexItem(item) : null;
}
