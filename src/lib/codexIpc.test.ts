import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { ipc } from "./codexIpc";

describe("Codex IPC", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("calls the native usage-limit refresh command for the selected thread", async () => {
    mockInvoke.mockResolvedValue({ refreshed: true, missingContext: false });

    await expect(ipc.refreshThreadUsageLimits("thread-123")).resolves.toEqual({
      refreshed: true,
      missingContext: false,
    });
    expect(mockInvoke).toHaveBeenCalledWith("refresh_thread_usage_limits", {
      threadId: "thread-123",
    });
  });
});
