import type {
  ApprovalBlock,
  AttachmentBlock,
  CodexItemStreamChunkRecord,
  CodexTurnEventRecord,
  CodexTurnItemRecord,
  CodexTurnSnapshot,
  ContentBlock,
  ErrorBlock,
  MentionBlock,
  NoticeBlock,
  SkillBlock,
  SteerBlock,
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

export interface CodexTranscriptSteerEntry {
  kind: "steer";
  id: string;
  sequence: number;
  observedAtMs: number | null;
  exact: boolean;
  block: SteerBlock;
  requestPayload: JsonRecord | null;
  responsePayload: JsonRecord | null;
}

export interface CodexTranscriptApprovalEntry {
  kind: "approval";
  id: string;
  sequence: number;
  observedAtMs: number | null;
  exact: true;
  block: ApprovalBlock;
  requestPayload: JsonRecord;
  requestId: string | null;
}

export interface CodexTranscriptNoticeEntry {
  kind: "notice";
  id: string;
  sequence: number;
  observedAtMs: number | null;
  exact: true;
  block: NoticeBlock;
}

export interface CodexTranscriptErrorEntry {
  kind: "error";
  id: string;
  sequence: number;
  observedAtMs: number | null;
  exact: true;
  block: ErrorBlock;
}

export interface CodexTranscriptPlanProgressEntry {
  kind: "planProgress";
  id: string;
  sequence: number;
  plan: CodexPlanProgress;
}

export type CodexTranscriptEntry =
  | CodexTranscriptMessageEntry
  | CodexTranscriptActivity
  | CodexTranscriptSteerEntry
  | CodexTranscriptApprovalEntry
  | CodexTranscriptNoticeEntry
  | CodexTranscriptErrorEntry
  | CodexTranscriptPlanProgressEntry;

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
  explanation: string | null;
}

export interface CodexReasoningText {
  summarySections: string[];
  content: string;
  plan: string;
  hasReadableText: boolean;
}

export interface CodexWebSearchResult {
  title: string;
  url: string | null;
  domain: string | null;
  snippet: string | null;
  refId: string | null;
  resultType: string | null;
  raw: JsonRecord;
}

