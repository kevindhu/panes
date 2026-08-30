import { create } from "zustand";
import {
  ipc,
  listenThreadEvents,
  type ChatTurnFinishedEvent,
} from "../lib/codexIpc";
import {
  armPlanImplementationPrompt,
  disarmPlanImplementationPrompt,
} from "../lib/planImplementationPromptState";
import { recordPerfMetric } from "../lib/perfTelemetry";
import {
  hasConfirmedCodexRemoteTurn,
  isCodexThreadSyncRequired,
} from "../lib/codexThreadRuntime";
import { useThreadStore } from "./threadStore";
import { useThreadPlanModeStore } from "./threadPlanModeStore";
import { toast } from "./toastStore";
import type {
  ApprovalResponse,
  ActionBlock,
  ApprovalBlock,
  AttachmentBlock,
  ChatAttachment,
  ChatInputItem,
  ContentBlock,
  ContextTokenBreakdown,
  ContextUsage,
  MentionBlock,
  Message,
  MessageWindowCursor,
  NoticeBlock,
  SkillBlock,
  SteerBlock,
  SteerMessageReceipt,
  StreamEvent,
  Thread,
  TurnCompletionSource,
  ThreadStatus
} from "../types";

interface ChatState {
  threadId: string | null;
  messages: Message[];
  olderCursor: MessageWindowCursor | null;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  olderLoadBlockedUntil: number;
  status: ThreadStatus;
  streaming: boolean;
  usageLimits: ContextUsage | null;
  error?: string;
  unlisten?: () => void;
  setActiveThread: (
    threadId: string | null,
    options?: {
      forceReload?: boolean;
    },
  ) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  send: (
    message: string,
    options?: {
      threadIdOverride?: string;
      modelId?: string | null;
      engineId?: string | null;
      reasoningEffort?: string | null;
      attachments?: ChatAttachment[];
      inputItems?: ChatInputItem[];
      planMode?: boolean;
      onAccepted?: () => void;
    },
  ) => Promise<boolean>;
  steer: (
    message: string,
    options?: {
      threadIdOverride?: string;
      attachments?: ChatAttachment[];
      inputItems?: ChatInputItem[];
      planMode?: boolean;
      onAccepted?: () => void;
    },
  ) => Promise<boolean>;
  cancel: () => Promise<void>;
  respondApproval: (approvalId: string, response: ApprovalResponse) => Promise<void>;
  hydrateActionOutput: (messageId: string, actionId: string) => Promise<void>;
}

let activeThreadBindSeq = 0;
const STREAM_EVENT_BATCH_WINDOW_MS = 16;
const STREAM_EVENT_QUEUE_FLUSH_THRESHOLD = 500;
const CONTEXT_USAGE_CACHE_METADATA_KEY = "contextUsageCache";
let lastKnownCodexAccountUsageWindows: ContextUsage | null = null;

function notifyTurnAccepted(onAccepted: (() => void) | undefined) {
  if (!onAccepted) {
    return;
  }
  try {
    onAccepted();
  } catch (error) {
    console.warn("Accepted turn callback failed", error);
  }
}

/**
 * Background listeners for threads that are still streaming when the user switches away.
 * Keeps the event stream alive so events are not lost. On switch-back, the DB state
 * will include all events that arrived while the thread was in the background.
 * Cleaned up on TurnCompleted or when the thread is explicitly cancelled.
 */
const backgroundStreamListeners = new Map<string, () => void>();

function cleanupBackgroundListener(threadId: string) {
  const cleanup = backgroundStreamListeners.get(threadId);
  if (cleanup) {
    cleanup();
    backgroundStreamListeners.delete(threadId);
  }
}
const MESSAGE_WINDOW_INITIAL_LIMIT = 80;
const OLDER_MESSAGES_RETRY_BACKOFF_MS = 2_000;
const MAX_FULLY_HYDRATED_MESSAGES = 80;
const ACTION_OUTPUT_MAX_CHARS = 80_000;
const ACTION_OUTPUT_TRIM_TARGET_CHARS = 48_000;
const ACTION_OUTPUT_MAX_CHUNKS = 160;
const MAX_QUEUED_TURN_FINISHED_EVENTS_PER_THREAD = 8;

interface PendingTurnMeta {
  turnEngineId?: string | null;
  turnModelId?: string | null;
  turnReasoningEffort?: string | null;
  clientTurnId?: string | null;
  assistantMessageId?: string | null;
  backendAccepted: boolean;
  startedAt: number;
  firstShellRecorded: boolean;
  firstContentRecorded: boolean;
  firstTextRecorded: boolean;
}

interface AssistantMessageTarget {
  clientTurnId?: string | null;
  assistantMessageId?: string | null;
}

const pendingTurnMetaByThread = new Map<string, PendingTurnMeta>();
const inflightActionOutputHydration = new Map<string, Promise<void>>();
const bindingSeqByThread = new Map<string, number>();
const queuedTurnFinishedEventsByThread = new Map<string, ChatTurnFinishedEvent[]>();
const MAX_CACHED_THREAD_VIEWS = 8;

interface CachedThreadView {
  messages: Message[];
  olderCursor: MessageWindowCursor | null;
  hasOlderMessages: boolean;
  status: ThreadStatus;
  streaming: boolean;
  usageLimits: ContextUsage | null;
}

const cachedThreadViews = new Map<string, CachedThreadView>();

function writeCachedThreadView(threadId: string, view: CachedThreadView): void {
  cachedThreadViews.delete(threadId);
  cachedThreadViews.set(threadId, view);
  while (cachedThreadViews.size > MAX_CACHED_THREAD_VIEWS) {
    const oldestThreadId = cachedThreadViews.keys().next().value as string | undefined;
    if (!oldestThreadId) break;
    cachedThreadViews.delete(oldestThreadId);
  }
}

function readCachedThreadView(threadId: string): CachedThreadView | null {
  const cached = cachedThreadViews.get(threadId);
  if (!cached) return null;
  cachedThreadViews.delete(threadId);
  cachedThreadViews.set(threadId, cached);
  return cached;
}

function updateCachedThreadRuntimeState(
  threadId: string,
  status: ThreadStatus,
  streaming: boolean,
): void {
  const cached = cachedThreadViews.get(threadId);
  if (!cached) return;
  writeCachedThreadView(threadId, { ...cached, status, streaming });
}

function cacheBoundThreadView(state: ChatState): void {
  if (!state.threadId) return;
  writeCachedThreadView(state.threadId, {
    messages: state.messages,
    olderCursor: state.olderCursor,
    hasOlderMessages: state.hasOlderMessages,
    status: state.status,
    streaming: state.streaming,
    usageLimits: state.usageLimits,
  });
}

function pendingTurnMatchesFinishedEvent(
  pendingTurn: PendingTurnMeta,
  event: ChatTurnFinishedEvent,
): boolean {
  const pendingClientTurnId = pendingTurn.clientTurnId?.trim();
  const eventClientTurnId = event.clientTurnId?.trim();
  if (pendingClientTurnId && eventClientTurnId) {
    return pendingClientTurnId === eventClientTurnId;
  }

  const pendingAssistantMessageId = pendingTurn.assistantMessageId?.trim();
  const eventAssistantMessageId = event.assistantMessageId?.trim();
  return Boolean(
    pendingAssistantMessageId &&
      eventAssistantMessageId &&
      pendingAssistantMessageId === eventAssistantMessageId,
  );
}

function assistantMessageMatchesFinishedEvent(
  message: Message,
  event: ChatTurnFinishedEvent,
): boolean {
  const messageClientTurnId = message.clientTurnId?.trim();
  const eventClientTurnId = event.clientTurnId?.trim();
  if (messageClientTurnId && eventClientTurnId) {
    return messageClientTurnId === eventClientTurnId;
  }
  return message.id === event.assistantMessageId;
}

interface TurnFinishedProjection {
  messageStatus: Message["status"];
  runtimeStatus: ThreadStatus;
  terminalState: TerminalTurnState;
}

function projectTurnFinishedEvent(event: ChatTurnFinishedEvent): TurnFinishedProjection {
  const messageStatus: Message["status"] =
    event.status === "error"
      ? "error"
      : event.status === "interrupted"
        ? "interrupted"
        : "completed";
  const terminalState: TerminalTurnState =
    event.status === "error"
      ? "failed"
      : event.status === "interrupted"
        ? "interrupted"
        : "completed";
  const runtimeStatus: ThreadStatus =
    event.status === "error"
      ? "error"
      : event.status === "interrupted"
        ? "idle"
        : "completed";

  return { messageStatus, runtimeStatus, terminalState };
}

function applyTurnFinishedEventToMessages(
  messages: Message[],
  event: ChatTurnFinishedEvent,
): { matched: boolean; messages: Message[] } {
  let assistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      assistantIndex = index;
      break;
    }
  }

  if (assistantIndex < 0) {
    return { matched: false, messages };
  }

  const assistant = messages[assistantIndex];
  if (
    !assistantMessageMatchesFinishedEvent(assistant, event) ||
    messages.slice(assistantIndex + 1).some((message) => message.role === "user")
  ) {
    return { matched: false, messages };
  }

  const { messageStatus, terminalState } = projectTurnFinishedEvent(event);
  let nextAssistant = assistant;
  if (assistant.status === "streaming") {
    const blocks = terminalizeUnresolvedTurnBlocks(
      assistant.blocks ?? [],
      terminalState,
    ) ?? [];
    nextAssistant = {
      ...assistant,
      status: messageStatus,
      blocks,
    };
  } else if (assistant.status !== messageStatus) {
    nextAssistant = {
      ...assistant,
      status: messageStatus,
    };
  }

  if (nextAssistant === assistant) {
    return { matched: true, messages };
  }

  return {
    matched: true,
    messages: [
      ...messages.slice(0, assistantIndex),
      nextAssistant,
      ...messages.slice(assistantIndex + 1),
    ],
  };
}

function applyAcceptedTurnFinishedToBoundChat(event: ChatTurnFinishedEvent): boolean {
  const { runtimeStatus } = projectTurnFinishedEvent(event);
  let applied = false;

  useChatStore.setState((state) => {
    if (state.threadId !== event.threadId) {
      return state;
    }

    const terminalized = applyTurnFinishedEventToMessages(state.messages, event);
    if (!terminalized.matched) {
      return state;
    }
    applied = true;
    if (
      terminalized.messages === state.messages &&
      state.status === runtimeStatus &&
      !state.streaming
    ) {
      return state;
    }

    return {
      ...state,
      messages: terminalized.messages,
      status: runtimeStatus,
      streaming: false,
    };
  });

  return applied;
}

function queueTurnFinishedEventForBinding(event: ChatTurnFinishedEvent): void {
  if (!bindingSeqByThread.has(event.threadId)) {
    return;
  }

  const queued = queuedTurnFinishedEventsByThread.get(event.threadId) ?? [];
  queued.push(event);
  if (queued.length > MAX_QUEUED_TURN_FINISHED_EVENTS_PER_THREAD) {
    queued.splice(0, queued.length - MAX_QUEUED_TURN_FINISHED_EVENTS_PER_THREAD);
  }
  queuedTurnFinishedEventsByThread.set(event.threadId, queued);
}

function replayQueuedTurnFinishedEvents(
  threadId: string,
  messages: Message[],
): Message[] {
  const queued = queuedTurnFinishedEventsByThread.get(threadId);
  queuedTurnFinishedEventsByThread.delete(threadId);
  if (!queued?.length) {
    return messages;
  }

  let nextMessages = messages;
  for (const event of queued) {
    const terminalized = applyTurnFinishedEventToMessages(nextMessages, event);
    if (terminalized.matched) {
      nextMessages = terminalized.messages;
    }
  }
  return nextMessages;
}

/**
 * Accepts a terminal event only when it still describes the current turn for
 * its thread, then applies it as a backstop to the bound chat. A newer turn can
 * start after the backend releases its turn lock but before the older global
 * completion event reaches the frontend, while a listener can also be briefly
 * replaced during navigation. The identity checks prevent the former and the
 * terminal application closes the latter gap.
 */
