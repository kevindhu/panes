import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LayoutModule = typeof import("./ThreeColumnLayout");
type UiStoreModule = typeof import("../../stores/uiStore");

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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("react-resizable-panels", () => ({
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PanelResizeHandle: (props: Record<string, unknown>) => <div {...props} />,
}));

vi.mock("../sidebar/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("../workspace/WorkspacePaneShell", () => ({
  ActiveWorkspacePaneShell: () => <div data-testid="workspace-shell" />,
}));

vi.mock("../onboarding/HarnessPanel", () => ({
  HarnessPanel: () => <div data-testid="harness-panel" />,
}));

vi.mock("../workspace/WorkspaceSettingsPage", () => ({
  WorkspaceSettingsPage: () => <div data-testid="workspace-settings" />,
}));

vi.mock("../git/GitPanel", () => ({
  GitPanel: () => <div data-testid="git-panel" />,
}));

vi.mock("../../lib/windowActions", () => ({
  usesCustomWindowFrame: () => false,
}));

describe("ThreeColumnLayout", () => {
  let ThreeColumnLayout: LayoutModule["ThreeColumnLayout"];
  let useUiStore: UiStoreModule["useUiStore"];

  async function loadModules(storageState?: Record<string, string>) {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageStub(storageState));
    ({ ThreeColumnLayout } = await import("./ThreeColumnLayout"));
    ({ useUiStore } = await import("../../stores/uiStore"));
    useUiStore.setState({
      showSidebar: true,
      sidebarPinned: true,
      showGitPanel: true,
      showExplorer: true,
      workspacePaneZoomPercent: 100,
      focusMode: false,
      focusModeSnapshot: null,
      activeView: "chat",
      settingsWorkspaceId: null,
      settingsWorkspaceSection: "general",
      commandPaletteOpen: false,
      commandPaletteLaunch: {
        variant: "general",
        initialQuery: "",
        searchScope: "all",
      },
      messageFocusTarget: null,
    });
  }

  beforeEach(async () => {
    await loadModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the docked git panel when visible", () => {
    const markup = renderToStaticMarkup(<ThreeColumnLayout />);

    expect(markup).toContain("data-testid=\"git-panel\"");
    expect(markup).not.toContain("git-collapsed-rail");
  });

  it("renders the collapsed right rail when the git panel is hidden", async () => {
    await loadModules({ "panes:gitPanelVisible": "false" });

    const markup = renderToStaticMarkup(<ThreeColumnLayout />);

    expect(markup).toContain("git-collapsed-rail");
    expect(markup).toContain("panel.reopen");
    expect(markup).not.toContain("data-testid=\"git-panel\"");
  });
});
