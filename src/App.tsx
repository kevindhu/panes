import { useEffect, useRef } from "react";
import { ThreeColumnLayout } from "./components/layout/ThreeColumnLayout";
import { CommandPalette } from "./components/shared/CommandPalette";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { ToastContainer } from "./components/shared/ToastContainer";
import { PowerSettingsModal } from "./components/shared/PowerSettingsModal";
import { TerminalNotificationSettingsModal } from "./components/shared/TerminalNotificationSettingsModal";
import { t } from "./i18n";
import { useUpdateStore } from "./stores/updateStore";
import {
  type ChatTurnFinishedEvent,
  ipc,
  listenChatTurnFinished,
  listenEngineRuntimeUpdated,
  listenMenuAction,
  listenThreadUpdated,
} from "./lib/ipc";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useEngineStore } from "./stores/engineStore";
import { useUiStore } from "./stores/uiStore";
import { useThreadStore } from "./stores/threadStore";
import {
  acceptTurnFinishedRuntimeEvent,
  useChatStore,
} from "./stores/chatStore";
import { useGitStore } from "./stores/gitStore";
import { useTerminalStore, collectSessionIds } from "./stores/terminalStore";
import { useFileStore } from "./stores/fileStore";
import { useKeepAwakeStore } from "./stores/keepAwakeStore";
import { useTerminalNotificationSettingsStore } from "./stores/terminalNotificationSettingsStore";
import { useThreadNotificationStore } from "./stores/threadNotificationStore";
import { useThreadPlanModeStore } from "./stores/threadPlanModeStore";
import { useWorkspacePaneStore } from "./stores/workspacePaneStore";
import { toast } from "./stores/toastStore";
import type { ChatEngineId, Message, RuntimeToast, Thread } from "./types";
import { getActiveEditorView, openSearchPanel } from "./components/editor/CodeMirrorEditor";
import { CustomWindowFrame } from "./components/shared/CustomWindowFrame";
import { useCustomWindowFrameState } from "./lib/customWindowFrame";
import {
  isPlanImplementationPromptArmed,
  planImplementationPromptLogOperationId,
} from "./lib/planImplementationPromptState";
import { runEditMenuAction } from "./lib/nativeEditActions";
import {
  isAppZoomAvailable,
  resolveAppZoomShortcut,
  runAppZoomAction,
} from "./lib/appZoom";
import { createAndActivateWorkspaceThread } from "./lib/newThreadActions";
import {
  isThreadActivityVisible,
  resolveVisibleChatThreadId,
} from "./lib/threadActivityVisibility";
import { restoreStartupThreadContext } from "./lib/threadActivation";
import {
  cycleWorkspaceTerminalLayout,
  isWorkspaceSurfaceVisible,
  toggleWorkspaceEditorLayout,
} from "./lib/workspacePaneNavigation";
import {
  usesCustomWindowFrame,
  isTerminalInputFocused,
  requestWindowClose,
  shouldHandleAppShortcutWhileTerminalFocused, toggleWindowFullscreen,
} from "./lib/windowActions";

// Debounce guard: when both the JS keydown handler and the native menu-action
// fire for the same shortcut, only the first one within 100ms takes effect.
const shortcutLastFired = new Map<string, number>();
const SHORTCUT_DEBOUNCE_MS = 100;
const KEEP_AWAKE_REFRESH_MS = 15000;

function fireShortcut(id: string, action: () => void) {
  const now = Date.now();
  const last = shortcutLastFired.get(id) ?? 0;
  if (now - last < SHORTCUT_DEBOUNCE_MS) return;
  shortcutLastFired.set(id, now);
  action();
}

async function createNewWorkspaceThread() {
  const { activeWorkspaceId } = useWorkspaceStore.getState();
  await createAndActivateWorkspaceThread(activeWorkspaceId);
}

function isCodexSyncRequired(thread: Thread | null | undefined): boolean {
  return thread?.engineId === "codex" && thread.engineMetadata?.codexSyncRequired === true;
}

function showRuntimeToast(runtimeToast?: RuntimeToast) {
  if (!runtimeToast) {
    return;
  }

  switch (runtimeToast.variant) {
    case "success":
      toast.success(runtimeToast.message);
      break;
    case "warning":
      toast.warning(runtimeToast.message);
      break;
    case "info":
      toast.info(runtimeToast.message);
      break;
    case "error":
    default:
      toast.error(runtimeToast.message);
      break;
  }
}

function resolveAgentDisplayName(engineId: ChatEngineId): string {
  switch (engineId) {
    case "claude":
      return "Claude";
    case "opencode":
      return "OpenCode";
    case "codex":
    default:
      return "Codex";
  }
}