export function acceptTurnFinishedRuntimeEvent(
  event: ChatTurnFinishedEvent,
): boolean {
  // The backend read the latest thread after finishing this assistant message.
  // An active snapshot means another turn has already superseded this event;
  // an unknown snapshot is rejected rather than risking a false completion.
  if (
    event.threadStatus !== "completed" &&
    event.threadStatus !== "idle" &&
    event.threadStatus !== "error"
  ) {
    return false;
  }

  const pendingTurn = pendingTurnMetaByThread.get(event.threadId);
  if (pendingTurn) {
    if (!pendingTurnMatchesFinishedEvent(pendingTurn, event)) {
      return false;
    }
    pendingTurnMetaByThread.delete(event.threadId);
  } else {
    const chatState = useChatStore.getState();
    if (chatState.threadId === event.threadId) {
      const latestAssistant = [...chatState.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (
        latestAssistant &&
        !assistantMessageMatchesFinishedEvent(latestAssistant, event) &&
        (latestAssistant.status === "streaming" ||
          Boolean(latestAssistant.clientTurnId && event.clientTurnId))
      ) {
        return false;
      }
    }
  }

  if (!applyAcceptedTurnFinishedToBoundChat(event)) {
    queueTurnFinishedEventForBinding(event);
  }
  return true;
}

function normalizeContextUsageCacheInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function normalizeContextUsageCachePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeContextTokenBreakdown(
  inputTokensValue: unknown,
  cachedInputTokensValue: unknown,
  cacheWriteInputTokensValue: unknown,
  outputTokensValue: unknown,
  reasoningOutputTokensValue: unknown,
): ContextTokenBreakdown | null {
  const breakdown: ContextTokenBreakdown = {
    inputTokens: normalizeContextUsageCacheInteger(inputTokensValue),
    cachedInputTokens: normalizeContextUsageCacheInteger(cachedInputTokensValue),
    cacheWriteInputTokens: normalizeContextUsageCacheInteger(cacheWriteInputTokensValue),
    outputTokens: normalizeContextUsageCacheInteger(outputTokensValue),
    reasoningOutputTokens: normalizeContextUsageCacheInteger(reasoningOutputTokensValue),
  };

  return Object.values(breakdown).some((value) => value !== null) ? breakdown : null;
}

function hasContextUsageMetrics(usage: ContextUsage | null | undefined): usage is ContextUsage {
  return Boolean(
    usage &&
      (usage.currentTokens !== null ||
        usage.maxContextTokens !== null ||
        usage.contextPercent !== null ||
        usage.breakdown !== null),
  );
}

function contextUsageFromThreadMetadata(
  metadata: Record<string, unknown> | undefined,
): ContextUsage | null {
  const cache = metadata?.[CONTEXT_USAGE_CACHE_METADATA_KEY];
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return null;
  }

  const cacheRecord = cache as Record<string, unknown>;
  const currentTokens = normalizeContextUsageCacheInteger(cacheRecord.currentTokens);
  const maxContextTokens = normalizeContextUsageCacheInteger(cacheRecord.maxContextTokens);
  const breakdown = normalizeContextTokenBreakdown(
    cacheRecord.inputTokens,
    cacheRecord.cachedInputTokens,
    cacheRecord.cacheWriteInputTokens,
    cacheRecord.outputTokens,
    cacheRecord.reasoningOutputTokens,
  );
  let contextPercent = calculateContextPercentRemaining(currentTokens, maxContextTokens);
  if (contextPercent === null) {
    contextPercent = normalizeContextUsageCachePercent(cacheRecord.contextWindowPercent);
  }

  if (
    currentTokens === null &&
    maxContextTokens === null &&
    contextPercent === null &&
    breakdown === null
  ) {
    return null;
  }

  return {
    currentTokens,
    maxContextTokens,
    contextPercent,
    breakdown,
    windowFiveHourPercent: null,
    windowWeeklyPercent: null,
    windowFiveHourResetsAt: null,
    windowWeeklyResetsAt: null,
  };
}

function accountUsageWindowsFromUsageLimits(usage: ContextUsage | null): ContextUsage | null {
  if (
    !usage ||
    (usage.windowFiveHourPercent === null &&
      usage.windowWeeklyPercent === null &&
      usage.windowFiveHourResetsAt === null &&
      usage.windowWeeklyResetsAt === null)
  ) {
    return null;
  }

  return {
    currentTokens: null,
    maxContextTokens: null,
    contextPercent: null,
    breakdown: null,
    windowFiveHourPercent: usage.windowFiveHourPercent,
    windowWeeklyPercent: usage.windowWeeklyPercent,
    windowFiveHourResetsAt: usage.windowFiveHourResetsAt,
    windowWeeklyResetsAt: usage.windowWeeklyResetsAt,
  };
}

function mergeContextUsageCacheIntoThread(thread: Thread, usage: ContextUsage): Thread {
  const currentCache =
    thread.engineMetadata?.[CONTEXT_USAGE_CACHE_METADATA_KEY] &&
    typeof thread.engineMetadata[CONTEXT_USAGE_CACHE_METADATA_KEY] === "object" &&
    !Array.isArray(thread.engineMetadata[CONTEXT_USAGE_CACHE_METADATA_KEY])
      ? (thread.engineMetadata[CONTEXT_USAGE_CACHE_METADATA_KEY] as Record<string, unknown>)
      : null;

  const nextCache = {
    currentTokens: usage.currentTokens,
    maxContextTokens: usage.maxContextTokens,
    contextWindowPercent: usage.contextPercent,
    inputTokens: usage.breakdown?.inputTokens ?? null,
    cachedInputTokens: usage.breakdown?.cachedInputTokens ?? null,
    cacheWriteInputTokens: usage.breakdown?.cacheWriteInputTokens ?? null,
    outputTokens: usage.breakdown?.outputTokens ?? null,
    reasoningOutputTokens: usage.breakdown?.reasoningOutputTokens ?? null,
  };

  if (
    normalizeContextUsageCacheInteger(currentCache?.currentTokens) === nextCache.currentTokens &&
    normalizeContextUsageCacheInteger(currentCache?.maxContextTokens) ===
      nextCache.maxContextTokens &&
    normalizeContextUsageCachePercent(currentCache?.contextWindowPercent) ===
      nextCache.contextWindowPercent &&
    normalizeContextUsageCacheInteger(currentCache?.inputTokens) === nextCache.inputTokens &&
    normalizeContextUsageCacheInteger(currentCache?.cachedInputTokens) ===
      nextCache.cachedInputTokens &&
    normalizeContextUsageCacheInteger(currentCache?.cacheWriteInputTokens) ===
      nextCache.cacheWriteInputTokens &&
    normalizeContextUsageCacheInteger(currentCache?.outputTokens) === nextCache.outputTokens &&
    normalizeContextUsageCacheInteger(currentCache?.reasoningOutputTokens) ===
      nextCache.reasoningOutputTokens
  ) {
    return thread;
  }

  const metadata = { ...(thread.engineMetadata ?? {}) };
  metadata[CONTEXT_USAGE_CACHE_METADATA_KEY] = nextCache;

  return {
    ...thread,
    engineMetadata: metadata,
  };
}

function syncThreadContextUsageCache(threadId: string, usage: ContextUsage | null): void {
  if (!hasContextUsageMetrics(usage)) {
    return;
  }

  const threadStore = useThreadStore.getState();
  const thread = threadStore.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    return;
  }

  const updatedThread = mergeContextUsageCacheIntoThread(thread, usage);
  if (updatedThread !== thread) {
    threadStore.applyThreadUpdateLocal(updatedThread);
  }
}

export function resetUsageLimitCachesForTests(): void {
  lastKnownCodexAccountUsageWindows = null;
  pendingTurnMetaByThread.clear();
  bindingSeqByThread.clear();
  queuedTurnFinishedEventsByThread.clear();
  cachedThreadViews.clear();
}

function isThreadTurnActive(status: ThreadStatus): boolean {
  return status === "streaming" || status === "awaiting_approval";
}

function threadStatusFromTurnCompletion(
  event: Extract<StreamEvent, { type: "TurnCompleted" }>,
): ThreadStatus {
  if (event.status === "failed") {
    return "error";
  }
  if (event.status === "interrupted") {
    return "idle";
  }
  return "completed";
}

function applyRuntimeStateFromEvent(
  status: ThreadStatus,
  streaming: boolean,
  event: StreamEvent,
  messages: Message[],
): Pick<ChatState, "status" | "streaming"> {
  if (event.type === "UsageLimitsUpdated") {
    return { status, streaming };
  }

  if (event.type === "ApprovalRequested") {
    return { status: "awaiting_approval", streaming: true };
  }

  if (event.type === "ApprovalResolved") {
    return deriveRuntimeStateFromMessages(messages) ?? { status: "streaming", streaming: true };
  }

  if (event.type === "Error" && !event.recoverable) {
    return { status: "error", streaming: false };
  }

  if (event.type === "TurnCompleted") {
    if (messagesHavePendingApprovals(messages)) {
      return { status: "awaiting_approval", streaming: true };
    }

    const completionStatus = String(event.status ?? "completed");
    if (completionStatus === "failed") {
      return { status: "error", streaming: false };
    }
    if (completionStatus === "interrupted") {
      return { status: "idle", streaming: false };
    }
    return { status: "completed", streaming: false };
  }

  if (event.type === "TurnStarted" || eventHasVisibleAssistantContent(event)) {
    return { status: "streaming", streaming: true };
  }

  return { status, streaming };
}

function recordPendingTurnMetric(
  threadId: string,
  flag: keyof Pick<
    PendingTurnMeta,
    "firstShellRecorded" | "firstContentRecorded" | "firstTextRecorded"
  >,
  metricName:
    | "chat.turn.first_shell.ms"
    | "chat.turn.first_content.ms"
    | "chat.turn.first_text.ms",
) {
  const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
  if (!pendingTurnMeta || pendingTurnMeta[flag]) {
    return;
  }

  pendingTurnMeta[flag] = true;
  recordPerfMetric(metricName, performance.now() - pendingTurnMeta.startedAt, {
    threadId,
    clientTurnId: pendingTurnMeta.clientTurnId ?? undefined,
    engineId: pendingTurnMeta.turnEngineId ?? undefined,
    modelId: pendingTurnMeta.turnModelId ?? undefined,
  });
}

function schedulePendingTurnShellMetric(threadId: string, clientTurnId: string) {
  const schedule = (() => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      return globalThis.requestAnimationFrame.bind(globalThis);
    }
    return (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(performance.now()), 0);
  })();

  schedule(() => {
    const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
    if (!pendingTurnMeta || pendingTurnMeta.clientTurnId !== clientTurnId) {
      return;
    }
    recordPendingTurnMetric(threadId, "firstShellRecorded", "chat.turn.first_shell.ms");
  });
}

function eventHasVisibleAssistantContent(event: StreamEvent): boolean {
  switch (event.type) {
    case "TextDelta":
      return String(event.content ?? "").length > 0;
    case "ThinkingDelta":
      return String(event.content ?? "").length > 0;
    case "TurnSnapshotRecovered":
      return Array.isArray(event.blocks) && event.blocks.length > 0;
    case "ActionStarted":
    case "ActionOutputDelta":
    case "ActionCompleted":
    case "ApprovalRequested":
    case "DiffUpdated":
    case "ActionProgressUpdated":
    case "ModelRerouted":
    case "Notice":
    case "Error":
      return true;
    default:
      return false;
  }
}

function recordPendingTurnLatencyMetrics(threadId: string, event: StreamEvent) {
  if (eventHasVisibleAssistantContent(event)) {
    recordPendingTurnMetric(threadId, "firstContentRecorded", "chat.turn.first_content.ms");
  }

  if (event.type === "TextDelta" && String(event.content ?? "").length > 0) {
    recordPendingTurnMetric(threadId, "firstTextRecorded", "chat.turn.first_text.ms");
  }
}

