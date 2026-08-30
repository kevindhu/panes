// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED,
  VirtualMessageTranscript,
  virtualRangeWithPinnedInterval,
} from "./VirtualMessageTranscript";
import {
  cacheMeasuredMessageHeight,
  cachedOrEstimatedMessageHeight,
  estimateMessageHeight,
} from "./virtualMessageSizing";

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
          virtualizationEnabled
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
          virtualizationEnabled
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

  it("renders the complete transcript while the production virtualization switch is off", async () => {
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

    expect(CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED).toBe(false);
    expect(container.querySelectorAll("[data-message-id]")).toHaveLength(100);
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

  it("estimates short user rows near their compact rendered height", () => {
    expect(estimateMessageHeight(message(0))).toBeGreaterThanOrEqual(78);
    expect(estimateMessageHeight(message(0))).toBeLessThan(120);
  });

  it("accounts for large compatibility transcripts instead of assigning one flat row height", () => {
    const largeTranscript: Message = {
      ...message(1),
      blocks: Array.from({ length: 100 }, (_, index) => ({
        type: "text" as const,
        content: `Transcript entry ${index}`,
      })),
    };

    expect(estimateMessageHeight(largeTranscript)).toBeGreaterThan(4_000);
  });

  it("reserves inline space for image references before they load", () => {
    const imageTranscript: Message = {
      ...message(1),
      blocks: [{
        type: "thinking",
        content: "![portrait](<C:\\Users\\tester\\Pictures\\folder (20)\\portrait (01).png>)",
      }],
    };

    expect(estimateMessageHeight(imageTranscript)).toBeGreaterThan(400);
  });

  it("does not treat inline image payload bytes as thousands of text lines", () => {
    const inlineImage: Message = {
      ...message(1),
      blocks: [{
        type: "text",
        content: `![inline](data:image/png;base64,${"A".repeat(20_000)})`,
      }],
    };

    expect(estimateMessageHeight(inlineImage)).toBeGreaterThan(400);
    expect(estimateMessageHeight(inlineImage)).toBeLessThan(1_000);
  });

  it("reuses a measured height only for the same message revision and width", () => {
    const measured = { ...message(0), id: "measured-height-message" };
    cacheMeasuredMessageHeight(measured, 777, 820);

    expect(cachedOrEstimatedMessageHeight(measured, 820)).toBe(777);
    expect(cachedOrEstimatedMessageHeight({ ...measured }, 820)).not.toBe(777);
    expect(cachedOrEstimatedMessageHeight(measured, 500)).not.toBe(777);
  });
});