function resolveChatNotificationBody(
  status: "completed" | "interrupted" | "error" | "attention" | "plan_ready",
  preview?: string | null,
): string {
  if (status === "interrupted") {
    return t("app:notificationSettings.chatNotificationFallbackInterrupted");
  }
  const normalizedPreview = preview?.trim();
  if (normalizedPreview) {
    return normalizedPreview;
  }
  if (status === "plan_ready") {
    return t("app:notificationSettings.chatNotificationFallbackPlanReady");
  }
  if (status === "attention") {
    return t("app:notificationSettings.chatNotificationFallbackAttention");
  }
  if (status === "error") {
    return t("app:notificationSettings.chatNotificationFallbackError");
  }
  return t("app:notificationSettings.chatNotificationFallbackComplete");
}

type ThreadAttentionReason = "awaiting_approval" | "awaiting_approval_visibility_sweep" | "plan_ready";

function isApprovalAttentionReason(reason: ThreadAttentionReason): boolean {
  return reason === "awaiting_approval" || reason === "awaiting_approval_visibility_sweep";
}

function messagesHavePendingApprovalBlocks(messages: Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.blocks ?? []).some(
        (block) => block.type === "approval" && block.status === "pending",
      ),
  );
}

function messagesHaveAssistantContent(messages: Message[]): boolean {
  return messages.some((message) => message.role === "assistant");
}

function loadedChatThreadHasPendingApproval(threadId: string): boolean {
  const chatState = useChatStore.getState();
  return chatState.threadId === threadId && messagesHavePendingApprovalBlocks(chatState.messages);
}

function threadHasPendingApprovalSignal(thread: Thread): boolean {
  return thread.status === "awaiting_approval" || loadedChatThreadHasPendingApproval(thread.id);
}

interface ChatTurnVisibilitySnapshot {
  visible: boolean;
  windowFocused: boolean;
  activeView: string;
  activeWorkspaceId: string | null;
  activeRepoId: string | null;
  selectedThreadId: string | null;
  boundChatThreadId: string | null;
  visibleThreadId: string | null;
  activityWorkspaceId: string;
  activityRepoId: string | null;
  activityThreadId: string;
  chatSurfaceVisible: boolean;
}

function getChatTurnVisibilitySnapshot(
  event: Pick<ChatTurnFinishedEvent, "threadId" | "workspaceId" | "repoId">,
): ChatTurnVisibilitySnapshot {
  const workspaceState = useWorkspaceStore.getState();
  const uiState = useUiStore.getState();
  const selectedThreadId = useThreadStore.getState().activeThreadId;
  const boundChatThreadId = useChatStore.getState().threadId;
  const visibleThreadId = resolveVisibleChatThreadId(selectedThreadId, boundChatThreadId);
  const windowFocused = document.hasFocus();
  const chatSurfaceVisible = isWorkspaceSurfaceVisible(event.workspaceId, "chat");
  const snapshot = {
    windowFocused,
    activeView: uiState.activeView,
    activeWorkspaceId: workspaceState.activeWorkspaceId,
    activeRepoId: workspaceState.activeRepoId,
    selectedThreadId,
    boundChatThreadId,
    visibleThreadId,
    activityWorkspaceId: event.workspaceId,
    activityRepoId: event.repoId,
    activityThreadId: event.threadId,
    chatSurfaceVisible,
  };
  return {
    ...snapshot,
    visible: isThreadActivityVisible({
      windowFocused,
      activeView: uiState.activeView,
      activeWorkspaceId: workspaceState.activeWorkspaceId,
      activeRepoId: workspaceState.activeRepoId,
      activeThreadId: visibleThreadId,
      activityWorkspaceId: event.workspaceId,
      activityRepoId: event.repoId,
      activityThreadId: event.threadId,
      chatSurfaceVisible,
    }),
  };
}

function isChatTurnVisible(
  event: Pick<ChatTurnFinishedEvent, "threadId" | "workspaceId" | "repoId">,
): boolean {
  return getChatTurnVisibilitySnapshot(event).visible;
}

function appendPlanPromptLogBestEffort(
  threadId: string,
  step: string,
  details?: Record<string, unknown>,
): void {
  let serializedDetails: string | null = null;
  if (details && Object.keys(details).length > 0) {
    serializedDetails = JSON.stringify(details);
  }
  void ipc
    .appendBranchProfileLog(
      planImplementationPromptLogOperationId(threadId),
      step,
      serializedDetails,
    )
    .catch((error) => {
      console.warn(`Failed to append plan prompt log for ${threadId}:`, error);
    });
}

