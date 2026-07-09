import { describe, expect, it } from "vitest";
import {
  buildVirtualizedMessageLayout,
  computeVirtualMessageWindow,
  mergeRetainedMessageRanges,
  resolveRetainedMessageIndexes,
  resolveVirtualMessageWindow,
  retainedMessageRangeForIndexes,
} from "./messageVirtualization";

function createMeasuredMessages(count: number) {
  const messages = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
  }));
  const heights = new Map(messages.map((message) => [message.id, 100]));
  const layout = buildVirtualizedMessageLayout(messages, heights);
  if (!layout) {
    throw new Error("Expected a measured layout");
  }
  return { messages, layout };
}

describe("message selection retention windows", () => {
  it("expands retained boundaries without a row cap", () => {
    const { messages } = createMeasuredMessages(140);
    const initial = retainedMessageRangeForIndexes(messages, 8, 16);
    const distant = retainedMessageRangeForIndexes(messages, 112, 120);

    const merged = mergeRetainedMessageRanges(messages, initial, distant);

    expect(resolveRetainedMessageIndexes(messages, merged)).toEqual({
      startIndex: 8,
      endIndexExclusive: 120,
    });
  });

  it("keeps message-id boundaries stable when older rows are prepended", () => {
    const { messages } = createMeasuredMessages(140);
    const retained = retainedMessageRangeForIndexes(messages, 25, 32);
    const prepended = [
      { id: "older-0" },
      { id: "older-1" },
      { id: "older-2" },
      ...messages,
    ];

    expect(resolveRetainedMessageIndexes(prepended, retained)).toEqual({
      startIndex: 28,
      endIndexExclusive: 35,
    });
  });

  it("falls back to the viewport if a retained boundary disappears", () => {
    const { messages, layout } = createMeasuredMessages(140);
    const viewportWindow = computeVirtualMessageWindow(layout, 6000, 700, 300);

    const resolved = resolveVirtualMessageWindow({
      virtualizationEnabled: true,
      layout,
      messages,
      retainedRange: {
        startMessageId: "deleted-message",
        endMessageId: "message-12",
      },
      viewportScrollTop: 6000,
      viewportHeight: 700,
      overscanPx: 300,
    });

    expect(resolved).toEqual(viewportWindow);
  });
});
