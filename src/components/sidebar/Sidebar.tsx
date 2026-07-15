import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  Command,
  Plus,
  FolderGit2,
  MessageSquare,
  GitBranch,
  ChevronDown,
  ChevronRight,
  Archive,
  RotateCcw,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Terminal,
  Check,
  Rocket,
  RefreshCw,
  PillBottle,
  BellRing,
  ListChecks,
} from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useUiStore } from "../../stores/uiStore";
import { useOnboardingStore } from "../../stores/onboardingStore";
import { useUpdateStore } from "../../stores/updateStore";
import { canToggleKeepAwake, useKeepAwakeStore } from "../../stores/keepAwakeStore";
import { useTerminalNotificationSettingsStore } from "../../stores/terminalNotificationSettingsStore";
import {
  countWorkspacePendingApprovalNotifications,
  countWorkspaceThreadNotifications,
  useThreadNotificationStore,
} from "../../stores/threadNotificationStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { toast } from "../../stores/toastStore";
import { canUseNativeCodexHistoryTools } from "../../lib/codexThreadCapabilities";
import { ipc } from "../../lib/ipc";
import { formatRelativeTime } from "../../lib/formatters";
import { activateThreadContext } from "../../lib/threadActivation";
import {
  emitTerminalAcceleratedRenderingChanged,
  getTerminalAcceleratedRenderingPreferenceVersion,
} from "../../lib/terminalRenderingSettings";
import { handleDragMouseDown, handleDragDoubleClick } from "../../lib/windowDrag";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
import { getActionMenuPosition } from "../git/actionMenuPosition";
import { UpdateDialog } from "../onboarding/UpdateDialog";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { WorkspaceMoreMenu } from "../workspace/WorkspaceMoreMenu";
import { normalizeSidebarCollapsedState } from "./sidebarCollapseState";
import {
  getWorkspaceDropIndex,
  moveWorkspaceId,
  type WorkspaceDragRowRect,
} from "./workspaceDragSort";
import type { Thread, Workspace } from "../../types";

interface ProjectGroup {
  workspace: Workspace;
  threads: Thread[];
}

interface ThreadContextMenuState {
  thread: Thread;
  top: number;
  left: number;
  triggerRect: { top: number; bottom: number; right: number };
}

interface WorkspaceDragState {
  workspaceId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  orderedIds: string[];
}

const MAX_VISIBLE_THREADS = 8;
const WORKSPACE_DRAG_THRESHOLD_PX = 5;
const WORKSPACE_DRAG_EDGE_SCROLL_PX = 36;
const WORKSPACE_DRAG_MAX_SCROLL_SPEED = 14;
const LEGACY_SCAN_DEPTH_STORAGE_KEY = "panes.workspace.scanDepth";
const LEGACY_SCAN_DEPTH_MIN = 0;
const LEGACY_SCAN_DEPTH_MAX = 12;

function isRunningThreadStatus(status: Thread["status"]): boolean {
  return status === "streaming" || status === "awaiting_approval";
}

