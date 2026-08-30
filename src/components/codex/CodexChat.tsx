import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  Brain,
  Check,
  Copy,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Send,
  Settings2,
  Square,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { buildCodexInputItems } from "../chat/codexInputItems";
import { AttachmentChip } from "../chat/AttachmentChip";
import { ToolInputQuestionnaire } from "../chat/ToolInputQuestionnaire";
import { CodexUsageLimits } from "./CodexUsageLimits";
import { findLatestPendingToolInputApproval } from "../chat/toolInputApproval";
import {
  canForkFromAssistantMessage,
  computeDroppedTurnsForEditedMessage,
  computeTurnsAfterAssistantMessage,
  extractEditableMessageContext,
  isEditableUserTurn,
  mergeUniqueChatAttachments,
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
  captureChatScrollPosition,
  readChatScrollPosition,
  restoreChatScrollPosition,
  saveChatScrollPosition,
} from "../../lib/chatScrollPosition";
import { useTranscriptSelection } from "../../lib/transcriptSelection";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
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
import type { ApprovalResponse, ChatAttachment, CodexApp, CodexSkill, ContentBlock, Message, Thread } from "../../types";

const PLAN_IMPLEMENTATION_QUESTION_ID = "plan_implementation_decision";
const PLAN_IMPLEMENTATION_CHOICE = "Implement the plan";
const STAY_IN_PLAN_MODE_CHOICE = "Stay in plan mode";
const SCROLL_RESTORE_SETTLE_MS = 2_500;
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

function fileNameFromPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").at(-1) || "attachment";
}

function guessMimeType(fileName: string): string | undefined {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", pdf: "application/pdf", json: "application/json",
    md: "text/markdown", txt: "text/plain", csv: "text/csv",
  };
  return extension ? types[extension] : undefined;
}

function messageBlocks(message: { content?: string; blocks?: ContentBlock[] }): ContentBlock[] {
  if (message.blocks?.length) return message.blocks;
  return message.content ? [{ type: "text", content: message.content }] : [];
}

