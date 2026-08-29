import type {
  CodexItemStreamChunkRecord,
  CodexTurnEventRecord,
  CodexTurnItemRecord,
  CodexTurnSnapshot,
} from "../types";

export type CodexActivityKind =
  | "command"
  | "file"
  | "mcp"
  | "search"
  | "reasoning"
  | "plan"
  | "agent"
  | "image"
  | "review"
  | "compaction"
  | "diff"
  | "other";

export type CodexActivityStatus = "pending" | "running" | "done" | "error";

export interface CodexTranscriptMessageEntry {
  kind: "message";
  id: string;
  sequence: number;
  phase: string | null;
  text: string;
  streaming: boolean;
}

export interface CodexTranscriptActivity {
  kind: "activity";
  id: string;
  itemId: string | null;
  itemType: string;
  activityKind: CodexActivityKind;
  sequence: number;
  status: CodexActivityStatus;
  phase: string | null;
  title: string;
  subtitle: string | null;
  durationMs: number | null;
  payload: JsonRecord;
  startedPayload: JsonRecord | null;
  completedPayload: JsonRecord | null;
  chunks: CodexItemStreamChunkRecord[];
}

export type CodexTranscriptEntry = CodexTranscriptMessageEntry | CodexTranscriptActivity;

export interface CodexTokenBucket {
  input: number | null;
  cachedInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
}

export interface CodexTranscriptUsage {
  turn: CodexTokenBucket;
  thread: CodexTokenBucket | null;
  modelContextWindow: number | null;
}

export interface CodexPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed" | string;
}

export interface CodexPlanProgress {
  steps: CodexPlanStep[];
  completed: number;
  total: number;
  activeStep: string | null;
}

export interface CodexTranscriptProjection {
  entries: CodexTranscriptEntry[];
  events: CodexTurnEventRecord[];
  usage: CodexTranscriptUsage | null;
  plan: CodexPlanProgress | null;
}