function normalizeNoticeDetails(details: unknown): string[] | undefined {
  if (!Array.isArray(details)) {
    return undefined;
  }

  const normalized = details
    .filter((detail): detail is string => typeof detail === "string")
    .map((detail) => detail.trim())
    .filter((detail) => detail.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function isContextCompactionNoticeEvent(
  event: StreamEvent,
): event is Extract<StreamEvent, { type: "Notice" }> {
  return event.type === "Notice" && String(event.kind ?? "") === "context_compacted";
}

function enqueueStreamEvent(queue: StreamEvent[], event: StreamEvent) {
  const previous = queue[queue.length - 1];
  if (!previous) {
    queue.push(event);
    return;
  }

  if (previous.type === "TextDelta" && event.type === "TextDelta") {
    queue[queue.length - 1] = {
      ...previous,
      content: `${previous.content}${event.content}`,
    };
    return;
  }

  if (previous.type === "ThinkingDelta" && event.type === "ThinkingDelta") {
    queue[queue.length - 1] = {
      ...previous,
      content: `${previous.content}${event.content}`,
    };
    return;
  }

  if (
    previous.type === "ActionOutputDelta" &&
    event.type === "ActionOutputDelta" &&
    previous.action_id === event.action_id &&
    previous.stream === event.stream
  ) {
    queue[queue.length - 1] = {
      ...previous,
      content: `${previous.content}${event.content}`,
    };
    return;
  }

  if (
    previous.type === "ActionProgressUpdated" &&
    event.type === "ActionProgressUpdated" &&
    previous.action_id === event.action_id
  ) {
    queue[queue.length - 1] = event;
    return;
  }

  if (
    previous.type === "DiffUpdated" &&
    event.type === "DiffUpdated" &&
    previous.scope === event.scope
  ) {
    queue[queue.length - 1] = event;
    return;
  }

  if (previous.type === "UsageLimitsUpdated" && event.type === "UsageLimitsUpdated") {
    queue[queue.length - 1] = event;
    return;
  }

  queue.push(event);
}

function resolveApprovalDecision(response: ApprovalResponse): ApprovalBlock["decision"] {
  if ("decision" in response && typeof response.decision === "string") {
    const decision = String(response.decision).trim();
    if (decision === "deny") {
      return "decline";
    }
    if (decision === "acceptForSession") {
      return "accept_for_session";
    }
    return decision as ApprovalBlock["decision"];
  }

  if ("action" in response && typeof response.action === "string") {
    const action = String(response.action).trim();
    if (action === "accept" || action === "decline" || action === "cancel") {
      return action;
    }
    return "custom";
  }

  if ("permissions" in response) {
    const scope = response.scope;
    const permissions =
      typeof response.permissions === "object" &&
      response.permissions !== null &&
      !Array.isArray(response.permissions)
        ? (response.permissions as Record<string, unknown>)
        : null;
    const hasGrantedPermission =
      permissions !== null &&
      Object.values(permissions).some((value) => {
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        if (typeof value === "object" && value !== null) {
          return Object.values(value as Record<string, unknown>).some((nested) => {
            if (Array.isArray(nested)) {
              return nested.length > 0;
            }
            if (typeof nested === "object" && nested !== null) {
              return Object.keys(nested as Record<string, unknown>).length > 0;
            }
            return nested === true || (typeof nested === "string" && nested.toLowerCase() !== "none");
          });
        }
        return value === true || (typeof value === "string" && value.toLowerCase() !== "none");
      });

    if (!hasGrantedPermission) {
      return "decline";
    }
    if (scope === "session") {
      return "accept_for_session";
    }
    return "accept";
  }

  return "custom";
}

function normalizeActionOutputStream(
  stream: unknown,
): ActionBlock["outputChunks"][number]["stream"] {
  return stream === "stderr" || stream === "stdin" ? stream : "stdout";
}

function resolveApprovalInMessages(
  messages: Message[],
  approvalId: string,
  decision?: ApprovalBlock["decision"],
  responseData?: Record<string, unknown>,
): Message[] {
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const blocks = message.blocks;
    if (!blocks || blocks.length === 0) {
      continue;
    }

    const approvalIndex = blocks.findIndex(
      (block) => block.type === "approval" && block.approvalId === approvalId,
    );
    if (approvalIndex < 0) {
      continue;
    }

    const approvalBlock = blocks[approvalIndex] as ApprovalBlock;
    if (
      approvalBlock.status === "answered" &&
      (decision === undefined || approvalBlock.decision === decision)
    ) {
      return messages;
    }

    const nextBlocks = [...blocks];
    nextBlocks[approvalIndex] = {
      ...approvalBlock,
      status: "answered" as const,
      ...(decision !== undefined ? { decision } : {}),
      ...(responseData !== undefined ? { responseData } : {}),
    };

    const nextMessages = [...messages];
    nextMessages[messageIndex] = {
      ...message,
      blocks: nextBlocks,
    };
    return nextMessages;
  }

  return messages;
}

function trimActionOutputChunks(
  chunks: ActionBlock["outputChunks"],
): {
  chunks: ActionBlock["outputChunks"];
  truncated: boolean;
} {
  if (chunks.length === 0) {
    return { chunks, truncated: false };
  }

  let nextChunks = chunks;
  let truncated = false;

  if (nextChunks.length > ACTION_OUTPUT_MAX_CHUNKS) {
    nextChunks = nextChunks.slice(nextChunks.length - ACTION_OUTPUT_MAX_CHUNKS);
    truncated = true;
  }

  let totalChars = 0;
  for (const chunk of nextChunks) {
    totalChars += chunk.content.length;
  }

  if (totalChars <= ACTION_OUTPUT_MAX_CHARS) {
    return { chunks: nextChunks, truncated };
  }

  truncated = true;
  let charsToTrim = totalChars - ACTION_OUTPUT_TRIM_TARGET_CHARS;
  const trimmedChunks = [...nextChunks];
  let startIndex = 0;

  while (charsToTrim > 0 && startIndex < trimmedChunks.length) {
    const currentChunk = trimmedChunks[startIndex];
    const currentLength = currentChunk.content.length;
    if (currentLength <= charsToTrim) {
      charsToTrim -= currentLength;
      startIndex += 1;
      continue;
    }
    trimmedChunks[startIndex] = {
      ...currentChunk,
      content: currentChunk.content.slice(charsToTrim),
    };
    charsToTrim = 0;
  }

  return {
    chunks: trimmedChunks.slice(startIndex),
    truncated,
  };
}

function patchActionBlock(
  blocks: ContentBlock[],
  actionId: string,
  updater: (block: ActionBlock) => ActionBlock,
): ContentBlock[] {
  const blockIndex = blocks.findIndex(
    (block) => block.type === "action" && block.actionId === actionId,
  );
  if (blockIndex < 0) {
    return blocks;
  }

  const current = blocks[blockIndex] as ActionBlock;
  const nextBlock = updater(current);
  if (nextBlock === current) {
    return blocks;
  }

  const nextBlocks = [...blocks];
  nextBlocks[blockIndex] = nextBlock;
  return nextBlocks;
}

function createStreamingAssistantMessage(
  threadId: string,
  options?: {
    id?: string;
    clientTurnId?: string | null;
  },
): Message {
  const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
  return {
    id: options?.id ?? crypto.randomUUID(),
    threadId,
    role: "assistant",
    clientTurnId: options?.clientTurnId ?? pendingTurnMeta?.clientTurnId ?? null,
    turnEngineId: pendingTurnMeta?.turnEngineId ?? null,
    turnModelId: pendingTurnMeta?.turnModelId ?? null,
    turnReasoningEffort: pendingTurnMeta?.turnReasoningEffort ?? null,
    status: "streaming",
    schemaVersion: 1,
    blocks: [],
    createdAt: new Date().toISOString(),
    hydration: "full",
    hasDeferredContent: false,
  };
}

function createOptimisticUserMessage(
  threadId: string,
  message: string,
  options?: {
    attachments?: ChatAttachment[];
    inputItems?: ChatInputItem[];
    planMode?: boolean;
  },
): Message {
  const attachments = options?.attachments ?? [];
  const inputItems = options?.inputItems ?? [];
  const planMode = options?.planMode ?? false;
  const userBlocks: ContentBlock[] = [];

  for (const inputItem of inputItems) {
    if (inputItem.type === "skill") {
      userBlocks.push({
        type: "skill",
        name: inputItem.name,
        path: inputItem.path,
      });
    } else if (inputItem.type === "mention") {
      userBlocks.push({
        type: "mention",
        name: inputItem.name,
        path: inputItem.path,
      });
    }
  }

  for (const attachment of attachments) {
    userBlocks.push({
      type: "attachment",
      fileName: attachment.fileName,
      filePath: attachment.filePath,
      sizeBytes: attachment.sizeBytes,
      mimeType: attachment.mimeType,
    });
  }

  userBlocks.push({ type: "text", content: message, planMode: planMode || undefined });

  return {
    id: crypto.randomUUID(),
    threadId,
    role: "user",
    content: message,
    blocks: userBlocks,
    status: "completed",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    hydration: "full",
    hasDeferredContent: false,
  };
}

function createSteerBlock(
  message: string,
  options?: {
    attachments?: ChatAttachment[];
    inputItems?: ChatInputItem[];
    planMode?: boolean;
    steerId?: string;
  },
): SteerBlock {
  const attachments = (options?.attachments ?? []).map<AttachmentBlock>((attachment) => ({
    type: "attachment",
    fileName: attachment.fileName,
    filePath: attachment.filePath,
    sizeBytes: attachment.sizeBytes,
    mimeType: attachment.mimeType,
  }));
  const skills: SkillBlock[] = [];
  const mentions: MentionBlock[] = [];

  for (const inputItem of options?.inputItems ?? []) {
    if (inputItem.type === "skill") {
      skills.push({
        type: "skill",
        name: inputItem.name,
        path: inputItem.path,
      });
    } else if (inputItem.type === "mention") {
      mentions.push({
        type: "mention",
        name: inputItem.name,
        path: inputItem.path,
      });
    }
  }

  return {
    type: "steer",
    steerId: options?.steerId ?? crypto.randomUUID(),
    content: message,
    planMode: options?.planMode || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    skills: skills.length > 0 ? skills : undefined,
    mentions: mentions.length > 0 ? mentions : undefined,
    observedAtMs: Date.now(),
    status: "pending",
  };
}

function createSteerBlockFromMessage(message: Message): SteerBlock {
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const content =
    typeof message.content === "string" && message.content.length > 0
      ? message.content
      : blocks
          .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.content)
          .join("\n");
  const attachments = blocks.filter(
    (block): block is AttachmentBlock => block.type === "attachment",
  );
  const skills = blocks.filter((block): block is SkillBlock => block.type === "skill");
  const mentions = blocks.filter((block): block is MentionBlock => block.type === "mention");
  const planMode = blocks.some(
    (block) => block.type === "text" && Boolean(block.planMode),
  );

  return {
    type: "steer",
    steerId: message.id,
    persistedMessageId: message.id,
    content,
    planMode: planMode || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    skills: skills.length > 0 ? skills : undefined,
    mentions: mentions.length > 0 ? mentions : undefined,
    observedAtMs: parseMessageCreatedAtTimestamp(message.createdAt) ?? undefined,
    status: "accepted",
  };
}

function messageHasSteerMarker(message: Message): boolean {
  return (message.blocks ?? []).some(
    (block) => block.type === "text" && block.isSteer === true,
  );
}

function appendSteerBlockToAssistantMessage(message: Message, steerBlock: SteerBlock): Message {
  const existingBlocks = message.blocks ?? [];
  if (
    existingBlocks.some(
      (block) => block.type === "steer" && block.steerId === steerBlock.steerId,
    )
  ) {
    return message;
  }

  const blocks = [...existingBlocks, steerBlock];
  return {
    ...message,
    blocks,
    hydration: "full",
    hasDeferredContent: hasDeferredActionOutput(blocks),
  };
}

function resolveActiveAssistantTarget(threadId: string): AssistantMessageTarget {
  const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
  return {
    clientTurnId: pendingTurnMeta?.clientTurnId ?? null,
    assistantMessageId: pendingTurnMeta?.assistantMessageId ?? null,
  };
}

function appendSteerBlockToActiveAssistant(
  messages: Message[],
  threadId: string,
  steerBlock: SteerBlock,
): Message[] {
  const { messages: ensuredMessages, assistantIndex } = ensureAssistantMessage(
    messages,
    threadId,
    resolveActiveAssistantTarget(threadId),
  );
  const assistant = ensuredMessages[assistantIndex];
  const nextAssistant = appendSteerBlockToAssistantMessage(assistant, steerBlock);
  if (nextAssistant === assistant) {
    return ensuredMessages;
  }

  return [
    ...ensuredMessages.slice(0, assistantIndex),
    nextAssistant,
    ...ensuredMessages.slice(assistantIndex + 1),
  ];
}

function removeSteerBlock(messages: Message[], steerId: string): Message[] {
  let nextMessages = messages;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const blocks = message.blocks ?? [];
    const nextBlocks = blocks.filter(
      (block) => !(block.type === "steer" && block.steerId === steerId),
    );
    if (nextBlocks.length === blocks.length) {
      continue;
    }

    if (nextMessages === messages) {
      nextMessages = [...messages];
    }
    nextMessages[index] = {
      ...message,
      blocks: nextBlocks,
      hydration: "full",
      hasDeferredContent: hasDeferredActionOutput(nextBlocks),
    };
  }

  return nextMessages;
}

function applySteerReceipt(
  messages: Message[],
  steerId: string,
  receipt: SteerMessageReceipt,
): Message[] {
  let nextMessages = messages;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const blocks = message.blocks ?? [];
    let changed = false;
    const nextBlocks = blocks.map((block) => {
      if (block.type !== "steer" || block.steerId !== steerId) return block;
      changed = true;
      return {
        ...block,
        persistedMessageId: receipt.messageId,
        sourceSequence: receipt.sourceSequence,
        status: receipt.acceptedSourceSequence === null ? "unconfirmed" as const : "accepted" as const,
      };
    });
    if (!changed) continue;
    if (nextMessages === messages) nextMessages = [...messages];
    nextMessages[index] = {
      ...message,
      blocks: nextBlocks,
      hydration: "full",
      hasDeferredContent: hasDeferredActionOutput(nextBlocks),
    };
  }
  return nextMessages;
}

function collapseTrailingSteerMessages(messages: Message[]): Message[] {
  let changed = false;
  const collapsed: Message[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const previous = collapsed[collapsed.length - 1];
    const nextMessage = messages[index + 1];

    const isSteerCandidate =
      message.role === "user" &&
      previous?.role === "assistant" &&
      messageHasSteerMarker(message) &&
      nextMessage?.role !== "assistant";

    if (isSteerCandidate) {
      collapsed[collapsed.length - 1] = appendSteerBlockToAssistantMessage(
        previous,
        createSteerBlockFromMessage(message),
      );
      changed = true;
      continue;
    }

    collapsed.push(message);
  }

  return changed ? collapsed : messages;
}

function isThreadStatusStreaming(status: ThreadStatus): boolean {
  return isThreadTurnActive(status);
}

function hasRenderableAssistantContent(message: Message): boolean {
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return true;
  }

  const blocks = message.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return false;
  }

  return blocks.some((block) => {
    if (block.type === "text" || block.type === "thinking") {
      return Boolean(block.content?.trim());
    }
    return true;
  });
}

function resolveActiveStreamingMessageIds(messages: Message[], threadId: string): Set<string> {
  const activeMessageIds = new Set<string>();
  const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
  if (pendingTurnMeta?.assistantMessageId) {
    activeMessageIds.add(pendingTurnMeta.assistantMessageId);
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isPendingAssistant =
      message.role === "assistant" &&
      (message.status === "streaming" ||
        (pendingTurnMeta?.clientTurnId != null &&
          message.clientTurnId === pendingTurnMeta.clientTurnId));
    if (!isPendingAssistant) {
      continue;
    }

    activeMessageIds.add(message.id);
    const previous = messages[index - 1];
    if (previous?.role === "user") {
      activeMessageIds.add(previous.id);
    }
  }

  return activeMessageIds;
}

function shouldPreferCurrentMessageDuringBind(current: Message, loaded: Message): boolean {
  if (current.role !== "assistant") {
    return false;
  }

  // A terminal event can arrive after the message query resolves but before
  // the replacement listener is installed. A message never legitimately
  // transitions from terminal back to streaming, so the newer in-memory
  // terminal state must win over that stale query result.
  if (current.status !== "streaming" && loaded.status === "streaming") {
    return true;
  }

  if (current.status !== "streaming" || loaded.status !== "streaming") {
    return false;
  }

  if (hasRenderableAssistantContent(current)) {
    return true;
  }

  return !hasRenderableAssistantContent(loaded);
}

function hasPersistedUserForCurrentOptimisticUser(
  currentMessage: Message,
  currentMessageIndex: number,
  currentMessages: Message[],
  mergedMessages: Message[],
): boolean {
  if (currentMessage.role !== "user") {
    return false;
  }

  const nextMessage = currentMessages[currentMessageIndex + 1];
  if (nextMessage?.role !== "assistant" || !nextMessage.clientTurnId) {
    return false;
  }

  const loadedAssistantIndex = mergedMessages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.clientTurnId === nextMessage.clientTurnId,
  );
  return loadedAssistantIndex > 0 && mergedMessages[loadedAssistantIndex - 1]?.role === "user";
}

