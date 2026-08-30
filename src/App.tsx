import { useEffect } from "react";
import { CodexChat } from "./components/codex/CodexChat";
import { CodexSearchOverlay } from "./components/codex/CodexOverlays";
import { CodexSidebar } from "./components/codex/CodexSidebar";
import { CodexWindowFrame } from "./components/codex/CodexWindowFrame";
import { ToastContainer } from "./components/shared/ToastContainer";
import {
  acceptTurnFinishedRuntimeEvent,
  useChatStore,
} from "./stores/chatStore";
import { useCodexUiStore } from "./stores/codexUiStore";
import { useEngineStore } from "./stores/engineStore";
import { useThreadStore } from "./stores/threadStore";
import { toast } from "./stores/toastStore";
import { useUpdateStore } from "./stores/updateStore";
import { useWorkspaceStore } from "./stores/workspaceStore";
import {
  ipc,
  listenChatTurnFinished,
  listenCodexCompatibilityForkMaterialized,
  listenCodexHistoryMutationFailed,
  listenEngineRuntimeUpdated,
  listenMenuAction,
  listenThreadUpdated,
} from "./lib/codexIpc";
import { createAndActivateWorkspaceThread } from "./lib/newThreadActions";
import { activateThreadContext } from "./lib/threadActivation";
import {
  isCodexZoomAvailable,
  resolveCodexZoomShortcut,
  runCodexZoomAction,
  type CodexZoomAction,
} from "./lib/codexZoom";
import { getCurrentWindow } from "@tauri-apps/api/window";

const zoomShortcutLastFired = new Map<CodexZoomAction, number>();
const ZOOM_SHORTCUT_DEBOUNCE_MS = 100;

function fireZoomShortcut(action: CodexZoomAction) {
  const now = Date.now();
  const lastFired = zoomShortcutLastFired.get(action) ?? 0;
  if (now - lastFired < ZOOM_SHORTCUT_DEBOUNCE_MS) return;
  zoomShortcutLastFired.set(action, now);
  runCodexZoomAction(action);
}

async function initializeCodexWorkspace() {
  await Promise.all([
    useWorkspaceStore.getState().loadWorkspaces(),
    useEngineStore.getState().load(),
  ]);
  const workspaceState = useWorkspaceStore.getState();
  const workspaceId = workspaceState.activeWorkspaceId;
  const workspaceIds = workspaceState.workspaces.map((workspace) => workspace.id);
  await useThreadStore.getState().refreshAllThreads(workspaceIds);
  const state = useThreadStore.getState();
  const selected = state.threads.find((thread) => thread.id === state.activeThreadId)
    ?? (workspaceId ? state.threadsByWorkspace[workspaceId]?.[0] : null)
    ?? null;
  await activateThreadContext(selected);
  if (workspaceIds.length) {
    void useEngineStore.getState().ensureHealth("codex");
  }
}

function handleShortcut(action: string) {
  switch (action) {
    case "toggle-sidebar":
      useCodexUiStore.getState().toggleSidebar();
      break;
    case "toggle-search":
      useCodexUiStore.getState().setSearchOpen(true);
      break;
    case "toggle-fullscreen":
      void getCurrentWindow().isFullscreen().then((fullscreen) => getCurrentWindow().setFullscreen(!fullscreen));
      break;
    case "zoom-in":
    case "zoom-out":
    case "reset-zoom":
      fireZoomShortcut(action);
      break;
    default:
      break;
  }
}

export function App() {
  const sidebarOpen = useCodexUiStore((state) => state.sidebarOpen);

  useEffect(() => {
    void initializeCodexWorkspace();
    const updateTimer = window.setTimeout(() => {
      void useUpdateStore.getState().checkForUpdate();
    }, 8_000);

    const unlisteners: Array<() => void> = [];
    void listenThreadUpdated((event) => {
      if (event.thread?.engineId !== "codex") return;
      const applied = useThreadStore.getState().applyThreadUpdateLocal(event.thread);
      const workspaceExists = useWorkspaceStore
        .getState()
        .workspaces.some((workspace) => workspace.id === event.workspaceId);
      if (!applied && workspaceExists) {
        void useThreadStore.getState().refreshThreads(event.workspaceId);
      }
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenChatTurnFinished((event) => {
      if (event.engineId !== "codex") return;
      const isNewFinish = useThreadStore.getState().recordFinishedTurn(
        event.threadId,
        event.assistantMessageId,
      );
      acceptTurnFinishedRuntimeEvent(event);
      useThreadStore.getState().setThreadStatusLocal(
        event.threadId,
        event.status === "error" ? "error" : "completed",
      );
      if (
        isNewFinish
        && (!document.hasFocus() || useThreadStore.getState().activeThreadId !== event.threadId)
      ) {
        void ipc.showAgentNotification("Codex", event.preview?.trim() || (event.status === "error" ? "The turn failed." : "The turn finished."));
      }
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenCodexCompatibilityForkMaterialized(() => {
      toast.info("Compatibility fork created for older Codex history.");
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenCodexHistoryMutationFailed((event) => {
      const label = event.operation === "fork" ? "fork" : "rollback";
      toast.error(`Codex ${label} preparation failed: ${event.message}`);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenEngineRuntimeUpdated((event) => {
      if (event.engineId === "codex") useEngineStore.getState().applyRuntimeUpdate(event);
    }).then((unlisten) => unlisteners.push(unlisten));
    void listenMenuAction(handleShortcut).then((unlisten) => unlisteners.push(unlisten));

    const onZoomKeyDown = (event: KeyboardEvent) => {
      if (!isCodexZoomAvailable()) return;
      const action = resolveCodexZoomShortcut(event);
      if (!action) return;

      event.preventDefault();
      event.stopPropagation();
      fireZoomShortcut(action);
    };
    window.addEventListener("keydown", onZoomKeyDown, true);

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "b") {
        event.preventDefault();
        useCodexUiStore.getState().toggleSidebar();
      } else if (mod && (event.key.toLowerCase() === "k" || (event.shiftKey && event.key.toLowerCase() === "f"))) {
        event.preventDefault();
        useCodexUiStore.getState().setSearchOpen(true);
      } else if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void createAndActivateWorkspaceThread(useWorkspaceStore.getState().activeWorkspaceId);
      } else if (mod && event.key === ".") {
        event.preventDefault();
        void useChatStore.getState().cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.clearTimeout(updateTimer);
      window.removeEventListener("keydown", onZoomKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className="codex-app">
      <CodexWindowFrame />
      <div className="codex-shell">
        {sidebarOpen && <CodexSidebar />}
        <CodexChat />
      </div>
      <CodexSearchOverlay />
      <ToastContainer />
    </div>
  );
}
