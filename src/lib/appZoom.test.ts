import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsTauri = vi.hoisted(() => vi.fn());
const mockSetZoom = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mockIsTauri,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: mockSetZoom,
  }),
}));

function shortcutEvent(overrides: Partial<{
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}> = {}) {
  return {
    key: "",
    code: "",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("app zoom", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(true);
    mockSetZoom.mockResolvedValue(undefined);
  });

  it("recognizes primary keyboard and numpad zoom shortcuts", async () => {
    const { resolveAppZoomShortcut } = await import("./appZoom");

    expect(resolveAppZoomShortcut(shortcutEvent({ key: "+", shiftKey: true }))).toBe("zoom-in");
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "=" }))).toBe("zoom-in");
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "-" }))).toBe("zoom-out");
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "0" }))).toBe("reset-zoom");
    expect(resolveAppZoomShortcut(shortcutEvent({
      key: "Unidentified",
      code: "NumpadAdd",
    }))).toBe("zoom-in");
    expect(resolveAppZoomShortcut(shortcutEvent({
      key: "Unidentified",
      code: "NumpadSubtract",
    }))).toBe("zoom-out");
    expect(resolveAppZoomShortcut(shortcutEvent({
      key: "Unidentified",
      code: "Numpad0",
    }))).toBe("reset-zoom");
  });

  it("supports Command on macOS and rejects unrelated or AltGr-like chords", async () => {
    const { resolveAppZoomShortcut } = await import("./appZoom");

    expect(resolveAppZoomShortcut(shortcutEvent({
      key: "+",
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    }))).toBe("zoom-in");
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "+", ctrlKey: false }))).toBeNull();
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "+", altKey: true }))).toBeNull();
    expect(resolveAppZoomShortcut(shortcutEvent({ key: "p" }))).toBeNull();
    expect(resolveAppZoomShortcut(shortcutEvent({
      key: ")",
      code: "Digit0",
      shiftKey: true,
    }))).toBeNull();
  });

  it("applies zoom to the native webview as a scale factor", async () => {
    const { applyAppZoomPercent } = await import("./appZoom");

    await applyAppZoomPercent(130);

    expect(mockSetZoom).toHaveBeenCalledWith(1.3);
  });

  it("coalesces rapid changes while preserving the newest zoom level", async () => {
    let releaseFirstCall!: () => void;
    mockSetZoom
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstCall = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    const { applyAppZoomPercent } = await import("./appZoom");

    const first = applyAppZoomPercent(110);
    const second = applyAppZoomPercent(120);
    expect(mockSetZoom).toHaveBeenCalledTimes(1);

    releaseFirstCall();
    await Promise.all([first, second]);

    expect(mockSetZoom.mock.calls).toEqual([[1.1], [1.2]]);
  });

  it("leaves normal browser zoom behavior untouched outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false);
    const { applyAppZoomPercent, isAppZoomAvailable } = await import("./appZoom");

    expect(isAppZoomAvailable()).toBe(false);
    await applyAppZoomPercent(120);
    expect(mockSetZoom).not.toHaveBeenCalled();
  });

  it("routes zoom actions through the persisted UI state", async () => {
    const { runAppZoomAction } = await import("./appZoom");
    const { useUiStore } = await import("../stores/uiStore");
    useUiStore.setState({ appZoomPercent: 100 });

    runAppZoomAction("zoom-in");
    expect(useUiStore.getState().appZoomPercent).toBe(110);

    runAppZoomAction("zoom-out");
    runAppZoomAction("reset-zoom");
    expect(useUiStore.getState().appZoomPercent).toBe(100);
  });
});
