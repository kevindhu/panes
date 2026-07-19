import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Bot,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquare,
  GitBranch,
  Archive,
  RotateCcw,
  Settings,
  PanelLeft,
  PanelLeftOpen,
  Search,
  Check,
  Rocket,
  RefreshCw,
  PillBottle,
  BellRing,
  ListFilter,
  ListChecks,
  Send,
} from "lucide-react";
import { useChatStore } from "../../stores/chatStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useUiStore, type WorkspaceSettingsSection } from "../../stores/uiStore";
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
import { isMacDesktop } from "../../lib/windowActions";
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
import "./Sidebar.css";

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

type SidebarView = "chat" | "harnesses" | "workspace-settings";

interface SidebarNavigationLocation {
  view: SidebarView;
  workspaceId: string | null;
  threadId: string | null;
  settingsWorkspaceId: string | null;
  settingsSection: WorkspaceSettingsSection;
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

function areSidebarLocationsEqual(
  left: SidebarNavigationLocation,
  right: SidebarNavigationLocation,
): boolean {
  return left.view === right.view
    && left.workspaceId === right.workspaceId
    && left.threadId === right.threadId
    && left.settingsWorkspaceId === right.settingsWorkspaceId
    && left.settingsSection === right.settingsSection;
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
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const activeView = useUiStore((state) => state.activeView);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const settingsWorkspaceId = useUiStore((state) => state.settingsWorkspaceId);
  const settingsWorkspaceSection = useUiStore((state) => state.settingsWorkspaceSection);
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
  const [navigationBackStack, setNavigationBackStack] = useState<SidebarNavigationLocation[]>([]);
  const [navigationForwardStack, setNavigationForwardStack] = useState<SidebarNavigationLocation[]>([]);
  const [navigationBusy, setNavigationBusy] = useState(false);
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

  function getCurrentNavigationLocation(): SidebarNavigationLocation {
    return {
      view: activeView,
      workspaceId: activeWorkspaceId,
      threadId: activeThreadId,
      settingsWorkspaceId,
      settingsSection: settingsWorkspaceSection,
    };
  }

  function rememberCurrentNavigationLocation() {
    const current = getCurrentNavigationLocation();
    setNavigationBackStack((previous) => {
      const last = previous.at(-1);
      if (last && areSidebarLocationsEqual(last, current)) {
        return previous;
      }
      return [...previous, current].slice(-40);
    });
    setNavigationForwardStack([]);
  }

  async function restoreNavigationLocation(location: SidebarNavigationLocation) {
    closeThreadContextMenu();
    closeSettingsMenu();

    const targetThread = location.threadId
      ? threads.find((thread) => thread.id === location.threadId)
      : null;
    const targetWorkspace = location.workspaceId
      ? workspaces.find((workspace) => workspace.id === location.workspaceId)
      : null;

    if (targetThread) {
      await activateThreadContext(targetThread);
    } else if (targetWorkspace) {
      await activateThreadContext(null);
      await setActiveWorkspace(targetWorkspace.id);
    }

    if (location.view === "workspace-settings") {
      const settingsTarget = workspaces.find(
        (workspace) => workspace.id === location.settingsWorkspaceId,
      ) ?? targetWorkspace;
      if (settingsTarget) {
        openWorkspaceSettings(settingsTarget.id, location.settingsSection);
        return;
      }
    }

    setActiveView(location.view === "workspace-settings" ? "chat" : location.view);
  }

  async function navigateHistory(direction: "back" | "forward") {
    if (navigationBusy) return;
    const target = direction === "back"
      ? navigationBackStack.at(-1)
      : navigationForwardStack[0];
    if (!target) return;

    const current = getCurrentNavigationLocation();
    if (direction === "back") {
      setNavigationBackStack((previous) => previous.slice(0, -1));
      setNavigationForwardStack((previous) => [current, ...previous].slice(0, 40));
    } else {
      setNavigationForwardStack((previous) => previous.slice(1));
      setNavigationBackStack((previous) => [...previous, current].slice(-40));
    }

    setNavigationBusy(true);
    try {
      await restoreNavigationLocation(target);
    } finally {
      setNavigationBusy(false);
    }
  }

  async function onOpenFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || Array.isArray(selected)) return;
    rememberCurrentNavigationLocation();
    await openWorkspace(selected, readLegacyDefaultScanDepth());
  }

  async function onSelectThread(thread: Thread) {
    closeThreadContextMenu();
    if (thread.id !== activeThreadId || activeView !== "chat") {
      rememberCurrentNavigationLocation();
    }
    if (activeView !== "chat") setActiveView("chat");
    await activateThreadContext(thread);
  }

  async function onSelectProject(wsId: string) {
    closeThreadContextMenu();
    if (wsId !== activeWorkspaceId || activeView !== "chat") {
      rememberCurrentNavigationLocation();
    }
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
    rememberCurrentNavigationLocation();
    setCollapsed((prev) => ({ ...prev, [project.id]: false }));
  }

  function navigateToWorkspaceSettings(
    workspaceId: string,
    section: WorkspaceSettingsSection = "general",
  ) {
    const alreadyOpen = activeView === "workspace-settings"
      && settingsWorkspaceId === workspaceId
      && settingsWorkspaceSection === section;
    if (!alreadyOpen) {
      rememberCurrentNavigationLocation();
    }
    openWorkspaceSettings(workspaceId, section);
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
    <div className={`sb${isMacDesktop() ? " sb-mac-titlebar" : ""}`}>
      <div
        className="sb-toolbar"
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleDragDoubleClick}
      >
        <button
          type="button"
          className="sb-toolbar-btn no-drag"
          onClick={onPin ?? toggleSidebar}
          title={onPin ? t("app:sidebar.pin") : t("app:sidebar.hide")}
          aria-label={onPin ? t("app:sidebar.pin") : t("app:sidebar.hide")}
        >
          <PanelLeft size={15} />
        </button>
        <div className="sb-toolbar-history no-drag">
          <button
            type="button"
            className="sb-toolbar-btn"
            disabled={navigationBusy || navigationBackStack.length === 0}
            onClick={() => void navigateHistory("back")}
            title={t("app:sidebar.back")}
            aria-label={t("app:sidebar.back")}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            type="button"
            className="sb-toolbar-btn"
            disabled={navigationBusy || navigationForwardStack.length === 0}
            onClick={() => void navigateHistory("forward")}
            title={t("app:sidebar.forward")}
            aria-label={t("app:sidebar.forward")}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>

      <nav className="sb-primary-nav" aria-label={t("app:sidebar.agents")}>
        <button
          type="button"
          className="sb-nav-item"
          disabled={!activeWorkspaceId}
          onClick={() => {
            const activeProject = projects.find(
              (project) => project.workspace.id === activeWorkspaceId,
            );
            if (activeProject) {
              void onCreateProjectThread(activeProject.workspace);
            }
          }}
        >
          <Send size={15} strokeWidth={1.55} aria-hidden="true" />
          <span>{t("app:sidebar.newThread")}</span>
        </button>
        <button
          type="button"
          className="sb-nav-item"
          onClick={() => openCommandPalette({ variant: "search", initialQuery: "?" })}
        >
          <Search size={15} strokeWidth={1.55} aria-hidden="true" />
          <span>{t("app:sidebar.search")}</span>
        </button>
        <button
          type="button"
          className={`sb-nav-item${activeView === "workspace-settings" && settingsWorkspaceSection === "startup" ? " sb-nav-item-active" : ""}`}
          disabled={!activeWorkspaceId}
          onClick={() => {
            if (!activeWorkspaceId) return;
            navigateToWorkspaceSettings(activeWorkspaceId, "startup");
          }}
        >
          <Bot size={15} strokeWidth={1.55} aria-hidden="true" />
          <span>{t("app:sidebar.automations")}</span>
        </button>
        <button
          type="button"
          className={`sb-nav-item${activeView === "harnesses" ? " sb-nav-item-active" : ""}`}
          onClick={() => {
            rememberCurrentNavigationLocation();
            setActiveView(activeView === "harnesses" ? "chat" : "harnesses");
          }}
        >
          <Blocks size={15} strokeWidth={1.55} aria-hidden="true" />
          <span>{t("app:sidebar.customize")}</span>
        </button>
      </nav>

      <div ref={workspaceScrollRef} className="sb-scroll">
        <div className="sb-section-label">
          <span>{t("app:sidebar.repositories")}</span>
          <span className="sb-section-actions">
            <button
              type="button"
              className={`sb-section-action${archivedOpen ? " sb-section-action-active" : ""}`}
              title={t(archivedOpen ? "app:sidebar.hideArchived" : "app:sidebar.showArchived")}
              aria-label={t(archivedOpen ? "app:sidebar.hideArchived" : "app:sidebar.showArchived")}
              aria-pressed={archivedOpen}
              onClick={() => setArchivedOpen((current) => !current)}
            >
              <ListFilter size={14} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="sb-section-action"
              title={t("app:sidebar.openWorkspace")}
              aria-label={t("app:sidebar.openWorkspace")}
              onClick={() => void onOpenFolder()}
            >
              <FolderPlus size={15} strokeWidth={1.5} />
            </button>
          </span>
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
                className={`sb-project-group${!isCollapsed ? " sb-project-group-expanded" : ""}${isDraggingProject ? " sb-project-group-dragging" : ""}`}
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
                    <Folder size={15} strokeWidth={1.55} aria-hidden="true" />
                  ) : (
                    <FolderOpen size={15} strokeWidth={1.55} aria-hidden="true" />
                  )}
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
                    ) : null}
                    <WorkspaceMoreMenu
                      workspace={project.workspace}
                      onOpenSettings={() => navigateToWorkspaceSettings(project.workspace.id)}
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
                        {visibleThreads.map((thread) => {
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
                              className={`sb-thread ${isActive ? "sb-thread-active" : ""}${hasNotification ? " sb-thread-notified" : ""}`}
                              aria-current={isActive ? "page" : undefined}
                              onClick={() => void onSelectThread(thread)}
                              onContextMenu={(event) => onThreadContextMenu(event, thread, isRunning)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  void onSelectThread(thread);
                                }
                              }}
                            >
                              <span className="sb-thread-status">
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
                              </span>
                              <span className="sb-thread-title">
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

        {archivedOpen && (
          <section className="sb-archive-panel">
            <div className="sb-archive-heading">
              <span>{t("app:sidebar.archived")}</span>
              <span>{archivedWorkspaces.length + archivedThreads.length}</span>
            </div>
            <div className="sb-archive-list">
              {archivedWorkspaces.map((workspace) => (
                <div key={workspace.id} className="sb-archived-item">
                  <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span className="sb-archived-label" title={workspace.name || workspace.rootPath}>
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
                  <MessageSquare size={15} strokeWidth={1.5} aria-hidden="true" />
                  <span className="sb-archived-label" title={getThreadLabel(thread)}>
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
          </section>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="sb-footer">
        <div className="sb-footer-identity">
          <span className="sb-footer-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <rect x="5.5" y="10.5" width="16" height="16" />
              <rect x="10.5" y="5.5" width="16" height="16" />
              <rect x="8" y="8" width="16" height="16" />
              <rect className="sb-footer-mark-core" x="13" y="13" width="6" height="6" />
            </svg>
          </span>
          <span className="sb-footer-copy">
            <span className="sb-footer-title">Panes</span>
            <span className="sb-footer-subtitle">{t("app:sidebar.localAgents")}</span>
          </span>
        </div>
        {hasUpdate && (
          <button
            type="button"
            className="sb-update-btn"
            onClick={() => setUpdateDialogOpen(true)}
          >
            {t("app:sidebar.update")}
          </button>
        )}
        <button
          ref={settingsTriggerRef}
          type="button"
          className="sb-settings-btn"
          title={t("app:sidebar.settings")}
          aria-label={t("app:sidebar.settings")}
          onClick={() => {
            if (settingsMenuOpen) {
              closeSettingsMenu();
              return;
            }
            const rect = settingsTriggerRef.current?.getBoundingClientRect();
            if (rect) {
              setSettingsMenuPos({
                top: rect.top - 4,
                left: Math.max(8, rect.right - 260),
              });
            }
            setSettingsMenuOpen(true);
          }}
        >
          <Settings size={14} strokeWidth={1.55} />
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
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const openWorkspaceSettings = useUiStore((s) => s.openWorkspaceSettings);
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
      className={`sb-rail${isMacDesktop() ? " sb-rail-mac-titlebar" : ""}`}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      style={{
        opacity: flyoutVisible ? 0 : 1,
        transition: "opacity 150ms var(--ease-out)",
      }}
    >
      <div
        className="sb-rail-toolbar"
        onMouseDown={handleDragMouseDown}
        onDoubleClick={handleDragDoubleClick}
      >
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={toggleSidebarPin}
          title={t("sidebar.pin")}
          aria-label={t("sidebar.pin")}
        >
          <PanelLeftOpen size={18} strokeWidth={1.55} />
        </button>
      </div>

      <div className="sb-rail-nav">
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={() => void onNewThread()}
          disabled={!activeWorkspaceId}
          title={t("sidebar.newThread")}
        >
          <Send size={18} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="sb-rail-btn no-drag"
          onClick={() => openCommandPalette({ variant: "search", initialQuery: "?" })}
          title={t("sidebar.search")}
        >
          <Search size={18} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className="sb-rail-btn no-drag"
          disabled={!activeWorkspaceId}
          onClick={() => {
            if (activeWorkspaceId) {
              openWorkspaceSettings(activeWorkspaceId, "startup");
            }
          }}
          title={t("sidebar.automations")}
        >
          <Bot size={18} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          className={`sb-rail-btn no-drag ${activeView === "harnesses" ? "sb-rail-btn-active" : ""}`}
          onClick={() => setActiveView(activeView === "harnesses" ? "chat" : "harnesses")}
          title={t("sidebar.customize")}
        >
          <Blocks size={18} strokeWidth={1.6} />
        </button>
      </div>

      <div className="sb-rail-projects">
        {projects.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
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
              {isActive ? (
                <FolderOpen size={18} strokeWidth={1.55} />
              ) : (
                <Folder size={18} strokeWidth={1.55} />
              )}
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

      <button
        type="button"
        className="sb-rail-btn"
        title={t("sidebar.pin")}
        onClick={toggleSidebarPin}
        style={{ marginBottom: 8 }}
      >
        <Settings size={18} strokeWidth={1.55} />
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