export interface CodexCommandOutputPart {
  stream: "stdout" | "stderr" | "stdin";
  content: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexJsonRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readString(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function readNumber(record: JsonRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).filter(Boolean).join("\n");
  if (isRecord(value)) {
    const text = readString(value, "text", "content", "message");
    if (text !== null) return text;
  }
  return "";
}

export function authoritativeCodexItem(item: CodexTurnItemRecord): JsonRecord {
  return parseCodexJsonRecord(item.completedJson ?? item.startedJson);
}

function codexItemPayloads(item: CodexTurnItemRecord) {
  const startedPayload = item.startedJson ? parseCodexJsonRecord(item.startedJson) : null;
  const completedPayload = item.completedJson ? parseCodexJsonRecord(item.completedJson) : null;
  return {
    startedPayload,
    completedPayload,
    payload: {
      ...(startedPayload ?? {}),
      ...(completedPayload ?? {}),
    },
  };
}

function normalizeStatus(status: string | null | undefined): CodexActivityStatus {
  switch ((status ?? "").replace(/[_-]/g, "").toLowerCase()) {
    case "completed":
    case "done":
    case "success":
      return "done";
    case "failed":
    case "error":
    case "declined":
    case "cancelled":
    case "canceled":
      return "error";
    case "inprogress":
    case "running":
    case "streaming":
      return "running";
    default:
      return "pending";
  }
}

function activityKind(itemType: string): CodexActivityKind {
  switch (itemType) {
    case "commandExecution": return "command";
    case "fileChange": return "file";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "collabToolCall":
    case "subAgentActivity": return "mcp";
    case "webSearch": return "search";
    case "reasoning": return "reasoning";
    case "plan": return "plan";
    case "imageView":
    case "imageGeneration": return "image";
    case "enteredReviewMode":
    case "exitedReviewMode": return "review";
    case "contextCompaction": return "compaction";
    default: return "other";
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? value;
}

function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function fileChangeTitle(payload: JsonRecord): { title: string; subtitle: string | null } {
  const changes = Array.isArray(payload.changes) ? payload.changes.filter(isRecord) : [];
  if (changes.length === 0) return { title: "Changed files", subtitle: null };
  const first = changes[0];
  const path = readString(first, "path") ?? "file";
  let additions = 0;
  let deletions = 0;
  for (const change of changes) {
    const counts = diffCounts(readString(change, "diff") ?? "");
    additions += counts.additions;
    deletions += counts.deletions;
  }
  const kind = readString(first, "kind") ?? "update";
  const verb = kind === "delete" ? "Deleted" : kind === "add" || kind === "create" ? "Created" : "Edited";
  const suffix = additions || deletions ? ` +${additions} -${deletions}` : "";
  return {
    title: `${verb} ${path}${suffix}`,
    subtitle: changes.length > 1 ? `${changes.length} files` : null,
  };
}

function activityTitle(itemType: string, payload: JsonRecord): { title: string; subtitle: string | null } {
  switch (itemType) {
    case "commandExecution": {
      const command = readString(payload, "command") ?? "Run command";
      return { title: command, subtitle: readString(payload, "cwd") };
    }
    case "fileChange":
      return fileChangeTitle(payload);
    case "mcpToolCall": {
      const server = readString(payload, "server") ?? "MCP";
      const tool = readString(payload, "tool") ?? "tool";
      return { title: `${server} · ${tool}`, subtitle: null };
    }
    case "dynamicToolCall":
      return { title: readString(payload, "tool") ?? "Dynamic tool", subtitle: "Dynamic tool" };
    case "collabAgentToolCall":
    case "collabToolCall":
      return { title: readString(payload, "tool") ?? "Agent task", subtitle: "Collaboration" };
    case "subAgentActivity":
      return { title: readString(payload, "status", "message") ?? "Agent activity", subtitle: "Subagent" };
    case "webSearch": {
      const action = isRecord(payload.action) ? payload.action : {};
      const queries = Array.isArray(action.queries)
        ? action.queries.filter((value): value is string => typeof value === "string").join(", ")
        : "";
      const query = readString(payload, "query")
        ?? readString(action, "query", "url", "pattern")
        ?? (queries || "Web search");
      return { title: query === "Web search" ? query : `Searched ${query}`, subtitle: null };
    }
    case "reasoning": {
      const summary = textFromUnknown(payload.summary).trim();
      return { title: summary ? firstLine(summary) : "Reasoning", subtitle: null };
    }
    case "plan":
      return { title: "Updated plan", subtitle: null };
    case "imageView":
      return { title: `Viewed ${readString(payload, "path") ?? "image"}`, subtitle: null };
    case "imageGeneration":
      return { title: "Generated image", subtitle: readString(payload, "prompt") };
    case "sleep":
      return { title: "Waited", subtitle: null };
    case "enteredReviewMode":
      return { title: "Entered review mode", subtitle: null };
    case "exitedReviewMode":
      return { title: "Completed review", subtitle: null };
    case "contextCompaction":
      return { title: "Compacted context", subtitle: null };
    case "userMessage":
      return { title: "User input", subtitle: null };
    case "hookPrompt":
      return { title: "Hook prompt", subtitle: null };
    default:
      return { title: itemType === "__pending__" ? "Pending item" : itemType, subtitle: null };
  }
}

function itemText(
  item: CodexTurnItemRecord,
  payload: JsonRecord,
  chunks: CodexItemStreamChunkRecord[],
): string {
  if (item.completedJson) {
    const authoritativeText = textFromUnknown(payload.text);
    if (authoritativeText || Object.prototype.hasOwnProperty.call(payload, "text")) {
      return authoritativeText;
    }
  }
  const streamed = chunks
    .filter((chunk) => chunk.streamKind === "agent_text")
    .map((chunk) => chunk.content)
    .join("");
  return streamed || textFromUnknown(payload.text);
}

function durationForItem(item: CodexTurnItemRecord, payload: JsonRecord): number | null {
  const nativeDuration = readNumber(payload, "durationMs", "duration_ms");
  if (nativeDuration !== null) return nativeDuration;
  if (item.startedAtMs !== null && item.completedAtMs !== null) {
    return Math.max(0, item.completedAtMs - item.startedAtMs);
  }
  return null;
}

function buildActivity(
  item: CodexTurnItemRecord,
  chunks: CodexItemStreamChunkRecord[],
): CodexTranscriptActivity {
  const { payload, startedPayload, completedPayload } = codexItemPayloads(item);
  const { title, subtitle } = activityTitle(item.itemType, payload);
  return {
    kind: "activity",
    id: `item:${item.itemId}`,
    itemId: item.itemId,
    itemType: item.itemType,
    activityKind: activityKind(item.itemType),
    sequence: item.firstSourceSequence,
    status: normalizeStatus(readString(payload, "status") ?? item.status),
    phase: item.phase,
    title,
    subtitle,
    durationMs: durationForItem(item, payload),
    payload,
    startedPayload,
    completedPayload,
    chunks,
  };
}

function buildTurnDiffActivity(event: CodexTurnEventRecord): CodexTranscriptActivity | null {
  const params = parseCodexJsonRecord(event.paramsJson);
  const diff = readString(params, "diff");
  if (diff === null) return null;
  const counts = diffCounts(diff);
  return {
    kind: "activity",
    id: `event:${event.id}`,
    itemId: null,
    itemType: "turnDiff",
    activityKind: "diff",
    sequence: event.sourceSequence,
    status: "done",
    phase: null,
    title: `Diff (turn) +${counts.additions} -${counts.deletions}`,
    subtitle: null,
    durationMs: null,
    payload: params,
    startedPayload: null,
    completedPayload: null,
    chunks: [],
  };
}

function methodSignature(method: string): string {
  return method.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function projectCodexTranscript(snapshot: CodexTurnSnapshot): CodexTranscriptProjection {
  const chunksByItem = new Map<string, CodexItemStreamChunkRecord[]>();
  for (const chunk of snapshot.chunks) {
    if (!chunk.itemId) continue;
    const existing = chunksByItem.get(chunk.itemId) ?? [];
    existing.push(chunk);
    chunksByItem.set(chunk.itemId, existing);
  }
  for (const chunks of chunksByItem.values()) {
    chunks.sort((left, right) => left.sourceSequence - right.sourceSequence || left.chunkIndex - right.chunkIndex);
  }

  const entries: CodexTranscriptEntry[] = [];
  for (const item of snapshot.items) {
    const payload = authoritativeCodexItem(item);
    const chunks = chunksByItem.get(item.itemId) ?? [];
    if (item.itemType === "agentMessage") {
      const text = itemText(item, payload, chunks);
      if (text) {
        entries.push({
          kind: "message",
          id: `item:${item.itemId}`,
          sequence: item.firstSourceSequence,
          phase: item.phase ?? readString(payload, "phase"),
          text,
          streaming: item.completedJson === null,
        });
      }
      continue;
    }
    if (item.itemType === "userMessage") continue;
    entries.push(buildActivity(item, chunks));
  }

  const latestTurnDiff = [...snapshot.events]
    .reverse()
    .find((event) => methodSignature(event.method) === "turndiffupdated");
  if (latestTurnDiff) {
    const diff = buildTurnDiffActivity(latestTurnDiff);
    if (diff) entries.push(diff);
  }

  entries.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  return {
    entries,
    events: [...snapshot.events].sort((left, right) => left.sourceSequence - right.sourceSequence),
    usage: parseCodexTranscriptUsage(snapshot.turn.usageJson),
    plan: parseCodexPlanProgress(snapshot.turn.planJson),
  };
}

function tokenBucket(value: unknown): CodexTokenBucket | null {
  if (!isRecord(value)) return null;
  const input = readNumber(value, "input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const cachedInput = readNumber(value, "cachedInput", "cachedInputTokens", "cached_input_tokens");
  const output = readNumber(value, "output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  const reasoningOutput = readNumber(value, "reasoning", "reasoningOutputTokens", "reasoning_output_tokens");
  const explicitTotal = readNumber(value, "total", "totalTokens", "total_tokens");
  const total = explicitTotal ?? (input !== null || output !== null ? (input ?? 0) + (output ?? 0) : null);
  if (input === null && cachedInput === null && output === null && reasoningOutput === null && total === null) return null;
  return { input, cachedInput, output, reasoningOutput, total };
}

export function parseCodexTranscriptUsage(value: string | null | undefined): CodexTranscriptUsage | null {
  const usage = parseCodexJsonRecord(value);
  if (Object.keys(usage).length === 0) return null;
  const turn = tokenBucket(usage.last) ?? tokenBucket(usage);
  const thread = tokenBucket(usage.total);
  if (!turn && !thread) return null;
  return {
    turn: turn ?? thread!,
    thread: turn && thread ? thread : null,
    modelContextWindow: readNumber(usage, "modelContextWindow", "model_context_window"),
  };
}

export function parseCodexPlanProgress(value: string | null | undefined): CodexPlanProgress | null {
  const payload = parseCodexJsonRecord(value);
  const rawSteps = Array.isArray(payload.plan) ? payload.plan : [];
  const steps = rawSteps.filter(isRecord).map((step) => ({
    step: readString(step, "step") ?? "Untitled step",
    status: readString(step, "status") ?? "pending",
  }));
  if (steps.length === 0) return null;
  const completed = steps.filter((step) => step.status.replace(/[_-]/g, "").toLowerCase() === "completed").length;
  const activeStep = steps.find((step) => {
    const status = step.status.replace(/[_-]/g, "").toLowerCase();
    return status === "inprogress" || status === "running";
  })?.step ?? null;
  return { steps, completed, total: steps.length, activeStep };
}

function eventConflict(existing: CodexTurnEventRecord, incoming: CodexTurnEventRecord): boolean {
  return existing.method !== incoming.method ||
    existing.paramsJson !== incoming.paramsJson ||
    existing.eventKind !== incoming.eventKind ||
    existing.requestId !== incoming.requestId;
}

function chunkConflict(existing: CodexItemStreamChunkRecord, incoming: CodexItemStreamChunkRecord): boolean {
  return existing.content !== incoming.content ||
    existing.streamKind !== incoming.streamKind ||
    existing.itemId !== incoming.itemId ||
    existing.metadataJson !== incoming.metadataJson;
}

export function mergeCodexTurnSnapshot(
  current: CodexTurnSnapshot | null,
  incoming: CodexTurnSnapshot,
): CodexTurnSnapshot {
  if (!current || current.turn.id !== incoming.turn.id) {
    return {
      turn: incoming.turn,
      events: [...incoming.events].sort((left, right) => left.sourceSequence - right.sourceSequence),
      items: [...incoming.items].sort((left, right) => left.firstSourceSequence - right.firstSourceSequence || left.itemId.localeCompare(right.itemId)),
      chunks: [...incoming.chunks].sort((left, right) => left.sourceSequence - right.sourceSequence || left.chunkIndex - right.chunkIndex),
    };
  }
  if (incoming.turn.lastSourceSequence < current.turn.lastSourceSequence) return current;

  const events = new Map(current.events.map((event) => [event.sourceSequence, event]));
  for (const event of incoming.events) {
    const existing = events.get(event.sourceSequence);
    if (existing && eventConflict(existing, event)) {
      throw new Error(`Conflicting Codex event at source sequence ${event.sourceSequence}`);
    }
    events.set(event.sourceSequence, event);
  }

  const items = new Map(current.items.map((item) => [item.itemId, item]));
  for (const item of incoming.items) items.set(item.itemId, item);

  const chunks = new Map(current.chunks.map((chunk) => [`${chunk.sourceSequence}:${chunk.chunkIndex}`, chunk]));
  for (const chunk of incoming.chunks) {
    const key = `${chunk.sourceSequence}:${chunk.chunkIndex}`;
    const existing = chunks.get(key);
    if (existing && chunkConflict(existing, chunk)) {
      throw new Error(`Conflicting Codex chunk at ${key}`);
    }
    chunks.set(key, chunk);
  }

  return {
    turn: incoming.turn,
    events: [...events.values()].sort((left, right) => left.sourceSequence - right.sourceSequence),
    items: [...items.values()].sort((left, right) => left.firstSourceSequence - right.firstSourceSequence || left.itemId.localeCompare(right.itemId)),
    chunks: [...chunks.values()].sort((left, right) => left.sourceSequence - right.sourceSequence || left.chunkIndex - right.chunkIndex),
  };
}

export function commandOutputParts(activity: CodexTranscriptActivity): CodexCommandOutputPart[] {
  const parts: CodexCommandOutputPart[] = [];
  for (const chunk of activity.chunks) {
    if (chunk.streamKind !== "command_output" && chunk.streamKind !== "terminal_input") continue;
    const metadata = parseCodexJsonRecord(chunk.metadataJson);
    const rawStream = readString(metadata, "stream");
    const stream = chunk.streamKind === "terminal_input"
      ? "stdin"
      : rawStream === "stderr" || rawStream === "stdin" ? rawStream : "stdout";
    const previous = parts.at(-1);
    if (previous?.stream === stream) previous.content += chunk.content;
    else parts.push({ stream, content: chunk.content });
  }
  if (parts.length === 0) {
    const aggregated = readString(activity.payload, "aggregatedOutput", "aggregated_output");
    if (aggregated) parts.push({ stream: "stdout", content: aggregated });
  }
  return parts;
}
