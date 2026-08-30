// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextUsage } from "../../types";
import {
  CodexUsageLimits,
  contextWindowTotals,
  contextWindowUsedPercent,
  formatTokenCount,
  remainingToUsedPercent,
} from "./CodexUsageLimits";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const usage: ContextUsage = {
  currentTokens: 42_000,
  maxContextTokens: 200_000,
  contextPercent: 84,
  breakdown: {
    inputTokens: 34_000,
    cachedInputTokens: 12_000,
    cacheWriteInputTokens: 2_000,
    outputTokens: 8_000,
    reasoningOutputTokens: 3_000,
  },
  windowFiveHourPercent: 83,
  windowWeeklyPercent: 58,
  windowFiveHourResetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  windowWeeklyResetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
};

describe("CodexUsageLimits", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("converts the stored remaining budget into Codex usage consumed", () => {
    expect(remainingToUsedPercent(83)).toBe(17);
    expect(remainingToUsedPercent(0)).toBe(100);
    expect(remainingToUsedPercent(null)).toBeNull();
  });

  it("formats context-window usage from the native token counts", () => {
    expect(contextWindowUsedPercent(usage)).toBe(21);
    expect(contextWindowUsedPercent({
      ...usage,
      currentTokens: null,
      maxContextTokens: null,
    })).toBe(16);
    expect(formatTokenCount(42_000)).toBe("42k");
    expect(formatTokenCount(747_600)).toBe("747.6k");
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(contextWindowTotals(usage)).toEqual({
      usedTokens: 42_000,
      freeTokens: 158_000,
      usedPercent: 21,
      freePercent: 79,
    });
  });

  it("opens the plan-limit popover and refreshes the current thread", async () => {
    const onRefresh = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <CodexUsageLimits
          usage={usage}
          threadId="thread-1"
          planType="pro"
          onRefresh={onRefresh}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(".codex-usage-trigger");
    expect(trigger?.getAttribute("aria-label")).toBe("Show Codex usage limits");

    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const popover = document.body.querySelector(".codex-usage-popover");
    expect(popover?.textContent).toContain("Context window");
    expect(popover?.textContent).toContain("42k / 200k (21%)");
    expect(popover?.textContent).toContain("Plan usage limits · Pro");
    expect(popover?.textContent).toContain("5-hour limit");
    expect(popover?.textContent).toContain("17%");
    expect(popover?.textContent).toContain("Weekly limit");
    expect(popover?.textContent).toContain("42%");
    const contextProgress = popover?.querySelector<HTMLElement>(
      '[role="progressbar"][aria-label="Context window usage"]',
    );
    expect(contextProgress?.getAttribute("aria-valuenow")).toBe("21");
    expect(contextProgress?.querySelector<HTMLSpanElement>("span")?.style.width).toBe("21%");

    await act(async () => {
      popover?.querySelector<HTMLButtonElement>(".codex-context-window-toggle")?.click();
    });
    expect(popover?.textContent).toContain("Used context");
    expect(popover?.textContent).toContain("Free space");
    expect(popover?.textContent).toContain("42k");
    expect(popover?.textContent).toContain("158k");
    expect(popover?.textContent).toContain("21%");
    expect(popover?.textContent).toContain("79%");
    expect(popover?.textContent).not.toContain("Cached input");
    expect(popover?.textContent).not.toContain("Reasoning output");
    expect(onRefresh).toHaveBeenCalledWith("thread-1");
  });

  it("closes the popover with Escape", async () => {
    await act(async () => {
      root.render(
        <CodexUsageLimits
          usage={usage}
          threadId="thread-1"
          onRefresh={async () => undefined}
        />,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".codex-usage-trigger")?.click();
    });
    expect(document.body.querySelector(".codex-usage-popover")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector(".codex-usage-popover")).toBeNull();
  });
});