function mergeRuntimeAssistantOntoPersistedMessage(
  persisted: Message,
  runtime: Message,
): Message {
  return {
    ...runtime,
    id: persisted.id,
    threadId: persisted.threadId,
    createdAt: persisted.createdAt,
    nativeTurnId: runtime.nativeTurnId ?? persisted.nativeTurnId,
    turnEngineId: runtime.turnEngineId ?? persisted.turnEngineId,
    turnModelId: runtime.turnModelId ?? persisted.turnModelId,
    turnReasoningEffort:
      runtime.turnReasoningEffort ?? persisted.turnReasoningEffort,
  };
}

function reconcileAssistantMessageIdentity(
  messages: Message[],
  optimisticAssistantMessageId: string,
  persistedAssistantMessageId: string,
  clientTurnId: string,
): Message[] {
  let runtimeIndex = messages.findIndex(
    (message) => message.role === "assistant" && message.id === optimisticAssistantMessageId,
  );
  if (runtimeIndex < 0) {
    runtimeIndex = messages.findIndex(
      (message) =>
        message.role === "assistant" && message.clientTurnId === clientTurnId,
    );
  }
  if (runtimeIndex < 0) {
    return messages;
  }

  const persistedIndex = messages.findIndex(
    (message) =>
      message.role === "assistant" && message.id === persistedAssistantMessageId,
  );
  const runtimeAssistant = messages[runtimeIndex];
  if (persistedIndex < 0) {
    const nextMessages = [...messages];
    nextMessages[runtimeIndex] = {
      ...runtimeAssistant,
      id: persistedAssistantMessageId,
      clientTurnId,
    };
    return nextMessages;
  }

  if (persistedIndex === runtimeIndex) {
    if (runtimeAssistant.clientTurnId === clientTurnId) {
      return messages;
    }
    const nextMessages = [...messages];
    nextMessages[runtimeIndex] = { ...runtimeAssistant, clientTurnId };
    return nextMessages;
  }

  const persistedAssistant = messages[persistedIndex];
  const reconciledAssistant = shouldPreferCurrentMessageDuringBind(
    runtimeAssistant,
    persistedAssistant,
  )
    ? mergeRuntimeAssistantOntoPersistedMessage(persistedAssistant, runtimeAssistant)
    : { ...persistedAssistant, clientTurnId };
  const optimisticUserIndex = runtimeIndex > 0 && messages[runtimeIndex - 1]?.role === "user"
    ? runtimeIndex - 1
    : -1;
  const persistedUserExists = persistedIndex > 0 && messages[persistedIndex - 1]?.role === "user";

  return messages.flatMap((message, index) => {
    if (index === persistedIndex) {
      return [reconciledAssistant];
    }
    if (index === runtimeIndex || (persistedUserExists && index === optimisticUserIndex)) {
      return [];
    }
    return [message];
  });
}

function mergeLoadedMessagesWithCurrentRuntimeMessages(
  loadedMessages: Message[],
  currentMessages: Message[],
  threadId: string,
): Message[] {
  if (currentMessages.length === 0) {
    return loadedMessages;
  }

  const activeMessageIds = resolveActiveStreamingMessageIds(currentMessages, threadId);
  const mergedMessages = [...loadedMessages];
  const loadedIndexById = new Map<string, number>();
  const loadedAssistantIndexByClientTurnId = new Map<string, number>();
  const loadedAssistantIndexByNativeTurnId = new Map<string, number>();
  const pendingTurn = pendingTurnMetaByThread.get(threadId);
  for (let index = 0; index < mergedMessages.length; index += 1) {
    const message = mergedMessages[index];
    loadedIndexById.set(message.id, index);
    if (message.role === "assistant" && message.clientTurnId) {
      loadedAssistantIndexByClientTurnId.set(message.clientTurnId, index);
    }
    if (message.role === "assistant" && message.nativeTurnId) {
      loadedAssistantIndexByNativeTurnId.set(message.nativeTurnId, index);
    }
    if (
      message.role === "assistant" &&
      pendingTurn?.clientTurnId &&
      pendingTurn.assistantMessageId === message.id
    ) {
      loadedAssistantIndexByClientTurnId.set(pendingTurn.clientTurnId, index);
    }
  }

  for (const currentMessage of currentMessages) {
    const loadedIndex = loadedIndexById.get(currentMessage.id);
    if (loadedIndex !== undefined) {
      const loadedMessage = mergedMessages[loadedIndex];
      if (shouldPreferCurrentMessageDuringBind(currentMessage, loadedMessage)) {
        mergedMessages[loadedIndex] = currentMessage.role === "assistant"
          ? mergeRuntimeAssistantOntoPersistedMessage(loadedMessage, currentMessage)
          : currentMessage;
      }
      continue;
    }

    if (currentMessage.role !== "assistant" || !currentMessage.clientTurnId) {
      continue;
    }

    const loadedAssistantIndex = loadedAssistantIndexByClientTurnId.get(
      currentMessage.clientTurnId,
    ) ?? (currentMessage.nativeTurnId
      ? loadedAssistantIndexByNativeTurnId.get(currentMessage.nativeTurnId)
      : undefined);
    if (loadedAssistantIndex === undefined) {
      continue;
    }

    const loadedAssistant = mergedMessages[loadedAssistantIndex];
    if (shouldPreferCurrentMessageDuringBind(currentMessage, loadedAssistant)) {
      mergedMessages[loadedAssistantIndex] = mergeRuntimeAssistantOntoPersistedMessage(
        loadedAssistant,
        currentMessage,
      );
      loadedAssistantIndexByClientTurnId.set(
        currentMessage.clientTurnId,
        loadedAssistantIndex,
      );
    }
  }

  const emittedIds = new Set(mergedMessages.map((message) => message.id));
  const emittedAssistantClientTurnIds = new Set(
    mergedMessages
      .filter(
        (message): message is Message & { clientTurnId: string } =>
          message.role === "assistant" && Boolean(message.clientTurnId),
      )
      .map((message) => message.clientTurnId),
  );

  for (let index = 0; index < currentMessages.length; index += 1) {
    const currentMessage = currentMessages[index];
    if (!activeMessageIds.has(currentMessage.id) || emittedIds.has(currentMessage.id)) {
      continue;
    }

    if (
      hasPersistedUserForCurrentOptimisticUser(
        currentMessage,
        index,
        currentMessages,
        mergedMessages,
      )
    ) {
      continue;
    }

    if (
      currentMessage.role === "assistant" &&
      currentMessage.clientTurnId &&
      emittedAssistantClientTurnIds.has(currentMessage.clientTurnId)
    ) {
      continue;
    }

    mergedMessages.push(currentMessage);
    emittedIds.add(currentMessage.id);
    if (currentMessage.role === "assistant" && currentMessage.clientTurnId) {
      emittedAssistantClientTurnIds.add(currentMessage.clientTurnId);
    }
  }

  return mergedMessages;
}

function mergeLoadedWindowWithCachedOlderHistory(
  loadedMessages: Message[],
  cachedMessages: Message[],
): { messages: Message[]; preservedOlderHistory: boolean } {
  if (loadedMessages.length === 0 || cachedMessages.length === 0) {
    return { messages: loadedMessages, preservedOlderHistory: false };
  }

  const firstLoaded = loadedMessages[0];
  const firstLoadedCachedIndex = cachedMessages.findIndex(
    (message) => message.id === firstLoaded.id,
  );
  if (firstLoadedCachedIndex < 0) {
    // With no shared identity there is no canonical boundary between these
    // windows. Timestamp inference can prepend stale pre-sync rows and corrupt
    // the backend sequence, so use the authoritative loaded window as-is.
    return { messages: loadedMessages, preservedOlderHistory: false };
  }
  const cachedOlderMessages = cachedMessages.slice(0, firstLoadedCachedIndex);

  if (cachedOlderMessages.length === 0) {
    return { messages: loadedMessages, preservedOlderHistory: false };
  }

  const loadedIds = new Set(loadedMessages.map((message) => message.id));
  return {
    messages: [
      ...cachedOlderMessages.filter((message) => !loadedIds.has(message.id)),
      ...loadedMessages,
    ],
    preservedOlderHistory: true,
  };
}

function resolveAssistantMessageIndex(
  messages: Message[],
  target: AssistantMessageTarget,
): number {
  if (target.assistantMessageId) {
    const byIdIndex = messages.findIndex((message) => message.id === target.assistantMessageId);
    if (byIdIndex >= 0) {
      return byIdIndex;
    }
  }

  if (target.clientTurnId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.clientTurnId === target.clientTurnId) {
        return index;
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.status === "streaming") {
      return index;
    }
  }

  return -1;
}

function compactTrailingStreamingAssistantMessages(
  messages: Message[],
  target: AssistantMessageTarget,
): Message[] {
  if (messages.length < 2) {
    return messages;
  }

  let trailingStart = messages.length;
  while (trailingStart > 0) {
    const message = messages[trailingStart - 1];
    if (message.role !== "assistant" || message.status !== "streaming") {
      break;
    }
    trailingStart -= 1;
  }

  const trailingCount = messages.length - trailingStart;
  if (trailingCount <= 1) {
    return messages;
  }

  const trailingMessages = messages.slice(trailingStart);
  let keepIndex = -1;

  if (target.assistantMessageId) {
    keepIndex = trailingMessages.findIndex((message) => message.id === target.assistantMessageId);
  }
  if (keepIndex < 0 && target.clientTurnId) {
    keepIndex = trailingMessages.findIndex(
      (message) => message.clientTurnId === target.clientTurnId,
    );
  }
  if (keepIndex < 0) {
    keepIndex = trailingMessages.length - 1;
    for (let index = trailingMessages.length - 1; index >= 0; index -= 1) {
      if (hasRenderableAssistantContent(trailingMessages[index])) {
        keepIndex = index;
        break;
      }
    }
  }

  return [...messages.slice(0, trailingStart), trailingMessages[keepIndex]];
}

function ensureAssistantMessage(
  messages: Message[],
  threadId: string,
  target: AssistantMessageTarget,
): { messages: Message[]; assistantIndex: number } {
  const compactedMessages = compactTrailingStreamingAssistantMessages(messages, target);
  const existingIndex = resolveAssistantMessageIndex(compactedMessages, target);
  if (existingIndex >= 0) {
    return {
      messages: compactedMessages,
      assistantIndex: existingIndex,
    };
  }

  const assistantMessage = createStreamingAssistantMessage(threadId, {
    id: target.assistantMessageId ?? undefined,
    clientTurnId: target.clientTurnId ?? null,
  });
  return {
    messages: [...compactedMessages, assistantMessage],
    assistantIndex: compactedMessages.length,
  };
}

function upsertBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  if (block.type === "action") {
    const idx = blocks.findIndex(
      (b) => b.type === "action" && (b as ActionBlock).actionId === block.actionId
    );
    if (idx >= 0) {
      const next = [...blocks];
      next[idx] = block;
      return next;
    }
  }

  if (block.type === "approval") {
    const idx = blocks.findIndex(
      (b) => b.type === "approval" && (b as ApprovalBlock).approvalId === block.approvalId
    );
    if (idx >= 0) {
      const next = [...blocks];
      next[idx] = block;
      return next;
    }
  }

  return [...blocks, block];
}

function upsertNoticeBlock(blocks: ContentBlock[], block: NoticeBlock): ContentBlock[] {
  const idx = blocks.findIndex(
    (candidate) =>
      candidate.type === "notice" &&
      (candidate as NoticeBlock).kind === block.kind,
  );
  if (idx >= 0) {
    const next = [...blocks];
    next[idx] = block;
    return next;
  }

  return [...blocks, block];
}

type TerminalTurnState = "completed" | "interrupted" | "failed";

function messagesHavePendingApprovals(messages: Message[]): boolean {
  return messages.some((message) =>
    message.role === "assistant" &&
    (message.blocks ?? []).some((block) => block.type === "approval" && block.status === "pending"),
  );
}

function deriveRuntimeStateFromMessages(
  messages: Message[],
): Pick<ChatState, "status" | "streaming"> | null {
  if (messagesHavePendingApprovals(messages)) {
    return { status: "awaiting_approval", streaming: true };
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    if (message.status === "error") {
      return { status: "error", streaming: false };
    }
    if (message.status === "completed") {
      return { status: "completed", streaming: false };
    }
    if (message.status === "interrupted") {
      return { status: "idle", streaming: false };
    }
    if (message.status === "streaming") {
      return { status: "streaming", streaming: true };
    }
  }

  return null;
}

function threadHasConfirmedRemoteTurn(thread: Thread | undefined): boolean {
  return Boolean(
    thread &&
      isThreadTurnActive(thread.status) &&
      hasConfirmedCodexRemoteTurn(thread),
  );
}

function resolveBoundThreadRuntimeState(
  threadId: string,
  thread: Thread | undefined,
  messages: Message[],
): Pick<ChatState, "status" | "streaming"> {
  const pendingTurn = pendingTurnMetaByThread.get(threadId);
  if (pendingTurn) {
    if (!pendingTurn.backendAccepted) {
      return { status: "streaming", streaming: true };
    }

    const persistedAssistant = pendingTurn.assistantMessageId
      ? messages.find((message) => message.id === pendingTurn.assistantMessageId)
      : undefined;
    if (!persistedAssistant || persistedAssistant.status === "streaming") {
      return { status: "streaming", streaming: true };
    }

    pendingTurnMetaByThread.delete(threadId);
  }

  if (threadHasConfirmedRemoteTurn(thread)) {
    return {
      status: thread?.status ?? "streaming",
      streaming: true,
    };
  }

  const messageRuntimeState = deriveRuntimeStateFromMessages(messages);
  if (messageRuntimeState) {
    return messageRuntimeState;
  }

  const status = thread?.status ?? "idle";
  return {
    status,
    streaming: isThreadStatusStreaming(status),
  };
}

