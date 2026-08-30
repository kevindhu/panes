import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, PanelLeft, Search, Square, X } from "lucide-react";
import { useCodexUiStore } from "../../stores/codexUiStore";

const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

export function CodexWindowFrame() {
  const toggleSidebar = useCodexUiStore((state) => state.toggleSidebar);
  const setSearchOpen = useCodexUiStore((state) => state.setSearchOpen);

  if (isMac) return null;

  const appWindow = getCurrentWindow();
  return (
    <header className="codex-window-frame" data-tauri-drag-region>
      <div className="codex-window-actions no-drag">
        <button type="button" onClick={toggleSidebar} title="Toggle sidebar (Ctrl+B)">
          <PanelLeft size={14} />
        </button>
        <button type="button" onClick={() => setSearchOpen(true)} title="Search (Ctrl+K)">
          <Search size={14} />
        </button>
      </div>
      <div className="codex-window-title" data-tauri-drag-region>Codex</div>
      <div className="codex-window-controls no-drag">
        <button type="button" onClick={() => void appWindow.minimize()} aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button type="button" onClick={() => void appWindow.toggleMaximize()} aria-label="Maximize">
          <Square size={11} />
        </button>
        <button className="close" type="button" onClick={() => void appWindow.close()} aria-label="Close">
          <X size={15} />
        </button>
      </div>
    </header>
  );
}
