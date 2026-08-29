// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  captureChatScrollPosition,
  readChatScrollPosition,
  resetChatScrollPositionsForTests,
  restoreChatScrollPosition,
  saveChatScrollPosition,
} from "./chatScrollPosition";

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 800,
    width: 800,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function makeViewport() {
  const viewport = document.createElement("div");
  const first = document.createElement("article");
  first.dataset.messageId = "message-1";
  const anchor = document.createElement("article");
  anchor.dataset.messageId = "message-2";
  viewport.append(first, anchor);
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 5_000 },
    clientHeight: { configurable: true, value: 1_000 },
  });
  viewport.getBoundingClientRect = () => rect(100, 1_100);
  first.getBoundingClientRect = () => rect(-200, 90);
  anchor.getBoundingClientRect = () => rect(80, 420);
  return { viewport, anchor };
}

describe("chat scroll positions", () => {
  beforeEach(() => {
    resetChatScrollPositionsForTests();
  });

  it("captures the visible message anchor and restores its exact viewport offset", () => {
    const { viewport, anchor } = makeViewport();
    viewport.scrollTop = 1_800;
    const position = captureChatScrollPosition(viewport);
    expect(position).toMatchObject({
      scrollTop: 1_800,
      distanceFromBottom: 2_200,
      nearBottom: false,
      anchorMessageId: "message-2",
      anchorOffset: -20,
    });

    viewport.scrollTop = 1_800;
    anchor.getBoundingClientRect = () => rect(150, 490);
    expect(restoreChatScrollPosition(viewport, position)).toBe(true);
    expect(viewport.scrollTop).toBe(1_870);
  });

  it("restores bottom-pinned sessions to the new bottom after content grows", () => {
    const { viewport } = makeViewport();
    viewport.scrollTop = 3_950;
    const position = captureChatScrollPosition(viewport);
    expect(position.nearBottom).toBe(true);

    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 7_000 });
    viewport.scrollTop = 0;
    restoreChatScrollPosition(viewport, position);
    expect(viewport.scrollTop).toBe(7_000);
  });

  it("keeps independent positions for each conversation", () => {
    const first = {
      scrollTop: 1_000,
      distanceFromBottom: 2_000,
      nearBottom: false,
      anchorMessageId: "first-anchor",
      anchorOffset: -12,
    };
    const second = {
      scrollTop: 2_000,
      distanceFromBottom: 1_000,
      nearBottom: false,
      anchorMessageId: "second-anchor",
      anchorOffset: 8,
    };
    saveChatScrollPosition("thread-1", first);
    saveChatScrollPosition("thread-2", second);

    expect(readChatScrollPosition("thread-1")).toEqual(first);
    expect(readChatScrollPosition("thread-2")).toEqual(second);
  });
});
