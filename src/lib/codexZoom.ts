import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export type CodexZoomAction = "zoom-in" | "zoom-out" | "reset-zoom";

export interface CodexZoomShortcutEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const STORAGE_KEY = "panes:codexZoomPercent";
let currentPercent = 100;

export function resolveCodexZoomShortcut(
  event: CodexZoomShortcutEvent,
): CodexZoomAction | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) return null;

  if (event.key === "+" || event.key === "=") return "zoom-in";
  if (event.key === "-") return "zoom-out";
  if (event.key === "0") return "reset-zoom";

  if (event.code === "NumpadAdd" || event.code === "Equal") return "zoom-in";
  if (!event.shiftKey && (event.code === "NumpadSubtract" || event.code === "Minus")) {
    return "zoom-out";
  }
  if (!event.shiftKey && (event.code === "Numpad0" || event.code === "Digit0")) {
    return "reset-zoom";
  }

  return null;
}

export function isCodexZoomAvailable(): boolean {
  return isTauri();
}

function readZoom(): number {
  const parsed = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? "100", 10);
  return Number.isFinite(parsed) ? Math.min(180, Math.max(70, parsed)) : 100;
}

async function apply(percent: number): Promise<void> {
  currentPercent = percent;
  localStorage.setItem(STORAGE_KEY, String(percent));
  if (isTauri()) await getCurrentWebview().setZoom(percent / 100);
}

export async function initializeCodexZoom(): Promise<void> {
  await apply(readZoom());
}

export function runCodexZoomAction(action: CodexZoomAction): void {
  const next = action === "reset-zoom"
    ? 100
    : Math.min(180, Math.max(70, currentPercent + (action === "zoom-in" ? 10 : -10)));
  void apply(next).catch((error) => console.warn("Could not apply zoom", error));
}
