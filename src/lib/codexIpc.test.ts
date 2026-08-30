import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

import {
  ipc,
  listenCodexCompatibilityForkMaterialized,
  listenCodexHistoryMutationFailed,
} from "./codexIpc";

describe("Codex IPC", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it("calls the native usage-limit refresh command for the selected thread", async () => {
    mocks.invoke.mockResolvedValue({ refreshed: true, missingContext: false });

    await expect(ipc.refreshThreadUsageLimits("thread-123")).resolves.toEqual({
      refreshed: true,
      missingContext: false,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("refresh_thread_usage_limits", {
      threadId: "thread-123",
    });
  });

  it("listens for compatibility fork materialization", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);

    await expect(listenCodexCompatibilityForkMaterialized(listener)).resolves.toBe(unlisten);

    expect(mocks.listen).toHaveBeenCalledWith(
      "codex-compatibility-fork-materialized",
      expect.any(Function),
    );
    const callback = mocks.listen.mock.calls[0]?.[1];
    callback({ payload: { threadId: "compatibility-thread" } });
    expect(listener).toHaveBeenCalledWith({ threadId: "compatibility-thread" });
  });

  it("listens for proactive Codex history mutation failures", async () => {
    const unlisten = vi.fn();
    const listener = vi.fn();
    mocks.listen.mockResolvedValue(unlisten);

    await expect(listenCodexHistoryMutationFailed(listener)).resolves.toBe(unlisten);

    expect(mocks.listen).toHaveBeenCalledWith(
      "codex-history-mutation-failed",
      expect.any(Function),
    );
    const callback = mocks.listen.mock.calls[0]?.[1];
    callback({
      payload: {
        threadId: "compatibility-thread",
        operation: "rollback",
        message: "durable marker missing",
      },
    });
    expect(listener).toHaveBeenCalledWith({
      threadId: "compatibility-thread",
      operation: "rollback",
      message: "durable marker missing",
    });
  });
});
