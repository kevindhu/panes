import { open } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  CheckCircle2,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
import { activateThreadContext } from "../../lib/threadActivation";
import { useCodexUiStore } from "../../stores/codexUiStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Thread } from "../../types";

const EMPTY_THREADS: Thread[] = [];
const SIDEBAR_WIDTH_KEY = "panes:sidebar-width";
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 380;
const DEFAULT_SIDEBAR_WIDTH = 250;
const SIDEBAR_KEYBOARD_STEP = 10;

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

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function CodexSidebar() {
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const openWorkspace = useWorkspaceStore((state) => state.openWorkspace);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const threads = useThreadStore((state) =>
    activeWorkspaceId
      ? state.threadsByWorkspace[activeWorkspaceId] ?? EMPTY_THREADS
      : EMPTY_THREADS,
  );
  const activeThreadId = useThreadStore((state) => state.activeThreadId);
  const removeThread = useThreadStore((state) => state.removeThread);
  const renameThread = useThreadStore((state) => state.renameThread);
  const refreshThreads = useThreadStore((state) => state.refreshThreads);
  const health = useEngineStore((state) => state.health.codex);
  const setSearchOpen = useCodexUiStore((state) => state.setSearchOpen);
  const setSetupOpen = useCodexUiStore((state) => state.setSetupOpen);

  const orderedThreads = useMemo(
    () => [...threads].sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()),
    [threads],
  );

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures; resizing should still work for this session.
    }
  }, [sidebarWidth]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

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

  async function chooseWorkspace() {
    const path = await open({ directory: true, multiple: false, title: "Open a workspace" });
    if (typeof path === "string") {
      const workspace = await openWorkspace(path, 0);
      if (workspace) await createAndActivateWorkspaceThread(workspace.id);
    }
  }

  async function selectWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) return;
    await activateThreadContext(null);
    await setActiveWorkspace(workspaceId);
    await refreshThreads(workspaceId);
    const next = useThreadStore.getState().threadsByWorkspace[workspaceId]?.[0] ?? null;
    if (next) await activateThreadContext(next);
  }

  async function selectThread(thread: Thread) {
    await activateThreadContext(thread);
  }

  async function editTitle(thread: Thread) {
    const title = window.prompt("Rename conversation", thread.title)?.trim();
    if (title && title !== thread.title) await renameThread(thread.id, title);
    setMenuThreadId(null);
  }

  return (
    <aside
      className="codex-sidebar"
      style={{ width: sidebarWidth, flexBasis: sidebarWidth }}
    >
      <div className="codex-brand">
        <div className="codex-mark">C</div>
        <div><strong>Codex</strong><span>workspace client</span></div>
      </div>

      <div className="codex-primary-actions">
        <button className="primary" type="button" disabled={!activeWorkspaceId} onClick={() => void createAndActivateWorkspaceThread(activeWorkspaceId)}>
          <MessageSquarePlus size={15} /> New conversation
        </button>
        <button type="button" onClick={() => setSearchOpen(true)}><Search size={15} /> Search</button>
      </div>

      <div className="codex-workspace-picker">
        <label htmlFor="workspace-select">Workspace</label>
        <div>
          <select id="workspace-select" value={activeWorkspaceId ?? ""} onChange={(event) => void selectWorkspace(event.target.value)}>
            {!workspaces.length && <option value="">No workspace</option>}
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <button type="button" onClick={() => void chooseWorkspace()} title="Open workspace"><FolderOpen size={14} /></button>
        </div>
      </div>

      <div className="codex-thread-list">
        <div className="codex-section-label">Conversations</div>
        {!orderedThreads.length && <div className="codex-empty-small">Start a conversation in this workspace.</div>}
        {orderedThreads.map((thread) => (
          <div key={thread.id} className={`codex-thread ${thread.id === activeThreadId ? "active" : ""}`}>
            <button className="codex-thread-main" type="button" onClick={() => void selectThread(thread)}>
              <span className={`codex-thread-status ${thread.status}`} />
              <span className="codex-thread-copy"><strong>{thread.title || "Untitled"}</strong><small>{relativeTime(thread.lastActivityAt)}</small></span>
            </button>
            <button className="codex-thread-menu" type="button" onClick={() => setMenuThreadId((id) => id === thread.id ? null : thread.id)} aria-label="Conversation actions">
              <MoreHorizontal size={14} />
            </button>
            {menuThreadId === thread.id && (
              <div className="codex-popover">
                <button type="button" onClick={() => void editTitle(thread)}>Rename</button>
                <button type="button" onClick={() => { setMenuThreadId(null); void removeThread(thread.id); }}><Archive size={12} /> Archive</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="codex-sidebar-footer">
        <button type="button" onClick={() => setSetupOpen(true)}>
          {health?.available ? <CheckCircle2 size={14} className="healthy" /> : <Settings2 size={14} />}
          <span>Codex {health?.available ? health.version || "ready" : "setup"}</span>
        </button>
      </div>

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
