import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useUiStore } from "../stores/uiStore";

export type AppZoomAction = "zoom-in" | "zoom-out" | "reset-zoom";

export interface AppZoomMetrics {
  factor: number;
  inverseFactor: number;
}

export interface AppZoomShortcutEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

let requestedZoomPercent: number | null = null;
let zoomFlushPromise: Promise<void> | null = null;
let lastAppliedZoomPercent: number | null = null;

export function getAppZoomMetrics(percent: number): AppZoomMetrics {
  const factor = Number.isFinite(percent) && percent > 0 ? percent / 100 : 1;
  return {
    factor,
    inverseFactor: 1 / factor,
  };
}

function syncZoomCompensationVariables(percent: number): void {
  if (typeof document === "undefined") {
    return;
  }

  const { factor, inverseFactor } = getAppZoomMetrics(percent);
  document.documentElement.style.setProperty("--app-zoom-factor", String(factor));
  document.documentElement.style.setProperty(
    "--app-zoom-inverse-factor",
    String(inverseFactor),
  );
}

export function resolveAppZoomShortcut(
  event: AppZoomShortcutEvent,
): AppZoomAction | null {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey) {
    return null;
  }

  if (event.key === "+" || event.key === "=") {
    return "zoom-in";
  }
  if (event.key === "-") {
    return "zoom-out";
  }
  if (event.key === "0") {
    return "reset-zoom";
  }

  // Physical-key fallbacks keep shortcuts working with keyboard layouts that
  // report an unidentified or layout-specific `key` value.
  if (event.code === "NumpadAdd" || event.code === "Equal") {
    return "zoom-in";
  }
  if (!event.shiftKey && (event.code === "NumpadSubtract" || event.code === "Minus")) {
    return "zoom-out";
  }
  if (!event.shiftKey && (event.code === "Numpad0" || event.code === "Digit0")) {
    return "reset-zoom";
  }

  return null;
}

export function isAppZoomAvailable(): boolean {
  return isTauri();
}

export function runAppZoomAction(action: AppZoomAction): void {
  const state = useUiStore.getState();
  switch (action) {
    case "zoom-in":
      state.increaseAppZoom();
      break;
    case "zoom-out":
      state.decreaseAppZoom();
      break;
    case "reset-zoom":
      state.resetAppZoom();
      break;
  }
}

function notifyZoomLayoutChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  const notify = () => window.dispatchEvent(new Event("resize"));
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(notify);
  } else {
    notify();
  }
}

async function flushRequestedZoom(): Promise<void> {
  let appliedZoom = false;
  while (requestedZoomPercent !== null) {
    const percent = requestedZoomPercent;
    requestedZoomPercent = null;
    if (percent === lastAppliedZoomPercent) {
      syncZoomCompensationVariables(percent);
      continue;
    }

    const { factor } = getAppZoomMetrics(percent);
    await getCurrentWebview().setZoom(factor);
    lastAppliedZoomPercent = percent;
    syncZoomCompensationVariables(percent);
    appliedZoom = true;
  }

  if (appliedZoom) {
    // Terminal fitting and other measured layouts listen for window resizes.
    // Webview zoom is not guaranteed to emit one consistently on every OS.
    notifyZoomLayoutChanged();
  }
}

export function applyAppZoomPercent(percent: number): Promise<void> {
  if (!isTauri()) {
    return Promise.resolve();
  }

  requestedZoomPercent = percent;
  if (zoomFlushPromise) {
    return zoomFlushPromise;
  }

  zoomFlushPromise = flushRequestedZoom().finally(() => {
    zoomFlushPromise = null;

    // A request can arrive while a failed native call is unwinding. Keep the
    // newest value rather than leaving the UI and persisted state out of sync.
    if (requestedZoomPercent !== null) {
      void applyAppZoomPercent(requestedZoomPercent).catch(reportAppZoomError);
    }
  });
  return zoomFlushPromise;
}

function reportAppZoomError(error: unknown): void {
  console.warn("[appZoom] Failed to apply webview zoom", error);
}

export async function startAppZoomSync(): Promise<() => void> {
  try {
    await applyAppZoomPercent(useUiStore.getState().appZoomPercent);
  } catch (error) {
    reportAppZoomError(error);
  }

  return useUiStore.subscribe((state, previousState) => {
    if (state.appZoomPercent === previousState.appZoomPercent) {
      return;
    }
    void applyAppZoomPercent(state.appZoomPercent).catch(reportAppZoomError);
  });
}