function appendThreadAttentionLogBestEffort(
  threadId: string,
  step: string,
  details?: Record<string, unknown>,
): void {
  let serializedDetails: string | null = null;
  if (details && Object.keys(details).length > 0) {
    serializedDetails = JSON.stringify(details);
  }
  void ipc
    .appendBranchProfileLog(`thread-attention:${threadId}`, step, serializedDetails)
    .catch((error) => {
      console.warn(`Failed to append thread attention log for ${threadId}:`, error);
    });
}

function clearVisibleThreadNotification(): void {
  const threadId = useChatStore.getState().threadId;
  if (!threadId) {
    return;
  }

  const thread = useThreadStore.getState().threads.find((item) => item.id === threadId);
  if (!thread) {
    return;
  }

  const visibility = getChatTurnVisibilitySnapshot({
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    repoId: thread.repoId,
  });
  if (!visibility.visible) {
    return;
  }

  const threadNotifications = useThreadNotificationStore.getState();
  const existingNotification = threadNotifications.notificationsByThreadId[thread.id];
  if (!existingNotification) {
    return;
  }

  if (threadHasPendingApprovalSignal(thread) && existingNotification.status === "pending_approval") {
    return;
  }

  threadNotifications.clearThreadNotification(thread.id);
  appendThreadAttentionLogBestEffort(thread.id, "frontend.thread_attention.visible_clear", {
    threadId: thread.id,
    status: thread.status,
    visibility,
    notificationStatus: existingNotification.status,
    preview: existingNotification.preview,
  });
}

async function notifyThreadNeedsAttention(
  thread: Thread,
  options: {
    body?: string;
    reason?: ThreadAttentionReason;
    requireAwaitingApproval?: boolean;
    showNative?: boolean;
  } = {},
): Promise<void> {
  const reason = options.reason ?? "awaiting_approval";
  const hasPendingApprovalSignal = threadHasPendingApprovalSignal(thread);
  if (options.requireAwaitingApproval !== false && !hasPendingApprovalSignal) {
    return;
  }

  const visibility = getChatTurnVisibilitySnapshot({
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    repoId: thread.repoId,
  });
  const visible = visibility.visible;
  const threadNotifications = useThreadNotificationStore.getState();
  const body = options.body ?? resolveChatNotificationBody("attention");
  const existingNotification = threadNotifications.notificationsByThreadId[thread.id];
  const approvalReason = isApprovalAttentionReason(reason);
  const expectedNotificationStatus = approvalReason ? "pending_approval" : "attention";
  const alreadyExpectedStatus = existingNotification?.status === expectedNotificationStatus;
  const alreadySameNotification = alreadyExpectedStatus && existingNotification.preview === body;
  const shouldPersistVisibleApprovalAttention =
    visible && hasPendingApprovalSignal && approvalReason;
  if (shouldPersistVisibleApprovalAttention) {
    if (!alreadySameNotification) {
      threadNotifications.markThreadPendingApproval(thread, body);
      appendThreadAttentionLogBestEffort(
        thread.id,
        "frontend.thread_attention.notification_visible_marked",
        {
          threadId: thread.id,
          reason,
          status: thread.status,
          visibility,
          expectedNotificationStatus,
          existingNotificationStatus: existingNotification?.status ?? null,
          body,
        },
      );
    }
    return;
  }

  if (visible) {
    if (existingNotification) {
      threadNotifications.clearThreadNotification(thread.id);
      if (reason === "plan_ready") {
        appendPlanPromptLogBestEffort(
          thread.id,
          "frontend.plan_prompt.notification_visible_clear",
          {
            threadId: thread.id,
            status: thread.status,
            visibility,
          },
        );
      } else {
        appendThreadAttentionLogBestEffort(
          thread.id,
          "frontend.thread_attention.notification_visible_clear",
          {
            threadId: thread.id,
            reason,
            status: thread.status,
            visibility,
          },
        );
      }
    } else if (reason !== "awaiting_approval_visibility_sweep") {
      if (reason === "plan_ready") {
        appendPlanPromptLogBestEffort(
          thread.id,
          "frontend.plan_prompt.notification_visible_skip",
          {
            threadId: thread.id,
            status: thread.status,
            visibility,
          },
        );
      } else {
        appendThreadAttentionLogBestEffort(
          thread.id,
          "frontend.thread_attention.notification_visible_skip",
          {
            threadId: thread.id,
            reason,
            status: thread.status,
            visibility,
          },
        );
      }
    }
    return;
  }

  if (alreadySameNotification) {
    return;
  }
  if (approvalReason) {
    threadNotifications.markThreadPendingApproval(thread, body);
  } else {
    threadNotifications.markThreadNeedsAttention(thread, body);
  }
  if (reason === "plan_ready") {
    appendPlanPromptLogBestEffort(thread.id, "frontend.plan_prompt.notification_marked", {
      threadId: thread.id,
      status: thread.status,
      visibility,
      alreadyAttention: alreadyExpectedStatus,
      existingNotificationStatus: existingNotification?.status ?? null,
      body,
    });
  } else {
    appendThreadAttentionLogBestEffort(thread.id, "frontend.thread_attention.notification_marked", {
      threadId: thread.id,
      reason,
      status: thread.status,
      visibility,
      expectedNotificationStatus,
      existingNotificationStatus: existingNotification?.status ?? null,
      body,
    });
  }
  if (alreadyExpectedStatus) {
    return;
  }
  if (options.showNative === false) {
    return;
  }

  const notificationStore = useTerminalNotificationSettingsStore.getState();
  const settings = notificationStore.settings ?? await notificationStore.load();
  if (!settings?.chatEnabled) {
    return;
  }

  const title = thread.title.trim() || resolveAgentDisplayName(thread.engineId);
  try {
    await ipc.showAgentNotification(title, body);
  } catch (error) {
    console.warn(`Failed to show chat attention notification for thread ${thread.id}:`, error);
  }
}

