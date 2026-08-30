import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  MoreVertical,
  Plus,
  RotateCcw,
  Search,
  Settings2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { canForkCodexMessageHistory } from "../../lib/codexThreadCapabilities";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
import { activateThreadContext } from "../../lib/threadActivation";
import { useCodexUiStore } from "../../stores/codexUiStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import {
  hasUnreadFinishedTurn,
  useThreadStore,
} from "../../stores/threadStore";
import { toast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Thread } from "../../types";

const EMPTY_THREADS: Thread[] = [];
const SIDEBAR_WIDTH_KEY = "panes:sidebar-width";
const COLLAPSED_WORKSPACES_KEY = "panes:sidebar-collapsed-workspace-ids";
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 380;
const DEFAULT_SIDEBAR_WIDTH = 250;
const SIDEBAR_KEYBOARD_STEP = 10;
const THREADS_PAGE_SIZE = 20;
const MENU_EDGE_GAP = 8;
const MENU_ANCHOR_GAP = 4;
const WORKSPACE_DRAG_THRESHOLD = 5;
const WORKSPACE_DRAG_OVERLAY_HEIGHT = 40;
const WORKSPACE_AUTOSCROLL_EDGE = 38;
const WORKSPACE_AUTOSCROLL_MAX_STEP = 14;

type SidebarView = "workspaces" | "archived";

interface SessionMenuState {
  thread: Thread;
  anchor: HTMLButtonElement;
}

interface WorkspacePointerDragSession {
  pointerId: number;
  workspaceId: string;
  startX: number;
  startY: number;
  previewOrder: string[];
  started: boolean;
}

