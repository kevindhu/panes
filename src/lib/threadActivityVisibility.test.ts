import { describe, expect, it } from "vitest";
import {
  isThreadActivityVisible,
  resolveVisibleChatThreadId,
} from "./threadActivityVisibility";

const visibleInput = {
  windowFocused: true,
  activeView: "chat",
  activeWorkspaceId: "ws-1",
  activeRepoId: "repo-1",
  activeThreadId: "thread-1",
  activityWorkspaceId: "ws-1",
  activityRepoId: "repo-1",
  activityThreadId: "thread-1",
  chatSurfaceVisible: true,
};

describe("isThreadActivityVisible", () => {
  it("returns true only for the focused visible matching chat thread", () => {
    expect(isThreadActivityVisible(visibleInput)).toBe(true);
  });

  it("returns false when the window is not focused", () => {
    expect(isThreadActivityVisible({ ...visibleInput, windowFocused: false })).toBe(false);
  });

  it("returns false when a non-chat app view is active", () => {
    expect(isThreadActivityVisible({ ...visibleInput, activeView: "harnesses" })).toBe(false);
  });

  it("returns false when the chat surface is hidden", () => {
    expect(isThreadActivityVisible({ ...visibleInput, chatSurfaceVisible: false })).toBe(false);
  });

  it("returns false when workspace, repo, or thread scope differs", () => {
    expect(isThreadActivityVisible({ ...visibleInput, activeWorkspaceId: "ws-2" })).toBe(false);
    expect(isThreadActivityVisible({ ...visibleInput, activeRepoId: "repo-2" })).toBe(false);
    expect(isThreadActivityVisible({ ...visibleInput, activeThreadId: "thread-2" })).toBe(false);
  });

  it("treats missing repo ids as workspace scope", () => {
    expect(
      isThreadActivityVisible({
        ...visibleInput,
        activeRepoId: null,
        activityRepoId: null,
      }),
    ).toBe(true);
  });
});

describe("resolveVisibleChatThreadId", () => {
  it("requires the selected thread and bound chat thread to match", () => {
    expect(resolveVisibleChatThreadId("thread-1", "thread-1")).toBe("thread-1");
    expect(resolveVisibleChatThreadId("thread-1", "thread-2")).toBeNull();
    expect(resolveVisibleChatThreadId(null, "thread-1")).toBeNull();
    expect(resolveVisibleChatThreadId("thread-1", null)).toBeNull();
  });
});
