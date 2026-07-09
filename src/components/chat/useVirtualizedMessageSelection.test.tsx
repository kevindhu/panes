// @vitest-environment jsdom

import { act, useMemo, useRef, useState, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildVirtualizedMessageLayout,
  resolveVirtualMessageWindow,
  retainedMessageRangeForIndexes,
  type RetainedMessageRange,
} from "./messageVirtualization";
import {
  useVirtualizedMessageSelection,
  type VirtualizedMessageSelectionState,
} from "./useVirtualizedMessageSelection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const messages = Array.from({ length: 140 }, (_, index) => ({
  id: `message-${index}`,
}));
const heights = new Map(messages.map((message) => [message.id, 100]));
let latestSelectionStateRef: RefObject<VirtualizedMessageSelectionState> | null = null;
let harnessRenderCount = 0;

function SelectionHarness({
  virtualizationEnabled = true,
  threadId = "thread-1",
}: {
  virtualizationEnabled?: boolean;
  threadId?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderedRangeRef = useRef<RetainedMessageRange | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [windowVersion, setWindowVersion] = useState(0);
  const layout = useMemo(() => buildVirtualizedMessageLayout(messages, heights), []);
  if (!layout) {
    throw new Error("Expected a measured layout");
  }

  const selection = useVirtualizedMessageSelection({
    viewportRef,
    threadId,
    messages,
    renderedRangeRef,
    onSelectionCleared: () => setWindowVersion((version) => version + 1),
  });
  latestSelectionStateRef = selection;
  harnessRenderCount += 1;
  const virtualWindow = resolveVirtualMessageWindow({
    virtualizationEnabled,
    layout,
    messages,
    retainedRange: selection.current.retainedRange,
    viewportScrollTop: scrollTop,
    viewportHeight: 240,
    overscanPx: 0,
  });
  const renderedStartIndex = virtualWindow?.startIndex ?? 0;
  const visibleMessages = virtualWindow
    ? messages.slice(virtualWindow.startIndex, virtualWindow.endIndexExclusive)
    : messages;
  renderedRangeRef.current = retainedMessageRangeForIndexes(
    messages,
    renderedStartIndex,
    renderedStartIndex + visibleMessages.length,
  );

  return (
    <div>
      <output data-selection-phase={selection.current.phase} />
      <output data-window-version={windowVersion} />
      <output data-window-start={virtualWindow?.startIndex ?? 0} />
      <output data-window-end={virtualWindow?.endIndexExclusive ?? messages.length} />
      <div
        ref={viewportRef}
        data-testid="viewport"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div aria-hidden="true" style={{ height: virtualWindow?.topSpacerHeight ?? 0 }} />
        <div data-testid="message-window">
          {visibleMessages.map((message) => (
            <div key={message.id} data-message-id={message.id}>
              <span>{`Selectable text for ${message.id}`}</span>
              <button type="button">Action</button>
            </div>
          ))}
        </div>
        <div aria-hidden="true" style={{ height: virtualWindow?.bottomSpacerHeight ?? 0 }} />
      </div>
    </div>
  );
}

describe("useVirtualizedMessageSelection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextAnimationFrameId: number;
  let animationFrames: Map<number, FrameRequestCallback>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    nextAnimationFrameId = 0;
    animationFrames = new Map();
    latestSelectionStateRef = null;
    harnessRenderCount = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextAnimationFrameId += 1;
      animationFrames.set(nextAnimationFrameId, callback);
      return nextAnimationFrameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      animationFrames.delete(id);
    });

    await act(async () => {
      root.render(<SelectionHarness />);
    });
  });

  afterEach(async () => {
    window.getSelection()?.removeAllRanges();
    await act(async () => {
      root.unmount();
    });
    vi.restoreAllMocks();
    container.remove();
    document.body.innerHTML = "";
  });

  async function flushAnimationFrames() {
    const pendingFrames = [...animationFrames.values()];
    animationFrames.clear();
    await act(async () => {
      for (const callback of pendingFrames) {
        callback(performance.now());
      }
    });
  }

  async function pinSelectionInMessage(messageId: string) {
    const row = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    const textNode = row?.querySelector("span")?.firstChild;
    if (!row || !textNode) {
      throw new Error(`Missing selectable row ${messageId}`);
    }

    await act(async () => {
      row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 10);
    await act(async () => {
      const nativeSelection = window.getSelection();
      nativeSelection?.removeAllRanges();
      nativeSelection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    });
    await flushAnimationFrames();

    return { row, textNode };
  }

  it("keeps selected nodes mounted after mouse-up and while scrolling far away", async () => {
    const rendersBeforeSelection = harnessRenderCount;
    const selected = await pinSelectionInMessage("message-1");
    expect(latestSelectionStateRef?.current.phase).toBe("pinned");
    expect(harnessRenderCount).toBe(rendersBeforeSelection);
    expect(window.getSelection()?.toString()).toBe("Selectable");

    const viewport = container.querySelector<HTMLElement>("[data-testid='viewport']");
    expect(viewport).not.toBeNull();
    await act(async () => {
      viewport!.scrollTop = 6000;
      viewport!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    expect(container.querySelector("[data-window-start='0']")).not.toBeNull();
    expect(container.querySelector("[data-message-id='message-55']")).not.toBeNull();
    expect(container.querySelector("[data-message-id='message-1']")).toBe(selected.row);
    expect(selected.textNode.isConnected).toBe(true);
    expect(window.getSelection()?.toString()).toBe("Selectable");

    await act(async () => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(latestSelectionStateRef?.current.phase).toBe("idle");
    expect(Number(container.querySelector("[data-window-start]")?.getAttribute("data-window-start")))
      .toBeGreaterThan(40);
    expect(selected.row.isConnected).toBe(false);
  });

  it("preserves selected row identity when virtualization temporarily turns off", async () => {
    const selected = await pinSelectionInMessage("message-1");

    await act(async () => {
      root.render(<SelectionHarness virtualizationEnabled={false} />);
    });
    expect(container.querySelector("[data-message-id='message-1']")).toBe(selected.row);
    expect(window.getSelection()?.toString()).toBe("Selectable");

    await act(async () => {
      root.render(<SelectionHarness virtualizationEnabled />);
    });
    expect(container.querySelector("[data-message-id='message-1']")).toBe(selected.row);
    expect(window.getSelection()?.toString()).toBe("Selectable");
  });

  it("does not enter selection retention for interactive controls", async () => {
    const action = container.querySelector<HTMLButtonElement>(
      "[data-message-id='message-0'] button",
    );
    expect(action).not.toBeNull();

    await act(async () => {
      action?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    });
    await flushAnimationFrames();

    expect(latestSelectionStateRef?.current.phase).toBe("idle");
  });

  it("pins pointerless native selections and resets them when the thread changes", async () => {
    const row = container.querySelector<HTMLElement>("[data-message-id='message-1']");
    const textNode = row?.querySelector("span")?.firstChild;
    expect(textNode).not.toBeNull();

    const range = document.createRange();
    range.setStart(textNode!, 0);
    range.setEnd(textNode!, 10);
    await act(async () => {
      const nativeSelection = window.getSelection();
      nativeSelection?.removeAllRanges();
      nativeSelection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(latestSelectionStateRef?.current.phase).toBe("pinned");

    await act(async () => {
      root.render(<SelectionHarness threadId="thread-2" />);
    });
    expect(latestSelectionStateRef?.current.phase).toBe("idle");
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });
});