function unresolvedActionTerminalError(
  state: TerminalTurnState,
  source?: TurnCompletionSource | null,
): string {
  if (source === "reconciled_stream_lost") {
    return "Panes lost the live Codex stream before this action reported completion.";
  }
  if (source === "reconciled_timeout") {
    return "Panes recovered the turn completion before this action reported completion.";
  }

  switch (state) {
    case "completed":
      return "The turn completed before this action reported completion.";
    case "failed":
      return "The turn failed before this action reported completion.";
    case "interrupted":
      return "The turn was interrupted before this action reported completion.";
    default:
      return "The turn ended before this action reported completion.";
  }
}

function terminalizeUnresolvedActionBlocks(
  blocks: ContentBlock[] | undefined,
  state: TerminalTurnState,
  source?: TurnCompletionSource | null,
): ContentBlock[] | undefined {
  if (!Array.isArray(blocks)) {
    return blocks;
  }

  let changed = false;
  const error = unresolvedActionTerminalError(state, source);
  const nextBlocks = blocks.map((block) => {
    if (
      block.type !== "action" ||
      (block.status !== "running" && block.status !== "pending")
    ) {
      return block;
    }

    changed = true;
    return {
      ...block,
      status: "error" as const,
      result:
        block.result ?? {
          success: false,
          error,
          durationMs: 0,
        },
    };
  });

  return changed ? nextBlocks : blocks;
}

function terminalizePendingApprovalBlocks(
  blocks: ContentBlock[] | undefined,
): ContentBlock[] | undefined {
  if (!Array.isArray(blocks)) {
    return blocks;
  }

  let changed = false;
  const nextBlocks = blocks.map((block) => {
    if (block.type !== "approval" || block.status !== "pending") {
      return block;
    }

    changed = true;
    return {
      ...block,
      status: "answered" as const,
      decision: block.decision ?? ("cancel" as const),
    };
  });

  return changed ? nextBlocks : blocks;
}

function terminalizeUnresolvedTurnBlocks(
  blocks: ContentBlock[] | undefined,
  state: TerminalTurnState,
  source?: TurnCompletionSource | null,
): ContentBlock[] | undefined {
  return terminalizePendingApprovalBlocks(terminalizeUnresolvedActionBlocks(blocks, state, source));
}

function cancelActiveAssistantMessage(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") {
    return messages;
  }

  if (last.status !== "streaming") {
    return messages;
  }

  return [
    ...messages.slice(0, -1),
    {
      ...last,
      status: "interrupted",
      blocks: terminalizeUnresolvedTurnBlocks(last.blocks, "interrupted") ?? last.blocks,
    },
  ];
}