interface WorkspaceDragOverlayState {
  workspaceId: string;
  name: string;
  left: number;
  top: number;
  width: number;
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const width = Number.parseInt(stored, 10);
      if (Number.isFinite(width)) return clampSidebarWidth(width);
    }
  } catch {
    // Keep the default when storage is unavailable.
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function loadCollapsedWorkspaceIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_WORKSPACES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function orderedThreads(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

function wholeThreadForkUnavailableReason(thread: Thread): string | null {
  if (thread.status === "streaming" || thread.status === "awaiting_approval") {
    return "Fork is available after the current turn finishes.";
  }
  if (!thread.engineThreadId) {
    return "Fork is available after this conversation has been initialized.";
  }
  if (!canForkCodexMessageHistory(thread)) {
    return "Fork is unavailable until the Codex transcript is ready.";
  }
  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  const message = String(error ?? "").trim();
  return message && message !== "undefined" ? message : fallback;
}

export function codexThreadStatusTone(
  status: Thread["status"],
  planMode: boolean,
): string {
  if (status === "error") return "error";
  if (planMode || status === "awaiting_approval") return "attention";
  return status;
}

function SessionRenameInput({
  value,
  busy,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (busy) return;
    committedRef.current = false;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [busy]);

  function requestCommit() {
    if (busy || cancelledRef.current || committedRef.current) return;
    committedRef.current = true;
    onCommit();
  }

  return (
    <input
      ref={inputRef}
      className="codex-session-rename-input"
      value={value}
      disabled={busy}
      aria-label="Rename conversation"
      onChange={(event) => {
        committedRef.current = false;
        onChange(event.target.value);
      }}
      onBlur={requestCommit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          requestCommit();
        } else if (event.key === "Escape" && !busy) {
          event.preventDefault();
          cancelledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}

function SessionActionsMenu({
  state,
  forkUnavailableReason,
  onRename,
  onFork,
  onArchive,
  onClose,
}: {
  state: SessionMenuState;
  forkUnavailableReason: string | null;
  onRename: () => void;
  onFork: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: -10_000,
    top: -10_000,
  });

  const placeMenu = useCallback(() => {
    const menu = menuRef.current;
    if (!menu || !state.anchor.isConnected) {
      onClose();
      return;
    }

    const anchorRect = state.anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const maxLeft = Math.max(
      MENU_EDGE_GAP,
      window.innerWidth - menuRect.width - MENU_EDGE_GAP,
    );
    const left = Math.min(
      maxLeft,
      Math.max(MENU_EDGE_GAP, anchorRect.right - menuRect.width),
    );
    const belowTop = anchorRect.bottom + MENU_ANCHOR_GAP;
    const top = belowTop + menuRect.height <= window.innerHeight - MENU_EDGE_GAP
      ? belowTop
      : Math.max(MENU_EDGE_GAP, anchorRect.top - menuRect.height - MENU_ANCHOR_GAP);
    setPosition({ left, top });
  }, [onClose, state.anchor]);

  useLayoutEffect(() => {
    placeMenu();
    const handleViewportChange = () => placeMenu();
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [placeMenu]);

  useEffect(() => {
    const menu = menuRef.current;
    menu?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();

    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || state.anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeFromOutside, true);
    return () => document.removeEventListener("pointerdown", closeFromOutside, true);
  }, [onClose, state.anchor]);

  function focusRelativeItem(direction: 1 | -1) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!items.length) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      state.anchor.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusRelativeItem(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        ) ?? [],
      );
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const shortcut = event.key.toLowerCase();
    const shortcutTarget = menuRef.current?.querySelector<HTMLButtonElement>(
      `button[data-shortcut="${shortcut}"]:not(:disabled)`,
    );
    if (shortcutTarget) {
      event.preventDefault();
      shortcutTarget.click();
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="codex-session-actions-menu"
      role="menu"
      aria-label={`Actions for ${state.thread.title || "Untitled"}`}
      style={position}
      onKeyDown={handleKeyDown}
    >
      <button type="button" role="menuitem" data-shortcut="r" onClick={onRename}>
        <span>Rename</span><kbd>R</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        data-shortcut="f"
        disabled={forkUnavailableReason !== null}
        title={forkUnavailableReason ?? "Fork conversation"}
        onClick={onFork}
      >
        <span>Fork</span><kbd>F</kbd>
      </button>
      <div className="codex-session-menu-separator" role="separator" />
      <button type="button" role="menuitem" data-shortcut="a" onClick={onArchive}>
        <span>Archive</span><kbd>A</kbd>
      </button>
    </div>,
    document.body,
  );
}

function SessionRow({
  thread,
  active,
  planMode,
  unreadFinishedTurn,
  menuOpen,
  editing,
  busy,
  actionsDisabled,
  renameValue,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onOpenMenu,
  registerRow,
}: {
  thread: Thread;
  active: boolean;
  planMode: boolean;
  unreadFinishedTurn: boolean;
  menuOpen: boolean;
  editing: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelect: () => void;
  onOpenMenu: (anchor: HTMLButtonElement) => void;
  registerRow: (element: HTMLDivElement | null) => void;
}) {
  const rowClassName = [
    "codex-session-row",
    active ? "active" : "",
    menuOpen ? "menu-open" : "",
    editing ? "editing" : "",
    busy ? "busy" : "",
  ].filter(Boolean).join(" ");
  const statusClassName = `codex-session-status ${codexThreadStatusTone(
    thread.status,
    planMode,
  )}${unreadFinishedTurn ? " notification" : ""}`;

  return (
    <div
      ref={registerRow}
      className={rowClassName}
      data-thread-id={thread.id}
    >
      {editing ? (
        <div className="codex-session-edit-main">
          <span
            className={statusClassName}
            title={unreadFinishedTurn ? "New finished turn" : undefined}
            aria-hidden="true"
          />
          <SessionRenameInput
            value={renameValue}
            busy={busy}
            onChange={onRenameValueChange}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        </div>
      ) : (
        <button
          className="codex-session-main"
          type="button"
          title={thread.title || "Untitled"}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
        >
          <span
            className={statusClassName}
            title={unreadFinishedTurn ? "New finished turn" : undefined}
            aria-hidden="true"
          />
          <span className="codex-session-title">{thread.title || "Untitled"}</span>
        </button>
      )}
      <button
        className="codex-session-menu-button"
        type="button"
        disabled={actionsDisabled || editing}
        aria-label={`Actions for ${thread.title || "Untitled"}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onOpenMenu(event.currentTarget)}
      >
        <MoreVertical size={14} />
      </button>
    </div>
  );
}

export function CodexSidebar() {
  const [sidebarView, setSidebarView] = useState<SidebarView>("workspaces");
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const [creatingWorkspaceId, setCreatingWorkspaceId] = useState<string | null>(null);
  const [openingWorkspace, setOpeningWorkspace] = useState(false);
  const [restoringThreadId, setRestoringThreadId] = useState<string | null>(null);
  const [archiveLoadError, setArchiveLoadError] = useState<string | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState(
    loadCollapsedWorkspaceIds,
  );
  const [draggingWorkspaceId, setDraggingWorkspaceId] = useState<string | null>(null);
  const [workspacePreviewOrder, setWorkspacePreviewOrder] = useState<string[] | null>(null);
  const [workspaceDragOverlay, setWorkspaceDragOverlay] = useState<WorkspaceDragOverlayState | null>(null);
  const [visibleThreadCountsByWorkspace, setVisibleThreadCountsByWorkspace] = useState<
    Record<string, number>
  >({});
  const [reorderingWorkspaces, setReorderingWorkspaces] = useState(false);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const workspaceDragCleanupRef = useRef<(() => void) | null>(null);
  const workspaceGroupRefs = useRef(new Map<string, HTMLElement>());
  const workspacePreviousRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const workspaceMoveAnimationsRef = useRef(new Map<string, Animation>());
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  const suppressedWorkspaceClickRef = useRef<{
    workspaceId: string;
    expiresAt: number;
  } | null>(null);
  const threadRowRefs = useRef(new Map<string, HTMLDivElement>());

  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const reorderWorkspaces = useWorkspaceStore((state) => state.reorderWorkspaces);
  const threadsByWorkspace = useThreadStore((state) => state.threadsByWorkspace);
  const finishedTurnNotifications = useThreadStore(
    (state) => state.finishedTurnNotifications,
  );
  const archivedThreadsByWorkspace = useThreadStore(
    (state) => state.archivedThreadsByWorkspace,
  );
  const activeThreadId = useThreadStore((state) => state.activeThreadId);
  const archivedLoading = useThreadStore((state) => state.archivedLoading);
  const threadModes = useThreadPlanModeStore((state) => state.threadModes);
  const removeThread = useThreadStore((state) => state.removeThread);
  const renameThread = useThreadStore((state) => state.renameThread);
  const forkCodexThread = useThreadStore((state) => state.forkCodexThread);
  const restoreThread = useThreadStore((state) => state.restoreThread);
  const refreshAllArchivedThreads = useThreadStore(
    (state) => state.refreshAllArchivedThreads,
  );
  const health = useEngineStore((state) => state.health.codex);
  const setSearchOpen = useCodexUiStore((state) => state.setSearchOpen);
  const setSetupOpen = useCodexUiStore((state) => state.setSetupOpen);

  const workspaceIds = useMemo(
    () => workspaces.map((workspace) => workspace.id),
    [workspaces],
  );
  const renderedWorkspaces = useMemo(() => {
    const order = workspacePreviewOrder ?? workspaceIds;
    return order.flatMap((workspaceId) => {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      return workspace ? [workspace] : [];
    });
  }, [workspaceIds, workspacePreviewOrder, workspaces]);
  const archivedWorkspaceGroups = useMemo(
    () => workspaces
      .map((workspace) => ({
        workspace,
        threads: archivedThreadsByWorkspace[workspace.id] ?? EMPTY_THREADS,
      }))
      .filter((group) => group.threads.length > 0),
    [archivedThreadsByWorkspace, workspaces],
  );
  const archivedThreadCount = useMemo(
    () => archivedWorkspaceGroups.reduce((total, group) => total + group.threads.length, 0),
    [archivedWorkspaceGroups],
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures; resizing should still work for this session.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_WORKSPACES_KEY,
        JSON.stringify([...collapsedWorkspaceIds]),
      );
    } catch {
      // Ignore storage failures; collapse state still works for this session.
    }
  }, [collapsedWorkspaceIds]);

  useEffect(() => () => {
    resizeCleanupRef.current?.();
    workspaceDragCleanupRef.current?.();
    for (const animation of workspaceMoveAnimationsRef.current.values()) {
      animation.cancel();
    }
    workspaceMoveAnimationsRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    const previousRects = workspacePreviousRectsRef.current;
    workspacePreviousRectsRef.current = null;
    if (!previousRects || !draggingWorkspaceId) return;

    for (const [workspaceId, previousRect] of previousRects) {
      if (workspaceId === draggingWorkspaceId) continue;
      const element = workspaceGroupRefs.current.get(workspaceId);
      if (!element || typeof element.animate !== "function") continue;

      workspaceMoveAnimationsRef.current.get(workspaceId)?.cancel();
      const currentRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - currentRect.left;
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;

      const animation = element.animate(
        [
          { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 150, easing: "cubic-bezier(.2, .8, .2, 1)" },
      );
      workspaceMoveAnimationsRef.current.set(workspaceId, animation);
      animation.onfinish = () => {
        if (workspaceMoveAnimationsRef.current.get(workspaceId) === animation) {
          workspaceMoveAnimationsRef.current.delete(workspaceId);
        }
      };
    }
  }, [draggingWorkspaceId, workspacePreviewOrder]);

  const expandWorkspace = useCallback((workspaceId: string) => {
    setCollapsedWorkspaceIds((current) => {
      if (!current.has(workspaceId)) return current;
      const next = new Set(current);
      next.delete(workspaceId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activeThreadId) return;
    const activeThread = useThreadStore
      .getState()
      .threads.find((thread) => thread.id === activeThreadId);
    if (!activeThread) return;

    expandWorkspace(activeThread.workspaceId);
    const workspaceThreads = orderedThreads(
      threadsByWorkspace[activeThread.workspaceId] ?? EMPTY_THREADS,
    );
    const activeIndex = workspaceThreads.findIndex((thread) => thread.id === activeThreadId);
    if (activeIndex < THREADS_PAGE_SIZE) return;

    setVisibleThreadCountsByWorkspace((current) => {
      const currentLimit = current[activeThread.workspaceId] ?? THREADS_PAGE_SIZE;
      if (activeIndex < currentLimit) return current;
      const requiredLimit = Math.min(
        workspaceThreads.length,
        Math.ceil((activeIndex + 1) / THREADS_PAGE_SIZE) * THREADS_PAGE_SIZE,
      );
      return { ...current, [activeThread.workspaceId]: requiredLimit };
    });
  }, [activeThreadId, expandWorkspace, threadsByWorkspace]);

  useEffect(() => {
    if (sidebarView !== "workspaces" || !activeThreadId) return;
    const frame = window.requestAnimationFrame(() => {
      const row = threadRowRefs.current.get(activeThreadId);
      if (typeof row?.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeThreadId, collapsedWorkspaceIds, sidebarView]);

  const beginResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const cleanup = () => {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setResizing(false);
      resizeCleanupRef.current = null;
    };

    const handleMove = (moveEvent: MouseEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    };

    const handleUp = () => cleanup();

    resizeCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [sidebarWidth]);

  const resizeWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setSidebarWidth((width) => clampSidebarWidth(width + direction * SIDEBAR_KEYBOARD_STEP));
  }, []);

  function toggleWorkspace(workspaceId: string) {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  async function chooseWorkspace() {
    if (openingWorkspace) return;
    setOpeningWorkspace(true);
    try {
      const path = await open({ directory: true, multiple: false, title: "Open a workspace" });
      if (typeof path !== "string") return;
      const workspace = await openWorkspace(path, 0);
      if (!workspace) {
        toast.error(useWorkspaceStore.getState().error ?? "Could not open the workspace.");
        return;
      }
      expandWorkspace(workspace.id);
      const threadId = await createAndActivateWorkspaceThread(workspace.id);
      if (!threadId) {
        toast.error(useThreadStore.getState().error ?? "Could not create a conversation.");
      } else {
        setSidebarView("workspaces");
      }
    } catch (error) {
      toast.error(`Could not open the workspace: ${errorMessage(error, "Unknown error")}`);
    } finally {
      setOpeningWorkspace(false);
    }
  }

  async function createWorkspaceThread(workspaceId: string) {
    if (creatingWorkspaceId) return;
    expandWorkspace(workspaceId);
    setCreatingWorkspaceId(workspaceId);
    try {
      const threadId = await createAndActivateWorkspaceThread(workspaceId);
      if (!threadId) {
        toast.error(useThreadStore.getState().error ?? "Could not create a conversation.");
      }
    } finally {
      setCreatingWorkspaceId(null);
    }
  }

  async function selectThread(thread: Thread) {
    expandWorkspace(thread.workspaceId);
    setSessionMenu(null);
    await activateThreadContext(thread);
  }

  function openSessionMenu(thread: Thread, anchor: HTMLButtonElement) {
    setEditingThreadId(null);
    setRenameValue("");
    setSessionMenu((current) => current?.thread.id === thread.id ? null : { thread, anchor });
  }

  function beginRename(thread: Thread) {
    setSessionMenu(null);
    setEditingThreadId(thread.id);
    setRenameValue(thread.title || "Untitled");
  }

  async function commitRename(thread: Thread) {
    if (busyThreadId) return;
    const title = renameValue.trim();
    if (!title || title === thread.title) {
      setEditingThreadId(null);
      setRenameValue("");
      return;
    }

    setBusyThreadId(thread.id);
    const updated = await renameThread(thread.id, title);
    setBusyThreadId(null);
    if (updated) {
      setEditingThreadId(null);
      setRenameValue("");
    } else {
      toast.error(useThreadStore.getState().error ?? "Could not rename the conversation.");
    }
  }

  async function forkThread(thread: Thread) {
    if (busyThreadId || wholeThreadForkUnavailableReason(thread)) return;
    setSessionMenu(null);
    setBusyThreadId(thread.id);
    const forked = await forkCodexThread(thread.id);
    setBusyThreadId(null);
    if (!forked) {
      toast.error(useThreadStore.getState().error ?? "Could not fork the conversation.");
      return;
    }

    expandWorkspace(forked.workspaceId);
    await activateThreadContext(forked);
    toast.success(`Forked “${thread.title || "Untitled"}”.`);
  }

  async function archiveThread(thread: Thread) {
    if (busyThreadId) return;
    setSessionMenu(null);
    setBusyThreadId(thread.id);
    const wasActive = activeThreadId === thread.id;
    const remainingThreads = orderedThreads(
      (threadsByWorkspace[thread.workspaceId] ?? EMPTY_THREADS)
        .filter((item) => item.id !== thread.id),
    );
    const archived = await removeThread(thread.id);
    setBusyThreadId(null);
    if (!archived) {
      toast.error(useThreadStore.getState().error ?? "Could not archive the conversation.");
      return;
    }

    if (wasActive) {
      const nextThread = remainingThreads[0] ?? null;
      if (nextThread) expandWorkspace(nextThread.workspaceId);
      await activateThreadContext(nextThread);
    }
    toast.success(`Archived “${thread.title || "Untitled"}”.`);
  }

  async function loadArchivedSessions() {
    setArchiveLoadError(null);
    await refreshAllArchivedThreads(workspaceIds);
    setArchiveLoadError(useThreadStore.getState().error ?? null);
  }

  async function showArchivedSessions() {
    setSessionMenu(null);
    setEditingThreadId(null);
    setSidebarView("archived");
    await loadArchivedSessions();
  }

  async function restoreArchivedThread(thread: Thread) {
    if (restoringThreadId) return;
    setRestoringThreadId(thread.id);
    const restored = await restoreThread(thread.id);
    setRestoringThreadId(null);
    if (!restored) {
      toast.error(useThreadStore.getState().error ?? "Could not restore the conversation.");
      return;
    }

    expandWorkspace(restored.workspaceId);
    setSidebarView("workspaces");
    await activateThreadContext(restored);
    toast.success(`Restored “${restored.title || "Untitled"}”.`);
  }

  async function persistWorkspaceOrder(nextWorkspaceIds: string[], announcement: string) {
    if (reorderingWorkspaces) return;
    setReorderingWorkspaces(true);
    try {
      await reorderWorkspaces(nextWorkspaceIds);
      setDragAnnouncement(announcement);
    } catch (error) {
      toast.error(`Could not reorder workspaces: ${errorMessage(error, "Unknown error")}`);
    } finally {
      setReorderingWorkspaces(false);
    }
  }

  function moveWorkspaceWithKeyboard(workspaceId: string, direction: -1 | 1) {
    const index = workspaceIds.indexOf(workspaceId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= workspaceIds.length) return;
    const next = [...workspaceIds];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(targetIndex, 0, moved);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    void persistWorkspaceOrder(
      next,
      `${workspace?.name ?? "Workspace"} moved to position ${targetIndex + 1}.`,
    );
  }

  function beginWorkspacePointerDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    workspaceId: string,
  ) {
    const pointerTarget = event.target instanceof Element ? event.target : null;
    if (
      reorderingWorkspaces
      || event.button !== 0
      || event.isPrimary === false
      || pointerTarget?.closest(".codex-workspace-add")
    ) {
      return;
    }

    workspaceDragCleanupRef.current?.();

    const header = event.currentTarget;
    const headerRect = header.getBoundingClientRect();
    const pointerOffsetX = headerRect.width > 0
      ? event.clientX - headerRect.left
      : Math.min(24, event.clientX);
    const pointerOffsetY = headerRect.height > 0
      ? event.clientY - headerRect.top
      : 15;
    const overlayWidth = headerRect.width > 0
      ? headerRect.width
      : Math.max(120, sidebarWidth - 14);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const session: WorkspacePointerDragSession = {
      pointerId: event.pointerId,
      workspaceId,
      startX: event.clientX,
      startY: event.clientY,
      previewOrder: [...workspaceIds],
      started: false,
    };
    let cleanedUp = false;

    const updatePreviewOrder = (clientY: number) => {
      const otherWorkspaceIds = session.previewOrder.filter(
        (candidateId) => candidateId !== session.workspaceId,
      );
      let insertionIndex = otherWorkspaceIds.length;

      for (let index = 0; index < otherWorkspaceIds.length; index += 1) {
        const candidateId = otherWorkspaceIds[index];
        if (!candidateId) continue;
        const candidate = workspaceGroupRefs.current.get(candidateId);
        if (!candidate) continue;
        const rect = candidate.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          insertionIndex = index;
          break;
        }
      }

      const nextOrder = [...otherWorkspaceIds];
      nextOrder.splice(insertionIndex, 0, session.workspaceId);
      if (nextOrder.every((candidateId, index) => (
        candidateId === session.previewOrder[index]
      ))) {
        return;
      }
      const previousRects = new Map<string, DOMRect>();
      for (const [candidateId, element] of workspaceGroupRefs.current) {
        previousRects.set(candidateId, element.getBoundingClientRect());
      }
      workspacePreviousRectsRef.current = previousRects;
      session.previewOrder = nextOrder;
      setWorkspacePreviewOrder(nextOrder);
    };

    const updateOverlayPosition = (clientX: number, clientY: number) => {
      const workspace = workspaces.find((item) => item.id === session.workspaceId);
      setWorkspaceDragOverlay({
        workspaceId: session.workspaceId,
        name: workspace?.name ?? "Workspace",
        left: clientX - pointerOffsetX,
        top: clientY - pointerOffsetY,
        width: overlayWidth,
      });
    };

    const autoScroll = (clientY: number) => {
      const scrollContainer = sidebarScrollRef.current;
      if (!scrollContainer) return;
      const rect = scrollContainer.getBoundingClientRect();
      let delta = 0;
      if (clientY < rect.top + WORKSPACE_AUTOSCROLL_EDGE) {
        const intensity = Math.min(
          1,
          (rect.top + WORKSPACE_AUTOSCROLL_EDGE - clientY) / WORKSPACE_AUTOSCROLL_EDGE,
        );
        delta = -Math.max(2, Math.ceil(WORKSPACE_AUTOSCROLL_MAX_STEP * intensity));
      } else if (clientY > rect.bottom - WORKSPACE_AUTOSCROLL_EDGE) {
        const intensity = Math.min(
          1,
          (clientY - (rect.bottom - WORKSPACE_AUTOSCROLL_EDGE)) / WORKSPACE_AUTOSCROLL_EDGE,
        );
        delta = Math.max(2, Math.ceil(WORKSPACE_AUTOSCROLL_MAX_STEP * intensity));
      }
      if (delta !== 0) scrollContainer.scrollTop += delta;
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      document.removeEventListener("pointermove", handleMove, true);
      document.removeEventListener("pointerup", handleUp, true);
      document.removeEventListener("pointercancel", handleCancel, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      if (typeof header.hasPointerCapture === "function"
        && typeof header.releasePointerCapture === "function"
        && header.hasPointerCapture(session.pointerId)) {
        header.releasePointerCapture(session.pointerId);
      }
      if (session.started) {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        setDraggingWorkspaceId(null);
        setWorkspacePreviewOrder(null);
        setWorkspaceDragOverlay(null);
      }
      workspaceDragCleanupRef.current = null;
    };

    const suppressNextClick = () => {
      suppressedWorkspaceClickRef.current = {
        workspaceId: session.workspaceId,
        expiresAt: Date.now() + 500,
      };
    };

    const finish = (commit: boolean) => {
      const didStart = session.started;
      const nextOrder = [...session.previewOrder];
      cleanup();
      if (!didStart) return;

      suppressNextClick();
      if (!commit || nextOrder.every((candidateId, index) => candidateId === workspaceIds[index])) {
        return;
      }
      const workspace = workspaces.find((item) => item.id === session.workspaceId);
      void persistWorkspaceOrder(
        nextOrder,
        `${workspace?.name ?? "Workspace"} moved to position ${nextOrder.indexOf(session.workspaceId) + 1}.`,
      );
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== session.pointerId) return;
      if (!session.started) {
        const distance = Math.hypot(
          moveEvent.clientX - session.startX,
          moveEvent.clientY - session.startY,
        );
        if (distance < WORKSPACE_DRAG_THRESHOLD) return;
        session.started = true;
        if (typeof header.setPointerCapture === "function") {
          try {
            header.setPointerCapture(session.pointerId);
          } catch {
            // The document listeners still keep the drag active if capture is unavailable.
          }
        }
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        flushSync(() => {
          setDraggingWorkspaceId(session.workspaceId);
          setWorkspacePreviewOrder(session.previewOrder);
          setDragAnnouncement("");
        });
      }
      moveEvent.preventDefault();
      updateOverlayPosition(moveEvent.clientX, moveEvent.clientY);
      autoScroll(moveEvent.clientY);
      updatePreviewOrder(
        moveEvent.clientY - pointerOffsetY + WORKSPACE_DRAG_OVERLAY_HEIGHT / 2,
      );
    };

    const handleUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId) return;
      if (session.started) upEvent.preventDefault();
      finish(true);
    };

    const handleCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== session.pointerId) return;
      finish(false);
    };

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !session.started) return;
      keyEvent.preventDefault();
      finish(false);
    };

    workspaceDragCleanupRef.current = cleanup;
    document.addEventListener("pointermove", handleMove, true);
    document.addEventListener("pointerup", handleUp, true);
    document.addEventListener("pointercancel", handleCancel, true);
    document.addEventListener("keydown", handleKeyDown, true);
  }

  return (
    <aside
      className="codex-sidebar"
      style={{ width: sidebarWidth, flexBasis: sidebarWidth }}
    >
      <div className="codex-sidebar-utilities">
        <button type="button" onClick={() => setSearchOpen(true)}>
          <Search size={15} /><span>Search</span>
        </button>
        <button type="button" disabled={openingWorkspace} onClick={() => void chooseWorkspace()}>
          {openingWorkspace
            ? <LoaderCircle size={15} className="codex-spin" />
            : <FolderOpen size={15} />}
          <span>Open workspace</span>
        </button>
      </div>

      <div className="codex-sidebar-scroll" ref={sidebarScrollRef}>
        {sidebarView === "workspaces" ? (
          <div
            className={`codex-workspace-list${draggingWorkspaceId ? " is-sorting" : ""}`}
            aria-label="Workspaces"
          >
            {!workspaces.length && (
              <div className="codex-sidebar-empty">Open a workspace to start.</div>
            )}
            {renderedWorkspaces.map((workspace) => {
              const threads = orderedThreads(
                threadsByWorkspace[workspace.id] ?? EMPTY_THREADS,
              );
              const visibleThreadCount = Math.min(
                threads.length,
                visibleThreadCountsByWorkspace[workspace.id] ?? THREADS_PAGE_SIZE,
              );
              const visibleThreads = threads.slice(0, visibleThreadCount);
              const hiddenThreadCount = threads.length - visibleThreadCount;
              const nextThreadBatchCount = Math.min(THREADS_PAGE_SIZE, hiddenThreadCount);
              const collapsed = collapsedWorkspaceIds.has(workspace.id);
              const dragPlaceholder = draggingWorkspaceId === workspace.id;
              const visuallyCollapsed = collapsed || dragPlaceholder;
              const unreadFinishedThreadCount = threads.reduce(
                (count, thread) => count + Number(hasUnreadFinishedTurn(
                  finishedTurnNotifications,
                  thread.id,
                )),
                0,
              );
              const workspaceClassName = [
                "codex-workspace-group",
                activeWorkspaceId === workspace.id ? "active-workspace" : "",
                dragPlaceholder ? "dragging drag-placeholder" : "",
              ].filter(Boolean).join(" ");
              const sessionListId = `workspace-sessions-${workspace.id}`;

              return (
                <section
                  key={workspace.id}
                  className={workspaceClassName}
                  ref={(element) => {
                    if (element) workspaceGroupRefs.current.set(workspace.id, element);
                    else workspaceGroupRefs.current.delete(workspace.id);
                  }}
                >
                  <div
                    className="codex-workspace-header"
                    onPointerDown={(event) => beginWorkspacePointerDrag(event, workspace.id)}
                  >
                    <button
                      className="codex-workspace-toggle"
                      type="button"
                      draggable={false}
                      aria-expanded={!visuallyCollapsed}
                      aria-controls={sessionListId}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      title={`${workspace.name} · Drag to reorder`}
                      onClick={(event) => {
                        const suppressedClick = suppressedWorkspaceClickRef.current;
                        if (
                          suppressedClick?.workspaceId === workspace.id
                          && suppressedClick.expiresAt >= Date.now()
                        ) {
                          event.preventDefault();
                          suppressedWorkspaceClickRef.current = null;
                          return;
                        }
                        suppressedWorkspaceClickRef.current = null;
                        toggleWorkspace(workspace.id);
                      }}
                      onKeyDown={(event) => {
                        if (!event.altKey) return;
                        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                          event.preventDefault();
                          moveWorkspaceWithKeyboard(
                            workspace.id,
                            event.key === "ArrowUp" ? -1 : 1,
                          );
                        }
                      }}
                    >
                      {visuallyCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <span>{workspace.name}</span>
                    </button>
                    {unreadFinishedThreadCount > 0 && (
                      <span
                        className="codex-workspace-notification"
                        title={`${unreadFinishedThreadCount} ${unreadFinishedThreadCount === 1 ? "conversation has" : "conversations have"} a finished turn not viewed`}
                        aria-hidden="true"
                      />
                    )}
                    <button
                      className="codex-workspace-add"
                      type="button"
                      draggable={false}
                      disabled={creatingWorkspaceId !== null}
                      title={`New conversation in ${workspace.name}`}
                      aria-label={`New conversation in ${workspace.name}`}
                      onClick={() => void createWorkspaceThread(workspace.id)}
                    >
                      {creatingWorkspaceId === workspace.id
                        ? <LoaderCircle size={14} className="codex-spin" />
                        : <Plus size={15} />}
                    </button>
                  </div>
                  <div
                    id={sessionListId}
                    className="codex-session-list"
                    hidden={visuallyCollapsed}
                  >
                    {visibleThreads.map((thread) => (
                      <SessionRow
                        key={thread.id}
                        thread={thread}
                        active={activeThreadId === thread.id}
                        planMode={threadModes[thread.id] === "plan"}
                        unreadFinishedTurn={hasUnreadFinishedTurn(
                          finishedTurnNotifications,
                          thread.id,
                        )}
                        menuOpen={sessionMenu?.thread.id === thread.id}
                        editing={editingThreadId === thread.id}
                        busy={busyThreadId === thread.id}
                        actionsDisabled={busyThreadId !== null}
                        renameValue={editingThreadId === thread.id ? renameValue : ""}
                        onRenameValueChange={setRenameValue}
                        onRenameCommit={() => void commitRename(thread)}
                        onRenameCancel={() => {
                          setEditingThreadId(null);
                          setRenameValue("");
                        }}
                        onSelect={() => void selectThread(thread)}
                        onOpenMenu={(anchor) => openSessionMenu(thread, anchor)}
                        registerRow={(element) => {
                          if (element) threadRowRefs.current.set(thread.id, element);
                          else threadRowRefs.current.delete(thread.id);
                        }}
                      />
                    ))}
                    {hiddenThreadCount > 0 && (
                      <button
                        className="codex-session-show-more"
                        type="button"
                        aria-label={`Show ${nextThreadBatchCount} more conversations in ${workspace.name}`}
                        onClick={() => {
                          setVisibleThreadCountsByWorkspace((current) => ({
                            ...current,
                            [workspace.id]: visibleThreadCount + nextThreadBatchCount,
                          }));
                        }}
                      >
                        Show {nextThreadBatchCount} more
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div className="codex-archive-drawer">
            <div className="codex-archive-drawer-header">
              <button type="button" onClick={() => setSidebarView("workspaces")}>
                <ChevronLeft size={15} /><span>Archived</span>
              </button>
              {archivedThreadCount > 0 && <span>{archivedThreadCount}</span>}
            </div>
            {archiveLoadError && (
              <div className="codex-archive-error" role="alert">
                <span>Some archived sessions could not be loaded.</span>
                <button type="button" onClick={() => void loadArchivedSessions()}>Retry</button>
              </div>
            )}
            {archivedLoading && archivedThreadCount === 0 && (
              <div className="codex-sidebar-loading">
                <LoaderCircle size={14} className="codex-spin" /> Loading archived sessions…
              </div>
            )}
            {!archivedLoading && archivedThreadCount === 0 && !archiveLoadError && (
              <div className="codex-sidebar-empty">No archived sessions.</div>
            )}
            <div className="codex-archived-workspace-list">
              {archivedWorkspaceGroups.map(({ workspace, threads }) => (
                <section className="codex-archived-workspace-group" key={workspace.id}>
                  <div className="codex-archived-workspace-name">{workspace.name}</div>
                  {threads.map((thread) => (
                    <div className="codex-archived-session-row" key={thread.id}>
                      <Archive size={12} aria-hidden="true" />
                      <span title={thread.title || "Untitled"}>{thread.title || "Untitled"}</span>
                      <button
                        type="button"
                        disabled={restoringThreadId !== null}
                        title={`Restore ${thread.title || "Untitled"}`}
                        aria-label={`Restore ${thread.title || "Untitled"}`}
                        onClick={() => void restoreArchivedThread(thread)}
                      >
                        {restoringThreadId === thread.id
                          ? <LoaderCircle size={13} className="codex-spin" />
                          : <RotateCcw size={13} />}
                      </button>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="codex-sidebar-footer">
        <button
          type="button"
          className={sidebarView === "archived" ? "active" : ""}
          onClick={() => void showArchivedSessions()}
        >
          <Archive size={14} /><span>Archived</span>
        </button>
        <button type="button" onClick={() => setSetupOpen(true)}>
          {health?.available
            ? <CheckCircle2 size={14} className="healthy" />
            : <Settings2 size={14} />}
          <span>Codex {health?.available ? health.version || "ready" : "setup"}</span>
        </button>
      </div>

      <div className="codex-sr-only" aria-live="polite">{dragAnnouncement}</div>

      {sessionMenu && (
        <SessionActionsMenu
          state={sessionMenu}
          forkUnavailableReason={wholeThreadForkUnavailableReason(sessionMenu.thread)}
          onRename={() => beginRename(sessionMenu.thread)}
          onFork={() => void forkThread(sessionMenu.thread)}
          onArchive={() => void archiveThread(sessionMenu.thread)}
          onClose={() => setSessionMenu(null)}
        />
      )}

      {workspaceDragOverlay && createPortal(
        <div
          className="codex-workspace-drag-overlay"
          aria-hidden="true"
          data-workspace-id={workspaceDragOverlay.workspaceId}
          style={{
            width: workspaceDragOverlay.width,
            transform: `translate3d(${workspaceDragOverlay.left}px, ${workspaceDragOverlay.top}px, 0)`,
          }}
        >
          <span>{workspaceDragOverlay.name}</span>
        </div>,
        document.body,
      )}

      <div
        className={`codex-sidebar-resize-handle${resizing ? " dragging" : ""}`}
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onMouseDown={beginResize}
        onKeyDown={resizeWithKeyboard}
      />
    </aside>
  );
}