function readMetadataString(thread: Thread | null, key: string): string | null {
  const value = thread?.engineMetadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const selectionPausedFollowRef = useRef(false);
  const scrollRestoreActiveRef = useRef(false);
  const scrollRestoreCleanupRef = useRef<(() => void) | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [newThreadServiceTier, setNewThreadServiceTier] = useState<"fast" | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [rollingBackMessageId, setRollingBackMessageId] = useState<string | null>(null);
  const [referenceCatalog, setReferenceCatalog] = useState<{ skills: CodexSkill[]; apps: CodexApp[] } | null>(null);
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
  const sourceTurnActive = streaming ||
    activeThread?.status === "streaming" ||
    activeThread?.status === "awaiting_approval";
  const displayedMessages = useMemo(() => {
    if (!rollingBackMessageId) return messages;
    return messagesBeforeEditableUserTurn(messages, rollingBackMessageId) ?? messages;
  }, [messages, rollingBackMessageId]);
  const visibleTranscriptRevision = useMemo(
    () => displayedMessages
      .map((message) => `${message.id}:${transcriptSequences[message.id] ?? 0}`)
      .join("|"),
    [displayedMessages, transcriptSequences],
  );
  const pendingToolInputApproval = useMemo(
    () => activeThreadId && boundThreadId === activeThreadId
      ? findLatestPendingToolInputApproval(messages)
      : null,
    [activeThreadId, boundThreadId, messages],
  );
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
    !pendingToolInputApproval &&
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
    scrollRestoreActiveRef.current = false;
    scrollRestoreCleanupRef.current?.();
    scrollRestoreCleanupRef.current = null;
  }, []);

  const handleTranscriptSelectionActiveChange = useCallback((active: boolean) => {
    if (!active) return;
    stopScrollRestoration();
    selectionPausedFollowRef.current = true;
    nearBottomRef.current = false;
  }, [stopScrollRestoration]);

  const {
    active: transcriptSelectionActive,
    clearSelection: clearTranscriptSelection,
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
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, [clearTranscriptSelection, stopScrollRestoration]);

  useEffect(() => {
    const captureCurrentThread = () => {
      const viewport = viewportRef.current;
      const currentThreadId = useChatStore.getState().threadId;
      if (!viewport || !currentThreadId) return;
      saveChatScrollPosition(
        currentThreadId,
        captureChatScrollPosition(viewport),
      );
    };
    const unsubscribe = useThreadStore.subscribe((next, previous) => {
      if (next.activeThreadId !== previous.activeThreadId) {
        captureCurrentThread();
      }
    });
    return () => {
      captureCurrentThread();
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !boundThreadId) {
      nearBottomRef.current = true;
      stopScrollRestoration();
      return;
    }

    const saved = readChatScrollPosition(boundThreadId);
    nearBottomRef.current = saved?.nearBottom ?? true;
    stopScrollRestoration();
    if (!saved) {
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }

    scrollRestoreActiveRef.current = true;
    const restore = () => {
      if (!scrollRestoreActiveRef.current) return;
      restoreChatScrollPosition(viewport, saved);
    };
    restore();

    let frame = 0;
    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(restore)
      : null;
    const observeMessages = () => {
      if (!resizeObserver) return;
      viewport
        .querySelectorAll<HTMLElement>("[data-message-id]")
        .forEach((message) => resizeObserver.observe(message));
    };
    observeMessages();

    const mutationObserver = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          observeMessages();
          restore();
        })
      : null;
    mutationObserver?.observe(viewport, { childList: true, subtree: true });

    let settleTimer = 0;
    const cleanup = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
    scrollRestoreCleanupRef.current = cleanup;

    // One extra frame covers the synchronous cached-history commit followed by
    // React's lazy transcript boundary resolving in the same paint cycle.
    frame = window.requestAnimationFrame(restore);
    settleTimer = window.setTimeout(() => {
      scrollRestoreActiveRef.current = false;
      if (scrollRestoreCleanupRef.current === cleanup) {
        scrollRestoreCleanupRef.current = null;
      }
      cleanup();
    }, SCROLL_RESTORE_SETTLE_MS);
    return () => {
      if (scrollRestoreCleanupRef.current === cleanup) {
        scrollRestoreCleanupRef.current = null;
      }
      cleanup();
    };
  }, [boundThreadId, stopScrollRestoration]);

  useEffect(() => {
    const preferredModel = readMetadataString(activeThread, "lastModelId") ?? activeThread?.modelId;
    const nextModel = models.find((model) => model.id === preferredModel) ?? models.find((model) => model.isDefault) ?? models[0];
    if (!nextModel) return;
    setSelectedModelId(nextModel.id);
    setReasoningEffort(resolveReasoningEffortForModel(nextModel, readMetadataString(activeThread, "reasoningEffort")));
  }, [activeThread?.id, models]);

  useEffect(() => {
    setReferenceCatalog(null);
  }, [workspace?.rootPath]);

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
    if (!input.includes("$") || referenceCatalog || !workspace?.rootPath) return;
    let cancelled = false;
    void Promise.all([ipc.listCodexSkills(workspace.rootPath), ipc.listCodexApps()])
      .then(([skills, apps]) => { if (!cancelled) setReferenceCatalog({ skills, apps }); })
      .catch(() => { if (!cancelled) setReferenceCatalog({ skills: [], apps: [] }); });
    return () => { cancelled = true; };
  }, [input, referenceCatalog, workspace?.rootPath]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (nearBottomRef.current && !selectionPausedFollowRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setHasUnseenOutput(false);
      return;
    }
    if (selectionPausedFollowRef.current || streaming) {
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
      !canForkFromAssistantMessage(message, sourceTurnActive)
    ) {
      return;
    }

    const turnsAfter = computeTurnsAfterAssistantMessage(messages, message.id);
    if (turnsAfter === null) {
      toast.error("Could not identify the Codex turn to fork.");
      return;
    }

    setForkingMessageId(message.id);
    const sourceTurnWasActive = sourceTurnActive;
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
      toast.success(sourceTurnWasActive
        ? "Forked conversation. The original is still running in the background."
        : "Forked conversation from here.");
    } catch (forkError) {
      toast.error(`Could not fork this message: ${String(forkError)}`);
    } finally {
      setForkingMessageId((current) => (current === message.id ? null : current));
    }
  }, [activeThread, canForkMessages, forkingMessageId, forkCodexThreadAtTurn, messages, rollingBackMessageId, sourceTurnActive]);

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
    setInput(context.text);
    setAttachments(context.attachments);
    if (activeThreadId) {
      disarmPlanImplementationPrompt(activeThreadId);
      setThreadMode(activeThreadId, context.planMode ? "plan" : "default");
    }
    stopScrollRestoration();
    nearBottomRef.current = true;
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
      textareaRef.current?.focus();
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

  function addPaths(paths: string[]) {
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.filePath.toLowerCase()));
      const added = paths
        .map((filePath) => filePath.trim())
        .filter((filePath) => filePath && !known.has(filePath.toLowerCase()))
        .map((filePath) => {
          const fileName = fileNameFromPath(filePath);
          return { id: crypto.randomUUID(), fileName, filePath, sizeBytes: 0, mimeType: guessMimeType(fileName) };
        });
      return [...current, ...added];
    });
  }

  async function chooseAttachments() {
    const selected = await open({ multiple: true, directory: false, title: "Attach files" });
    if (!selected) return;
    addPaths(Array.isArray(selected) ? selected : [selected]);
  }

  async function savePastedImage(file: File): Promise<ChatAttachment | null> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const saved = await ipc.savePastedImageAttachment(
      file.name || `pasted-${Date.now()}.png`,
      file.type || "image/png",
      base64,
    );
    return { ...saved, id: crypto.randomUUID() };
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void Promise.all(images.map(savePastedImage)).then((saved) => {
      setAttachments((current) => [...current, ...saved.filter((item): item is ChatAttachment => Boolean(item))]);
    }).catch((pasteError) => toast.error(`Could not attach pasted image: ${String(pasteError)}`));
  }

  async function submit() {
    const submittedInput = input;
    const text = input.trim();
    if (rollingBackMessageId || (!text && !attachments.length) || !activeWorkspaceId || !composerModeScopeReady) return;
    let targetThreadId = activeThreadId;
    const creatingThread = !targetThreadId;
    if (creatingThread) {
      targetThreadId = await createAndActivateWorkspaceThread(activeWorkspaceId, {
        serviceTier: fastMode ? "fast" : null,
      });
    }
    if (!targetThreadId) return;
    if (creatingThread) clearNewThreadMode(activeWorkspaceId);

    const submittedAttachments = attachments;
    const inputItems = referenceCatalog ? buildCodexInputItems(text, referenceCatalog.skills, referenceCatalog.apps) : undefined;
    let composerConsumed = false;
    const consumeSubmittedComposer = () => {
      if (composerConsumed) return;
      composerConsumed = true;
      setInput("");
      setAttachments([]);
      nearBottomRef.current = true;
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const restoreSubmittedComposer = () => {
      if (!composerConsumed) return;
      setInput((current) => {
        if (!current) return submittedInput;
        if (!submittedInput || current === submittedInput) return current;
        return `${submittedInput}${submittedInput.endsWith("\n") ? "" : "\n"}${current}`;
      });
      setAttachments((current) => mergeUniqueChatAttachments(submittedAttachments, current));
    };
    const accepted = streaming
      ? await steer(text, {
          threadIdOverride: targetThreadId,
          attachments: submittedAttachments,
          inputItems,
          planMode,
          onAccepted: consumeSubmittedComposer,
        })
      : await send(text, {
          threadIdOverride: targetThreadId,
          engineId: "codex",
          modelId: selectedModel?.id ?? null,
          reasoningEffort,
          attachments: submittedAttachments,
          inputItems,
          planMode,
          onAccepted: consumeSubmittedComposer,
        });
    if (accepted) {
      // The store invokes this synchronously when it inserts the optimistic turn.
      // Keep the fallback for alternate implementations and test doubles.
      consumeSubmittedComposer();
    } else {
      restoreSubmittedComposer();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.shiftKey && event.key === "Tab" && !streaming && composerModeScopeReady) {
      event.preventDefault();
      setPlanMode(!planMode);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  async function submitPendingToolInput(response: ApprovalResponse) {
    if (!pendingToolInputApproval) return;
    await respondApproval(pendingToolInputApproval.approvalId, response);
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
        className={`codex-message-viewport ${showSpecialComposer ? "awaiting-input" : ""}`}
        onWheelCapture={stopScrollRestoration}
        onPointerDownCapture={stopScrollRestoration}
        onTouchStartCapture={stopScrollRestoration}
        onKeyDownCapture={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
            stopScrollRestoration();
          }
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const position = captureChatScrollPosition(element);
          nearBottomRef.current = position.nearBottom;
          if (position.nearBottom && !transcriptSelectionActive) {
            selectionPausedFollowRef.current = false;
            setHasUnseenOutput(false);
          }
          if (boundThreadId) saveChatScrollPosition(boundThreadId, position);
        }}
      >
        {hasOlderMessages && (
          <button className="codex-load-older" type="button" disabled={loadingOlderMessages} onClick={() => void loadOlderMessages()}>
            <ArrowDown size={13} className="rotate" /> {loadingOlderMessages ? "Loading…" : "Load older messages"}
          </button>
        )}
        {!activeThread && <div className="codex-welcome"><h1>What should we work on?</h1><p>Codex can inspect, edit, test, and explain anything in {workspace.name}.</p></div>}
        {activeThread && boundThreadId !== activeThread.id && <div className="codex-loading">Loading conversation…</div>}
        {displayedMessages.map((message) => {
          const blocks = messageBlocks(message);
          const copyText = message.content ?? blocks.filter((block) => block.type === "text").map((block) => block.content).join("\n\n");
          const canForkMessage =
            canForkFromAssistantMessage(message, sourceTurnActive) &&
            canForkMessages;
          const canRollbackMessage =
            message.role === "user" &&
            canRollbackMessages &&
            isEditableUserTurn(message);
          const isForkingMessage = forkingMessageId === message.id;
          const isRollingBackMessage = rollingBackMessageId === message.id;
          return (
            <article
              key={message.id}
              className={`codex-message ${message.role}`}
              data-message-id={message.id}
              data-transcript-selection-scope={`message:${message.id}`}
            >
              {message.role === "user" && (
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
              <Suspense fallback={<div className="codex-loading">Rendering…</div>}>
                {message.role === "assistant" ? (
                  <CodexTurnTranscript
                    messageId={message.id}
                    blocks={blocks}
                    status={message.status}
                    tokenUsage={message.tokenUsage}
                    workspaceRootPath={workspace.rootPath}
                    refreshSequence={transcriptSequences[message.id] ?? 0}
                    onApproval={approval}
                    onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
                    onPlanText={recordNativePlanText}
                  />
                ) : (
                  <MessageBlocks
                    blocks={blocks}
                    status={message.status}
                    workspaceRootPath={workspace.rootPath}
                    selectionNamespace={`message:${message.id}:blocks`}
                    onApproval={approval}
                    onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
                  />
                )}
              </Suspense>
              {message.role === "assistant" && message.status !== "streaming" && (
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
              )}
            </article>
          );
        })}
        {error && <div className="codex-error">{error}</div>}
      </div>

      <div className={`codex-composer-wrap ${planMode ? "plan" : ""} ${showSpecialComposer ? "special" : ""}`}>
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
        <div className="codex-composer">
          {showSpecialComposer && planMode && (
            <div className="codex-composer-mode"><ListChecks size={12} /> Plan mode</div>
          )}
          {pendingToolInputApproval ? (
            <ToolInputQuestionnaire
              details={pendingToolInputApproval.details}
              onSubmit={submitPendingToolInput}
              onStop={cancel}
            />
          ) : showPlanImplementationPrompt ? (
            <ToolInputQuestionnaire
              details={PLAN_IMPLEMENTATION_QUESTION_DETAILS}
              onSubmit={handlePlanImplementationResponse}
              submitLabel={implementingPlan ? "Starting…" : "Continue"}
            />
          ) : (
            <>
              {attachments.length > 0 && (
                <div className="codex-composer-attachments" aria-label="Attached files">
                  {attachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      composerPreview
                      removeLabel={`Remove ${attachment.fileName}`}
                      onRemove={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
                    />
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                rows={2}
                value={input}
                disabled={!activeWorkspaceId || !composerModeScopeReady}
                placeholder={planMode ? "Ask Codex to make a plan…" : streaming ? "Steer the current turn…" : "Message Codex…"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <div className="codex-composer-toolbar">
                <button type="button" onClick={() => void chooseAttachments()} disabled={!composerModeScopeReady} title="Attach files"><Paperclip size={14} /></button>
                <button type="button" className={planMode ? "active" : ""} aria-pressed={planMode} onClick={() => setPlanMode(!planMode)} disabled={streaming || !composerModeScopeReady} title={`${planMode ? "Disable" : "Enable"} Plan mode (Shift+Tab)`}><ListChecks size={14} /> Plan</button>
                <select value={selectedModel?.id ?? ""} onChange={(event) => {
                  const model = models.find((item) => item.id === event.target.value) ?? null;
                  setSelectedModelId(event.target.value);
                  setReasoningEffort(resolveReasoningEffortForModel(model, reasoningEffort));
                }} aria-label="Model">
                  {models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}
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
                <span className="spacer" />
                {streaming && <button type="button" onClick={() => void cancel()} title="Stop"><Square size={13} /></button>}
                <button className="send" type="button" disabled={rollingBackMessageId !== null || (!input.trim() && !attachments.length) || !selectedModel || !composerModeScopeReady} onClick={() => void submit()} title={rollingBackMessageId ? "Finishing rollback" : streaming ? "Steer" : "Send"}><Send size={14} /></button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
