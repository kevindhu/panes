// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  VirtualMessageTranscript,
  virtualRangeWithPinnedInterval,
} from "./VirtualMessageTranscript";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function message(index: number): Message {
  return {
    id: `message-${index}`,
    threadId: "thread-1",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`,
    status: "completed",
    schemaVersion: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

describe("VirtualMessageTranscript", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps only a bounded tail mounted before the viewport can be measured", async () => {
    const viewport = document.createElement("div");
    const viewportRef = createRef<HTMLDivElement>();
    viewportRef.current = viewport;
    const messages = Array.from({ length: 100 }, (_, index) => message(index));

    await act(async () => {
      root.render(
        <VirtualMessageTranscript
          messages={messages}
          viewportRef={viewportRef}
          restorePosition={null}
          selectedMessageRange={null}
          layoutRevision="stable"
          renderMessage={(item) => <article data-message-id={item.id}>{item.content}</article>}
        />,
      );
    });

    const mounted = container.querySelectorAll("[data-message-id]");
    expect(mounted).toHaveLength(30);
    expect(mounted[0]?.getAttribute("data-message-id")).toBe("message-70");
    expect(mounted[29]?.getAttribute("data-message-id")).toBe("message-99");
  });

  it("mounts only a visible chunk and overscan once the viewport is measurable", async () => {
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 600 },
      offsetHeight: { configurable: true, value: 600 },
      offsetWidth: { configurable: true, value: 820 },
      scrollHeight: { configurable: true, value: 24_000 },
    });
    viewport.scrollTo = ({ top }: ScrollToOptions) => {
      if (typeof top === "number") viewport.scrollTop = top;
    };
    const viewportRef = createRef<HTMLDivElement>();
    viewportRef.current = viewport;
    const messages = Array.from({ length: 100 }, (_, index) => message(index));

    await act(async () => {
      root.render(
        <VirtualMessageTranscript
          messages={messages}
          viewportRef={viewportRef}
          restorePosition={null}
          selectedMessageRange={null}
          layoutRevision="stable"
          renderMessage={(item) => <article data-message-id={item.id}>{item.content}</article>}
        />,
      );
      await new Promise((resolve) => window.setTimeout(resolve, 30));
      viewport.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });

    const mounted = container.querySelectorAll("[data-message-id]");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(30);
  });

  it("adds the complete selected interval to the normal virtual range", () => {
    expect(virtualRangeWithPinnedInterval({
      startIndex: 40,
      endIndex: 44,
      overscan: 2,
      count: 100,
    }, [10, 12])).toEqual([
      10, 11, 12,
      38, 39, 40, 41, 42, 43, 44, 45, 46,
    ]);
  });
});
