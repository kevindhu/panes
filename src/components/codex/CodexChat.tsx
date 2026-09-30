import type { ReactNode } from "react";
import { CodexTranscriptSource } from "./CodexTranscriptSource";
import type { TranscriptRow } from "./transcriptRows";
import {
  ArrowDown,
  Brain,
  Check,
  Copy,
  GitBranch,
  ListChecks,
  LoaderCircle,
  RotateCcw,
  Settings2,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";
import { MessageTimestamp } from "../chat/MessageTimestamp";
import { ToolInputQuestionnaire } from "../chat/ToolInputQuestionnaire";
import { CodexUsageLimits } from "./CodexUsageLimits";
import { CodexComposer, type CodexComposerHandle, type CodexComposerSubmission } from "./CodexComposer";
import {
  CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED,
  VirtualMessageTranscript,
  type VirtualMessageTranscriptHandle,
} from "./VirtualMessageTranscript";
import { parseToolInputQuestions } from "../chat/toolInputApproval";
import { isBlockingApproval, pendingQuestions } from "../../lib/pendingQuestions";
import {
  canForkFromAssistantMessage,
  computeDroppedTurnsForEditedMessage,
  computeTurnsAfterAssistantMessage,
  extractEditableMessageContext,
  isEditableUserTurn,
  messagesBeforeEditableUserTurn,
} from "../chat/messageEditBranching";
import {
  PLAN_IMPLEMENTATION_CODING_MESSAGE,
  resolvePlanImplementationDecision,
  shouldClearPendingPlanImplementationPrompt,
  shouldPromptToImplementPlan,
} from "../chat/planModePrompt";
import { resolveReasoningEffortForModel } from "../chat/reasoningEffort";
import {
  canEditCodexMessageHistory,
  canForkCodexMessageHistory,
} from "../../lib/codexThreadCapabilities";
import {
  readChatScrollPosition,
  saveChatScrollPosition,
} from "../../lib/chatScrollPosition";
import { useTranscriptSelection } from "../../lib/transcriptSelection";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
import { NEW_THREAD_FALLBACK_RUNTIME } from "../../lib/newThreadRuntime";
import { activateThreadContext } from "../../lib/threadActivation";
import {
  ipc,
  listenCodexRollbackMaterialized,
  listenCodexTranscriptUpdated,
} from "../../lib/codexIpc";
import {
  armPlanImplementationPrompt,
  disarmPlanImplementationPrompt,
  isPlanImplementationPromptArmed,
} from "../../lib/planImplementationPromptState";
import { useChatStore } from "../../stores/chatStore";
import { useEngineStore } from "../../stores/engineStore";
import {
  readComposerModeForResolvedScope,
  resolveComposerModeScope,
  useThreadPlanModeStore,
} from "../../stores/threadPlanModeStore";
import { useThreadStore } from "../../stores/threadStore";
import { toast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { ApprovalResponse, ContentBlock, Message, Thread } from "../../types";

const MODEL_PICKER_PRIORITY: Readonly<Record<string, number>> = {
  "gpt-6-astra": 0,
  "gpt-6-sol": 1,
  "gpt-6-luna": 2,
};

const PLAN_IMPLEMENTATION_QUESTION_ID = "plan_implementation_decision";
const PLAN_IMPLEMENTATION_CHOICE = "Implement the plan";
const STAY_IN_PLAN_MODE_CHOICE = "Stay in plan mode";
const PLAN_IMPLEMENTATION_QUESTION_DETAILS: Record<string, unknown> = {
  questions: [{
    id: PLAN_IMPLEMENTATION_QUESTION_ID,
    header: "Next step",
    question: "The plan is ready. What should Codex do next?",
    isOther: false,
    options: [
      {
        label: PLAN_IMPLEMENTATION_CHOICE,
        description: "Switch to Default mode and start implementing this plan now.",
        recommended: true,
      },
      {
        label: STAY_IN_PLAN_MODE_CHOICE,
        description: "Keep planning without changing files.",
      },
    ],
  }],
};

const MessageBlocks = lazy(() =>
  import("../chat/MessageBlocks").then((module) => ({ default: module.MessageBlocks })),
);
const CodexTurnTranscript = lazy(() =>
  import("../chat/CodexTurnTranscript").then((module) => ({ default: module.CodexTurnTranscript })),
);

function messageBlocks(message: { content?: string; blocks?: ContentBlock[] }): ContentBlock[] {
  if (message.blocks?.length) return message.blocks;
  return message.content ? [{ type: "text", content: message.content }] : [];
}

function readMetadataString(thread: Thread | null, key: string): string | null {
  const value = thread?.engineMetadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function readMetadataBoolean(thread: Thread | null, key: string): boolean {
  return thread?.engineMetadata?.[key] === true;
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="codex-copy-message"
      type="button"
      title="Copy message"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function CodexChat() {
  const [nativeRows, setNativeRows] = useState<Record<string, TranscriptRow[]>>({});
  const publishRows = useCallback((messageId: string, rows: TranscriptRow[]) => {
    setNativeRows(current => current[messageId] === rows ? current : { ...current, [messageId]: rows });
  }, []);
  const viewportRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<VirtualMessageTranscriptHandle>(null);
  const composerRef = useRef<CodexComposerHandle>(null);
  const nearBottomRef = useRef(true);
  const selectionPausedFollowRef = useRef(false);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [newThreadServiceTier, setNewThreadServiceTier] = useState<"fast" | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [rollingBackMessageId, setRollingBackMessageId] = useState<string | null>(null);
  const [transcriptSequences, setTranscriptSequences] = useState<Record<string, number>>({});
  const [nativePlanTextByMessageId, setNativePlanTextByMessageId] = useState<Record<string, string>>({});
  const [implementingPlan, setImplementingPlan] = useState(false);
  const [hasUnseenOutput, setHasUnseenOutput] = useState(false);
  const [, setPlanPromptRevision] = useState(0);
  const previousStreamingRef = useRef(false);

  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? null);
  const activeThreadId = useThreadStore((state) => state.activeThreadId);
  const activeThread = useThreadStore((state) => (
    state.threads.find((item) => item.id === state.activeThreadId) ?? null
  ));
  const applyThreadUpdateLocal = useThreadStore((state) => state.applyThreadUpdateLocal);
  const forkCodexThreadAtTurn = useThreadStore((state) => state.forkCodexThreadAtTurn);
  const rollbackCodexThread = useThreadStore((state) => state.rollbackCodexThread);
  const renameThread = useThreadStore((state) => state.renameThread);
  const engine = useEngineStore((state) => state.engines.find((item) => item.id === "codex") ?? null);
  const codexPlanType = useEngineStore((state) => (
    state.health.codex?.protocolDiagnostics?.account?.planType ?? null
  ));
  const messages = useChatStore((state) => state.messages);
  const boundThreadId = useChatStore((state) => state.threadId);
  const streaming = useChatStore((state) => state.streaming);
  const status = useChatStore((state) => state.status);
  const error = useChatStore((state) => state.error);
  const hasOlderMessages = useChatStore((state) => state.hasOlderMessages);
  const loadingOlderMessages = useChatStore((state) => state.loadingOlderMessages);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const send = useChatStore((state) => state.send);
  const steer = useChatStore((state) => state.steer);
  const cancel = useChatStore((state) => state.cancel);
  const respondApproval = useChatStore((state) => state.respondApproval);
  const hydrateActionOutput = useChatStore((state) => state.hydrateActionOutput);
  const usage = useChatStore((state) => state.usageLimits);
  const threadModes = useThreadPlanModeStore((state) => state.threadModes);
  const newThreadModes = useThreadPlanModeStore((state) => state.newThreadModesByWorkspaceId);
  const setThreadMode = useThreadPlanModeStore((state) => state.setThreadMode);
  const setNewThreadMode = useThreadPlanModeStore((state) => state.setNewThreadMode);
  const clearNewThreadMode = useThreadPlanModeStore((state) => state.clearNewThreadMode);

  const models = useMemo(() => engine?.models.filter((model) => !model.hidden) ?? [], [engine]);
  // Keep available GPT-6 models together, preserving catalog order for other models.
  const modelOptions = useMemo(() => [...models].sort((a, b) =>
    (MODEL_PICKER_PRIORITY[a.id] ?? 3) - (MODEL_PICKER_PRIORITY[b.id] ?? 3),
  ), [models]);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0] ?? null;
  const composerModeScope = useMemo(() => resolveComposerModeScope({
    activeThreadId,
    boundThreadId,
    activeWorkspaceId,
    threads: activeThread ? [activeThread] : [],
  }), [activeThread, activeThreadId, activeWorkspaceId, boundThreadId]);
  const planMode = readComposerModeForResolvedScope(
    { threadModes, newThreadModesByWorkspaceId: newThreadModes },
    composerModeScope,
  ) === "plan";
  const composerModeScopeReady = composerModeScope.kind === "thread" || composerModeScope.kind === "new-thread";
  const serviceTier = activeThread
    ? readMetadataString(activeThread, "serviceTier")
    : newThreadServiceTier;
  const fastMode = serviceTier === "fast";
  const planModeThreadIsBound = composerModeScope.kind === "thread" && composerModeScope.threadId === boundThreadId;
  const canForkMessages = canForkCodexMessageHistory(activeThread);
  const canRollbackMessages = canEditCodexMessageHistory(activeThread, streaming);
  const engineForkPending = readMetadataBoolean(activeThread, "engineForkPending");
  const engineRollbackPending = readMetadataBoolean(activeThread, "engineRollbackPending");
  const compatibilityFork = readMetadataBoolean(activeThread, "codexCompatibilityFork");
  const engineMutationError = engineForkPending
    ? readMetadataString(activeThread, "engineForkError")
    : engineRollbackPending
      ? readMetadataString(activeThread, "engineRollbackError")
      : null;
  const engineMutationStatus = engineForkPending
    ? "Preparing conversation fork in Codex…"
    : engineRollbackPending
      ? compatibilityFork
        ? "Confirming compatibility rollback in Codex…"
        : "Confirming rollback in Codex…"
      : null;
  const displayedMessages = useMemo(() => {
    if (!rollingBackMessageId) return messages;
    return messagesBeforeEditableUserTurn(messages, rollingBackMessageId) ?? messages;
  }, [messages, rollingBackMessageId]);
  useEffect(() => {
    const ids = new Set(displayedMessages.map(message => message.id));
    setNativeRows(current => Object.keys(current).some(id => !ids.has(id))
      ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))) : current);
  }, [displayedMessages]);
  const savedScrollPosition = useMemo(
    () => boundThreadId ? readChatScrollPosition(boundThreadId) : null,
    [boundThreadId],
  );
  useEffect(() => {
    if (savedScrollPosition?.anchorMessageId && !savedScrollPosition.nearBottom && hasOlderMessages
      && !loadingOlderMessages && !error && !displayedMessages.some(message => message.id === savedScrollPosition.anchorMessageId)) {
      void loadOlderMessages();
    }
  }, [savedScrollPosition, displayedMessages, hasOlderMessages, loadingOlderMessages, error, loadOlderMessages]);
  const visibleTranscriptRevision = useMemo(
    () => displayedMessages
      .map((message) => `${message.id}:${transcriptSequences[message.id] ?? 0}`)
      .join("|"),
    [displayedMessages, transcriptSequences],
  );
  const toolInputRequests = useMemo(
    () => activeThreadId && boundThreadId === activeThreadId
      ? pendingQuestions(messages).filter((request) => parseToolInputQuestions(request.details).length > 0)
      : [],
    [activeThreadId, boundThreadId, messages],
  );
  const pendingToolInputApproval = toolInputRequests.find((request) => isBlockingApproval(request.details)) ?? null;
  const nonblockingQuestions = toolInputRequests.filter((request) => !isBlockingApproval(request.details));
  const nativePlanText = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant") break;
      const planText = nativePlanTextByMessageId[message.id];
      if (planText) return planText;
    }
    return null;
  }, [messages, nativePlanTextByMessageId]);
  const armedPlanThreadId = activeThreadId && isPlanImplementationPromptArmed(activeThreadId)
    ? activeThreadId
    : null;
  const showPlanImplementationPrompt = Boolean(
    planMode &&
    planModeThreadIsBound &&
    toolInputRequests.length === 0 &&
    shouldPromptToImplementPlan({
      streaming,
      status,
      activeThreadId,
      armedThreadId: armedPlanThreadId,
      messages,
      nativePlanText,
    }),
  );
  const showSpecialComposer = !rollingBackMessageId && Boolean(pendingToolInputApproval || showPlanImplementationPrompt);

  const stopScrollRestoration = useCallback(() => {
    transcriptRef.current?.cancelRestore();
  }, []);

  const handleTranscriptSelectionActiveChange = useCallback((active: boolean) => {
    if (!active) return;
    stopScrollRestoration();
    selectionPausedFollowRef.current = true;
    nearBottomRef.current = false;
  }, [stopScrollRestoration]);

  const {
    clearSelection: clearTranscriptSelection,
    selectedMessageRange,
  } = useTranscriptSelection({
    rootRef: viewportRef,
    resetKey: `${activeThreadId ?? ""}:${boundThreadId ?? ""}`,
    onActiveChange: handleTranscriptSelectionActiveChange,
  });

  const jumpToLatest = useCallback(() => {
    clearTranscriptSelection();
    stopScrollRestoration();
    selectionPausedFollowRef.current = false;
    nearBottomRef.current = true;
    setHasUnseenOutput(false);
    window.requestAnimationFrame(() => {
      transcriptRef.current?.scrollToEnd();
    });
  }, [clearTranscriptSelection, stopScrollRestoration]);

  useEffect(() => {
    nearBottomRef.current = savedScrollPosition?.nearBottom ?? true;
  }, [boundThreadId, savedScrollPosition]);

  useEffect(() => {
    const preferredModel = readMetadataString(activeThread, "lastModelId")
      ?? activeThread?.modelId
      ?? NEW_THREAD_FALLBACK_RUNTIME.modelId;
    const nextModel = models.find((model) => model.id === preferredModel) ?? models.find((model) => model.isDefault) ?? models[0];
    if (!nextModel) return;
    setSelectedModelId(nextModel.id);
    setReasoningEffort(resolveReasoningEffortForModel(nextModel, readMetadataString(activeThread, "reasoningEffort")));
  }, [activeThread?.id, models]);

  useEffect(() => {
    setNewThreadServiceTier(null);
  }, [activeThreadId]);

  useEffect(() => {
    setForkingMessageId(null);
    setRollingBackMessageId(null);
    setTranscriptSequences({});
    setNativePlanTextByMessageId({});
    setImplementingPlan(false);
    setHasUnseenOutput(false);
    selectionPausedFollowRef.current = false;
    previousStreamingRef.current = false;
  }, [activeThreadId]);

  useEffect(() => {
    const wasStreaming = previousStreamingRef.current;
    previousStreamingRef.current = streaming;
    if (
      wasStreaming &&
      !streaming &&
      activeThreadId &&
      planModeThreadIsBound &&
      isPlanImplementationPromptArmed(activeThreadId) &&
      shouldClearPendingPlanImplementationPrompt(status)
    ) {
      disarmPlanImplementationPrompt(activeThreadId);
      setPlanPromptRevision((current) => current + 1);
    }
  }, [activeThreadId, planModeThreadIsBound, status, streaming]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listenCodexTranscriptUpdated((event) => {
      const chat = useChatStore.getState();
      if (
        chat.threadId !== event.threadId ||
        !chat.messages.some((message) => message.id === event.assistantMessageId)
      ) {
        return;
      }
      setTranscriptSequences((current) => {
        if ((current[event.assistantMessageId] ?? 0) >= event.lastSourceSequence) return current;
        return { ...current, [event.assistantMessageId]: event.lastSourceSequence };
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch((listenError) => {
      console.error("Could not listen for Codex transcript updates", listenError);
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listenCodexRollbackMaterialized((event) => {
      const chat = useChatStore.getState();
      if (chat.threadId !== event.threadId) return;
      void chat.setActiveThread(event.threadId, { forceReload: true });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch((listenError) => {
      console.error("Could not listen for completed Codex rollbacks", listenError);
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!nearBottomRef.current && (selectionPausedFollowRef.current || streaming)) {
      setHasUnseenOutput(true);
    }
  }, [messages, streaming, visibleTranscriptRevision]);

  const approval = useCallback((approvalId: string, response: ApprovalResponse) => {
    void respondApproval(approvalId, response);
  }, [respondApproval]);

  const recordNativePlanText = useCallback((messageId: string, planText: string | null) => {
    setNativePlanTextByMessageId((current) => {
      if (planText) {
        if (current[messageId] === planText) return current;
        return { ...current, [messageId]: planText };
      }
      if (!(messageId in current)) return current;
      const { [messageId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const forkFromMessage = useCallback(async (message: Message) => {
    if (
      !activeThread ||
      !canForkMessages ||
      forkingMessageId !== null ||
      rollingBackMessageId !== null ||
      !canForkFromAssistantMessage(message)
    ) {
      return;
    }

    const turnsAfter = computeTurnsAfterAssistantMessage(messages, message.id);
    if (turnsAfter === null) {
      toast.error("Could not identify the Codex turn to fork.");
      return;
    }

    setForkingMessageId(message.id);
    try {
      const forked = await forkCodexThreadAtTurn(
        activeThread.id,
        message.id,
        message.nativeTurnId?.trim() || null,
        turnsAfter,
      );
      if (!forked) {
        throw new Error(useThreadStore.getState().error ?? "Codex did not return a forked thread.");
      }
      await activateThreadContext(forked);
    } catch (forkError) {
      toast.error(`Could not fork this message: ${String(forkError)}`);
    } finally {
      setForkingMessageId((current) => (current === message.id ? null : current));
    }
  }, [activeThread, canForkMessages, forkingMessageId, forkCodexThreadAtTurn, messages, rollingBackMessageId]);

  const rollbackToMessage = useCallback(async (message: Message) => {
    if (
      !activeThread ||
      !canRollbackMessages ||
      forkingMessageId !== null ||
      rollingBackMessageId !== null ||
      !isEditableUserTurn(message)
    ) {
      return;
    }

    const context = extractEditableMessageContext(message);
    const numTurns = computeDroppedTurnsForEditedMessage(messages, message.id);
    if (!context || !numTurns) {
      toast.error("Could not identify the Codex turn to roll back.");
      return;
    }

    const confirmed = window.confirm(
      `Roll back to before this message? This removes ${numTurns} ${numTurns === 1 ? "turn" : "turns"} from the chat history and does not undo file changes.`,
    );
    if (!confirmed) return;

    setRollingBackMessageId(message.id);
    composerRef.current?.setDraft(context);
    if (activeThreadId) {
      disarmPlanImplementationPrompt(activeThreadId);
      setThreadMode(activeThreadId, context.planMode ? "plan" : "default");
    }
    stopScrollRestoration();
    nearBottomRef.current = true;
    requestAnimationFrame(() => {
      transcriptRef.current?.scrollToEnd();
      composerRef.current?.focus();
    });

    try {
      const rolledBack = await rollbackCodexThread(activeThread.id, numTurns);
      if (!rolledBack) {
        throw new Error(useThreadStore.getState().error ?? "Codex did not return the rolled-back thread.");
      }

      if (useThreadStore.getState().activeThreadId === rolledBack.id) {
        await activateThreadContext(rolledBack, { forceChatReload: true });
      }
    } catch (rollbackError) {
      toast.error(`Could not roll back to this message: ${String(rollbackError)}`);
    } finally {
      setRollingBackMessageId((current) => (current === message.id ? null : current));
    }
  }, [
    activeThread,
    activeThreadId,
    canRollbackMessages,
    forkingMessageId,
    messages,
    rollbackCodexThread,
    rollingBackMessageId,
    setThreadMode,
    stopScrollRestoration,
  ]);

  function setPlanMode(enabled: boolean) {
    if (composerModeScope.kind === "thread") {
      setThreadMode(composerModeScope.threadId, enabled ? "plan" : "default");
    } else if (composerModeScope.kind === "new-thread") {
      setNewThreadMode(composerModeScope.workspaceId, enabled ? "plan" : "default");
    }
  }

  async function submit(
    { text, attachments, inputItems }: CodexComposerSubmission,
    onAccepted: () => void,
  ): Promise<boolean> {
    if (rollingBackMessageId || engineRollbackPending || (!text && !attachments.length) || !activeWorkspaceId || !composerModeScopeReady) return false;
    let targetThreadId = activeThreadId;
    const creatingThread = !targetThreadId;
    if (creatingThread) {
      targetThreadId = await createAndActivateWorkspaceThread(activeWorkspaceId, {
        serviceTier: fastMode ? "fast" : null,
      });
    }
    if (!targetThreadId) return false;
    if (creatingThread) clearNewThreadMode(activeWorkspaceId);

    const consumeSubmittedComposer = () => {
      nearBottomRef.current = true;
      onAccepted();
    };
    return streaming
      ? await steer(text, {
          threadIdOverride: targetThreadId,
          attachments,
          inputItems,
          planMode,
          onAccepted: consumeSubmittedComposer,
        })
      : await send(text, {
          threadIdOverride: targetThreadId,
          engineId: "codex",
          modelId: selectedModel?.id ?? null,
          reasoningEffort,
          attachments,
          inputItems,
          planMode,
          onAccepted: consumeSubmittedComposer,
        });
  }

  async function submitPendingToolInput(response: ApprovalResponse) {
    if (!pendingToolInputApproval) return false;
    return respondApproval(pendingToolInputApproval.approvalId, response);
  }

  async function executePlanImplementation() {
    if (
      !activeThread ||
      !activeThreadId ||
      boundThreadId !== activeThreadId ||
      streaming ||
      implementingPlan
    ) {
      return;
    }

    const modelId = selectedModel?.id ?? readMetadataString(activeThread, "lastModelId") ?? activeThread.modelId;
    if (!modelId) {
      toast.error("Could not start implementation because no Codex model is selected.");
      return;
    }

    setImplementingPlan(true);
    setThreadMode(activeThreadId, "default");
    try {
      const accepted = await send(PLAN_IMPLEMENTATION_CODING_MESSAGE, {
        threadIdOverride: activeThreadId,
        engineId: "codex",
        modelId,
        reasoningEffort,
        planMode: false,
      });
      if (!accepted) {
        setThreadMode(activeThreadId, "plan");
        armPlanImplementationPrompt(activeThreadId);
        setPlanPromptRevision((current) => current + 1);
        toast.error(useChatStore.getState().error ?? "Could not start implementing the plan.");
      }
    } catch (implementationError) {
      setThreadMode(activeThreadId, "plan");
      armPlanImplementationPrompt(activeThreadId);
      setPlanPromptRevision((current) => current + 1);
      toast.error(`Could not start implementing the plan: ${String(implementationError)}`);
    } finally {
      setImplementingPlan(false);
    }
  }

  async function handlePlanImplementationResponse(response: ApprovalResponse) {
    const answerMap = "answers" in response && response.answers && typeof response.answers === "object"
      ? response.answers as Record<string, { answers?: string[] }>
      : null;
    const selectedAnswer = answerMap?.[PLAN_IMPLEMENTATION_QUESTION_ID]?.answers?.[0];
    const decision = resolvePlanImplementationDecision(
      selectedAnswer,
      PLAN_IMPLEMENTATION_CHOICE,
      STAY_IN_PLAN_MODE_CHOICE,
    );
    if (decision === "stay") {
      disarmPlanImplementationPrompt(activeThreadId);
      setPlanPromptRevision((current) => current + 1);
      return;
    }
    if (decision === "implement") await executePlanImplementation();
  }

  async function updatePolicy(patch: Parameters<typeof ipc.setThreadExecutionPolicy>[1]) {
    if (!activeThread) return;
    try {
      const updated = await ipc.setThreadExecutionPolicy(activeThread.id, patch);
      applyThreadUpdateLocal(updated);
    } catch (policyError) {
      toast.error(`Could not update execution policy: ${String(policyError)}`);
    }
  }

  async function updateServiceTier(value: string) {
    if (!activeThread) return;
    try {
      const updated = await ipc.setThreadCodexConfig(activeThread.id, { serviceTier: value === "inherit" ? null : value });
      applyThreadUpdateLocal(updated);
    } catch (configError) {
      toast.error(`Could not update Codex mode: ${String(configError)}`);
    }
  }

  function setFastMode(enabled: boolean) {
    if (!activeThread) {
      setNewThreadServiceTier(enabled ? "fast" : null);
      return;
    }
    void updateServiceTier(enabled ? "fast" : "inherit");
  }

  function renderMessage(message: Message, body?: ReactNode, part: "complete" | "body" | "footer" = "complete") {
    const blocks = messageBlocks(message);
    const copyText = message.content ?? blocks
      .filter((block) => block.type === "text")
      .map((block) => block.content)
      .join("\n\n");
    const canForkMessage = canForkFromAssistantMessage(message) && canForkMessages;
    const canRollbackMessage = message.role === "user" && canRollbackMessages && isEditableUserTurn(message);
    const isForkingMessage = forkingMessageId === message.id;
    const isRollingBackMessage = rollingBackMessageId === message.id;
    return (
      <article
        className={`codex-message ${message.role} ${part !== "complete" ? "codex-message-part" : ""} ${part === "footer" ? "is-footer" : ""}`}
        data-message-id={message.id}
        data-transcript-selection-scope={`message:${message.id}`}
      >
        {part === "complete" && message.role === "user" && (
          <div className="codex-message-label">
            <CopyMessageButton text={copyText} />
            {canRollbackMessage && (
              <button
                className="codex-rollback-message"
                type="button"
                title={isRollingBackMessage ? "Rolling back conversation" : "Roll back to here"}
                aria-label={isRollingBackMessage ? "Rolling back conversation" : "Roll back to here"}
                disabled={forkingMessageId !== null || rollingBackMessageId !== null}
                onClick={() => void rollbackToMessage(message)}
              >
                {isRollingBackMessage
                  ? <LoaderCircle size={12} className="codex-spin" />
                  : <RotateCcw size={12} />}
              </button>
            )}
          </div>
        )}
        {part !== "footer" && <Suspense fallback={<div className="codex-loading">Rendering…</div>}>
          {part === "body" ? body : message.role === "assistant" ? (
            <CodexTurnTranscript
              messageId={message.id}
              blocks={blocks}
              status={message.status}
              tokenUsage={message.tokenUsage}
              workspaceRootPath={workspace?.rootPath ?? ""}
              refreshSequence={transcriptSequences[message.id] ?? 0}
              onApproval={approval}
              onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
              onPlanText={recordNativePlanText}
            />
          ) : (
            <MessageBlocks
              blocks={blocks}
              status={message.status}
              workspaceRootPath={workspace?.rootPath ?? ""}
              selectionNamespace={`message:${message.id}:blocks`}
              onApproval={approval}
              onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
            />
          )}
        </Suspense>}
        {part !== "body" && message.role === "assistant" && message.status !== "streaming" && (
          <div className="codex-message-footer">
            <div className="codex-message-actions">
              <CopyMessageButton text={copyText} />
              {canForkMessage && (
                <button
                  className="codex-fork-message"
                  type="button"
                  title={isForkingMessage ? "Forking conversation" : "Fork from here"}
                  aria-label={isForkingMessage ? "Forking conversation" : "Fork from here"}
                  disabled={forkingMessageId !== null || rollingBackMessageId !== null}
                  onClick={() => void forkFromMessage(message)}
                >
                  {isForkingMessage
                    ? <LoaderCircle size={12} className="codex-spin" />
                    : <GitBranch size={12} />}
                </button>
              )}
            </div>
            <MessageTimestamp createdAt={message.createdAt} />
          </div>
        )}
      </article>
    );
  }

  if (!workspace) {
    return <main className="codex-empty"><div className="codex-mark large">C</div><h1>Open a workspace</h1><p>Choose a folder to start working with Codex.</p></main>;
  }

  return (
    <main className="codex-chat">
      <header className="codex-chat-header">
        <div>
          <button
            className="codex-title-button"
            type="button"
            disabled={!activeThread}
            onDoubleClick={() => {
              if (!activeThread) return;
              const title = window.prompt("Rename conversation", activeThread.title)?.trim();
              if (title) void renameThread(activeThread.id, title);
            }}
          >
            {activeThread?.title ?? "New conversation"}
          </button>
          <span>{workspace.name} · {status === "streaming" ? "Codex is working" : status.replace("_", " ")}</span>
        </div>
        <button type="button" className={policyOpen ? "active" : ""} onClick={() => setPolicyOpen((open) => !open)} title="Execution settings">
          <Settings2 size={15} />
        </button>
      </header>

      {policyOpen && activeThread && (
        <div className="codex-policy-bar">
          <label>Approvals<select value={readMetadataString(activeThread, "sandboxApprovalPolicy") ?? "inherit"} onChange={(event) => void updatePolicy({ approvalPolicy: event.target.value === "inherit" ? null : event.target.value })}>
            <option value="inherit">Config default</option><option value="untrusted">Untrusted commands</option><option value="on-failure">On failure</option><option value="on-request">On request</option><option value="never">Never</option>
          </select></label>
          <label>Sandbox<select value={readMetadataString(activeThread, "sandboxMode") ?? "inherit"} onChange={(event) => void updatePolicy({ sandboxMode: event.target.value === "inherit" ? null : event.target.value })}>
            <option value="inherit">Config default</option><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option>
          </select></label>
          <label>Network<select value={activeThread.engineMetadata?.sandboxAllowNetwork === true ? "enabled" : activeThread.engineMetadata?.sandboxAllowNetwork === false ? "restricted" : "inherit"} onChange={(event) => void updatePolicy({ allowNetwork: event.target.value === "inherit" ? null : event.target.value === "enabled" })}>
            <option value="inherit">Config default</option><option value="enabled">Enabled</option><option value="restricted">Restricted</option>
          </select></label>
          <label>Service<select value={readMetadataString(activeThread, "serviceTier") ?? "inherit"} onChange={(event) => void updateServiceTier(event.target.value)}>
            <option value="inherit">Standard</option><option value="fast">Fast</option><option value="flex">Flex</option>
          </select></label>
        </div>
      )}

      <div
        ref={viewportRef}
        className={`codex-message-viewport ${showSpecialComposer ? "awaiting-input" : ""} ${CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED ? "is-virtualized" : ""}`}
      >
        {hasOlderMessages && (
          <button className="codex-load-older" type="button" disabled={loadingOlderMessages} onClick={() => void loadOlderMessages()}>
            <ArrowDown size={13} className="rotate" /> {loadingOlderMessages ? "Loading…" : "Load older messages"}
          </button>
        )}
        {!activeThread && <div className="codex-welcome"><h1>What should we work on?</h1><p>Codex can inspect, edit, test, and explain anything in {workspace.name}.</p></div>}
        {activeThread && boundThreadId !== activeThread.id && <div className="codex-loading">Loading conversation…</div>}
        {displayedMessages.filter(message => message.role === "assistant").slice().reverse().map(message => (
          <CodexTranscriptSource key={message.id} message={message}
            refreshSequence={transcriptSequences[message.id] ?? 0} workspaceRootPath={workspace.rootPath}
            onRows={publishRows} onApproval={approval} onPlanText={recordNativePlanText}
            hydrateActionOutput={hydrateActionOutput} />
        ))}
        <VirtualMessageTranscript
          key={boundThreadId ?? "unbound"}
          ref={transcriptRef}
          messages={displayedMessages}
          rows={displayedMessages.flatMap(message => message.role !== "assistant" ? [{
            key: message.id, messageId: message.id, content: renderMessage(message), estimatedHeight: 110,
          }] : [
            ...(nativeRows[message.id] ?? [{ key: message.id, messageId: message.id,
              content: <div className="codex-loading">Loading transcript?</div>, estimatedHeight: 120 }])
              .map(row => ({ ...row, content: renderMessage(message, row.content, "body") })),
            { key: `${message.id}/footer`, messageId: message.id,
              content: renderMessage(message, null, "footer"), estimatedHeight: 60 },
          ])}
          onFollowChange={following => {
            nearBottomRef.current = following;
            if (following) { selectionPausedFollowRef.current = false; setHasUnseenOutput(false); }
            else setHasUnseenOutput(true);
          }}
          onPositionChange={position => { if (boundThreadId) saveChatScrollPosition(boundThreadId, position); }}
          viewportRef={viewportRef}
          restorePosition={savedScrollPosition}
          selectedMessageRange={selectedMessageRange}
          layoutRevision={`${hasOlderMessages}:${loadingOlderMessages}:${showSpecialComposer}`}
          virtualizationEnabled={CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED}
          renderMessage={renderMessage}
        />
        {error && <div className="codex-error">{error}</div>}
      </div>

      <div className={`codex-composer-wrap ${planMode ? "plan" : ""} ${showSpecialComposer ? "special" : ""}`}>
        {engineMutationStatus && (
          <div
            className={`codex-history-mutation-status ${engineMutationError ? "error" : ""}`}
            role={engineMutationError ? "alert" : "status"}
          >
            {!engineMutationError && <LoaderCircle size={13} className="codex-spin" />}
            <span>
              {engineMutationError
                ? engineForkPending ? "Fork preparation failed. Sending will retry automatically." : "History edit needs recovery. Refresh the thread before continuing."
                : engineMutationStatus}
            </span>
            {engineRollbackPending && engineMutationError && activeThreadId && (
              <button type="button" onClick={() => void ipc.syncThreadFromEngine(activeThreadId)
                .then(applyThreadUpdateLocal)
                .catch((error) => toast.error(String(error)))
                .finally(() => {
                  if (useThreadStore.getState().activeThreadId === activeThreadId) {
                    return useChatStore.getState().setActiveThread(activeThreadId, { forceReload: true });
                  }
                })}>Recover history</button>
            )}
          </div>
        )}
        {hasUnseenOutput && (
          <button
            type="button"
            className="codex-jump-latest"
            data-transcript-selection-ignore
            onClick={jumpToLatest}
          >
            <ArrowDown size={13} />
            Jump to latest
          </button>
        )}
        {nonblockingQuestions.length > 0 && (
          <section className="codex-pending-questions" aria-label="Pending questions">
            <div className="codex-pending-questions-label">Questions · Codex can keep working</div>
            {nonblockingQuestions.map((request) => (
              <details key={request.approvalId} open>
                <summary>{request.summary || "Question from Codex"}</summary>
                <ToolInputQuestionnaire
                  details={request.details}
                  onSubmit={(response) => respondApproval(request.approvalId, response)}
                  draftKey={`${activeThreadId}:${request.approvalId}`}
                />
              </details>
            ))}
          </section>
        )}
        <div className="codex-composer">
          {showSpecialComposer && planMode && (
            <div className="codex-composer-mode"><ListChecks size={12} /> Plan mode</div>
          )}
          <CodexComposer
            ref={composerRef}
            workspaceRootPath={workspace.rootPath}
            disabled={!activeWorkspaceId || !composerModeScopeReady}
            submitDisabled={engineRollbackPending || rollingBackMessageId !== null || !selectedModel}
            submitTitle={engineRollbackPending || rollingBackMessageId ? "Finishing history edit" : streaming ? "Steer" : "Send"}
            placeholder={planMode ? "Ask Codex to make a plan…" : streaming ? "Steer the current turn…" : "Message Codex…"}
            streaming={streaming}
            onSubmit={submit}
            onTogglePlanMode={() => setPlanMode(!planMode)}
            onStop={cancel}
            prompt={pendingToolInputApproval ? (
              <ToolInputQuestionnaire
                key={pendingToolInputApproval.approvalId}
                details={pendingToolInputApproval.details}
                onSubmit={submitPendingToolInput}
                onStop={cancel}
                draftKey={`${activeThreadId}:${pendingToolInputApproval.approvalId}`}
              />
            ) : showPlanImplementationPrompt ? (
              <ToolInputQuestionnaire
                details={PLAN_IMPLEMENTATION_QUESTION_DETAILS}
                onSubmit={handlePlanImplementationResponse}
                submitLabel={implementingPlan ? "Starting…" : "Continue"}
              />
            ) : null}
          >
            <button type="button" className={planMode ? "active" : ""} aria-pressed={planMode} onClick={() => setPlanMode(!planMode)} disabled={streaming || !composerModeScopeReady} title={`${planMode ? "Disable" : "Enable"} Plan mode (Shift+Tab)`}><ListChecks size={14} /> Plan</button>
            <select value={selectedModel?.id ?? ""} onChange={(event) => {
              const model = models.find((item) => item.id === event.target.value) ?? null;
              setSelectedModelId(event.target.value);
              setReasoningEffort(resolveReasoningEffortForModel(model, reasoningEffort));
            }} aria-label="Model">
              {modelOptions.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}
            </select>
            {selectedModel && selectedModel.supportedReasoningEfforts.length > 0 && (
              <label className="codex-effort"><Brain size={13} /><select value={reasoningEffort ?? ""} onChange={(event) => setReasoningEffort(event.target.value || null)} aria-label="Reasoning effort">
                {selectedModel.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
              </select></label>
            )}
            <button
              type="button"
              className={`codex-fast ${fastMode ? "active" : ""}`}
              aria-label="Fast mode"
              aria-pressed={fastMode}
              onClick={() => setFastMode(!fastMode)}
              disabled={streaming || !composerModeScopeReady}
              title={`${fastMode ? "Disable" : "Enable"} Fast mode`}
            >
              <Zap size={12} /> Fast
            </button>
            <CodexUsageLimits
              usage={usage}
              threadId={activeThreadId === boundThreadId ? activeThreadId : null}
              planType={codexPlanType}
              onRefresh={ipc.refreshThreadUsageLimits}
            />
          </CodexComposer>
        </div>
      </div>
    </main>
  );
}
