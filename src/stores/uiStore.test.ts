import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_PALETTE_DEFAULT_LAUNCH } from "../lib/commandPalette";

type UiStoreModule = typeof import("./uiStore");

function createStorageStub(initial: Record<string, string> = {}) {
  const storage = new Map<string, string>(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    clear: vi.fn(() => {
      storage.clear();
    }),
  };
}

describe("uiStore focus mode", () => {
  let useUiStore: UiStoreModule["useUiStore"];

  async function loadStore(storageState?: Record<string, string>) {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageStub(storageState));
    ({ useUiStore } = await import("./uiStore"));
    const initialState = useUiStore.getState();
    useUiStore.setState({
      showSidebar: true,
      sidebarPinned: true,
      showGitPanel: initialState.showGitPanel,
      showExplorer: initialState.showExplorer,
      appZoomPercent: initialState.appZoomPercent,
      focusMode: initialState.focusMode,
      focusModeSnapshot: initialState.focusModeSnapshot,
      activeView: "chat",
      settingsWorkspaceId: null,
      commandPaletteOpen: false,
      commandPaletteLaunch: COMMAND_PALETTE_DEFAULT_LAUNCH,
      messageFocusTarget: null,
    });
  }

  beforeEach(async () => {
    await loadStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads persisted git panel visibility", async () => {
    await loadStore({ "panes:gitPanelVisible": "false" });

    expect(useUiStore.getState().showGitPanel).toBe(false);
  });

  it("captures the current shell state and hides the left sidebar on entry", () => {
    useUiStore.getState().setFocusMode(true);

    expect(useUiStore.getState()).toMatchObject({
      focusMode: true,
      showSidebar: false,
      showGitPanel: true,
      focusModeSnapshot: {
        showSidebar: true,
        showGitPanel: true,
      },
    });
  });

  it("keeps sidebar and git toggles working while focus mode is active", () => {
    const state = useUiStore.getState();

    state.setFocusMode(true);
    state.toggleSidebar();
    state.toggleGitPanel();

    expect(useUiStore.getState()).toMatchObject({
      focusMode: true,
      showSidebar: true,
      showGitPanel: false,
    });
  });

  it("restores the pre-focus shell state when leaving focus mode", () => {
    useUiStore.setState({
      showSidebar: true,
      showGitPanel: false,
      focusMode: false,
      focusModeSnapshot: null,
    });

    const state = useUiStore.getState();
    state.setFocusMode(true);
    state.toggleSidebar();
    state.toggleGitPanel();
    state.toggleFocusMode();

    expect(useUiStore.getState()).toMatchObject({
      focusMode: false,
      showSidebar: true,
      showGitPanel: false,
      focusModeSnapshot: null,
    });
  });

  it("persists the restored git panel visibility when leaving focus mode", () => {
    const storage = globalThis.localStorage as unknown as ReturnType<typeof createStorageStub>;

    useUiStore.setState({
      showSidebar: true,
      showGitPanel: false,
      focusMode: false,
      focusModeSnapshot: null,
    });

    const state = useUiStore.getState();
    state.setFocusMode(true);
    state.toggleGitPanel();
    state.setFocusMode(false);

    expect(storage.setItem).toHaveBeenCalledWith("panes:gitPanelVisible", "false");
    expect(useUiStore.getState().showGitPanel).toBe(false);
  });

  it("does not overwrite the original snapshot on repeated activation", () => {
    useUiStore.setState({
      showSidebar: false,
      showGitPanel: true,
      focusMode: false,
      focusModeSnapshot: null,
    });

    const state = useUiStore.getState();
    state.setFocusMode(true);
    state.toggleGitPanel();
    state.setFocusMode(true);
    state.setFocusMode(false);

    expect(useUiStore.getState()).toMatchObject({
      focusMode: false,
      showSidebar: false,
      showGitPanel: true,
      focusModeSnapshot: null,
    });
  });

  it("persists explicit git visibility changes", () => {
    const storage = globalThis.localStorage as unknown as ReturnType<typeof createStorageStub>;
    const state = useUiStore.getState();

    state.setGitPanelVisible(false);
    expect(storage.setItem).toHaveBeenCalledWith("panes:gitPanelVisible", "false");
    expect(useUiStore.getState().showGitPanel).toBe(false);

    state.toggleGitPanel();
    expect(storage.setItem).toHaveBeenCalledWith("panes:gitPanelVisible", "true");
    expect(useUiStore.getState().showGitPanel).toBe(true);
  });

  it("persists explicit explorer visibility changes", () => {
    const storage = globalThis.localStorage as unknown as ReturnType<typeof createStorageStub>;

    useUiStore.getState().setExplorerOpen(false);

    expect(storage.setItem).toHaveBeenCalledWith("panes:explorerOpen", "false");
    expect(useUiStore.getState().showExplorer).toBe(false);
  });

  it("increments and decrements app zoom in fixed steps", () => {
    const state = useUiStore.getState();

    state.increaseAppZoom();
    expect(useUiStore.getState().appZoomPercent).toBe(110);

    state.decreaseAppZoom();
    state.decreaseAppZoom();
    expect(useUiStore.getState().appZoomPercent).toBe(90);
  });

  it("persists app zoom changes and reset", () => {
    const storage = globalThis.localStorage as unknown as ReturnType<typeof createStorageStub>;
    const state = useUiStore.getState();

    state.setAppZoomPercent(999);
    expect(useUiStore.getState().appZoomPercent).toBe(200);
    expect(storage.setItem).toHaveBeenCalledWith("panes:appZoomPercent", "200");

    state.resetAppZoom();
    expect(useUiStore.getState().appZoomPercent).toBe(100);
    expect(storage.setItem).toHaveBeenCalledWith("panes:appZoomPercent", "100");
  });

  it("migrates the previous middle-pane zoom preference to whole-app zoom", async () => {
    await loadStore({ "panes:workspacePaneZoomPercent": "130" });
    const storage = globalThis.localStorage as unknown as ReturnType<typeof createStorageStub>;

    expect(useUiStore.getState().appZoomPercent).toBe(130);
    expect(storage.setItem).toHaveBeenCalledWith("panes:appZoomPercent", "130");
    expect(storage.removeItem).toHaveBeenCalledWith("panes:workspacePaneZoomPercent");
  });

  it("opens the command palette with structured launch defaults", () => {
    useUiStore.getState().openCommandPalette({
      variant: "search",
      initialQuery: "?",
      searchScope: "threads",
    });

    expect(useUiStore.getState()).toMatchObject({
      commandPaletteOpen: true,
      commandPaletteLaunch: {
        variant: "search",
        initialQuery: "?",
        searchScope: "threads",
      },
    });
  });

  it("resets command palette launch state when closing", () => {
    const state = useUiStore.getState();
    state.openCommandPalette({ variant: "search", initialQuery: "?", searchScope: "files" });
    state.closeCommandPalette();

    expect(useUiStore.getState()).toMatchObject({
      commandPaletteOpen: false,
      commandPaletteLaunch: COMMAND_PALETTE_DEFAULT_LAUNCH,
    });
  });
});
