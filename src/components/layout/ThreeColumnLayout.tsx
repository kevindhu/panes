import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightOpen } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Sidebar } from "../sidebar/Sidebar";
import { ActiveWorkspacePaneShell } from "../workspace/WorkspacePaneShell";
import { HarnessPanel } from "../onboarding/HarnessPanel";
import { WorkspaceSettingsPage } from "../workspace/WorkspaceSettingsPage";
import { GitPanel } from "../git/GitPanel";
import { usesCustomWindowFrame } from "../../lib/windowActions";
import { useUiStore } from "../../stores/uiStore";
import { handleDragDoubleClick, handleDragMouseDown } from "../../lib/windowDrag";

const SIDEBAR_WIDTH_KEY = "panes:sidebar-width";
const GIT_PANEL_SIZE_KEY = "panes:git-panel-size";
const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 380;
const DEFAULT_SIDEBAR = 220;
const COLLAPSED_SIDEBAR_WIDTH = 68;
const MIN_GIT_PANEL_SIZE = 18;
const MAX_GIT_PANEL_SIZE = 40;
const DEFAULT_GIT_PANEL_SIZE = 26;
const RESIZE_HANDLE_CLICK_THRESHOLD = 4;

function loadSidebarWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const value = Number.parseInt(stored, 10);
      if (value >= MIN_SIDEBAR && value <= MAX_SIDEBAR) return value;
    }
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
  return DEFAULT_SIDEBAR;
}

function loadGitPanelSize(): number {
  try {
    const stored = localStorage.getItem(GIT_PANEL_SIZE_KEY);
    if (stored) {
      const value = Number.parseFloat(stored);
      if (value >= MIN_GIT_PANEL_SIZE && value <= MAX_GIT_PANEL_SIZE) {
        return value;
      }
    }
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
  return DEFAULT_GIT_PANEL_SIZE;
}

export function ThreeColumnLayout() {
  const { t } = useTranslation("git");
  const showSidebar = useUiStore((state) => state.showSidebar);
  const sidebarPinned = useUiStore((state) => state.sidebarPinned);
  const toggleSidebarPin = useUiStore((state) => state.toggleSidebarPin);
  const showGitPanel = useUiStore((state) => state.showGitPanel);
  const setGitPanelVisible = useUiStore((state) => state.setGitPanelVisible);
  const focusMode = useUiStore((state) => state.focusMode);
  const activeView = useUiStore((state) => state.activeView);
  const customWindowFrame = usesCustomWindowFrame();

  const sidebarDocked = showSidebar && sidebarPinned;
  const fullBleedContent = focusMode || !showSidebar;
  const showFocusDragStrip = focusMode && !showSidebar && !showGitPanel && !customWindowFrame;

  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [gitPanelSize, setGitPanelSize] = useState(loadGitPanelSize);
  const sidebarHandleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures in non-browser/test environments.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    const chromeSidebarWidth = showSidebar
      ? sidebarPinned
        ? sidebarWidth
        : COLLAPSED_SIDEBAR_WIDTH
      : 0;
    document.documentElement.style.setProperty(
      "--sidebar-current-width",
      `${chromeSidebarWidth}px`,
    );

    return () => {
      document.documentElement.style.removeProperty("--sidebar-current-width");
    };
  }, [showSidebar, sidebarPinned, sidebarWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(GIT_PANEL_SIZE_KEY, String(gitPanelSize));
    } catch {
      // Ignore storage failures in non-browser/test environments.
    }
  }, [gitPanelSize]);

  const handleSidebarResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let isDragging = false;
    sidebarHandleRef.current?.classList.add("dragging");

    function onMove(nextEvent: MouseEvent) {
      const delta = nextEvent.clientX - startX;
      if (!isDragging && Math.abs(delta) < RESIZE_HANDLE_CLICK_THRESHOLD) {
        return;
      }
      isDragging = true;
      setSidebarWidth(Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, startWidth + delta)));
    }

    function onUp(nextEvent: MouseEvent) {
      sidebarHandleRef.current?.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!isDragging && Math.abs(nextEvent.clientX - startX) < RESIZE_HANDLE_CLICK_THRESHOLD) {
        toggleSidebarPin();
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth, toggleSidebarPin]);

  const mainContent = (
    activeView === "harnesses" ? (
      <HarnessPanel />
    ) : activeView === "workspace-settings" ? (
      <WorkspaceSettingsPage />
    ) : (
      <ActiveWorkspacePaneShell />
    )
  );

  return (
    <div className="layout-root">
      {showSidebar && !sidebarPinned && <Sidebar />}

      {sidebarDocked && (
        <div className="layout-sidebar" style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>
      )}

      {sidebarDocked && (
        <div
          ref={sidebarHandleRef}
          className="sidebar-resize-handle"
          onMouseDown={handleSidebarResizeMouseDown}
        />
      )}

      <div className={`content-card ${fullBleedContent ? "content-card-full" : ""}`}>
        {showFocusDragStrip && (
          <div
            className="focus-drag-strip"
            onMouseDown={handleDragMouseDown}
            onDoubleClick={handleDragDoubleClick}
          />
        )}

        {showGitPanel ? (
          <PanelGroup
            key="main-layout-docked"
            id="main-layout-panels"
            autoSaveId="panes:main-layout-panels"
            direction="horizontal"
            style={{ height: "100%", flex: 1 }}
          >
            <Panel
              id="main-layout-content"
              order={1}
              defaultSize={100 - gitPanelSize}
              minSize={35}
            >
              <div className="content-panel" style={{ height: "100%" }}>
                {mainContent}
              </div>
            </Panel>

            <PanelResizeHandle
              id="main-layout-git-resize-handle"
              className="resize-handle"
              aria-label={t("panel.resize")}
              title={t("panel.resize")}
            />

            <Panel
              id="main-layout-git-panel"
              order={2}
              defaultSize={gitPanelSize}
              minSize={MIN_GIT_PANEL_SIZE}
              maxSize={MAX_GIT_PANEL_SIZE}
              onResize={setGitPanelSize}
            >
              <div className="content-panel" style={{ height: "100%" }}>
                <GitPanel />
              </div>
            </Panel>
          </PanelGroup>
        ) : (
          <div className="content-panel content-panel-with-git-rail" style={{ height: "100%", flex: 1 }}>
            <div className="content-panel-main">
              {mainContent}
            </div>
            <div className="git-collapsed-rail">
              <button
                type="button"
                className="git-collapsed-rail-btn"
                title={t("panel.reopen")}
                aria-label={t("panel.reopen")}
                onClick={() => setGitPanelVisible(true)}
              >
                <PanelRightOpen size={14} />
                <span className="git-collapsed-rail-label">{t("panel.railLabel")}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
