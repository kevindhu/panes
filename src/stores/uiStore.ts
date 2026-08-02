import { create } from "zustand";
import {
  COMMAND_PALETTE_DEFAULT_LAUNCH,
  type CommandPaletteLaunchState,
} from "../lib/commandPalette";

const SIDEBAR_PINNED_KEY = "panes:sidebarPinned";
const GIT_PANEL_VISIBLE_KEY = "panes:gitPanelVisible";
const EXPLORER_OPEN_KEY = "panes:explorerOpen";
const APP_ZOOM_PERCENT_KEY = "panes:appZoomPercent";
const LEGACY_WORKSPACE_PANE_ZOOM_PERCENT_KEY = "panes:workspacePaneZoomPercent";
const DEFAULT_APP_ZOOM_PERCENT = 100;
const MIN_APP_ZOOM_PERCENT = 70;
const MAX_APP_ZOOM_PERCENT = 200;
const APP_ZOOM_STEP_PERCENT = 10;

interface MessageFocusTarget {
  threadId: string;
  messageId: string;
  requestedAt: number;
}

interface FocusModeSnapshot {
  showSidebar: boolean;
  showGitPanel: boolean;
}

type ActiveView = "chat" | "harnesses" | "workspace-settings";

function clampAppZoomPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_APP_ZOOM_PERCENT;
  }
  return Math.min(
    MAX_APP_ZOOM_PERCENT,
    Math.max(MIN_APP_ZOOM_PERCENT, Math.round(value)),
  );
}

