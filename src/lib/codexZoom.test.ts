// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: vi.fn(),
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

describe("Codex zoom shortcuts", () => {
  it("recognizes keyboard and numpad zoom shortcuts", async () => {
    const { resolveCodexZoomShortcut } = await import("./codexZoom");

    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "+", shiftKey: true }))).toBe("zoom-in");
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "=" }))).toBe("zoom-in");
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "-" }))).toBe("zoom-out");
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "0" }))).toBe("reset-zoom");
    expect(resolveCodexZoomShortcut(shortcutEvent({
      key: "Unidentified",
      code: "NumpadAdd",
    }))).toBe("zoom-in");
    expect(resolveCodexZoomShortcut(shortcutEvent({
      key: "Unidentified",
      code: "NumpadSubtract",
    }))).toBe("zoom-out");
  });

  it("supports Command and ignores unrelated or AltGr-like chords", async () => {
    const { resolveCodexZoomShortcut } = await import("./codexZoom");

    expect(resolveCodexZoomShortcut(shortcutEvent({
      key: "+",
      ctrlKey: false,
      metaKey: true,
      shiftKey: true,
    }))).toBe("zoom-in");
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "+", ctrlKey: false }))).toBeNull();
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "+", altKey: true }))).toBeNull();
    expect(resolveCodexZoomShortcut(shortcutEvent({ key: "p" }))).toBeNull();
  });
});
