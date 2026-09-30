// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCodexI18n } from "../../i18n/codex";
import { MessageTimestamp } from "./MessageTimestamp";

describe("MessageTimestamp", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => { await initializeCodexI18n(); });
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T18:00:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it.each([
    [30_000, "just now"],
    [2 * 60_000, "2 minutes ago"],
    [3 * 60 * 60_000, "3 hours ago"],
    [2 * 24 * 60 * 60_000, "2 days ago"],
    [21 * 24 * 60 * 60_000, "3 weeks ago"],
    [60 * 24 * 60 * 60_000, "2 months ago"],
    [730 * 24 * 60 * 60_000, "2 years ago"],
    [-60_000, "just now"],
  ])("shows the recorded message age (%s ms)", async (age, expected) => {
    await act(async () => root.render(<MessageTimestamp createdAt={new Date(Date.now() - age).toISOString()} />));
    expect(container.querySelector("time")?.textContent).toBe(expected);
  });

  it.each(["2026-08-26T18:00:00Z", "2026-08-26 18:00:00", "2026-08-26T11:00:00-07:00"])(
    "shows the same exact date for stored timestamp formats: %s", async (createdAt) => {
      await act(async () => root.render(<MessageTimestamp createdAt={createdAt} />));
      const button = container.querySelector("button")!;
      const date = new Date("2026-08-26T18:00:00Z");
      expect(button.textContent).toBe("3 weeks ago");
      expect(button.querySelector("time")?.dateTime).toBe(date.toISOString());
      expect(button.title).toBe(date.toLocaleString("en", {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
      }));
      await act(async () => button.click());
      expect(button.textContent).toBe(button.title);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      await act(async () => button.click());
      expect(button.textContent).toBe("3 weeks ago");
    },
  );

  it("refreshes while an idle conversation stays open", async () => {
    await act(async () => root.render(<MessageTimestamp createdAt={new Date().toISOString()} />));
    expect(container.textContent).toBe("just now");
    await act(async () => vi.advanceTimersByTime(2 * 60_000));
    expect(container.textContent).toBe("2 minutes ago");
  });

  it.each(["", "invalid"])("does not invent a date for an invalid timestamp (%s)", async (createdAt) => {
    await act(async () => root.render(<MessageTimestamp createdAt={createdAt} />));
    expect(container.querySelector("time")).toBeNull();
  });
});