function readLegacyDefaultScanDepth(): number | undefined {
  const stored = window.localStorage.getItem(LEGACY_SCAN_DEPTH_STORAGE_KEY);
  if (!stored) return undefined;
  const parsed = Number.parseInt(stored, 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < LEGACY_SCAN_DEPTH_MIN || parsed > LEGACY_SCAN_DEPTH_MAX) {
    return undefined;
  }
  return parsed;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/* ─────────────────────────────────────────────────────
   Sidebar content — shared between pinned and flyout
   ───────────────────────────────────────────────────── */

function SidebarContent({ onPin }: { onPin?: () => void }) {
  const { t, i18n } = useTranslation(["app", "common", "chat"]);
  const {
    workspaces,
    archivedWorkspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    setActiveRepo,
    openWorkspace,
    removeWorkspace,
    restoreWorkspace,
    reorderWorkspaces,
    refreshArchivedWorkspaces,
    error,
  } = useWorkspaceStore();
  const {
    threads,
    archivedThreadsByWorkspace,
    activeThreadId,
    setActiveThread,
    forkCodexThread,
    removeThread,
    restoreThread,
    refreshArchivedThreads,
  } = useThreadStore();
  const openOnboarding = useOnboardingStore((state) => state.openOnboarding);
  const sidebarPinned = useUiStore((state) => state.sidebarPinned);
  const toggleSidebarPin = useUiStore((state) => state.toggleSidebarPin);
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const openWorkspaceSettings = useUiStore((state) => state.openWorkspaceSettings);
  const openCommandPalette = useUiStore((state) => state.openCommandPalette);
  const boundChatThreadId = useChatStore((s) => s.threadId);
  const boundChatStatus = useChatStore((s) => s.status);
  const boundChatStreaming = useChatStore((s) => s.streaming);
  const updateStatus = useUpdateStore((s) => s.status);
  const updateSnoozed = useUpdateStore((s) => s.snoozed);
  const keepAwakeState = useKeepAwakeStore((s) => s.state);
  const keepAwakeLoading = useKeepAwakeStore((s) => s.loading);
  const toggleKeepAwake = useKeepAwakeStore((s) => s.toggle);
  const openPowerSettings = useKeepAwakeStore((s) => s.openPowerSettings);
  const terminalNotificationSettings = useTerminalNotificationSettingsStore((s) => s.settings);
  const terminalNotificationLoading = useTerminalNotificationSettingsStore((s) => s.loading);
  const terminalNotificationLoadedOnce = useTerminalNotificationSettingsStore((s) => s.loadedOnce);
  const terminalNotificationUpdatingChatEnabled = useTerminalNotificationSettingsStore((s) => s.updatingChatEnabled);
  const terminalNotificationUpdatingTerminalEnabled = useTerminalNotificationSettingsStore((s) => s.updatingTerminalEnabled);
  const toggleTerminalNotifications = useTerminalNotificationSettingsStore((s) => s.toggle);
  const openTerminalNotificationSettings = useTerminalNotificationSettingsStore((s) => s.openModal);
  const threadNotificationsByThreadId = useThreadNotificationStore((s) => s.notificationsByThreadId);
  const threadPlanModes = useThreadPlanModeStore((s) => s.threadModes);
  const hasUpdate = updateStatus === "available" && !updateSnoozed;
  const keepAwakeAvailable = canToggleKeepAwake(keepAwakeState);

  const projects = useMemo<ProjectGroup[]>(
    () =>
      workspaces.map((ws) => ({
        workspace: ws,
        threads: threads.filter((t) => t.workspaceId === ws.id),
      })),
    [workspaces, threads],
  );
  const workspaceIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const [workspaceDragState, setWorkspaceDragState] = useState<WorkspaceDragState | null>(null);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.workspace.id, project])),
    [projects],
  );
  const visibleProjects = useMemo(() => {
    const orderedIds = workspaceDragState?.dragging ? workspaceDragState.orderedIds : workspaceIds;
    return orderedIds
      .map((workspaceId) => projectsById.get(workspaceId))
      .filter((project): project is ProjectGroup => project !== undefined);
  }, [projectsById, workspaceDragState, workspaceIds]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    normalizeSidebarCollapsedState(workspaceIds, activeWorkspaceId, {}, null),
  );
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [archiveWorkspacePrompt, setArchiveWorkspacePrompt] = useState<{
    workspace: Workspace;
  } | null>(null);
  const [archiveThreadPrompt, setArchiveThreadPrompt] = useState<{
    thread: Thread;
  } | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [settingsMenuPos, setSettingsMenuPos] = useState({ top: 0, left: 0 });
  const [threadContextMenu, setThreadContextMenu] = useState<ThreadContextMenuState | null>(null);
  const [terminalAcceleratedRendering, setTerminalAcceleratedRendering] = useState(true);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const threadContextMenuRef = useRef<HTMLDivElement>(null);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);
  const workspaceRowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const workspaceDragStateRef = useRef<WorkspaceDragState | null>(null);
  const workspaceIdsRef = useRef<string[]>(workspaceIds);
  const workspacePointerCleanupRef = useRef<(() => void) | null>(null);
  const workspaceAutoScrollFrameRef = useRef<number | null>(null);
  const workspaceAutoScrollSpeedRef = useRef(0);
  const workspaceDragClientYRef = useRef(0);
  const suppressWorkspaceClickRef = useRef(false);
  const previousSyncedActiveWorkspaceIdRef = useRef<string | null>(activeWorkspaceId);

  const closeSettingsMenu = useCallback(() => setSettingsMenuOpen(false), []);
  const closeThreadContextMenu = useCallback(() => setThreadContextMenu(null), []);

  useEffect(() => {
    workspaceIdsRef.current = workspaceIds;
  }, [workspaceIds]);

  function setWorkspaceDrag(updater: (state: WorkspaceDragState | null) => WorkspaceDragState | null) {
    const next = updater(workspaceDragStateRef.current);
    workspaceDragStateRef.current = next;
    setWorkspaceDragState(next);
  }

  function getWorkspaceRowRects(orderedIds: string[]): WorkspaceDragRowRect[] {
    return orderedIds.flatMap((workspaceId) => {
      const row = workspaceRowRefs.current[workspaceId];
      if (!row) {
        return [];
      }
      const rect = row.getBoundingClientRect();
      return [{ id: workspaceId, top: rect.top, bottom: rect.bottom }];
    });
  }

  function updateWorkspaceDragOrder(clientY: number) {
    setWorkspaceDrag((state) => {
      if (!state?.dragging) {
        return state;
      }
      const rowRects = getWorkspaceRowRects(state.orderedIds);
      const dropIndex = getWorkspaceDropIndex(clientY, rowRects, state.workspaceId);
      const orderedIds = moveWorkspaceId(state.orderedIds, state.workspaceId, dropIndex);
      if (areStringArraysEqual(orderedIds, state.orderedIds)) {
        return state;
      }
      return { ...state, orderedIds };
    });
  }

  function stopWorkspaceAutoScroll() {
    workspaceAutoScrollSpeedRef.current = 0;
    if (workspaceAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(workspaceAutoScrollFrameRef.current);
      workspaceAutoScrollFrameRef.current = null;
    }
  }

  function clearWorkspacePointerListeners() {
    workspacePointerCleanupRef.current?.();
    workspacePointerCleanupRef.current = null;
  }

  function runWorkspaceAutoScroll() {
    const speed = workspaceAutoScrollSpeedRef.current;
    const scrollContainer = workspaceScrollRef.current;
    const dragState = workspaceDragStateRef.current;
    if (!speed || !scrollContainer || !dragState?.dragging) {
      workspaceAutoScrollFrameRef.current = null;
      return;
    }

    scrollContainer.scrollTop += speed;
    updateWorkspaceDragOrder(workspaceDragClientYRef.current);
    workspaceAutoScrollFrameRef.current = window.requestAnimationFrame(runWorkspaceAutoScroll);
  }

  function updateWorkspaceAutoScroll(clientY: number) {
    const scrollContainer = workspaceScrollRef.current;
    if (!scrollContainer) {
      stopWorkspaceAutoScroll();
      return;
    }

    const rect = scrollContainer.getBoundingClientRect();
    if (rect.height <= 0) {
      stopWorkspaceAutoScroll();
      return;
    }

    let speed = 0;
    if (clientY < rect.top + WORKSPACE_DRAG_EDGE_SCROLL_PX) {
      const distance = rect.top + WORKSPACE_DRAG_EDGE_SCROLL_PX - clientY;
      speed = -Math.min(WORKSPACE_DRAG_MAX_SCROLL_SPEED, Math.max(2, Math.ceil(distance / 3)));
    } else if (clientY > rect.bottom - WORKSPACE_DRAG_EDGE_SCROLL_PX) {
      const distance = clientY - (rect.bottom - WORKSPACE_DRAG_EDGE_SCROLL_PX);
      speed = Math.min(WORKSPACE_DRAG_MAX_SCROLL_SPEED, Math.max(2, Math.ceil(distance / 3)));
    }

    workspaceAutoScrollSpeedRef.current = speed;
    if (speed !== 0 && workspaceAutoScrollFrameRef.current === null) {
      workspaceAutoScrollFrameRef.current = window.requestAnimationFrame(runWorkspaceAutoScroll);
    }
    if (speed === 0 && workspaceAutoScrollFrameRef.current !== null) {
      stopWorkspaceAutoScroll();
    }
  }

  function suppressNextWorkspaceClick() {
    suppressWorkspaceClickRef.current = true;
    window.setTimeout(() => {
      suppressWorkspaceClickRef.current = false;
    }, 0);
  }

  function finishWorkspaceDrag() {
    stopWorkspaceAutoScroll();
    const completedDrag = workspaceDragStateRef.current;
    setWorkspaceDrag(() => null);

    if (!completedDrag?.dragging) {
      return;
    }

    suppressNextWorkspaceClick();
    const currentIds = workspaceIdsRef.current;
    if (areStringArraysEqual(completedDrag.orderedIds, currentIds)) {
      return;
    }

    void reorderWorkspaces(completedDrag.orderedIds).catch(() => {
      toast.error(t("app:sidebar.workspaceOrderFailed"));
    });
  }

  function onWorkspacePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    workspaceId: string,
  ) {
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      (event.target as HTMLElement).closest("[data-workspace-drag-ignore]")
    ) {
      return;
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const initialOrder = workspaceIdsRef.current;
    clearWorkspacePointerListeners();
    workspaceDragClientYRef.current = startY;
    workspaceDragStateRef.current = {
      workspaceId,
      pointerId,
      startX,
      startY,
      dragging: false,
      orderedIds: initialOrder,
    };
    setWorkspaceDragState(workspaceDragStateRef.current);

    const onPointerMove = (moveEvent: PointerEvent) => {
      const state = workspaceDragStateRef.current;
      if (!state || moveEvent.pointerId !== pointerId) {
        return;
      }

      workspaceDragClientYRef.current = moveEvent.clientY;
      const distance = Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY);
      const shouldDrag = state.dragging || distance >= WORKSPACE_DRAG_THRESHOLD_PX;
      if (!shouldDrag) {
        return;
      }

      moveEvent.preventDefault();
      closeSettingsMenu();
      closeThreadContextMenu();

      if (!state.dragging) {
        setWorkspaceDrag((current) =>
          current ? { ...current, dragging: true, orderedIds: workspaceIdsRef.current } : current
        );
      }

      updateWorkspaceDragOrder(moveEvent.clientY);
      updateWorkspaceAutoScroll(moveEvent.clientY);
    };

    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      clearWorkspacePointerListeners();
      finishWorkspaceDrag();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    workspacePointerCleanupRef.current = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }

  useEffect(() => {
    return () => {
      clearWorkspacePointerListeners();
      stopWorkspaceAutoScroll();
      workspaceDragStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        settingsMenuRef.current?.contains(target) ||
        settingsTriggerRef.current?.contains(target)
      )
        return;
      closeSettingsMenu();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeSettingsMenu();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [settingsMenuOpen, closeSettingsMenu]);

  useEffect(() => {
    if (!threadContextMenu) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (threadContextMenuRef.current?.contains(target)) {
        return;
      }
      closeThreadContextMenu();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeThreadContextMenu();
    }
    function onScroll() {
      closeThreadContextMenu();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [threadContextMenu, closeThreadContextMenu]);

  useEffect(() => {
    let cancelled = false;
    const requestVersion = getTerminalAcceleratedRenderingPreferenceVersion();
    ipc
      .getTerminalAcceleratedRendering()
      .then((enabled) => {
        if (
          !cancelled &&
          getTerminalAcceleratedRenderingPreferenceVersion() === requestVersion
        ) {
          setTerminalAcceleratedRendering(enabled);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const archivedThreads = useMemo(
    () =>
      activeWorkspaceId
        ? archivedThreadsByWorkspace[activeWorkspaceId] ?? []
        : [],
    [archivedThreadsByWorkspace, activeWorkspaceId],
  );

  const toggleCollapse = (wsId: string) =>
    setCollapsed((prev) => ({ ...prev, [wsId]: !prev[wsId] }));

  useEffect(() => {
    setCollapsed((prev) =>
      normalizeSidebarCollapsedState(
        workspaceIds,
        activeWorkspaceId,
        prev,
        previousSyncedActiveWorkspaceIdRef.current,
      ),
    );
    previousSyncedActiveWorkspaceIdRef.current = activeWorkspaceId;
  }, [workspaceIds, activeWorkspaceId]);

  useEffect(() => {
    void refreshArchivedWorkspaces();
  }, [refreshArchivedWorkspaces]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    void refreshArchivedThreads(activeWorkspaceId);
  }, [activeWorkspaceId, refreshArchivedThreads]);

  async function onOpenFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    await openWorkspace(selected, readLegacyDefaultScanDepth());
  }

  async function onSelectThread(thread: Thread) {
    closeThreadContextMenu();
    if (activeView !== "chat") setActiveView("chat");
    await activateThreadContext(thread);
  }

  async function onSelectProject(wsId: string) {
    closeThreadContextMenu();
    if (activeView !== "chat") setActiveView("chat");
    setCollapsed(
      Object.fromEntries(projects.map((p) => [p.workspace.id, p.workspace.id !== wsId]))
    );
    await activateThreadContext(null);
    await setActiveWorkspace(wsId);
  }

  async function onCreateProjectThread(project: Workspace) {
    const createdThreadId = await createAndActivateWorkspaceThread(project.id);
    if (!createdThreadId) return;
    setCollapsed((prev) => ({ ...prev, [project.id]: false }));
  }

  function onDeleteWorkspace(project: Workspace) {
    closeThreadContextMenu();
    setArchiveWorkspacePrompt({ workspace: project });
  }

  async function executeArchiveWorkspace(project: Workspace) {
    setArchiveWorkspacePrompt(null);
    const wasActive = project.id === activeWorkspaceId;
    await removeWorkspace(project.id);
    if (wasActive) {
      setActiveThread(null);
      await activateThreadContext(null);
    }
  }

  function onDeleteThread(thread: Thread) {
    closeThreadContextMenu();
    setArchiveThreadPrompt({ thread });
  }

  function onThreadContextMenu(
    event: React.MouseEvent<HTMLDivElement>,
    thread: Thread,
    busy: boolean,
  ) {
    event.preventDefault();
    event.stopPropagation();
    closeSettingsMenu();

    if (thread.engineId !== "codex") {
      closeThreadContextMenu();
      return;
    }

    const triggerRect = {
      top: event.clientY,
      bottom: event.clientY,
      right: event.clientX,
    };
    const position = getActionMenuPosition({
      triggerRect,
      menuWidth: 200,
      menuHeight: 44,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setThreadContextMenu({
      thread,
      top: position.top,
      left: position.left,
      triggerRect,
    });
  }

  async function onForkThread(thread: Thread, busy: boolean) {
    closeThreadContextMenu();
    if (!canUseNativeCodexHistoryTools(thread, busy)) {
      return;
    }

    const forkedThread = await forkCodexThread(thread.id);
    if (!forkedThread) {
      toast.error(t("chat:panel.toasts.codexThreadForkFailed"));
      return;
    }

    await onSelectThread(forkedThread);
    toast.success(t("chat:panel.toasts.codexThreadForked"));
  }

  async function executeArchiveThread(thread: Thread) {
    setArchiveThreadPrompt(null);
    const wasActive = thread.id === activeThreadId;
    await removeThread(thread.id);
    if (wasActive) {
      setActiveThread(null);
      await activateThreadContext(null);
    }
  }

  async function onRestoreWorkspace(workspace: Workspace) {
    await restoreWorkspace(workspace.id);
  }

  async function onRestoreThread(thread: Thread) {
    await restoreThread(thread.id);
  }

  async function onToggleTerminalAcceleratedRendering() {
    const nextValue = !terminalAcceleratedRendering;

    try {
      const saved = await ipc.setTerminalAcceleratedRendering(nextValue);
      setTerminalAcceleratedRendering(saved);
      emitTerminalAcceleratedRenderingChanged(saved);
    } catch {
      toast.error(t("app:sidebar.terminalAcceleratedRenderingFailed"));
    }
  }

  function getWorkspaceLabel(workspace: Workspace) {
    return workspace.name || workspace.rootPath.split("/").pop() || t("app:sidebar.workspaceFallback");
  }

  function getThreadLabel(thread: Thread) {
    return thread.title?.trim() || t("app:sidebar.untitledThread");
  }

  function isThreadRunning(thread: Thread) {
    if (thread.id === boundChatThreadId) {
      return boundChatStreaming || isRunningThreadStatus(boundChatStatus);
    }

    return isRunningThreadStatus(thread.status);
  }

  const keepAwakeDescription = useMemo(() => {
    if (!keepAwakeState) {
      return t("app:sidebar.keepAwakeDescription");
    }
    if (!keepAwakeState?.supported) {
      return t("app:sidebar.keepAwakeUnsupported");
    }
    if (keepAwakeState.enabled && !keepAwakeState.active) {
      return t("app:sidebar.keepAwakeInactive");
    }
    if (
      keepAwakeState.enabled &&
      keepAwakeState.active &&
      keepAwakeState.supportsClosedDisplay === false &&
      keepAwakeState.closedDisplayActive === false
    ) {
      return t("app:sidebar.keepAwakeLimited");
    }
    return t("app:sidebar.keepAwakeDescription");
  }, [keepAwakeState, t]);
  const terminalNotificationDescription = useMemo(() => {
    if (!terminalNotificationLoadedOnce || !terminalNotificationSettings) {
      return t("app:sidebar.terminalNotificationsDescription");
    }
    if (terminalNotificationSettings.chatEnabled && terminalNotificationSettings.terminalEnabled) {
      return t("app:sidebar.terminalNotificationsEnabledAll");
    }
    if (terminalNotificationSettings.chatEnabled) {
      return t("app:sidebar.terminalNotificationsEnabledChat");
    }
    if (terminalNotificationSettings.terminalEnabled) {
      return t("app:sidebar.terminalNotificationsEnabledTerminal");
    }
    if (terminalNotificationSettings.terminalSetupComplete) {
      return t("app:sidebar.terminalNotificationsReady");
    }
    return t("app:sidebar.terminalNotificationsDescription");
  }, [terminalNotificationLoadedOnce, terminalNotificationSettings, t]);

  const terminalNotificationAnyEnabled =
    (terminalNotificationSettings?.chatEnabled ?? false)
    || (terminalNotificationSettings?.terminalEnabled ?? false);
  const terminalNotificationBusy =
    (terminalNotificationLoading && !terminalNotificationLoadedOnce)
    || terminalNotificationUpdatingChatEnabled
    || terminalNotificationUpdatingTerminalEnabled;
  const threadContextMenuBusy = threadContextMenu
    ? isThreadRunning(threadContextMenu.thread)
    : false;
  const threadContextMenuCanFork = threadContextMenu
    ? canUseNativeCodexHistoryTools(threadContextMenu.thread, threadContextMenuBusy)
    : false;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "inherit",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* ── Drag region ── */}
      <div
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleDragDoubleClick}
        style={{ height: 34, flexShrink: 0 }}
      />

      {/* ── Nav items ── */}
      <div style={{ padding: "0 8px 4px", flexShrink: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {/* New thread */}
          <button
            type="button"
            className="sb-nav-item"
            onClick={() => {
              const activeProject = projects.find(
                (p) => p.workspace.id === activeWorkspaceId,
              );
              if (activeProject) {
                void onCreateProjectThread(activeProject.workspace);
              }
            }}
          >
            <Plus size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            {t("app:sidebar.newThread")}
            <span className="sb-nav-item-shortcut">⌘⇧N</span>
          </button>

          {/* Commands — general command palette */}
          <button
            type="button"
            className="sb-nav-item"
            onClick={() => openCommandPalette()}
          >
            <Command size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            {t("app:commandPalette.group.commands")}
            <span className="sb-nav-item-shortcut">⌘K</span>
          </button>

          {/* Search workspace */}
          <button
            type="button"
            className="sb-nav-item"
            onClick={() => openCommandPalette({ variant: "search", initialQuery: "?" })}
          >
            <Search size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            {t("app:sidebar.search")}
            <span className="sb-nav-item-shortcut">⌘⇧F</span>
          </button>

          {/* Agents */}
          <button
            type="button"
            className={`sb-nav-item${activeView === "harnesses" ? " sb-nav-item-active" : ""}`}
            onClick={() => setActiveView(activeView === "harnesses" ? "chat" : "harnesses")}
          >
            <Terminal size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
            {t("app:sidebar.agents")}
          </button>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div
        ref={workspaceScrollRef}
        style={{ flex: 1, minHeight: 0, overflow: "auto", paddingBottom: 4, borderTop: "1px solid rgba(31, 35, 40, 0.06)", marginTop: 4 }}
      >
        <div className="sb-section-label">
          <span>{t("app:sidebar.workspaces")}</span>
          <button
            type="button"
            className="sb-add-project-btn"
            title={t("app:sidebar.openWorkspace")}
            onClick={() => {
              if (activeView !== "chat") setActiveView("chat");
              void onOpenFolder();
            }}
          >
            <Plus size={12} strokeWidth={2.2} />
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="sb-empty">
            {t("app:sidebar.noWorkspaces")}
            <br />
            {t("app:sidebar.openFolder")}
          </div>
        ) : (
          visibleProjects.map((project) => {
            const isActiveProject = project.workspace.id === activeWorkspaceId;
            const isCollapsed = collapsed[project.workspace.id] ?? false;
            const projectName = getWorkspaceLabel(project.workspace);
            const isShowingAll = showAll[project.workspace.id] ?? false;
            const visibleThreads = isShowingAll
              ? project.threads
              : project.threads.slice(0, MAX_VISIBLE_THREADS);
            const hasMore = project.threads.length > MAX_VISIBLE_THREADS;
            const constrainExpandedThreads = isShowingAll && hasMore;
            const isDraggingProject =
              workspaceDragState?.dragging && workspaceDragState.workspaceId === project.workspace.id;
            const workspaceNotificationCount = countWorkspaceThreadNotifications(
              threadNotificationsByThreadId,
              project.workspace.id,
            );
            const workspacePendingApprovalCount = countWorkspacePendingApprovalNotifications(
              threadNotificationsByThreadId,
              project.workspace.id,
            );

            return (
              <div
                key={project.workspace.id}
                className={`sb-project-group${isDraggingProject ? " sb-project-group-dragging" : ""}`}
                style={{ marginBottom: 2 }}
              >
                {/* Workspace header */}
                <button
                  ref={(node) => {
                    workspaceRowRefs.current[project.workspace.id] = node;
                  }}
                  type="button"
                  className={`sb-project ${isActiveProject ? "sb-project-active" : ""}${
                    isDraggingProject ? " sb-project-dragging" : ""
                  }`}
                  aria-grabbed={isDraggingProject}
                  onPointerDown={(event) => onWorkspacePointerDown(event, project.workspace.id)}
                  onClick={(event) => {
                    if (suppressWorkspaceClickRef.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      suppressWorkspaceClickRef.current = false;
                      return;
                    }
                    if (isActiveProject) {
                      toggleCollapse(project.workspace.id);
                    } else {
                      void onSelectProject(project.workspace.id);
                    }
                  }}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} style={{ flexShrink: 0, opacity: 0.4 }} />
                  ) : (
                    <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.4 }} />
                  )}
                  <FolderGit2
                    size={14}
                    style={{
                      flexShrink: 0,
                      color: isActiveProject ? "var(--accent)" : "var(--text-3)",
                    }}
                  />
                  <span className="sb-project-name">{projectName}</span>

                  <span className="sb-project-trailing">
                    {workspaceNotificationCount > 0 ? (
                      <span
                        className={`sb-project-notification-badge${workspacePendingApprovalCount > 0 ? " sb-project-notification-badge-pending-approval" : ""}`}
                        title={t(
                          workspacePendingApprovalCount > 0
                            ? "app:sidebar.pendingApprovalThreadNotifications"
                            : "app:sidebar.unreadThreadNotifications",
                          {
                            count: workspaceNotificationCount,
                          },
                        )}
                        aria-label={t(
                          workspacePendingApprovalCount > 0
                            ? "app:sidebar.pendingApprovalThreadNotifications"
                            : "app:sidebar.unreadThreadNotifications",
                          {
                            count: workspaceNotificationCount,
                          },
                        )}
                      >
                        {workspaceNotificationCount > 9 ? "9+" : workspaceNotificationCount}
                      </span>
                    ) : project.threads.length > 0 && (
                      <span className="sb-project-count">
                        {project.threads.length}
                      </span>
                    )}
                    <WorkspaceMoreMenu
                      workspace={project.workspace}
                      onOpenSettings={() => openWorkspaceSettings(project.workspace.id)}
                      onArchive={() => onDeleteWorkspace(project.workspace)}
                    />
                  </span>
                </button>

                {/* Threads — tree-line indented */}
                {!isCollapsed && (
                  <div
                    className={`sb-thread-tree${constrainExpandedThreads ? " sb-thread-tree-scrollable" : ""}`}
                  >
                    {project.threads.length === 0 ? (
                      <div className="sb-no-threads">{t("app:sidebar.noThreads")}</div>
                    ) : (
                      <>
                        {visibleThreads.map((thread, i) => {
                          const isActive = thread.id === activeThreadId;
                          const isRunning = isThreadRunning(thread);
                          const threadLabel = getThreadLabel(thread);
                          const threadNotification = threadNotificationsByThreadId[thread.id];
                          const hasNotification = Boolean(threadNotification);
                          const hasPendingApprovalNotification =
                            threadNotification?.status === "pending_approval";
                          const hasInterruptedNotification =
                            threadNotification?.status === "interrupted";
                          const hasPlanMode = threadPlanModes[thread.id] === "plan";
                          return (
                            <div
                              key={thread.id}
                              role="button"
                              tabIndex={0}
                              className={`sb-thread sb-thread-animate ${isActive ? "sb-thread-active" : ""}${hasNotification ? " sb-thread-notified" : ""}${hasPendingApprovalNotification ? " sb-thread-pending-approval" : ""}`}
                              style={{ animationDelay: `${i * 20}ms` }}
                              onClick={() => void onSelectThread(thread)}
                              onContextMenu={(event) => onThreadContextMenu(event, thread, isRunning)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  void onSelectThread(thread);
                                }
                              }}
                            >
                              <span className="sb-thread-title">
                                {isRunning && (
                                  <span
                                    className="sb-thread-running-indicator"
                                    aria-hidden="true"
                                  >
                                    <span />
                                    <span />
                                    <span />
                                  </span>
                                )}
                                {hasPlanMode && (
                                  <span
                                    className="sb-thread-plan-indicator"
                                    title={t("app:sidebar.planModeThread")}
                                    aria-label={t("app:sidebar.planModeThread")}
                                    role="img"
                                  >
                                    <ListChecks size={12} aria-hidden="true" />
                                  </span>
                                )}
                                {hasNotification && (
                                  <span
                                    className={`sb-thread-notification-dot${hasPendingApprovalNotification ? " sb-thread-notification-dot-pending-approval" : ""}${hasInterruptedNotification ? " sb-thread-notification-dot-interrupted" : ""}`}
                                    title={t(
                                      hasPendingApprovalNotification
                                        ? "app:sidebar.pendingApprovalThreadNotification"
                                        : hasInterruptedNotification
                                          ? "app:sidebar.interruptedThreadNotification"
                                        : "app:sidebar.unreadThreadNotification",
                                    )}
                                    aria-label={t(
                                      hasPendingApprovalNotification
                                        ? "app:sidebar.pendingApprovalThreadNotification"
                                        : hasInterruptedNotification
                                          ? "app:sidebar.interruptedThreadNotification"
                                        : "app:sidebar.unreadThreadNotification",
                                    )}
                                  />
                                )}
                                <span
                                  className="sb-thread-title-label"
                                  title={threadLabel}
                                >
                                  {threadLabel}
                                </span>
                              </span>
                              <span className="sb-thread-trailing">
                                <span className="sb-thread-time">
                                  {thread.lastActivityAt
                                    ? formatRelativeTime(thread.lastActivityAt, i18n.language)
                                    : ""}
                                </span>
                                <button
                                  type="button"
                                  title={t("app:sidebar.archiveThread")}
                                  aria-label={t("app:sidebar.archiveThread")}
                                  className="sb-thread-archive"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onContextMenu={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void onDeleteThread(thread);
                                  }}
                                >
                                  <Archive size={11} />
                                </button>
                              </span>
                            </div>
                          );
                        })}

                        {hasMore && !isShowingAll && (
                          <button
                            type="button"
                            className="sb-show-more"
                            onClick={() =>
                              setShowAll((prev) => ({
                                ...prev,
                                [project.workspace.id]: true,
                              }))
                            }
                          >
                            {t("app:sidebar.showMore", {
                              count: project.threads.length - MAX_VISIBLE_THREADS,
                            })}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {/* Archived section */}
        <div style={{ marginTop: 8, borderTop: "1px solid rgba(31, 35, 40, 0.06)", paddingTop: 4 }}>
          <button
            type="button"
            className="sb-archived-toggle"
            onClick={() => setArchivedOpen((c) => !c)}
          >
            {archivedOpen ? (
              <ChevronDown size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
            ) : (
              <ChevronRight size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
            )}
            <Archive size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
            <span style={{ flex: 1, textAlign: "left" }}>{t("app:sidebar.archived")}</span>
            <span className="sb-project-count" style={{ fontSize: 11 }}>
              {archivedWorkspaces.length + archivedThreads.length}
            </span>
          </button>

          {archivedOpen && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingBottom: 4 }}>
              {archivedWorkspaces.map((workspace) => (
                <div key={workspace.id} className="sb-archived-item">
                  <FolderGit2 size={12} style={{ flexShrink: 0, color: "var(--text-3)" }} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={workspace.name || workspace.rootPath}
                  >
                    {getWorkspaceLabel(workspace)}
                  </span>
                  <button
                    type="button"
                    className="sb-archived-restore"
                    onClick={() => void onRestoreWorkspace(workspace)}
                    title={t("app:sidebar.restoreWorkspace")}
                  >
                    <RotateCcw size={11} />
                  </button>
                </div>
              ))}

              {archivedThreads.map((thread) => (
                <div key={thread.id} className="sb-archived-item">
                  <MessageSquare size={12} style={{ flexShrink: 0, color: "var(--text-3)" }} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={getThreadLabel(thread)}
                  >
                    {getThreadLabel(thread)}
                  </span>
                  <button
                    type="button"
                    className="sb-archived-restore"
                    onClick={() => void onRestoreThread(thread)}
                    title={t("app:sidebar.restoreThread")}
                  >
                    <RotateCcw size={11} />
                  </button>
                </div>
              ))}

              {archivedWorkspaces.length === 0 && archivedThreads.length === 0 && (
                <div className="sb-no-threads">{t("app:sidebar.nothingArchived")}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="sb-footer">
        <button
          ref={settingsTriggerRef}
          type="button"
          className="sb-settings-btn"
          onClick={() => {
            if (settingsMenuOpen) {
              closeSettingsMenu();
              return;
            }
            const rect = settingsTriggerRef.current?.getBoundingClientRect();
            if (rect) {
              setSettingsMenuPos({ top: rect.top - 4, left: rect.left });
            }
            setSettingsMenuOpen(true);
          }}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            <Settings size={14} style={{ opacity: 0.5 }} />
            {hasUpdate && <span className="sb-update-dot" />}
          </span>
          {t("app:sidebar.settings")}
        </button>
        <button
          type="button"
          className="shell-pin-btn"
          onClick={onPin ?? toggleSidebarPin}
          title={sidebarPinned ? t("app:sidebar.unpin") : t("app:sidebar.pin")}
          aria-label={sidebarPinned ? t("app:sidebar.unpin") : t("app:sidebar.pin")}
        >
          {sidebarPinned ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
        </button>
      </div>

      {/* Settings portal menu */}
      {settingsMenuOpen &&
        createPortal(
          <div
            ref={settingsMenuRef}
            className="git-action-menu"
            style={{
              position: "fixed",
              bottom: window.innerHeight - settingsMenuPos.top,
              left: settingsMenuPos.left,
              minWidth: 260,
            }}
          >
            {/* ── Preferences ── */}
            <div
              style={{
                padding: "6px 12px 4px",
                fontSize: 10,
                color: "var(--text-3)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              {t("app:sidebar.preferences")}
            </div>
            <div
              className="git-action-menu-item"
              style={{
                justifyContent: "space-between",
                opacity: keepAwakeLoading || !keepAwakeAvailable ? 0.5 : 1,
              }}
            >
              <button
                type="button"
                title={keepAwakeDescription}
                onClick={() => openPowerSettings()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "inherit",
                  padding: 0,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <PillBottle size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                {t("app:sidebar.keepAwake")}
              </button>
              <label
                className="ws-toggle"
                title={keepAwakeDescription}
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: keepAwakeLoading || !keepAwakeAvailable ? "not-allowed" : undefined }}
              >
                <input
                  type="checkbox"
                  checked={keepAwakeState?.enabled ?? false}
                  disabled={keepAwakeLoading || !keepAwakeAvailable}
                  onChange={() => void toggleKeepAwake()}
                />
                <span className="ws-toggle-track" />
                <span className="ws-toggle-thumb" />
              </label>
            </div>
            <div
              className="git-action-menu-item"
              style={{
                justifyContent: "space-between",
                opacity:
                  terminalNotificationBusy
                    ? 0.75
                    : 1,
              }}
            >
              <button
                type="button"
                title={terminalNotificationDescription}
                onClick={() => openTerminalNotificationSettings()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "inherit",
                  padding: 0,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <BellRing size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                {t("app:sidebar.terminalNotifications")}
              </button>
              <label
                className="ws-toggle"
                title={terminalNotificationDescription}
                onClick={(e) => e.stopPropagation()}
                style={{
                  cursor:
                    terminalNotificationBusy
                      ? "wait"
                      : undefined,
                }}
              >
                <input
                  type="checkbox"
                  checked={terminalNotificationAnyEnabled}
                  disabled={terminalNotificationBusy}
                  onChange={() => { void toggleTerminalNotifications(); }}
                />
                <span className="ws-toggle-track" />
                <span className="ws-toggle-thumb" />
              </label>
            </div>
            <div className="git-action-menu-divider" />
            <div
              style={{
                padding: "6px 10px 4px",
                fontSize: 11,
                color: "var(--text-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {t("app:sidebar.terminal")}
            </div>
            <button
              type="button"
              className="git-action-menu-item"
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              onClick={() => {
                void onToggleTerminalAcceleratedRendering();
              }}
            >
              <span>{t("app:sidebar.terminalAcceleratedRendering")}</span>
              {terminalAcceleratedRendering ? <Check size={12} /> : null}
            </button>
            <div className="git-action-menu-divider" />

            {/* ── Actions ── */}
            <button
              type="button"
              className="git-action-menu-item"
              onClick={() => {
                closeSettingsMenu();
                openOnboarding();
              }}
            >
              <Rocket size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
              {t("app:sidebar.engineSetup")}
            </button>
            <button
              type="button"
              className="git-action-menu-item"
              style={{ justifyContent: "space-between" }}
              onClick={() => {
                closeSettingsMenu();
                setUpdateDialogOpen(true);
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <RefreshCw size={14} style={{ opacity: 0.5, flexShrink: 0 }} />
                {t("app:sidebar.checkUpdates")}
              </span>
              {hasUpdate && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    flexShrink: 0,
                  }}
                />
              )}
            </button>
          </div>,
          document.body,
        )}

      {threadContextMenu &&
        createPortal(
          <div
            ref={threadContextMenuRef}
            className="git-action-menu"
            role="menu"
            style={{
              position: "fixed",
              top: threadContextMenu.top,
              left: threadContextMenu.left,
              minWidth: 200,
            }}
          >
            <button
              type="button"
              className="git-action-menu-item"
              disabled={!threadContextMenuCanFork}
              onClick={() => void onForkThread(threadContextMenu.thread, threadContextMenuBusy)}
            >
              <GitBranch size={13} />
              {t("commandPalette.commands.codexFork")}
            </button>
          </div>,
          document.body,
        )}

      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />

      {createPortal(
        <ConfirmDialog
          open={archiveWorkspacePrompt !== null}
          title={t("app:sidebar.archiveWorkspaceTitle")}
          message={
            archiveWorkspacePrompt
              ? t("app:sidebar.archiveWorkspaceMessage", {
                  name: getWorkspaceLabel(archiveWorkspacePrompt.workspace),
                })
              : ""
          }
          confirmLabel={t("app:sidebar.archive")}
          onConfirm={() => {
            if (archiveWorkspacePrompt) void executeArchiveWorkspace(archiveWorkspacePrompt.workspace);
          }}
          onCancel={() => setArchiveWorkspacePrompt(null)}
        />,
        document.body,
      )}

      {createPortal(
        <ConfirmDialog
          open={archiveThreadPrompt !== null}
          title={t("app:sidebar.archiveThreadTitle")}
          message={
            archiveThreadPrompt
              ? t("app:sidebar.archiveThreadMessage", {
                  name: getThreadLabel(archiveThreadPrompt.thread),
                })
              : ""
          }
          confirmLabel={t("app:sidebar.archive")}
          onConfirm={() => {
            if (archiveThreadPrompt) void executeArchiveThread(archiveThreadPrompt.thread);
          }}
          onCancel={() => setArchiveThreadPrompt(null)}
        />,
        document.body,
      )}

      {error && (
        <div
          style={{
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--danger)",
            borderTop: "1px solid rgba(248, 113, 113, 0.15)",
            background: "rgba(248, 113, 113, 0.06)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   Collapsed rail — shown when unpinned
   ───────────────────────────────────────────────────── */

function CollapsedRail({
  onHoverStart,
  onHoverEnd,
  flyoutVisible,
}: {
  onHoverStart: () => void;
  onHoverEnd: () => void;
  flyoutVisible?: boolean;
}) {
  const { t } = useTranslation("app");
  const projects = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const hasUpdate = useUpdateStore((s) => s.status === "available" && !s.snoozed);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openCommandPalette = useUiStore((s) => s.openCommandPalette);
  const threadNotificationsByThreadId = useThreadNotificationStore((s) => s.notificationsByThreadId);

  async function onNewThread() {
    const activeProject = projects.find((p) => p.id === activeWorkspaceId);
    if (!activeProject) return;
    await createAndActivateWorkspaceThread(activeProject.id);
  }

  async function onSelectRailWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) {
      return;
    }
    await activateThreadContext(null);
    await setActiveWorkspace(workspaceId);
  }

  return (
    <div
      className="sb-rail"
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      style={{
        opacity: flyoutVisible ? 0 : 1,
        transition: "opacity 150ms var(--ease-out)",
      }}
    >
      {/* Drag region + logo — 74px to clear macOS traffic lights */}
      <div
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleDragDoubleClick}
        style={{
          height: 74,
          width: "100%",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: 4,
        }}
      >
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={() => void onNewThread()}
          disabled={!activeWorkspaceId}
          title={t("sidebar.newThread")}
          style={{
            opacity: activeWorkspaceId ? 1 : 0.45,
            border: "none",
            background: "transparent",
          }}
        >
          <svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg" width="20" height="20">
            <rect x="10" y="36" width="94" height="94" stroke="white" strokeWidth="6"/>
            <rect x="36" y="10" width="94" height="94" stroke="white" strokeWidth="6"/>
            <rect x="23" y="23" width="94" height="94" stroke="white" strokeWidth="6"/>
            <rect x="50" y="50" width="40" height="40" fill="#0969DA"/>
          </svg>
        </button>
      </div>

      <div className="sb-rail-divider" />

      {/* Nav icons — Commands, Search, Agents */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={() => openCommandPalette()}
          title={t("sidebar.commands", "Commands")}
          style={{ border: "none", background: "transparent" }}
        >
          <Command size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={() => openCommandPalette({ variant: "search", initialQuery: "?" })}
          title={t("sidebar.search")}
          style={{ border: "none", background: "transparent" }}
        >
          <Search size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className={`sb-rail-btn no-drag ${activeView === "harnesses" ? "sb-rail-btn-active" : ""}`}
          onClick={() => setActiveView(activeView === "harnesses" ? "chat" : "harnesses")}
          title={t("sidebar.agents")}
          style={{ border: "none", background: "transparent" }}
        >
          <Terminal size={16} strokeWidth={1.5} />
        </button>
      </div>

      <div className="sb-rail-divider" />

      {/* Project icons */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          paddingTop: 4,
          overflow: "auto",
        }}
      >
        {projects.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const name = ws.name || ws.rootPath.split("/").pop() || "P";
          const notificationCount = countWorkspaceThreadNotifications(
            threadNotificationsByThreadId,
            ws.id,
          );
          const pendingApprovalCount = countWorkspacePendingApprovalNotifications(
            threadNotificationsByThreadId,
            ws.id,
          );
          return (
            <button
              key={ws.id}
              type="button"
              className={`sb-rail-btn ${isActive ? "sb-rail-btn-active" : ""}`}
              title={ws.name || ws.rootPath}
              onClick={() => {
                if (activeView !== "chat") setActiveView("chat");
                void onSelectRailWorkspace(ws.id);
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                }}
              >
                {name.charAt(0).toUpperCase()}
              </span>
              {notificationCount > 0 && (
                <span
                  className={`sb-rail-notification-badge${pendingApprovalCount > 0 ? " sb-rail-notification-badge-pending-approval" : ""}`}
                  title={t(
                    pendingApprovalCount > 0
                      ? "sidebar.pendingApprovalThreadNotifications"
                      : "sidebar.unreadThreadNotifications",
                    {
                      count: notificationCount,
                    },
                  )}
                  aria-label={t(
                    pendingApprovalCount > 0
                      ? "sidebar.pendingApprovalThreadNotifications"
                      : "sidebar.unreadThreadNotifications",
                    {
                      count: notificationCount,
                    },
                  )}
                >
                  {notificationCount > 9 ? "9+" : notificationCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="sb-rail-divider" />

      {/* Settings at bottom */}
      <button
        type="button"
        className="sb-rail-btn"
        title={t("sidebar.settings")}
        style={{ marginBottom: 8 }}
      >
        <Settings size={15} />
        {hasUpdate && <span className="sb-update-dot" />}
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────
   Main Sidebar export
   ───────────────────────────────────────────────────── */

export function Sidebar() {
  const sidebarPinned = useUiStore((s) => s.sidebarPinned);
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const [hovered, setHovered] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flyoutRef = useRef<HTMLDivElement>(null);

  // When pinned, render the full sidebar content directly
  if (sidebarPinned) {
    return <SidebarContent />;
  }

  // When unpinned, render rail + hover flyout
  const handleHoverStart = () => {
    clearTimeout(hoverTimeout.current);
    setHovered(true);
  };

  const handleHoverEnd = () => {
    hoverTimeout.current = setTimeout(() => setHovered(false), 200);
  };

  const handleFlyoutEnter = () => {
    clearTimeout(hoverTimeout.current);
    setHovered(true);
  };

  const handleFlyoutLeave = () => {
    hoverTimeout.current = setTimeout(() => setHovered(false), 150);
  };

  return (
    <>
      <CollapsedRail onHoverStart={handleHoverStart} onHoverEnd={handleHoverEnd} flyoutVisible={hovered} />

      {/* Flyout overlay */}
      {createPortal(
        <div
          className="sb-flyout-wrapper"
          onMouseEnter={handleFlyoutEnter}
          onMouseLeave={handleFlyoutLeave}
          style={{ pointerEvents: hovered ? "auto" : "none" }}
        >
          <div
            ref={flyoutRef}
            className={`shell-flyout shell-flyout-left ${hovered ? "shell-flyout-visible" : ""}`}
          >
            <SidebarContent
              onPin={() => {
                setHovered(false);
                toggleSidebarPin();
              }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