export function App() {
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeRepoId = useWorkspaceStore((s) => s.activeRepoId);
  const workspaceLoading = useWorkspaceStore((s) => s.loading);
  const reposLoading = useWorkspaceStore((s) => s.reposLoading);
  const loadEngines = useEngineStore((s) => s.load);
  const applyEngineRuntimeUpdate = useEngineStore((s) => s.applyRuntimeUpdate);
  const loadKeepAwake = useKeepAwakeStore((s) => s.load);
  const loadTerminalNotificationSettings = useTerminalNotificationSettingsStore((s) => s.load);
  const refreshKeepAwake = useKeepAwakeStore((s) => s.refresh);
  const keepAwakeEnabled = useKeepAwakeStore((s) => s.state?.enabled ?? false);
  const keepAwakeSessionTimer = useKeepAwakeStore((s) => s.state?.sessionRemainingSecs);
  const refreshAllThreads = useThreadStore((s) => s.refreshAllThreads);
  const refreshThreads = useThreadStore((s) => s.refreshThreads);
  const refreshArchivedThreads = useThreadStore((s) => s.refreshArchivedThreads);
  const applyThreadUpdateLocal = useThreadStore((s) => s.applyThreadUpdateLocal);
  const threads = useThreadStore((s) => s.threads);
  const activeThreadId = useThreadStore((s) => s.activeThreadId);
  const threadLoading = useThreadStore((s) => s.loading);
  const threadLoadError = useThreadStore((s) => s.error);
  const startupRestorePending = useThreadStore((s) => s.startupRestorePending);
  const setStartupRestorePending = useThreadStore((s) => s.setStartupRestorePending);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const activeView = useUiStore((s) => s.activeView);
  const closeCommandPalette = useUiStore((s) => s.closeCommandPalette);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const visibleChatThreadId = useChatStore((s) => s.threadId);
  const chatMessages = useChatStore((s) => s.messages);
  const activeWorkspacePaneLayout = useWorkspacePaneStore((state) =>
    activeWorkspaceId ? state.workspaces[activeWorkspaceId] ?? null : null,
  );
  const pruneThreadNotifications = useThreadNotificationStore((s) => s.pruneThreadNotifications);
  const pruneThreadPlanModes = useThreadPlanModeStore((s) => s.pruneThreadModes);
  const customWindowFrame = usesCustomWindowFrame();
  const customWindowFrameState = useCustomWindowFrameState();
  const startupRestoreAttemptedRef = useRef(false);

  useEffect(() => {
    void loadWorkspaces();
    void loadEngines();
    void loadKeepAwake();
    void loadTerminalNotificationSettings();
  }, [loadWorkspaces, loadEngines, loadKeepAwake, loadTerminalNotificationSettings]);

  useEffect(() => {
    void refreshAllThreads(workspaces.map((workspace) => workspace.id));
  }, [workspaces, refreshAllThreads]);

  useEffect(() => {
    if (startupRestorePending || workspaceLoading || threadLoading || threadLoadError) {
      return;
    }
    const validThreadIds = threads.map((thread) => thread.id);
    pruneThreadNotifications(validThreadIds);
    pruneThreadPlanModes(validThreadIds);
  }, [
    pruneThreadNotifications,
    pruneThreadPlanModes,
    startupRestorePending,
    threadLoadError,
    threadLoading,
    threads,
    workspaceLoading,
  ]);

  useEffect(() => {
    if (!visibleChatThreadId || !messagesHaveAssistantContent(chatMessages)) {
      return;
    }

    const thread = threads.find((item) => item.id === visibleChatThreadId);
    if (!thread) {
      return;
    }

    const hasPendingApprovalBlocks = messagesHavePendingApprovalBlocks(chatMessages);
    if (hasPendingApprovalBlocks) {
      void notifyThreadNeedsAttention(thread, {
        reason: "awaiting_approval_visibility_sweep",
        requireAwaitingApproval: false,
        showNative: false,
      });
      return;
    }

    const threadNotifications = useThreadNotificationStore.getState();
    const existingNotification = threadNotifications.notificationsByThreadId[thread.id];
    if (existingNotification?.status !== "pending_approval") {
      return;
    }

    const visibility = getChatTurnVisibilitySnapshot({
      threadId: thread.id,
      workspaceId: thread.workspaceId,
      repoId: thread.repoId,
    });
    if (!visibility.visible || thread.status === "awaiting_approval") {
      return;
    }

    threadNotifications.clearThreadNotification(thread.id);
    appendThreadAttentionLogBestEffort(
      thread.id,
      "frontend.thread_attention.pending_approval_resolved_clear",
      {
        threadId: thread.id,
        status: thread.status,
        visibility,
        notificationStatus: existingNotification.status,
        preview: existingNotification.preview,
      },
    );
  }, [chatMessages, threads, visibleChatThreadId]);

  useEffect(() => {
    clearVisibleThreadNotification();
    window.addEventListener("focus", clearVisibleThreadNotification);
    return () => {
      window.removeEventListener("focus", clearVisibleThreadNotification);
    };
  }, [
    activeRepoId,
    activeView,
    activeWorkspaceId,
    activeWorkspacePaneLayout,
    threads,
    visibleChatThreadId,
  ]);

  useEffect(() => {
    for (const thread of threads) {
      if (thread.status !== "awaiting_approval") {
        continue;
      }

      void notifyThreadNeedsAttention(thread, {
        reason: "awaiting_approval_visibility_sweep",
        showNative: false,
      });
    }
  }, [
    activeRepoId,
    activeThreadId,
    activeView,
    activeWorkspaceId,
    activeWorkspacePaneLayout,
    threads,
    visibleChatThreadId,
  ]);

  useEffect(() => {
    if (startupRestoreAttemptedRef.current) {
      return;
    }

    if (workspaceLoading || reposLoading || threadLoading) {
      return;
    }

    startupRestoreAttemptedRef.current = true;

    let cancelled = false;
    void restoreStartupThreadContext({
      activeThreadId,
      threads,
      workspaceLoading,
      reposLoading,
      threadLoading,
    }).then(() => {
      if (cancelled) {
        return;
      }
      setStartupRestorePending(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeThreadId,
    reposLoading,
    setStartupRestorePending,
    threadLoading,
    threads,
    workspaceLoading,
  ]);

  useEffect(() => {
    const hasSessionTimer = keepAwakeSessionTimer != null;
    if (!keepAwakeEnabled && !hasSessionTimer) {
      return;
    }

    const pollInterval = hasSessionTimer ? 30_000 : KEEP_AWAKE_REFRESH_MS;
    const intervalId = window.setInterval(() => {
      void refreshKeepAwake();
    }, pollInterval);

    return () => window.clearInterval(intervalId);
  }, [keepAwakeEnabled, keepAwakeSessionTimer, refreshKeepAwake]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenThreadUpdated(async ({ workspaceId, thread }) => {
      if (thread) {
        const applied = applyThreadUpdateLocal(thread);
        await notifyThreadNeedsAttention(thread);
        const activeThreadId = useThreadStore.getState().activeThreadId;
        if (thread.id === activeThreadId && isCodexSyncRequired(thread)) {
          try {
            const syncedThread = await ipc.syncThreadFromEngine(thread.id);
            if (useThreadStore.getState().applyThreadUpdateLocal(syncedThread)) {
              await notifyThreadNeedsAttention(syncedThread);
              return;
            }
          } catch (error) {
            console.warn(`Failed to sync active Codex thread ${thread.id}:`, error);
          }
          void refreshThreads(workspaceId);
          void refreshArchivedThreads(workspaceId);
          return;
        }
        if (applied) {
          return;
        }
      }
      void refreshThreads(workspaceId);
      void refreshArchivedThreads(workspaceId);
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [applyThreadUpdateLocal, refreshArchivedThreads, refreshThreads]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenChatTurnFinished(async (event) => {
      if (!acceptTurnFinishedRuntimeEvent(event)) {
        console.info("[chat-runtime] ignored stale turn completion", {
          threadId: event.threadId,
          assistantMessageId: event.assistantMessageId,
          clientTurnId: event.clientTurnId ?? null,
          threadStatus: event.threadStatus,
          status: event.status,
        });
        return;
      }
      const threadStore = useThreadStore.getState();
      const currentThread = threadStore.threads.find(
        (thread) => thread.id === event.threadId,
      );
      const awaitingApproval =
        currentThread?.status === "awaiting_approval" ||
        loadedChatThreadHasPendingApproval(event.threadId);
      const finishedStatus =
        event.status === "interrupted"
          ? "idle"
          : event.status === "error"
            ? "error"
            : awaitingApproval
              ? "awaiting_approval"
              : "completed";
      threadStore.setThreadStatusLocal(event.threadId, finishedStatus);

      const eventThread = useThreadStore
        .getState()
        .threads.find((thread) => thread.id === event.threadId);
      if (eventThread?.status === "awaiting_approval") {
        await notifyThreadNeedsAttention(eventThread);
        return;
      }
      if (eventThread && loadedChatThreadHasPendingApproval(event.threadId)) {
        await notifyThreadNeedsAttention(eventThread, {
          reason: "awaiting_approval_visibility_sweep",
          requireAwaitingApproval: false,
          showNative: false,
        });
        return;
      }
      if (event.status === "completed" && isPlanImplementationPromptArmed(event.threadId)) {
        if (eventThread) {
          await notifyThreadNeedsAttention(eventThread, {
            body: resolveChatNotificationBody("plan_ready"),
            reason: "plan_ready",
            requireAwaitingApproval: false,
          });
          return;
        }
        appendPlanPromptLogBestEffort(
          event.threadId,
          "frontend.plan_prompt.notification_thread_missing",
          {
            threadId: event.threadId,
            workspaceId: event.workspaceId,
            repoId: event.repoId,
            status: event.status,
          },
        );
      }

      const visible = isChatTurnVisible(event);
      const threadNotifications = useThreadNotificationStore.getState();
      if (visible) {
        threadNotifications.clearThreadNotification(event.threadId);
      } else {
        threadNotifications.markThreadFinished(event);
      }

      const notificationStore = useTerminalNotificationSettingsStore.getState();
      const settings = notificationStore.settings ?? await notificationStore.load();
      if (!settings?.chatEnabled || visible) {
        return;
      }

      const title = event.threadTitle.trim() || resolveAgentDisplayName(event.engineId);
      const body = resolveChatNotificationBody(event.status, event.preview);

      try {
        await ipc.showAgentNotification(title, body);
      } catch (error) {
        console.warn(`Failed to show chat notification for thread ${event.threadId}:`, error);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEngineRuntimeUpdated((event) => {
      applyEngineRuntimeUpdate(event);
      showRuntimeToast(event.toast);
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [applyEngineRuntimeUpdate]);

  useEffect(() => {
    function onBeforeUnload() {
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      if (wsId) {
        useGitStore.getState().flushDrafts(wsId);
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkForUpdate();
    }, 3000);
    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  // Capture zoom shortcuts before focused editors or terminals can consume
  // them. In a regular browser we leave the event untouched so its native
  // page-zoom behavior remains available.
  useEffect(() => {
    function onAppZoomKeyDown(event: KeyboardEvent) {
      if (!isAppZoomAvailable()) {
        return;
      }
      const action = resolveAppZoomShortcut(event);
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      fireShortcut(action, () => runAppZoomAction(action));
    }

    window.addEventListener("keydown", onAppZoomKeyDown, true);
    return () => window.removeEventListener("keydown", onAppZoomKeyDown, true);
  }, []);

  // Handle app-level keyboard shortcuts via JavaScript keydown listeners.
  // On macOS, when a contenteditable element (CodeMirror editor) is focused,
  // WKWebView claims Cmd+key events for text formatting before they reach
  // Tauri's native menu accelerators. JavaScript keydown events still fire,
  // so the JS handler is the primary source of truth for these shortcuts.
  //
  // When the native menu accelerator DOES fire (non-contenteditable focus),
  // both the JS handler and the menu-action listener would toggle the same
  // state, canceling each other out. A debounce guard (`shortcutLastFired`)
  // prevents the second handler from re-toggling within 100ms.
  //
  // Cmd+Alt+F (focus mode) is intercepted before Cmd+F so it wins even in editors.
  // F11 toggles native window fullscreen independently from focus mode.
  // Cmd+Shift+N (new thread) and Cmd+E (editor toggle) are JS-only.
  // Cmd+S always prevents the browser save-page dialog.
  // Cmd+W is debounced like the native menu path so Linux can use the same
  // close behavior even without a native menubar.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        fireShortcut("toggle-fullscreen", () => {
          void toggleWindowFullscreen();
        });
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      // On macOS/WebKit, e.key is lowercase even when Shift is held with Cmd,
      // so normalize to lowercase and use e.shiftKey to differentiate.
      const key = e.key.toLowerCase();
      const allowWhileTerminalFocused = shouldHandleAppShortcutWhileTerminalFocused(key, e.shiftKey);

      if (isTerminalInputFocused() && !allowWhileTerminalFocused) return;

      // Always prevent Cmd+S from opening the browser save dialog
      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        return;
      }

      if (key === "f" && e.altKey && !e.shiftKey) {
        e.preventDefault();
        fireShortcut("toggle-focus-mode", () => useUiStore.getState().toggleFocusMode());
        return;
      }

      switch (key) {
        case "n":
          if (!e.shiftKey) return;
          e.preventDefault();
          fireShortcut("new-thread", () => {
            void createNewWorkspaceThread();
          });
          break;
        case "e":
          if (e.shiftKey) return;
          e.preventDefault();
          {
            const wsId = useWorkspaceStore.getState().activeWorkspaceId;
            if (!wsId) return;
            toggleWorkspaceEditorLayout(wsId);
          }
          break;
        case "b":
          e.preventDefault();
          if (e.shiftKey) {
            fireShortcut("toggle-git-panel", () => useUiStore.getState().toggleGitPanel());
          } else {
            fireShortcut("toggle-sidebar", () => useUiStore.getState().toggleSidebar());
          }
          break;
        case "f": {
          if (!e.shiftKey) {
            // Cmd+F — editor find (only in editor mode)
            const wsIdF = useWorkspaceStore.getState().activeWorkspaceId;
            if (wsIdF && isWorkspaceSurfaceVisible(wsIdF, "editor")) {
              e.preventDefault();
              const fileState = useFileStore.getState();
              const activeTabId = fileState.activeTabId;
              if (activeTabId) {
                const activeTab = fileState.tabs.find((tab) => tab.id === activeTabId);
                const editorId =
                  activeTab?.renderMode === "git-diff-editor"
                    ? `${activeTabId}:git-modified`
                    : activeTabId;
                const view = getActiveEditorView(editorId);
                if (view) openSearchPanel(view);
              }
            }
            return;
          }
          // Cmd+Shift+F — search-focused command palette
          e.preventDefault();
          fireShortcut("toggle-search", () =>
            useUiStore.getState().openCommandPalette({ variant: "search", initialQuery: "?" })
          );
          break;
        }
        case "h": {
          if (e.shiftKey) return;
          // Cmd+H — editor find & replace (only in editor mode)
          const wsIdH = useWorkspaceStore.getState().activeWorkspaceId;
          if (!wsIdH || !isWorkspaceSurfaceVisible(wsIdH, "editor")) return;
          e.preventDefault();
          const fileState = useFileStore.getState();
          const activeTabIdH = fileState.activeTabId;
          if (activeTabIdH) {
            const activeTab = fileState.tabs.find((tab) => tab.id === activeTabIdH);
            const editorId =
              activeTab?.renderMode === "git-diff-editor"
                ? `${activeTabIdH}:git-modified`
                : activeTabIdH;
            const view = getActiveEditorView(editorId);
            if (view) {
              openSearchPanel(view);
              requestAnimationFrame(() => {
                const replaceInput = view.dom.querySelector<HTMLInputElement>("[name=replace]");
                replaceInput?.focus();
              });
            }
          }
          break;
        }
        case "t":
          e.preventDefault();
          if (e.shiftKey) {
            fireShortcut("toggle-terminal", () => {
              const wsId = useWorkspaceStore.getState().activeWorkspaceId;
              if (wsId) cycleWorkspaceTerminalLayout(wsId);
            });
          } else {
            fireShortcut("new-terminal-tab", () => {
              const wsId = useWorkspaceStore.getState().activeWorkspaceId;
              if (!wsId) return;
              const ws = useTerminalStore.getState().workspaces[wsId];
              if (!ws || (ws.layoutMode !== "split" && ws.layoutMode !== "terminal")) return;
              void useTerminalStore.getState().createSession(wsId);
            });
          }
          break;
        case "w":
          if (e.shiftKey) return;
          e.preventDefault();
          fireShortcut("close-window", () => {
            void requestWindowClose();
          });
          break;
        case "i":
          if (!e.shiftKey) return;
          e.preventDefault();
          fireShortcut("toggle-broadcast", () => {
            const wsId = useWorkspaceStore.getState().activeWorkspaceId;
            if (!wsId) return;
            const ws = useTerminalStore.getState().workspaces[wsId];
            if (!ws || (ws.layoutMode !== "split" && ws.layoutMode !== "terminal")) return;
            const activeGroupId = ws.activeGroupId;
            if (!activeGroupId) return;
            const activeGroup = ws.groups.find((g) => g.id === activeGroupId);
            if (!activeGroup) return;
            const isBroadcastingActiveGroup = ws.broadcastGroupId === activeGroupId;
            if (!isBroadcastingActiveGroup && collectSessionIds(activeGroup.root).length < 2) return;
            useTerminalStore.getState().toggleBroadcast(wsId, activeGroupId);
          });
          break;
        case "d":
          e.preventDefault();
          fireShortcut(e.shiftKey ? "split-horizontal" : "split-vertical", () => {
            const wsId = useWorkspaceStore.getState().activeWorkspaceId;
            if (!wsId) return;
            const ws = useTerminalStore.getState().workspaces[wsId];
            if (!ws || (ws.layoutMode !== "split" && ws.layoutMode !== "terminal")) return;
            const sid = ws.focusedSessionId;
            if (!sid) return;
            void useTerminalStore.getState().splitSession(
              wsId, sid, e.shiftKey ? "horizontal" : "vertical",
            );
          });
          break;
        case "p":
          if (e.shiftKey) return;
          e.preventDefault();
          fireShortcut("open-command-palette-files", () =>
            useUiStore.getState().openCommandPalette({ initialQuery: "%" })
          );
          break;
        case "k":
          e.preventDefault();
          if (e.shiftKey) {
            fireShortcut("open-command-palette-threads", () =>
              useUiStore.getState().openCommandPalette({ initialQuery: "@" })
            );
          } else {
            fireShortcut("toggle-command-palette", () =>
              useUiStore.getState().openCommandPalette()
            );
          }
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenMenuAction((action) => {
      switch (action) {
        case "toggle-sidebar":
          fireShortcut("toggle-sidebar", () => useUiStore.getState().toggleSidebar());
          break;
        case "toggle-git-panel":
          fireShortcut("toggle-git-panel", () => useUiStore.getState().toggleGitPanel());
          break;
        case "toggle-focus-mode":
          fireShortcut("toggle-focus-mode", () => useUiStore.getState().toggleFocusMode());
          break;
        case "toggle-fullscreen":
          fireShortcut("toggle-fullscreen", () => {
            void toggleWindowFullscreen();
          });
          break;
        case "toggle-search":
          fireShortcut("toggle-search", () =>
            useUiStore.getState().openCommandPalette({ variant: "search", initialQuery: "?" })
          );
          break;
        case "toggle-terminal":
          fireShortcut("toggle-terminal", () => {
            const wsId = useWorkspaceStore.getState().activeWorkspaceId;
            if (wsId) cycleWorkspaceTerminalLayout(wsId);
          });
          break;
        case "zoom-in":
        case "zoom-out":
        case "reset-zoom":
          fireShortcut(action, () => runAppZoomAction(action));
          break;
        case "close-window": {
          void requestWindowClose();
          break;
        }
        case "edit-undo":
        case "edit-redo":
        case "edit-cut":
        case "edit-copy":
        case "edit-paste":
        case "edit-select-all":
          void runEditMenuAction(action).catch((error) => {
            if (import.meta.env.DEV) {
              console.warn("[App] Failed to execute edit menu action", action, error);
            }
          });
          break;
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div
      className={`app-shell${customWindowFrame ? " app-shell-custom-frame" : ""}${
        customWindowFrameState.isMaximized ? " app-shell-custom-frame-maximized" : ""
      }${customWindowFrameState.isFullscreen ? " app-shell-custom-frame-fullscreen" : ""}`}
    >
      {customWindowFrame && <CustomWindowFrame frameState={customWindowFrameState} />}
      <div className="app-shell-body">
        <ThreeColumnLayout />
      </div>
      <CommandPalette open={commandPaletteOpen} onClose={closeCommandPalette} />
      <PowerSettingsModal />
      <TerminalNotificationSettingsModal />
      <OnboardingWizard />
      <ToastContainer />
    </div>
  );
}