function persistAppZoomPercent(value: number) {
  try {
    localStorage.setItem(APP_ZOOM_PERCENT_KEY, String(value));
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
}

function readSavedAppZoomPercent(): string | null {
  try {
    const saved = localStorage.getItem(APP_ZOOM_PERCENT_KEY);
    if (saved !== null) {
      return saved;
    }

    // Preserve the user's previous middle-pane zoom when upgrading it to
    // whole-app zoom, then retire the old storage key.
    const legacy = localStorage.getItem(LEGACY_WORKSPACE_PANE_ZOOM_PERCENT_KEY);
    if (legacy === null) {
      return null;
    }
    const migrated = clampAppZoomPercent(Number.parseInt(legacy, 10));
    localStorage.setItem(APP_ZOOM_PERCENT_KEY, String(migrated));
    localStorage.removeItem(LEGACY_WORKSPACE_PANE_ZOOM_PERCENT_KEY);
    return String(migrated);
  } catch {
    return null;
  }
}

function persistGitPanelVisible(value: boolean) {
  try {
    localStorage.setItem(GIT_PANEL_VISIBLE_KEY, String(value));
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
}

interface UiState {
  showSidebar: boolean;
  sidebarPinned: boolean;
  showGitPanel: boolean;
  showExplorer: boolean;
  appZoomPercent: number;
  focusMode: boolean;
  focusModeSnapshot: FocusModeSnapshot | null;
  activeView: ActiveView;
  settingsWorkspaceId: string | null;
  commandPaletteOpen: boolean;
  commandPaletteLaunch: CommandPaletteLaunchState;
  messageFocusTarget: MessageFocusTarget | null;
  openCommandPalette: (launch?: Partial<CommandPaletteLaunchState>) => void;
  closeCommandPalette: () => void;
  toggleSidebar: () => void;
  toggleSidebarPin: () => void;
  setSidebarPinned: (pinned: boolean) => void;
  toggleGitPanel: () => void;
  setGitPanelVisible: (visible: boolean) => void;
  toggleExplorer: () => void;
  setExplorerOpen: (open: boolean) => void;
  setAppZoomPercent: (percent: number) => void;
  increaseAppZoom: () => void;
  decreaseAppZoom: () => void;
  resetAppZoom: () => void;
  setFocusMode: (enabled: boolean) => void;
  toggleFocusMode: () => void;
  setActiveView: (view: ActiveView) => void;
  openWorkspaceSettings: (workspaceId: string) => void;
  setMessageFocusTarget: (target: { threadId: string; messageId: string }) => void;
  clearMessageFocusTarget: () => void;
}

const savedPinned = (() => {
  try {
    return localStorage.getItem(SIDEBAR_PINNED_KEY);
  } catch {
    return null;
  }
})();

const savedGitPanelVisible = (() => {
  try {
    return localStorage.getItem(GIT_PANEL_VISIBLE_KEY);
  } catch {
    return null;
  }
})();

const savedExplorerOpen = (() => {
  try {
    return localStorage.getItem(EXPLORER_OPEN_KEY);
  } catch {
    return null;
  }
})();

const savedAppZoomPercent = readSavedAppZoomPercent();

export const useUiStore = create<UiState>((set) => ({
  showSidebar: true,
  sidebarPinned: savedPinned !== null ? savedPinned === "true" : true,
  showGitPanel: savedGitPanelVisible !== null ? savedGitPanelVisible === "true" : true,
  showExplorer: savedExplorerOpen !== null ? savedExplorerOpen === "true" : true,
  appZoomPercent: clampAppZoomPercent(
    savedAppZoomPercent == null
      ? DEFAULT_APP_ZOOM_PERCENT
      : Number.parseInt(savedAppZoomPercent, 10),
  ),
  focusMode: false,
  focusModeSnapshot: null,
  commandPaletteOpen: false,
  commandPaletteLaunch: COMMAND_PALETTE_DEFAULT_LAUNCH,
  activeView: "chat",
  settingsWorkspaceId: null,
  messageFocusTarget: null,
  openCommandPalette: (launch) =>
    set({
      commandPaletteOpen: true,
      commandPaletteLaunch: {
        ...COMMAND_PALETTE_DEFAULT_LAUNCH,
        ...launch,
      },
    }),
  closeCommandPalette: () =>
    set({
      commandPaletteOpen: false,
      commandPaletteLaunch: COMMAND_PALETTE_DEFAULT_LAUNCH,
    }),
  toggleSidebar: () => set((state) => ({ showSidebar: !state.showSidebar })),
  toggleSidebarPin: () =>
    set((state) => {
      const next = !state.sidebarPinned;
      try {
        localStorage.setItem(SIDEBAR_PINNED_KEY, String(next));
      } catch {
        // Ignore storage failures in non-browser/test environments.
      }
      return { sidebarPinned: next, showSidebar: true };
    }),
  setSidebarPinned: (pinned) => {
    try {
      localStorage.setItem(SIDEBAR_PINNED_KEY, String(pinned));
    } catch {
      // Ignore storage failures in non-browser/test environments.
    }
    set({ sidebarPinned: pinned, showSidebar: true });
  },
  toggleGitPanel: () =>
    set((state) => {
      const next = !state.showGitPanel;
      persistGitPanelVisible(next);
      return { showGitPanel: next };
    }),
  setGitPanelVisible: (visible) => {
    persistGitPanelVisible(visible);
    set({ showGitPanel: visible });
  },
  toggleExplorer: () =>
    set((state) => {
      const next = !state.showExplorer;
      try {
        localStorage.setItem(EXPLORER_OPEN_KEY, String(next));
      } catch {
        // Ignore storage failures in non-browser/test environments.
      }
      return { showExplorer: next };
    }),
  setExplorerOpen: (open) => {
    try {
      localStorage.setItem(EXPLORER_OPEN_KEY, String(open));
    } catch {
      // Ignore storage failures in non-browser/test environments.
    }
    set({ showExplorer: open });
  },
  setAppZoomPercent: (percent) =>
    set((state) => {
      const next = clampAppZoomPercent(percent);
      if (next === state.appZoomPercent) {
        return state;
      }
      persistAppZoomPercent(next);
      return { appZoomPercent: next };
    }),
  increaseAppZoom: () =>
    set((state) => {
      const next = clampAppZoomPercent(
        state.appZoomPercent + APP_ZOOM_STEP_PERCENT,
      );
      if (next === state.appZoomPercent) {
        return state;
      }
      persistAppZoomPercent(next);
      return { appZoomPercent: next };
    }),
  decreaseAppZoom: () =>
    set((state) => {
      const next = clampAppZoomPercent(
        state.appZoomPercent - APP_ZOOM_STEP_PERCENT,
      );
      if (next === state.appZoomPercent) {
        return state;
      }
      persistAppZoomPercent(next);
      return { appZoomPercent: next };
    }),
  resetAppZoom: () =>
    set((state) => {
      if (state.appZoomPercent === DEFAULT_APP_ZOOM_PERCENT) {
        return state;
      }
      persistAppZoomPercent(DEFAULT_APP_ZOOM_PERCENT);
      return { appZoomPercent: DEFAULT_APP_ZOOM_PERCENT };
    }),
  setFocusMode: (enabled) =>
    set((state) => {
      if (enabled) {
        if (state.focusMode) {
          return state;
        }
        return {
          focusMode: true,
          focusModeSnapshot: {
            showSidebar: state.showSidebar,
            showGitPanel: state.showGitPanel,
          },
          showSidebar: false,
        };
      }

      if (!state.focusMode) {
        return state;
      }

      const snapshot = state.focusModeSnapshot;
      const restoredGitPanel = snapshot?.showGitPanel ?? state.showGitPanel;
      persistGitPanelVisible(restoredGitPanel);
      return {
        focusMode: false,
        focusModeSnapshot: null,
        showSidebar: snapshot?.showSidebar ?? state.showSidebar,
        showGitPanel: restoredGitPanel,
      };
    }),
  toggleFocusMode: () =>
    set((state) => {
      if (!state.focusMode) {
        return {
          focusMode: true,
          focusModeSnapshot: {
            showSidebar: state.showSidebar,
            showGitPanel: state.showGitPanel,
          },
          showSidebar: false,
        };
      }

      const snapshot = state.focusModeSnapshot;
      const restoredGitPanel = snapshot?.showGitPanel ?? state.showGitPanel;
      persistGitPanelVisible(restoredGitPanel);
      return {
        focusMode: false,
        focusModeSnapshot: null,
        showSidebar: snapshot?.showSidebar ?? state.showSidebar,
        showGitPanel: restoredGitPanel,
      };
    }),
  setActiveView: (view) => {
    set({ activeView: view });
    if (view === "harnesses") {
      // Lazy import to avoid circular dependency
      void import("./harnessStore").then(({ useHarnessStore }) => {
        void useHarnessStore.getState().scan();
      });
    }
  },
  openWorkspaceSettings: (workspaceId) => {
    set({ activeView: "workspace-settings", settingsWorkspaceId: workspaceId });
  },
  setMessageFocusTarget: (target) =>
    set({
      messageFocusTarget: {
        ...target,
        requestedAt: Date.now(),
      },
    }),
  clearMessageFocusTarget: () => set({ messageFocusTarget: null }),
}));