export interface CodexWebSearchDetails {
  actionType: string | null;
  query: string | null;
  queries: string[];
  results: CodexWebSearchResult[];
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

function readNonEmptyString(record: JsonRecord, ...keys: string[]): string | null {
  const value = readString(record, ...keys)?.trim();
  return value ? value : null;
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

export function webSearchDetails(payload: JsonRecord): CodexWebSearchDetails {
  const action = isRecord(payload.action) ? payload.action : {};
  const actionQueries = Array.isArray(action.queries) ? action.queries : [];
  const actionQuery = readNonEmptyString(action, "query");
  const payloadQuery = readNonEmptyString(payload, "query");
  const queries = uniqueStrings([
    ...actionQueries,
    ...(actionQuery ? [actionQuery] : []),
    ...(actionQueries.length === 0 && !actionQuery && payloadQuery ? [payloadQuery] : []),
  ]);
  const results = (Array.isArray(payload.results) ? payload.results : [])
    .filter(isRecord)
    .map((result, index): CodexWebSearchResult => {
      const url = readNonEmptyString(result, "url");
      const domain = readNonEmptyString(result, "domain");
      const refId = readNonEmptyString(result, "ref_id", "refId");
      return {
        title: readNonEmptyString(result, "title") ?? domain ?? url ?? refId ?? `Result ${index + 1}`,
        url,
        domain,
        snippet: readNonEmptyString(result, "snippet", "text", "content"),
        refId,
        resultType: readNonEmptyString(result, "type"),
        raw: result,
      };
    });

  return {
    actionType: readNonEmptyString(action, "type"),
    query: payloadQuery ?? actionQuery ?? queries[0] ?? null,
    queries,
    results,
  };
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
      const details = webSearchDetails(payload);
      const resultLabel = details.results.length > 0
        ? `${details.results.length} ${details.results.length === 1 ? "result" : "results"}`
        : null;
      if (details.queries.length > 1) {
        return {
          title: `Searched ${details.queries[0]} +${details.queries.length - 1} more`,
          subtitle: resultLabel,
        };
      }
      if (details.query) return { title: `Searched ${details.query}`, subtitle: resultLabel };
      if (details.results.length > 0) {
        return {
          title: `Read ${details.results.length} ${details.results.length === 1 ? "source" : "sources"}`,
          subtitle: resultLabel,
        };
      }
      return { title: "Web search", subtitle: null };
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

function nonEmptyText(value: unknown): string {
  return textFromUnknown(value).trim();
}

function nonEmptyTextSections(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(nonEmptyText).filter(Boolean);
  }
  const text = nonEmptyText(value);
  return text ? [text] : [];
}

function streamedReasoningSummarySections(chunks: CodexItemStreamChunkRecord[]): string[] {
  const sections = new Map<number, string>();
  let fallbackIndex = 0;
  for (const chunk of chunks) {
    if (chunk.streamKind !== "reasoning_summary" && chunk.streamKind !== "reasoning_summary_boundary") {
      continue;
    }
    const index = chunk.summaryIndex ?? fallbackIndex;
    if (chunk.streamKind === "reasoning_summary_boundary") {
      if (!sections.has(index)) sections.set(index, "");
      fallbackIndex = Math.max(fallbackIndex, index);
      continue;
    }
    sections.set(index, `${sections.get(index) ?? ""}${chunk.content}`);
    fallbackIndex = index;
  }
  return [...sections.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value.trim())
    .filter(Boolean);
}

export function reasoningText(activity: CodexTranscriptActivity): CodexReasoningText {
  const streamedSummary = streamedReasoningSummarySections(activity.chunks);
  const completedSummary = nonEmptyTextSections(activity.completedPayload?.summary);
  const startedSummary = nonEmptyTextSections(activity.startedPayload?.summary);
  const summarySections = completedSummary.length > 0
    ? completedSummary
    : streamedSummary.length > 0
      ? streamedSummary
      : startedSummary;

  const streamedContent = activity.chunks
    .filter((chunk) => chunk.streamKind === "reasoning")
    .map((chunk) => chunk.content)
    .join("")
    .trim();
  const completedContent = nonEmptyText(activity.completedPayload?.content);
  const startedContent = nonEmptyText(activity.startedPayload?.content);
  const content = completedContent || streamedContent || startedContent;

  const streamedPlan = activity.chunks
    .filter((chunk) => chunk.streamKind === "plan")
    .map((chunk) => chunk.content)
    .join("")
    .trim();
  const completedPlan = nonEmptyText(activity.completedPayload?.text);
  const startedPlan = nonEmptyText(activity.startedPayload?.text);
  const plan = completedPlan || streamedPlan || startedPlan;

  return {
    summarySections,
    content,
    plan,
    hasReadableText: summarySections.length > 0 || Boolean(content) || Boolean(plan),
  };
}

function buildActivity(
  item: CodexTurnItemRecord,
  chunks: CodexItemStreamChunkRecord[],
): CodexTranscriptActivity {
  const { payload, startedPayload, completedPayload } = codexItemPayloads(item);
  const { title, subtitle } = activityTitle(item.itemType, payload);
  const activity: CodexTranscriptActivity = {
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
  if (activity.activityKind === "reasoning") {
    const details = reasoningText(activity);
    activity.title = details.summarySections[0]
      ? firstLine(details.summarySections[0])
      : "Thought";
    activity.subtitle = details.hasReadableText ? null : "No readable summary emitted";
  }
  return activity;
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

function blocksFromUnknown(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate): candidate is ContentBlock => (
    isRecord(candidate) && typeof candidate.type === "string"
  ));
}

function steerBlockFromSubmittedEvent(
  event: CodexTurnEventRecord,
  payload: JsonRecord,
): SteerBlock | null {
  const steerId = readString(payload, "steerId") ?? event.requestId;
  if (!steerId) return null;
  const display = isRecord(payload.display) ? payload.display : {};
  const displayBlocks = blocksFromUnknown(display.blocks);
  const attachments = displayBlocks.filter(
    (block): block is AttachmentBlock => block.type === "attachment",
  );
  const skills = displayBlocks.filter((block): block is SkillBlock => block.type === "skill");
  const mentions = displayBlocks.filter((block): block is MentionBlock => block.type === "mention");
  const textBlocks = displayBlocks.filter(
    (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
  );
  const content = readString(display, "content")
    ?? textBlocks.map((block) => block.content).join("\n");
  return {
    type: "steer",
    steerId,
    persistedMessageId: readString(payload, "messageId") ?? undefined,
    content,
    planMode: display.planMode === true || textBlocks.some((block) => block.planMode === true) || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    skills: skills.length > 0 ? skills : undefined,
    mentions: mentions.length > 0 ? mentions : undefined,
    sourceSequence: event.sourceSequence,
    observedAtMs: event.observedAtMs,
    status: "pending",
  };
}

function buildSteerEntries(events: CodexTurnEventRecord[]): CodexTranscriptSteerEntry[] {
  const entries = new Map<string, CodexTranscriptSteerEntry>();
  const ordered = [...events].sort((left, right) => left.sourceSequence - right.sourceSequence);
  for (const event of ordered) {
    if (methodSignature(event.method) !== "turnsteer") continue;
    if (event.eventKind !== "client_request" && event.eventKind !== "client_response") continue;
    const payload = parseCodexJsonRecord(event.paramsJson);
    const steerId = readString(payload, "steerId") ?? event.requestId;
    if (!steerId) continue;
    if (event.eventKind === "client_request") {
      const block = steerBlockFromSubmittedEvent(event, payload);
      if (!block) continue;
      entries.set(steerId, {
        kind: "steer",
        id: `steer:${steerId}`,
        sequence: event.sourceSequence,
        observedAtMs: event.observedAtMs,
        exact: true,
        block,
        requestPayload: payload,
        responsePayload: null,
      });
      continue;
    }

    const existing = entries.get(steerId);
    if (!existing) continue;
    const status = readString(payload, "status");
    existing.block = {
      ...existing.block,
      status: status === "failed" ? "failed" : status === "accepted" ? "accepted" : "unconfirmed",
      error: readString(payload, "error") ?? undefined,
    };
    existing.responsePayload = payload;
  }
  return [...entries.values()].map((entry) => (
    entry.block.status === "pending"
      ? { ...entry, block: { ...entry.block, status: "unconfirmed" } }
      : entry
  ));
}

function estimateLegacySteerSequence(
  events: CodexTurnEventRecord[],
  observedAtMs: number,
  offset: number,
): number | null {
  const ordered = [...events].sort((left, right) => left.sourceSequence - right.sourceSequence);
  if (ordered.length === 0) return null;
  const nextIndex = ordered.findIndex((event) => event.observedAtMs > observedAtMs);
  const epsilon = Math.min(0.49, (offset + 1) / 10_000);
  if (nextIndex === 0) return ordered[0]!.sourceSequence - 0.5 + epsilon;
  if (nextIndex < 0) return ordered.at(-1)!.sourceSequence + 0.5 + epsilon;
  const previous = ordered[nextIndex - 1]!;
  const next = ordered[nextIndex]!;
  return previous.sourceSequence + (next.sourceSequence - previous.sourceSequence) / 2 + epsilon;
}

function approvalRequestIdentifiers(event: CodexTurnEventRecord): string[] {
  if (event.eventKind !== "request") return [];
  const signature = methodSignature(event.method);
  const isApprovalRequest = signature.includes("requestapproval")
    || signature.includes("requestuserinput")
    || signature === "execcommandapproval"
    || signature === "applypatchapproval"
    || signature === "itemtoolcall"
    || signature === "mcpserverelicitationrequest";
  if (!isApprovalRequest) return [];

  const payload = parseCodexJsonRecord(event.paramsJson);
  const identifiers = [
    readString(payload, "approvalId", "itemId", "callId", "id"),
    event.requestId,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(identifiers)];
}

function noticeKindFromEvent(event: CodexTurnEventRecord): string | null {
  if (event.eventKind !== "notification") return null;
  const signature = methodSignature(event.method);
  switch (signature) {
    case "modelrerouted": return "model_rerouted";
    case "threadcompacted":
    case "contextcompacted": return "context_compacted";
    case "warning": return "codex_warning";
    case "guardianwarning": return "codex_guardian_warning";
    case "modelverification": return "codex_model_verification";
    case "itemguardianapprovalreviewstarted": return "codex_guardian_review_started";
    case "itemguardianapprovalreviewcompleted": return "codex_guardian_review_completed";
    case "threadrealtimestarted": return "codex_realtime_started";
    case "threadrealtimeclosed": return "codex_realtime_closed";
    case "deprecationnotice": return "deprecation_notice";
    case "hookstarted":
    case "hookcompleted": {
      const payload = parseCodexJsonRecord(event.paramsJson);
      const run = isRecord(payload.run) ? payload.run : {};
      const hookId = readString(run, "id") ?? "unknown";
      return `${signature === "hookstarted" ? "hook_started" : "hook_completed"}_${hookId}`;
    }
    default: return null;
  }
}

function nativeErrorMessage(event: CodexTurnEventRecord): string | null {
  if (event.eventKind !== "notification") return null;
  const signature = methodSignature(event.method);
  if (signature !== "error" && signature !== "threadrealtimeerror") return null;
  const payload = parseCodexJsonRecord(event.paramsJson);
  const nestedError = isRecord(payload.error) ? payload.error : {};
  return readString(nestedError, "message") ?? readString(payload, "message") ?? "Unknown error";
}

export function interleaveLegacyTranscriptBlocks(
  entries: CodexTranscriptEntry[],
  events: CodexTurnEventRecord[],
  blocks: ContentBlock[] | undefined,
): {
  entries: CodexTranscriptEntry[];
  consumedSteerIds: Set<string>;
  consumedApprovalIds: Set<string>;
  consumedNoticeKinds: Set<string>;
  consumedErrorBlockIndexes: Set<number>;
} {
  const consumedSteerIds = new Set<string>();
  const consumedApprovalIds = new Set<string>();
  const consumedNoticeKinds = new Set<string>();
  const consumedErrorBlockIndexes = new Set<number>();
  const nativeSteers = entries.filter(
    (entry): entry is CodexTranscriptSteerEntry => entry.kind === "steer",
  );
  const nativeIds = new Set<string>();
  for (const entry of nativeSteers) {
    nativeIds.add(entry.block.steerId);
    if (entry.block.persistedMessageId) nativeIds.add(entry.block.persistedMessageId);
  }

  const merged = [...entries];
  (blocks ?? []).forEach((block, index) => {
    if (block.type !== "steer") return;
    const keys = [block.steerId, block.persistedMessageId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (keys.some((key) => nativeIds.has(key))) {
      keys.forEach((key) => consumedSteerIds.add(key));
      return;
    }
    const exactSequence = typeof block.sourceSequence === "number" && Number.isFinite(block.sourceSequence)
      ? block.sourceSequence
      : null;
    const estimatedSequence = exactSequence === null && typeof block.observedAtMs === "number"
      ? estimateLegacySteerSequence(events, block.observedAtMs, index)
      : null;
    const sequence = exactSequence ?? estimatedSequence;
    if (sequence === null) return;
    keys.forEach((key) => consumedSteerIds.add(key));
    merged.push({
      kind: "steer",
      id: `legacy-steer:${block.steerId}`,
      sequence,
      observedAtMs: block.observedAtMs ?? null,
      exact: exactSequence !== null,
      block,
      requestPayload: null,
      responsePayload: null,
    });
  });

  const approvalRequestById = new Map<string, CodexTurnEventRecord>();
  for (const event of [...events].sort(
    (left, right) => left.sourceSequence - right.sourceSequence,
  )) {
    for (const identifier of approvalRequestIdentifiers(event)) {
      if (!approvalRequestById.has(identifier)) {
        approvalRequestById.set(identifier, event);
      }
    }
  }
  for (const block of blocks ?? []) {
    if (block.type !== "approval") continue;
    const event = approvalRequestById.get(block.approvalId);
    if (!event) continue;
    consumedApprovalIds.add(block.approvalId);
    merged.push({
      kind: "approval",
      id: `approval:${block.approvalId}`,
      sequence: event.sourceSequence,
      observedAtMs: event.observedAtMs,
      exact: true,
      block,
      requestPayload: parseCodexJsonRecord(event.paramsJson),
      requestId: event.requestId,
    });
  }

  const noticeEventByKind = new Map<string, CodexTurnEventRecord>();
  const nativeErrors: Array<{ event: CodexTurnEventRecord; message: string }> = [];
  const usedNativeErrorIndexes = new Set<number>();
  for (const event of [...events].sort(
    (left, right) => left.sourceSequence - right.sourceSequence,
  )) {
    const noticeKind = noticeKindFromEvent(event);
    if (noticeKind && !noticeEventByKind.has(noticeKind)) {
      noticeEventByKind.set(noticeKind, event);
    }
    const errorMessage = nativeErrorMessage(event);
    if (errorMessage !== null) nativeErrors.push({ event, message: errorMessage });
  }
  (blocks ?? []).forEach((block, blockIndex) => {
    if (block.type === "notice" && block.kind !== "turn_status") {
      const event = noticeEventByKind.get(block.kind);
      if (!event) return;
      consumedNoticeKinds.add(block.kind);
      merged.push({
        kind: "notice",
        id: `notice:${block.kind}`,
        sequence: event.sourceSequence,
        observedAtMs: event.observedAtMs,
        exact: true,
        block,
      });
      return;
    }
    if (block.type !== "error") return;
    let nativeErrorIndex = nativeErrors.findIndex(
      ({ message }, index) => !usedNativeErrorIndexes.has(index) && message === block.message,
    );
    if (nativeErrorIndex < 0) {
      nativeErrorIndex = nativeErrors.findIndex((_, index) => !usedNativeErrorIndexes.has(index));
    }
    if (nativeErrorIndex < 0) return;
    usedNativeErrorIndexes.add(nativeErrorIndex);
    consumedErrorBlockIndexes.add(blockIndex);
    const event = nativeErrors[nativeErrorIndex]!.event;
    merged.push({
      kind: "error",
      id: `error:${blockIndex}:${event.sourceSequence}`,
      sequence: event.sourceSequence,
      observedAtMs: event.observedAtMs,
      exact: true,
      block,
    });
  });
  merged.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  return {
    entries: merged,
    consumedSteerIds,
    consumedApprovalIds,
    consumedNoticeKinds,
    consumedErrorBlockIndexes,
  };
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

  const entries: CodexTranscriptEntry[] = buildSteerEntries(snapshot.events);
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

  const plan = parseCodexPlanProgress(snapshot.turn.planJson);
  if (plan) {
    const latestPlanEvent = [...snapshot.events]
      .reverse()
      .find((event) => methodSignature(event.method) === "turnplanupdated");
    if (latestPlanEvent) {
      entries.push({
        kind: "planProgress",
        id: `plan-progress:${latestPlanEvent.sourceSequence}`,
        sequence: latestPlanEvent.sourceSequence,
        plan,
      });
    }
  }

  entries.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  return {
    entries,
    events: [...snapshot.events].sort((left, right) => left.sourceSequence - right.sourceSequence),
    usage: parseCodexTranscriptUsage(snapshot.turn.usageJson),
    plan,
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
  return {
    steps,
    completed,
    total: steps.length,
    activeStep,
    explanation: readNonEmptyString(payload, "explanation"),
  };
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