function terminalStateFromMessageStatus(status: Message["status"]): TerminalTurnState | null {
  switch (status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function normalizeTerminalTurnBlocks(message: Message): Message {
  if (message.role !== "assistant") {
    return message;
  }

  const state = terminalStateFromMessageStatus(message.status);
  if (!state) {
    return message;
  }

  const nextBlocks = terminalizeUnresolvedTurnBlocks(message.blocks, state);
  if (nextBlocks === message.blocks) {
    return message;
  }

  return {
    ...message,
    blocks: nextBlocks,
  };
}

function normalizeBlocks(blocks?: ContentBlock[]): ContentBlock[] | undefined {
  if (!Array.isArray(blocks)) {
    return blocks;
  }

  const normalized: ContentBlock[] = [];
  for (const block of blocks) {
    // Historical messages may still contain the removed terminal-status card.
    // Drop it at the compatibility boundary instead of letting it reappear.
    if (block.type === "notice" && block.kind === "turn_status") {
      continue;
    }
    const last = normalized[normalized.length - 1];
    if (block.type === "text" && last?.type === "text") {
      normalized[normalized.length - 1] = {
        ...last,
        content: `${last.content}${block.content ?? ""}`
      };
      continue;
    }
    if (block.type === "thinking" && last?.type === "thinking") {
      normalized[normalized.length - 1] = {
        ...last,
        content: `${last.content}${block.content ?? ""}`
      };
      continue;
    }
    normalized.push(block);
  }

  return normalized;
}

function hasDeferredActionOutput(blocks?: ContentBlock[]): boolean {
  if (!Array.isArray(blocks)) {
    return false;
  }
  return blocks.some((block) => block.type === "action" && block.outputDeferred === true);
}

function markMessageAsFullyHydrated(message: Message): Message {
  const hasDeferredContent = hasDeferredActionOutput(message.blocks);
  if (message.hydration === "full" && message.hasDeferredContent === hasDeferredContent) {
    return message;
  }

  return {
    ...message,
    hydration: "full",
    hasDeferredContent,
  };
}

function summarizeActionBlockForMemory(block: ActionBlock): ActionBlock {
  const hasOutput =
    block.outputChunks.length > 0 ||
    (typeof block.result?.output === "string" && block.result.output.length > 0) ||
    block.outputDeferred === true;
  if (!hasOutput) {
    return block;
  }

  let nextResult = block.result;
  if (block.result && typeof block.result.output === "string") {
    nextResult = {
      ...block.result,
      output: undefined,
    };
  }

  if (
    block.outputDeferred === true &&
    block.outputDeferredLoaded === false &&
    block.outputChunks.length === 0 &&
    nextResult === block.result
  ) {
    return block;
  }

  return {
    ...block,
    outputChunks: [],
    outputDeferred: true,
    outputDeferredLoaded: false,
    result: nextResult,
  };
}

function summarizeMessageForMemory(message: Message): Message {
  const sourceBlocks = message.blocks;
  let nextBlocks = sourceBlocks;

  if (Array.isArray(sourceBlocks) && sourceBlocks.length > 0) {
    for (let index = 0; index < sourceBlocks.length; index += 1) {
      const block = sourceBlocks[index];
      if (block.type !== "action") {
        continue;
      }

      const summarizedBlock = summarizeActionBlockForMemory(block);
      if (summarizedBlock === block) {
        continue;
      }

      if (nextBlocks === sourceBlocks) {
        nextBlocks = [...sourceBlocks];
      }
      (nextBlocks as ContentBlock[])[index] = summarizedBlock;
    }
  }

  const hasDeferredContent = hasDeferredActionOutput(nextBlocks);
  if (
    nextBlocks === sourceBlocks &&
    message.hydration === "summary" &&
    message.hasDeferredContent === hasDeferredContent
  ) {
    return message;
  }

  return {
    ...message,
    hydration: "summary",
    hasDeferredContent,
    blocks: nextBlocks,
  };
}

function applyHydrationWindow(messages: Message[]): Message[] {
  if (messages.length === 0) {
    return messages;
  }

  const summarizeUntil = Math.max(0, messages.length - MAX_FULLY_HYDRATED_MESSAGES);
  let nextMessages = messages;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const nextMessage =
      index < summarizeUntil
        ? summarizeMessageForMemory(message)
        : message.hydration === "summary"
          ? message
          : markMessageAsFullyHydrated(message);
    if (nextMessage !== message) {
      if (nextMessages === messages) {
        nextMessages = [...messages];
      }
      nextMessages[index] = nextMessage;
    }
  }

  return nextMessages;
}

const SQLITE_MESSAGE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function parseMessageCreatedAtTimestamp(createdAt: string): number | null {
  if (SQLITE_MESSAGE_TIMESTAMP_PATTERN.test(createdAt)) {
    const normalized = `${createdAt.replace(" ", "T")}Z`;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const direct = Date.parse(createdAt);
  return Number.isFinite(direct) ? direct : null;
}

function normalizeMessages(
  messages: Message[],
  options?: { collapseTrailingSteers?: boolean },
): Message[] {
  // SQLite and Codex already provide an authoritative sequence. Timestamps are
  // metadata, not ordering keys: live user/assistant rows are commonly written
  // in the same millisecond, and imported completion times can overlap the next
  // turn. Preserve the source order all the way to the renderer.
  let nextMessages = messages;
  for (let index = 0; index < nextMessages.length; index += 1) {
    const message = nextMessages[index];
    const normalizedBlocks = normalizeBlocks(message.blocks);
    const normalizedContent =
      message.role === "user" && normalizedBlocks && typeof message.content === "string"
        ? undefined
        : message.content;
    const normalizedMessage =
      normalizedBlocks === message.blocks && normalizedContent === message.content
        ? message
        : {
            ...message,
            content: normalizedContent,
            blocks: normalizedBlocks,
          };
    const nextMessage = markMessageAsFullyHydrated(
      normalizeTerminalTurnBlocks(normalizedMessage),
    );
    if (nextMessage !== message) {
      if (nextMessages === messages) {
        nextMessages = [...messages];
      }
      nextMessages[index] = nextMessage;
    }
  }

  return options?.collapseTrailingSteers === false
    ? nextMessages
    : collapseTrailingSteerMessages(nextMessages);
}

function toIsoTimestamp(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const normalized = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

const CONTEXT_WINDOW_BASELINE_TOKENS = 12_000;

function calculateContextPercentRemaining(
  currentTokens: number | null,
  maxContextTokens: number | null,
): number | null {
  if (
    typeof currentTokens !== "number" ||
    !Number.isFinite(currentTokens) ||
    typeof maxContextTokens !== "number" ||
    !Number.isFinite(maxContextTokens)
  ) {
    return null;
  }

  if (maxContextTokens <= CONTEXT_WINDOW_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = maxContextTokens - CONTEXT_WINDOW_BASELINE_TOKENS;
  const usedTokens = Math.max(0, currentTokens - CONTEXT_WINDOW_BASELINE_TOKENS);
  const remainingTokens = Math.max(0, effectiveWindow - usedTokens);

  return Math.max(
    0,
    Math.min(100, Math.round((remainingTokens / effectiveWindow) * 100)),
  );
}

function mapUsageLimitsFromEvent(event: Extract<StreamEvent, { type: "UsageLimitsUpdated" }>): ContextUsage | null {
  const usage = event.usage ?? {};
  const currentTokensRaw = usage.current_tokens;
  const maxContextTokensRaw = usage.max_context_tokens;
  const contextPercentRaw = usage.context_window_percent;
  const breakdown = normalizeContextTokenBreakdown(
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.cache_write_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
  );
  const fiveHourPercentRaw = usage.five_hour_percent;
  const weeklyPercentRaw = usage.weekly_percent;

  const currentTokens =
    typeof currentTokensRaw === "number" ? Math.max(0, Math.round(currentTokensRaw)) : null;
  const maxContextTokens =
    typeof maxContextTokensRaw === "number" ? Math.max(0, Math.round(maxContextTokensRaw)) : null;
  const hasContextMetrics = currentTokens !== null || maxContextTokens !== null;

  let contextPercent = calculateContextPercentRemaining(currentTokens, maxContextTokens);
  if (contextPercent === null && typeof contextPercentRaw === "number") {
    contextPercent = Math.round(contextPercentRaw);
  }
  if (contextPercent !== null && !Number.isFinite(contextPercent)) {
    contextPercent = null;
  }

  const hasAnyMetric =
    hasContextMetrics ||
    breakdown !== null ||
    typeof contextPercentRaw === "number" ||
    typeof fiveHourPercentRaw === "number" ||
    typeof weeklyPercentRaw === "number";
  if (!hasAnyMetric) {
    return null;
  }

  // Codex reports `usedPercent`; UI shows remaining budget.
  const toRemainingPercent = (
    usedPercent: number | null | undefined,
  ): number | null => {
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
      return null;
    }
    const used = Math.max(0, Math.min(100, Math.round(usedPercent)));
    return 100 - used;
  };

  return {
    currentTokens,
    maxContextTokens,
    contextPercent:
      contextPercent === null ? null : Math.max(0, Math.min(100, contextPercent)),
    breakdown,
    windowFiveHourPercent: toRemainingPercent(fiveHourPercentRaw),
    windowWeeklyPercent: toRemainingPercent(weeklyPercentRaw),
    windowFiveHourResetsAt: toIsoTimestamp(usage.five_hour_resets_at),
    windowWeeklyResetsAt: toIsoTimestamp(usage.weekly_resets_at),
  };
}

function mergeUsageLimits(
  previous: ContextUsage | null,
  next: ContextUsage | null,
): ContextUsage | null {
  if (!next) {
    return previous;
  }

  if (!previous) {
    return next;
  }

  return {
    currentTokens: next.currentTokens ?? previous.currentTokens,
    maxContextTokens: next.maxContextTokens ?? previous.maxContextTokens,
    contextPercent: next.contextPercent ?? previous.contextPercent,
    breakdown: next.breakdown ?? previous.breakdown,
    windowFiveHourPercent: next.windowFiveHourPercent ?? previous.windowFiveHourPercent,
    windowWeeklyPercent: next.windowWeeklyPercent ?? previous.windowWeeklyPercent,
    windowFiveHourResetsAt: next.windowFiveHourResetsAt ?? previous.windowFiveHourResetsAt,
    windowWeeklyResetsAt: next.windowWeeklyResetsAt ?? previous.windowWeeklyResetsAt,
  };
}

function resolveAssistantTargetFromEvent(
  threadId: string,
  event: StreamEvent,
): AssistantMessageTarget {
  const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
  const eventClientTurnId =
    event.type === "TurnStarted" && typeof event.client_turn_id === "string"
      ? event.client_turn_id
      : null;

  return {
    clientTurnId: eventClientTurnId ?? pendingTurnMeta?.clientTurnId ?? null,
    assistantMessageId:
      eventClientTurnId && pendingTurnMeta?.clientTurnId === eventClientTurnId
        ? pendingTurnMeta.assistantMessageId ?? null
        : pendingTurnMeta?.assistantMessageId ?? null,
  };
}

function applyStreamEvent(messages: Message[], event: StreamEvent, threadId: string): Message[] {
  if (event.type === "UsageLimitsUpdated") {
    return messages;
  }

  if (event.type === "ApprovalResolved") {
    return resolveApprovalInMessages(messages, String(event.approval_id ?? ""));
  }

  const assistantTarget = resolveAssistantTargetFromEvent(threadId, event);
  const { messages: ensuredMessages, assistantIndex } = ensureAssistantMessage(
    messages,
    threadId,
    assistantTarget,
  );
  let next = ensuredMessages;
  const currentAssistant = next[assistantIndex];
  const assistant: Message = { ...currentAssistant };
  const existingBlocks = currentAssistant.blocks ?? [];
  assistant.blocks = existingBlocks;

  if (event.type === "TurnStarted" && typeof event.client_turn_id === "string") {
    assistant.clientTurnId = event.client_turn_id;
  }
  if (event.type === "TurnStarted" && typeof event.native_turn_id === "string") {
    assistant.nativeTurnId = event.native_turn_id;
  }

  if (event.type === "TurnSnapshotRecovered") {
    assistant.blocks = normalizeBlocks(Array.isArray(event.blocks) ? event.blocks : []) ?? [];
  }

  // Stamp durationMs on the last thinking block when a non-thinking event arrives
  if (event.type !== "ThinkingDelta") {
    const blocks = assistant.blocks ?? [];
    const last = blocks[blocks.length - 1];
    if (last?.type === "thinking" && last.startedAt != null && last.durationMs == null) {
      assistant.blocks = [
        ...blocks.slice(0, -1),
        { ...last, durationMs: Date.now() - last.startedAt },
      ];
    }
  }

  if (event.type === "TextDelta") {
    const blocks = assistant.blocks ?? [];
    const delta = String(event.content ?? "");
    if (!delta) {
      return next;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") {
      assistant.blocks = [
        ...blocks.slice(0, -1),
        {
          ...last,
          content: `${last.content}${delta}`,
        },
      ];
    } else {
      assistant.blocks = [...blocks, { type: "text", content: delta }];
    }
  }

  if (event.type === "ThinkingDelta") {
    const blocks = assistant.blocks ?? [];
    const delta = String(event.content ?? "");
    if (!delta) {
      return next;
    }
    const last = blocks[blocks.length - 1];
    if (last?.type === "thinking") {
      assistant.blocks = [
        ...blocks.slice(0, -1),
        {
          ...last,
          content: `${last.content}${delta}`,
        },
      ];
    } else {
      assistant.blocks = [...blocks, { type: "thinking" as const, content: delta, startedAt: Date.now() }];
    }
  }

  if (event.type === "ActionStarted") {
    const blocks = assistant.blocks ?? [];
    assistant.blocks = upsertBlock(blocks, {
      type: "action",
      actionId: String(event.action_id),
      engineActionId: event.engine_action_id as string | undefined,
      actionType: String(event.action_type ?? "other") as ActionBlock["actionType"],
      summary: String(event.summary ?? ""),
      details: (event.details as Record<string, unknown>) ?? {},
      outputChunks: [],
      outputDeferred: false,
      outputDeferredLoaded: true,
      status: "running"
    });
  }

  if (event.type === "ActionOutputDelta") {
    const actionId = String(event.action_id ?? "");
    const stream = normalizeActionOutputStream(event.stream);
    const content = String(event.content ?? "");
    if (actionId && content) {
      const blocks = assistant.blocks ?? [];
      assistant.blocks = patchActionBlock(blocks, actionId, (block) => {
        const details = (block.details ?? {}) as Record<string, unknown>;
        const previousChunk = block.outputChunks[block.outputChunks.length - 1];
        const mergedChunks =
          previousChunk && previousChunk.stream === stream
            ? [
                ...block.outputChunks.slice(0, -1),
                {
                  ...previousChunk,
                  content: `${previousChunk.content}${content}`,
                },
              ]
            : [
                ...block.outputChunks,
                {
                  stream,
                  content,
                },
              ];
        const { chunks: nextOutputChunks, truncated } = trimActionOutputChunks(mergedChunks);
        const shouldMarkTruncated =
          truncated &&
          !("outputTruncated" in details && details.outputTruncated === true);
        const nextDetails = shouldMarkTruncated
          ? {
              ...details,
              outputTruncated: true,
            }
          : details;

        if (nextOutputChunks === block.outputChunks && nextDetails === block.details) {
          return block;
        }

        return {
          ...block,
          outputChunks: nextOutputChunks,
          details: nextDetails,
          outputDeferred: false,
          outputDeferredLoaded: true,
        };
      });
    }
  }

  if (event.type === "ActionProgressUpdated") {
    const actionId = String(event.action_id ?? "");
    const progressMessage = String(event.message ?? "");
    if (actionId && progressMessage) {
      const blocks = assistant.blocks ?? [];
      assistant.blocks = patchActionBlock(blocks, actionId, (block) => {
        const details = (block.details ?? {}) as Record<string, unknown>;
        if (
          details.progressKind === "mcp" &&
          typeof details.progressMessage === "string" &&
          details.progressMessage === progressMessage
        ) {
          return block;
        }

        return {
          ...block,
          details: {
            ...details,
            progressKind: "mcp",
            progressMessage,
          },
        };
      });
    }
  }

  if (event.type === "ActionCompleted") {
    const blocks = assistant.blocks ?? [];
    const actionId = String(event.action_id ?? "");
    assistant.blocks = patchActionBlock(blocks, actionId, (block) => {
      const result = (event.result as Record<string, unknown> | undefined) ?? {};
      const completedDetails = event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? event.details
        : {};
      return {
        ...block,
        details: {
          ...((block.details ?? {}) as Record<string, unknown>),
          ...completedDetails,
        },
        status: result.success ? "done" : "error",
        result: {
          success: Boolean(result.success),
          output: result.output as string | undefined,
          error: result.error as string | undefined,
          diff: result.diff as string | undefined,
          durationMs: Number(result.durationMs ?? result.duration_ms ?? 0)
        }
      };
    });
  }

  if (event.type === "ApprovalRequested") {
    const blocks = assistant.blocks ?? [];
    assistant.blocks = upsertBlock(blocks, {
      type: "approval",
      approvalId: String(event.approval_id),
      actionType: String(event.action_type ?? "other") as ApprovalBlock["actionType"],
      summary: String(event.summary ?? ""),
      details: (event.details as Record<string, unknown>) ?? {},
      status: "pending"
    });
  }

  if (event.type === "DiffUpdated") {
    const blocks = assistant.blocks ?? [];
    const scope = String(event.scope ?? "turn") as "turn" | "file" | "workspace";
    const diff = String(event.diff ?? "");

    let existingDiffIndex = -1;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.type === "diff" && block.scope === scope) {
        existingDiffIndex = index;
        break;
      }
    }

    if (existingDiffIndex >= 0) {
      const existingBlock = blocks[existingDiffIndex];
      if (existingBlock.type === "diff") {
        const nextBlocks: ContentBlock[] = [];
        blocks.forEach((block, index) => {
          if (block.type === "diff" && block.scope === scope) {
            if (index === existingDiffIndex) {
              nextBlocks.push({
                ...existingBlock,
                diff,
              });
            }
            return;
          }
          nextBlocks.push(block);
        });
        if (nextBlocks.length !== blocks.length || existingBlock.diff !== diff) {
          assistant.blocks = nextBlocks;
        }
      }
    } else {
      assistant.blocks = [
        ...blocks,
        {
          type: "diff",
          diff,
          scope,
        },
      ];
    }
  }

  if (event.type === "ModelRerouted") {
    const fromModel = String(event.from_model ?? "").trim();
    const toModel = String(event.to_model ?? "").trim();
    const reason = String(event.reason ?? "").trim();
    if (toModel) {
      assistant.turnModelId = toModel;
      assistant.blocks = upsertNoticeBlock(assistant.blocks ?? [], {
        type: "notice",
        kind: "model_rerouted",
        level: "info",
        title: "Model rerouted",
        message: `Switched from ${fromModel || "the requested model"} to ${toModel}${reason ? ` (${reason})` : ""}.`,
      });
    }
  }

  if (event.type === "Notice") {
    const kind = String(event.kind ?? "notice");
    if (kind !== "turn_status") {
      assistant.blocks = upsertNoticeBlock(assistant.blocks ?? [], {
        type: "notice",
        kind,
        level:
          event.level === "warning" || event.level === "error"
            ? event.level
            : "info",
        title: String(event.title ?? "Notice"),
        message: String(event.message ?? ""),
        details: normalizeNoticeDetails(event.details),
      });
    }
  }

  if (event.type === "Error") {
    const blocks = assistant.blocks ?? [];
    assistant.blocks = [...blocks, { type: "error", message: String(event.message ?? "Unknown error") }];
    if (!event.recoverable) {
      assistant.status = "error";
    }
  }

  if (event.type === "TurnCompleted") {
    const status = String(event.status ?? "completed");
    const terminalState =
      status === "failed"
        ? "failed"
        : status === "interrupted"
          ? "interrupted"
          : "completed";
    const source = event.diagnostics?.source;
    assistant.blocks = terminalizeUnresolvedTurnBlocks(
      assistant.blocks ?? [],
      terminalState,
      source,
    ) ?? [];
    if (status === "failed") {
      assistant.status = "error";
    } else if (status === "interrupted") {
      assistant.status = "interrupted";
    } else {
      assistant.status = "completed";
    }
  }

  assistant.hydration = "full";
  assistant.hasDeferredContent = hasDeferredActionOutput(assistant.blocks);

  const blocksChanged = assistant.blocks !== existingBlocks;
  const statusChanged = assistant.status !== currentAssistant.status;
  const metadataChanged =
    assistant.clientTurnId !== currentAssistant.clientTurnId ||
    assistant.nativeTurnId !== currentAssistant.nativeTurnId ||
    assistant.turnEngineId !== currentAssistant.turnEngineId ||
    assistant.turnModelId !== currentAssistant.turnModelId ||
    assistant.turnReasoningEffort !== currentAssistant.turnReasoningEffort ||
    assistant.hydration !== currentAssistant.hydration ||
    assistant.hasDeferredContent !== currentAssistant.hasDeferredContent;

  if (!blocksChanged && !statusChanged && !metadataChanged) {
    return next;
  }

  next = [
    ...next.slice(0, assistantIndex),
    assistant,
    ...next.slice(assistantIndex + 1),
  ];
  return next;
}

export const useChatStore = create<ChatState>((set, get) => ({
  threadId: null,
  messages: [],
  olderCursor: null,
  hasOlderMessages: false,
  loadingOlderMessages: false,
  olderLoadBlockedUntil: 0,
  status: "idle",
  streaming: false,
  usageLimits: null,
  setActiveThread: async (threadId, options) => {
    const currentThreadId = get().threadId;
    const currentUnlisten = get().unlisten;
    if (threadId && threadId === currentThreadId && currentUnlisten && !options?.forceReload) {
      return;
    }

    const bindStartedAt = performance.now();
    if (currentThreadId && currentThreadId !== threadId) {
      cacheBoundThreadView(get());
    }

    activeThreadBindSeq += 1;
    const bindSeq = activeThreadBindSeq;
    if (threadId) {
      bindingSeqByThread.set(threadId, bindSeq);
    }

    if (currentThreadId && currentThreadId !== threadId) {
      useThreadStore
        .getState()
        .setThreadStatusLocal(currentThreadId, get().status);
    }

    // Tear down the current listener. If the thread was still streaming,
    // install a lightweight background listener that watches for TurnCompleted
    // so the thread status updates correctly when the user switches back.
    if (currentUnlisten) {
      currentUnlisten();
    }
    if (currentThreadId && currentThreadId !== threadId && get().streaming) {
      cleanupBackgroundListener(currentThreadId);
      let backgroundTurnFinished = false;
      listenThreadEvents(currentThreadId, (event) => {
        if (event.type === "ApprovalRequested") {
          updateCachedThreadRuntimeState(currentThreadId, "awaiting_approval", true);
          useThreadStore
            .getState()
            .setThreadStatusLocal(currentThreadId, "awaiting_approval");
          return;
        }
        if (event.type === "ApprovalResolved") {
          updateCachedThreadRuntimeState(currentThreadId, "streaming", true);
          useThreadStore.getState().setThreadStatusLocal(currentThreadId, "streaming");
          return;
        }
        if (event.type === "Error" && !event.recoverable) {
          backgroundTurnFinished = true;
          pendingTurnMetaByThread.delete(currentThreadId);
          updateCachedThreadRuntimeState(currentThreadId, "error", false);
          useThreadStore.getState().setThreadStatusLocal(currentThreadId, "error");
          cleanupBackgroundListener(currentThreadId);
          return;
        }
        if (event.type === "TurnCompleted") {
          backgroundTurnFinished = true;
          pendingTurnMetaByThread.delete(currentThreadId);
          const completedStatus = threadStatusFromTurnCompletion(event);
          updateCachedThreadRuntimeState(currentThreadId, completedStatus, false);
          useThreadStore
            .getState()
            .setThreadStatusLocal(currentThreadId, completedStatus);
          cleanupBackgroundListener(currentThreadId!);
        }
      }).then((unsub) => {
        // If the turn finished before listener registration settled, or the user
        // already switched back to this thread, do not retain a stale listener.
        if (
          backgroundTurnFinished ||
          useChatStore.getState().threadId === currentThreadId
        ) {
          unsub();
          return;
        }
        const existing = backgroundStreamListeners.get(currentThreadId!);
        if (existing) {
          // Another background listener was set up in the meantime
          unsub();
        } else {
          backgroundStreamListeners.set(currentThreadId!, unsub);
        }
      });
    }

    if (!threadId) {
      if (bindSeq !== activeThreadBindSeq) {
        return;
      }

      set({
        threadId: null,
        messages: [],
        olderCursor: null,
        hasOlderMessages: false,
        loadingOlderMessages: false,
        olderLoadBlockedUntil: 0,
        streaming: false,
        status: "idle",
        usageLimits: null,
        unlisten: undefined,
      });
      return;
    }

    const cachedView = !options?.forceReload && currentThreadId !== threadId
      ? readCachedThreadView(threadId)
      : null;
    if (cachedView) {
      set({
        threadId,
        messages: cachedView.messages,
        olderCursor: cachedView.olderCursor,
        hasOlderMessages: cachedView.hasOlderMessages,
        loadingOlderMessages: false,
        olderLoadBlockedUntil: 0,
        status: cachedView.status,
        streaming: cachedView.streaming,
        usageLimits: cachedView.usageLimits,
        error: undefined,
        unlisten: undefined,
      });
      recordPerfMetric("chat.thread.history_visible.ms", performance.now() - bindStartedAt, {
        threadId,
        source: "memory",
      });
    }

    try {
      // Clean up any background listener for this thread before re-subscribing
      cleanupBackgroundListener(threadId);

      const threadState = useThreadStore.getState();
      let activeThread = threadState.threads.find((thread) => thread.id === threadId);
      const syncPromise = isCodexThreadSyncRequired(activeThread)
        ? ipc.syncThreadFromEngine(threadId).then((syncedThread) => {
          threadState.applyThreadUpdateLocal(syncedThread);
          return syncedThread;
        }).catch((error) => {
          console.warn(`Failed to sync Codex thread ${threadId}:`, error);
          return null;
        })
        : null;

      const messageWindow = await ipc.getThreadMessagesWindow(
        threadId,
        null,
        MESSAGE_WINDOW_INITIAL_LIMIT,
      );
      const cachedHistoryMerge = cachedView
        ? mergeLoadedWindowWithCachedOlderHistory(
            normalizeMessages(messageWindow.messages),
            cachedView.messages,
          )
        : {
            messages: normalizeMessages(messageWindow.messages),
            preservedOlderHistory: false,
          };
      let messages = applyHydrationWindow(cachedHistoryMerge.messages);
      const olderCursor = cachedHistoryMerge.preservedOlderHistory
        ? cachedView?.olderCursor ?? null
        : messageWindow.nextCursor;
      if (bindSeq !== activeThreadBindSeq) {
        return;
      }

      // Publish durable local history as soon as it arrives. Listener setup and
      // Codex rollout reconciliation both remain important, but neither belongs
      // on the first-paint path when switching conversations.
      messages = replayQueuedTurnFinishedEvents(threadId, messages);
      const localState = get();
      const locallyMergedMessages = localState.threadId === threadId
        ? applyHydrationWindow(
            mergeLoadedMessagesWithCurrentRuntimeMessages(
              messages,
              localState.messages,
              threadId,
            ),
          )
        : messages;
      const localThread =
        useThreadStore
          .getState()
          .threads.find((candidate) => candidate.id === threadId) ?? activeThread;
      const localRuntimeState = resolveBoundThreadRuntimeState(
        threadId,
        localThread,
        locallyMergedMessages,
      );
      const localUsageLimits = localThread?.engineId === "codex"
        ? mergeUsageLimits(
            contextUsageFromThreadMetadata(localThread.engineMetadata),
            lastKnownCodexAccountUsageWindows,
          )
        : null;
      set({
        threadId,
        messages: locallyMergedMessages,
        olderCursor,
        hasOlderMessages: olderCursor !== null,
        loadingOlderMessages: false,
        olderLoadBlockedUntil: 0,
        unlisten: undefined,
        error: undefined,
        status: localRuntimeState.status,
        streaming: localRuntimeState.streaming,
        usageLimits: localUsageLimits,
      });
      writeCachedThreadView(threadId, {
        messages: locallyMergedMessages,
        olderCursor,
        hasOlderMessages: olderCursor !== null,
        status: localRuntimeState.status,
        streaming: localRuntimeState.streaming,
        usageLimits: localUsageLimits,
      });
      if (!cachedView) {
        recordPerfMetric("chat.thread.history_visible.ms", performance.now() - bindStartedAt, {
          threadId,
          source: "local",
        });
      }

      const queuedStreamEvents: StreamEvent[] = [];
      let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let streamFlushInProgress = false;
      let eventRateWindowStartedAt = performance.now();
      let eventRateWindowCount = 0;

      const emitEventRateMetric = (now: number) => {
        const elapsedMs = now - eventRateWindowStartedAt;
        if (elapsedMs <= 0 || eventRateWindowCount <= 0) {
          eventRateWindowStartedAt = now;
          eventRateWindowCount = 0;
          return;
        }
        const eventsPerSecond = (eventRateWindowCount * 1000) / elapsedMs;
        recordPerfMetric("chat.stream.events_per_sec", eventsPerSecond, {
          threadId,
          events: eventRateWindowCount,
          windowMs: elapsedMs,
        });
        eventRateWindowStartedAt = now;
        eventRateWindowCount = 0;
      };

      const flushQueuedStreamEvents = () => {
        if (streamFlushInProgress) {
          return;
        }
        // Listener registration can synchronously deliver events before this
        // thread becomes the bound chat. Keep those events queued so the
        // loaded snapshot and the subscription form one ordered handoff.
        if (bindSeq !== activeThreadBindSeq || get().threadId !== threadId) {
          return;
        }
        if (streamFlushTimer !== null) {
          globalThis.clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        if (queuedStreamEvents.length === 0) {
          return;
        }

        streamFlushInProgress = true;
        const batch = queuedStreamEvents.splice(0, queuedStreamEvents.length);
        const usageUpdateSeen = batch.some((event) => event.type === "UsageLimitsUpdated");
        const flushStartedAt = performance.now();
        try {
          set((state) => {
            if (bindSeq !== activeThreadBindSeq || state.threadId !== threadId) {
              return state;
            }

            let nextMessages = state.messages;
            let nextStreaming = state.streaming;
            let nextStatus = state.status;
            let nextUsageLimits = state.usageLimits;
            let hydrationRecalcRequired = false;
            for (const queuedEvent of batch) {
              if (queuedEvent.type === "UsageLimitsUpdated") {
                nextUsageLimits = mergeUsageLimits(
                  nextUsageLimits,
                  mapUsageLimitsFromEvent(queuedEvent),
                );
                continue;
              }
              const previousLength = nextMessages.length;
              nextMessages = applyStreamEvent(nextMessages, queuedEvent, state.threadId);
              if (nextMessages.length !== previousLength) {
                hydrationRecalcRequired = true;
              }
              const nextRuntimeState = applyRuntimeStateFromEvent(
                nextStatus,
                nextStreaming,
                queuedEvent,
                nextMessages,
              );
              nextStatus = nextRuntimeState.status;
              nextStreaming = nextRuntimeState.streaming;
              if (queuedEvent.type === "TurnCompleted") {
                pendingTurnMetaByThread.delete(threadId);
              }
            }
            if (hydrationRecalcRequired) {
              nextMessages = applyHydrationWindow(nextMessages);
            }

            if (
              nextMessages === state.messages &&
              nextStatus === state.status &&
              nextStreaming === state.streaming &&
              nextUsageLimits === state.usageLimits
            ) {
              return state;
            }

            return {
              ...state,
              messages: nextMessages,
              status: nextStatus,
              streaming: nextStreaming,
              usageLimits: nextUsageLimits,
            };
          });
        } finally {
          streamFlushInProgress = false;
        }

        const currentRuntimeState = get();
        if (currentRuntimeState.threadId === threadId) {
          useThreadStore
            .getState()
            .setThreadStatusLocal(threadId, currentRuntimeState.status);
        }

        if (usageUpdateSeen) {
          const currentState = useChatStore.getState();
          if (currentState.threadId === threadId) {
            syncThreadContextUsageCache(threadId, currentState.usageLimits);
            const thread = useThreadStore
              .getState()
              .threads.find((candidate) => candidate.id === threadId);
            if (thread?.engineId === "codex") {
              lastKnownCodexAccountUsageWindows =
                accountUsageWindowsFromUsageLimits(currentState.usageLimits) ??
                lastKnownCodexAccountUsageWindows;
            }
          }
        }

        recordPerfMetric("chat.stream.flush.ms", performance.now() - flushStartedAt, {
          threadId,
          batchSize: batch.length,
        });

        if (queuedStreamEvents.length > 0) {
          scheduleStreamFlush();
        }
      };

      const scheduleStreamFlush = () => {
        if (streamFlushTimer !== null) {
          return;
        }
        streamFlushTimer = globalThis.setTimeout(() => {
          streamFlushTimer = null;
          flushQueuedStreamEvents();
        }, STREAM_EVENT_BATCH_WINDOW_MS);
      };

      const unlistenStream = await listenThreadEvents(threadId, (event) => {
        if (bindSeq !== activeThreadBindSeq) {
          return;
        }
        if (isContextCompactionNoticeEvent(event)) {
          toast.info(String(event.title ?? "Context compacted").trim() || "Context compacted");
        }
        const pendingTurnMeta = pendingTurnMetaByThread.get(threadId);
        if (
          pendingTurnMeta &&
          event.type === "TurnStarted" &&
          typeof event.client_turn_id === "string" &&
          event.client_turn_id.length > 0
        ) {
          pendingTurnMeta.clientTurnId = event.client_turn_id;
        }
        if (pendingTurnMeta && event.type === "ModelRerouted") {
          const reroutedModelId =
            typeof event.to_model === "string" ? event.to_model.trim() : "";
          if (reroutedModelId) {
            pendingTurnMeta.turnModelId = reroutedModelId;
          }
        }
        recordPendingTurnLatencyMetrics(threadId, event);
        enqueueStreamEvent(queuedStreamEvents, event);
        eventRateWindowCount += 1;
        const now = performance.now();
        if (now - eventRateWindowStartedAt >= 1000) {
          emitEventRateMetric(now);
        }
        if (event.type === "TurnCompleted") {
          flushQueuedStreamEvents();
          emitEventRateMetric(performance.now());
          return;
        }
        if (queuedStreamEvents.length >= STREAM_EVENT_QUEUE_FLUSH_THRESHOLD) {
          flushQueuedStreamEvents();
          return;
        }
        scheduleStreamFlush();
      });

      const unlisten = () => {
        if (streamFlushTimer !== null) {
          globalThis.clearTimeout(streamFlushTimer);
          streamFlushTimer = null;
        }
        queuedStreamEvents.length = 0;
        emitEventRateMetric(performance.now());
        unlistenStream();
      };

      const reconcileSyncedHistory = () => {
        if (!syncPromise) return;
        void syncPromise.then(async (syncedThread) => {
          if (!syncedThread || bindSeq !== activeThreadBindSeq) return;
          const syncedWindow = await ipc.getThreadMessagesWindow(
            threadId,
            null,
            MESSAGE_WINDOW_INITIAL_LIMIT,
          );
          if (bindSeq !== activeThreadBindSeq) return;

          const currentState = get();
          if (currentState.threadId !== threadId) return;
          const syncedHistoryMerge = mergeLoadedWindowWithCachedOlderHistory(
            normalizeMessages(syncedWindow.messages),
            currentState.messages,
          );
          const syncedMessages = applyHydrationWindow(
            mergeLoadedMessagesWithCurrentRuntimeMessages(
              applyHydrationWindow(syncedHistoryMerge.messages),
              currentState.messages,
              threadId,
            ),
          );
          const syncedOlderCursor = syncedHistoryMerge.preservedOlderHistory
            ? currentState.olderCursor
            : syncedWindow.nextCursor;
          const syncedRuntimeState = resolveBoundThreadRuntimeState(
            threadId,
            syncedThread,
            syncedMessages,
          );
          const syncedUsageLimits = mergeUsageLimits(
            contextUsageFromThreadMetadata(syncedThread.engineMetadata),
            lastKnownCodexAccountUsageWindows,
          );
          set({
            messages: syncedMessages,
            olderCursor: syncedOlderCursor,
            hasOlderMessages: syncedOlderCursor !== null,
            status: syncedRuntimeState.status,
            streaming: syncedRuntimeState.streaming,
            usageLimits: syncedUsageLimits,
          });
          writeCachedThreadView(threadId, {
            messages: syncedMessages,
            olderCursor: syncedOlderCursor,
            hasOlderMessages: syncedOlderCursor !== null,
            status: syncedRuntimeState.status,
            streaming: syncedRuntimeState.streaming,
            usageLimits: syncedUsageLimits,
          });
          useThreadStore
            .getState()
            .setThreadStatusLocal(threadId, syncedRuntimeState.status);
        }).catch((error) => {
          console.warn(`Failed to reconcile synced Codex history ${threadId}:`, error);
        });
      };

      if (bindSeq !== activeThreadBindSeq) {
        unlisten();
        return;
      }

      messages = replayQueuedTurnFinishedEvents(threadId, messages);
      const currentState = get();
      if (currentState.threadId === threadId) {
        const hasSupersedingListener = Boolean(
          currentState.unlisten && currentState.unlisten !== currentUnlisten,
        );
        if (hasSupersedingListener) {
          unlisten();
        }
        const mergedMessages = applyHydrationWindow(
          mergeLoadedMessagesWithCurrentRuntimeMessages(
            messages,
            currentState.messages,
            threadId,
          ),
        );
        const latestThreadForMerge =
          useThreadStore
            .getState()
            .threads.find((candidate) => candidate.id === threadId) ?? activeThread;
        const mergedRuntimeState = resolveBoundThreadRuntimeState(
          threadId,
          latestThreadForMerge,
          mergedMessages,
        );
        set({
          messages: mergedMessages,
          olderCursor,
          hasOlderMessages: olderCursor !== null,
          loadingOlderMessages: false,
          olderLoadBlockedUntil: 0,
          unlisten: hasSupersedingListener ? currentState.unlisten : unlisten,
          error: undefined,
          status: mergedRuntimeState.status,
          streaming: mergedRuntimeState.streaming,
          usageLimits:
            latestThreadForMerge?.engineId === "codex"
              ? mergeUsageLimits(
                  contextUsageFromThreadMetadata(latestThreadForMerge.engineMetadata),
                  lastKnownCodexAccountUsageWindows,
                )
              : null,
        });
        useThreadStore
          .getState()
          .setThreadStatusLocal(threadId, mergedRuntimeState.status);
        flushQueuedStreamEvents();
        reconcileSyncedHistory();
        return;
      }

      const latestActiveThread =
        useThreadStore
          .getState()
          .threads.find((candidate) => candidate.id === threadId) ?? activeThread;
      const boundRuntimeState = resolveBoundThreadRuntimeState(
        threadId,
        latestActiveThread,
        messages,
      );

      set({
        threadId,
        messages,
        olderCursor,
        hasOlderMessages: olderCursor !== null,
        loadingOlderMessages: false,
        olderLoadBlockedUntil: 0,
        unlisten,
        error: undefined,
        streaming: boundRuntimeState.streaming,
        status: boundRuntimeState.status,
        usageLimits:
          latestActiveThread?.engineId === "codex"
            ? mergeUsageLimits(
                contextUsageFromThreadMetadata(latestActiveThread.engineMetadata),
                lastKnownCodexAccountUsageWindows,
              )
            : null,
      });
      useThreadStore
        .getState()
        .setThreadStatusLocal(threadId, boundRuntimeState.status);
      flushQueuedStreamEvents();
      reconcileSyncedHistory();
    } catch (error) {
      if (bindSeq !== activeThreadBindSeq) {
        return;
      }
      set((current) => current.threadId === threadId
        ? {
            ...current,
            loadingOlderMessages: false,
            olderLoadBlockedUntil: 0,
            error: String(error),
          }
        : {
            ...current,
            threadId,
            messages: [],
            olderCursor: null,
            hasOlderMessages: false,
            loadingOlderMessages: false,
            olderLoadBlockedUntil: 0,
            usageLimits: null,
            error: String(error),
          });
    } finally {
      if (bindingSeqByThread.get(threadId) === bindSeq) {
        bindingSeqByThread.delete(threadId);
        queuedTurnFinishedEventsByThread.delete(threadId);
      }
    }
  },
  loadOlderMessages: async () => {
    const state = get();
    const threadId = state.threadId;
    const cursor = state.olderCursor;
    if (
      !threadId ||
      !cursor ||
      state.loadingOlderMessages ||
      state.olderLoadBlockedUntil > Date.now()
    ) {
      return;
    }

    set((current) => {
      if (
        current.threadId !== threadId ||
        current.loadingOlderMessages ||
        current.olderCursor !== cursor
      ) {
        return current;
      }
      return {
        ...current,
        loadingOlderMessages: true,
      };
    });

    try {
      const olderWindow = await ipc.getThreadMessagesWindow(
        threadId,
        cursor,
        MESSAGE_WINDOW_INITIAL_LIMIT,
      );
      const olderMessages = normalizeMessages(olderWindow.messages, {
        collapseTrailingSteers: false,
      }).map((message) =>
        summarizeMessageForMemory(message),
      );
      set((current) => {
        if (current.threadId !== threadId) {
          return current;
        }
        const nextCursor = olderWindow.nextCursor;
        const mergedMessages = collapseTrailingSteerMessages([
          ...olderMessages,
          ...current.messages,
        ]);
        return {
          ...current,
          messages: applyHydrationWindow(mergedMessages),
          olderCursor: nextCursor,
          hasOlderMessages: nextCursor !== null,
          loadingOlderMessages: false,
          olderLoadBlockedUntil: 0,
        };
      });
    } catch (error) {
      const retryAt = Date.now() + OLDER_MESSAGES_RETRY_BACKOFF_MS;
      set((current) => {
        if (current.threadId !== threadId) {
          return current;
        }
        return {
          ...current,
          loadingOlderMessages: false,
          olderLoadBlockedUntil: retryAt,
          error: String(error),
        };
      });
    }
  },
  send: async (message, options) => {
    const state = get();
    if (state.streaming) {
      set({ error: "A turn is already in progress for this thread." });
      return false;
    }
    if (messagesHavePendingApprovals(state.messages)) {
      set({ error: "Resolve the pending approval before starting a new turn." });
      return false;
    }

    const threadId = options?.threadIdOverride ?? state.threadId;
    if (!threadId) {
      set({ error: "No active thread selected" });
      return false;
    }
    if (options?.threadIdOverride && options.threadIdOverride !== state.threadId) {
      set({ error: "Cannot send a turn to a thread that is not currently active" });
      return false;
    }
    const startedAt = performance.now();
    const clientTurnId = crypto.randomUUID();
    const optimisticAssistantMessageId = crypto.randomUUID();
    pendingTurnMetaByThread.set(threadId, {
      turnEngineId: options?.engineId ?? null,
      turnModelId: options?.modelId ?? null,
      turnReasoningEffort: options?.reasoningEffort ?? null,
      clientTurnId,
      assistantMessageId: optimisticAssistantMessageId,
      backendAccepted: false,
      startedAt,
      firstShellRecorded: false,
      firstContentRecorded: false,
      firstTextRecorded: false,
    });

    const attachments = options?.attachments ?? [];
    const inputItems = options?.inputItems ?? [];
    const planMode = options?.planMode ?? false;
    useThreadPlanModeStore
      .getState()
      .setThreadMode(threadId, planMode ? "plan" : "default");
    if (planMode) {
      armPlanImplementationPrompt(threadId);
    } else {
      disarmPlanImplementationPrompt(threadId);
    }
    const userMessage = createOptimisticUserMessage(threadId, message, {
      attachments,
      inputItems,
      planMode,
    });
    const optimisticAssistantMessage = createStreamingAssistantMessage(threadId, {
      id: optimisticAssistantMessageId,
      clientTurnId,
    });

    set((state) => ({
      messages: applyHydrationWindow([
        ...state.messages,
        userMessage,
        optimisticAssistantMessage,
      ]),
      status: "streaming",
      streaming: true,
      error: undefined
    }));
    useThreadStore.getState().setThreadStatusLocal(threadId, "streaming");
    notifyTurnAccepted(options?.onAccepted);
    schedulePendingTurnShellMetric(threadId, clientTurnId);

    try {
      const backendAssistantMessageId = await ipc.sendMessage(
        threadId,
        message,
        options?.modelId ?? null,
        options?.reasoningEffort ?? null,
        attachments.length > 0 ? attachments : null,
        inputItems.length > 0 ? inputItems : null,
        planMode,
        clientTurnId,
      );
      const pendingTurn = pendingTurnMetaByThread.get(threadId);
      if (pendingTurn?.clientTurnId === clientTurnId) {
        pendingTurn.backendAccepted = true;
      }
      if (
        typeof backendAssistantMessageId === "string" &&
        backendAssistantMessageId.trim().length > 0
      ) {
        const persistedAssistantMessageId = backendAssistantMessageId.trim();
        if (pendingTurn?.clientTurnId === clientTurnId) {
          pendingTurn.assistantMessageId = persistedAssistantMessageId;
        }
        set((current) => {
          if (current.threadId !== threadId) return current;
          const messages = reconcileAssistantMessageIdentity(
            current.messages,
            optimisticAssistantMessageId,
            persistedAssistantMessageId,
            clientTurnId,
          );
          return messages === current.messages
            ? current
            : { ...current, messages: applyHydrationWindow(messages) };
        });
        const cached = cachedThreadViews.get(threadId);
        if (cached) {
          const messages = reconcileAssistantMessageIdentity(
            cached.messages,
            optimisticAssistantMessageId,
            persistedAssistantMessageId,
            clientTurnId,
          );
          if (messages !== cached.messages) {
            writeCachedThreadView(threadId, {
              ...cached,
              messages: applyHydrationWindow(messages),
            });
          }
        }
      }
      return true;
    } catch (error) {
      if (planMode) {
        disarmPlanImplementationPrompt(threadId);
      }
      pendingTurnMetaByThread.delete(threadId);
      set((state) => ({
        messages: state.messages.filter(
          (item) => item.id !== userMessage.id && item.id !== optimisticAssistantMessage.id,
        ),
        status: "error",
        streaming: false,
        error: String(error),
      }));
      useThreadStore.getState().setThreadStatusLocal(threadId, "error");
      return false;
    }
  },
  steer: async (message, options) => {
    const state = get();
    if (!state.streaming) {
      set({ error: "No turn is currently in progress for this thread." });
      return false;
    }

    const threadId = options?.threadIdOverride ?? state.threadId;
    if (!threadId) {
      set({ error: "No active thread selected" });
      return false;
    }

    if (options?.threadIdOverride && options.threadIdOverride !== state.threadId) {
      set({ error: "Cannot steer a thread that is not currently active" });
      return false;
    }

    const attachments = options?.attachments ?? [];
    const inputItems = options?.inputItems ?? [];
    const planMode = options?.planMode ?? false;
    const steerBlock = createSteerBlock(message, {
      attachments,
      inputItems,
      planMode,
    });

    set((current) => ({
      messages: applyHydrationWindow(
        appendSteerBlockToActiveAssistant(current.messages, threadId, steerBlock),
      ),
      error: undefined,
    }));
    notifyTurnAccepted(options?.onAccepted);

    try {
      const receipt = await ipc.steerMessage(
        threadId,
        message,
        attachments.length > 0 ? attachments : null,
        inputItems.length > 0 ? inputItems : null,
        planMode,
        steerBlock.steerId,
      );
      if (receipt) {
        set((current) => ({
          messages: applyHydrationWindow(
            applySteerReceipt(current.messages, steerBlock.steerId, receipt),
          ),
        }));
      }
      return true;
    } catch (error) {
      set((current) => ({
        messages: applyHydrationWindow(removeSteerBlock(current.messages, steerBlock.steerId)),
        error: String(error),
      }));
      return false;
    }
  },
  cancel: async () => {
    const threadId = get().threadId;
    if (!threadId) {
      return;
    }

    pendingTurnMetaByThread.delete(threadId);
    set((state) => ({
      status: "idle",
      streaming: false,
      messages: cancelActiveAssistantMessage(state.messages),
    }));
    useThreadStore.getState().setThreadStatusLocal(threadId, "idle");

    try {
      await ipc.cancelTurn(threadId);
    } catch (error) {
      set({ error: String(error) });
    }
  },
  respondApproval: async (approvalId, response) => {
    const threadId = get().threadId;
    if (!threadId) {
      set({ error: "No active thread selected" });
      return;
    }

    // Apply optimistic update BEFORE the IPC call
    const decision = resolveApprovalDecision(response);
    const responseData = typeof response === "object" && response !== null && !Array.isArray(response)
      ? response as Record<string, unknown>
      : undefined;
    const previousState = {
      messages: get().messages,
      status: get().status,
      streaming: get().streaming,
    };
    set((state) => {
      const nextMessages = resolveApprovalInMessages(state.messages, approvalId, decision, responseData);
      if (nextMessages === state.messages) {
        return state;
      }
      const nextRuntimeState = deriveRuntimeStateFromMessages(nextMessages);
      return {
        ...state,
        messages: nextMessages,
        status: nextRuntimeState?.status ?? state.status,
        streaming: nextRuntimeState?.streaming ?? state.streaming,
      };
    });
    useThreadStore
      .getState()
      .setThreadStatusLocal(threadId, get().status);

    try {
      await ipc.respondApproval(threadId, approvalId, response);
    } catch (error) {
      // Roll back the optimistic update on failure
      set({
        messages: previousState.messages,
        status: previousState.status,
        streaming: previousState.streaming,
        error: String(error),
      });
      useThreadStore
        .getState()
        .setThreadStatusLocal(threadId, previousState.status);
    }
  },
  hydrateActionOutput: async (messageId, actionId) => {
    const requestKey = `${messageId}::${actionId}`;
    const existingRequest = inflightActionOutputHydration.get(requestKey);
    if (existingRequest) {
      await existingRequest;
      return;
    }

    const request = (async () => {
      const payload = await ipc.getActionOutput(messageId, actionId);
      if (!payload.found) {
        throw new Error("Action output not found.");
      }

      const normalizedChunks: ActionBlock["outputChunks"] = payload.outputChunks.map((chunk) => ({
        stream: normalizeActionOutputStream(chunk.stream),
        content: String(chunk.content ?? ""),
      }));
      const { chunks: trimmedChunks, truncated: trimmedByFrontend } =
        trimActionOutputChunks(normalizedChunks);

      set((state) => {
        const messageIndex = state.messages.findIndex((message) => message.id === messageId);
        if (messageIndex < 0) {
          return state;
        }

        const message = state.messages[messageIndex];
        const blocks = message.blocks;
        if (!blocks || blocks.length === 0) {
          return state;
        }

        const nextBlocks = patchActionBlock(blocks, actionId, (block) => {
          if (
            block.outputDeferred !== true &&
            block.outputDeferredLoaded === true &&
            block.outputChunks.length > 0
          ) {
            return block;
          }

          const details = (block.details ?? {}) as Record<string, unknown>;
          const shouldMarkTruncated =
            (payload.truncated || trimmedByFrontend) &&
            !("outputTruncated" in details && details.outputTruncated === true);
          const nextDetails = shouldMarkTruncated
            ? {
                ...details,
                outputTruncated: true,
              }
            : details;

          return {
            ...block,
            details: nextDetails,
            outputChunks: trimmedChunks,
            outputDeferred: false,
            outputDeferredLoaded: true,
          };
        });

        if (nextBlocks === blocks) {
          return state;
        }

        const nextMessages = [...state.messages];
        nextMessages[messageIndex] = {
          ...message,
          blocks: nextBlocks,
          hasDeferredContent: hasDeferredActionOutput(nextBlocks),
        };

        return {
          ...state,
          messages: nextMessages,
        };
      });
    })();

    inflightActionOutputHydration.set(requestKey, request);
    try {
      await request;
    } finally {
      inflightActionOutputHydration.delete(requestKey);
    }
  },
}));
