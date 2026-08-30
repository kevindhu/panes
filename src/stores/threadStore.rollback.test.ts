// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";

const mockIpc = vi.hoisted(() => ({
  forkCodexThreadAtTurn: vi.fn(),
  rollbackCodexThread: vi.fn(),
}));

vi.mock("../lib/codexIpc", () => ({
  ipc: mockIpc,
}));

import { useThreadStore } from "./threadStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    repoId: null,
    engineId: "codex",
    modelId: "gpt-5.4",
    engineThreadId: "engine-thread-1",
    title: "Thread",
    status: "idle",
    messageCount: 4,
    totalTokens: 12,
    createdAt: "2026-08-28T00:00:00.000Z",
    lastActivityAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("threadStore native Codex rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    const thread = makeThread();
    useThreadStore.setState({
      threads: [thread],
      threadsByWorkspace: { "workspace-1": [thread] },
      archivedThreadsByWorkspace: {},
      activeThreadId: thread.id,
      loading: false,
      error: undefined,
    });
  });

  it("replaces the existing thread instead of adding and activating a branch", async () => {
    const rolledBack = makeThread({
      messageCount: 2,
      totalTokens: 6,
      title: "Rolled back",
    });
    mockIpc.rollbackCodexThread.mockResolvedValue(rolledBack);

    const result = await useThreadStore
      .getState()
      .rollbackCodexThread("thread-1", 1, "profile-1");

    expect(mockIpc.rollbackCodexThread).toHaveBeenCalledWith(
      "thread-1",
      1,
      "profile-1",
    );
    expect(result).toEqual(rolledBack);
    expect(useThreadStore.getState().activeThreadId).toBe("thread-1");
    expect(useThreadStore.getState().threads).toEqual([rolledBack]);
    expect(useThreadStore.getState().threadsByWorkspace["workspace-1"]).toEqual([
      rolledBack,
    ]);
  });

  it("uses the native turn cutoff without putting the whole thread store into loading", async () => {
    const forked = makeThread({
      id: "thread-fork",
      engineThreadId: "engine-thread-fork",
      messageCount: 2,
      title: "Forked thread",
    });
    let resolveFork!: (thread: Thread) => void;
    mockIpc.forkCodexThreadAtTurn.mockImplementation(
      () => new Promise<Thread>((resolve) => { resolveFork = resolve; }),
    );

    const pending = useThreadStore
      .getState()
      .forkCodexThreadAtTurn(
        "thread-1",
        "assistant-message-1",
        "turn-native-1",
        1,
        "profile-1",
      );

    expect(useThreadStore.getState().loading).toBe(false);
    expect(mockIpc.forkCodexThreadAtTurn).toHaveBeenCalledWith(
      "thread-1",
      "assistant-message-1",
      "turn-native-1",
      1,
      "profile-1",
    );

    resolveFork(forked);
    await expect(pending).resolves.toEqual(forked);
    expect(useThreadStore.getState().activeThreadId).toBe("thread-fork");
    expect(useThreadStore.getState().threadsByWorkspace["workspace-1"][0]).toEqual(forked);
  });

  it("keeps the thread store interactive while native rollback is pending", async () => {
    const rolledBack = makeThread({ messageCount: 2 });
    let resolveRollback!: (thread: Thread) => void;
    mockIpc.rollbackCodexThread.mockImplementation(
      () => new Promise<Thread>((resolve) => { resolveRollback = resolve; }),
    );

    const pending = useThreadStore.getState().rollbackCodexThread("thread-1", 1);

    expect(useThreadStore.getState().loading).toBe(false);
    resolveRollback(rolledBack);
    await expect(pending).resolves.toEqual(rolledBack);
  });

  it("propagates the Codex rollback failure instead of replacing it with null", async () => {
    mockIpc.rollbackCodexThread.mockRejectedValue(
      new Error("thread not found: engine-thread-1"),
    );

    await expect(
      useThreadStore.getState().rollbackCodexThread("thread-1", 1),
    ).rejects.toThrow("thread not found: engine-thread-1");

    expect(useThreadStore.getState().loading).toBe(false);
    expect(useThreadStore.getState().error).toContain(
      "thread not found: engine-thread-1",
    );
  });
});
