// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";

const mockIpc = vi.hoisted(() => ({
  archiveThread: vi.fn(),
  listArchivedThreads: vi.fn(),
  renameThread: vi.fn(),
  restoreThread: vi.fn(),
}));

vi.mock("../lib/codexIpc", () => ({ ipc: mockIpc }));

import { hasUnreadFinishedTurn, useThreadStore } from "./threadStore";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    repoId: null,
    engineId: "codex",
    modelId: "gpt-5.6-codex",
    engineThreadId: "engine-thread-1",
    title: "Thread",
    status: "completed",
    messageCount: 2,
    totalTokens: 12,
    createdAt: "2026-08-28T00:00:00.000Z",
    lastActivityAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  const thread = makeThread();
  useThreadStore.setState({
    threads: [thread],
    threadsByWorkspace: { [thread.workspaceId]: [thread] },
    archivedThreadsByWorkspace: {},
    finishedTurnNotifications: {},
    activeThreadId: thread.id,
    loading: false,
    archivedLoading: false,
    error: undefined,
  });
});

describe("threadStore sidebar operations", () => {
  it("clears finished-turn notifications monotonically across selection races", () => {
    useThreadStore.setState({ activeThreadId: "another-thread" });

    expect(useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-1"))
      .toBe(true);
    expect(hasUnreadFinishedTurn(
      useThreadStore.getState().finishedTurnNotifications,
      "thread-1",
    )).toBe(true);

    useThreadStore.getState().setActiveThread("thread-1");
    expect(hasUnreadFinishedTurn(
      useThreadStore.getState().finishedTurnNotifications,
      "thread-1",
    )).toBe(false);

    useThreadStore.getState().setActiveThread("another-thread");
    expect(useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-1"))
      .toBe(false);
    expect(hasUnreadFinishedTurn(
      useThreadStore.getState().finishedTurnNotifications,
      "thread-1",
    )).toBe(false);

    useThreadStore.getState().setActiveThread("thread-1");
    expect(useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-2"))
      .toBe(true);
    useThreadStore.getState().setActiveThread("another-thread");
    expect(useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-2"))
      .toBe(false);
    expect(hasUnreadFinishedTurn(
      useThreadStore.getState().finishedTurnNotifications,
      "thread-1",
    )).toBe(false);

    expect(JSON.parse(localStorage.getItem("panes:finished-turn-notifications") ?? "{}"))
      .toEqual({ "thread-1": { "assistant-1": false, "assistant-2": false } });
  });

  it("keeps a later background finish unread after earlier turns were cleared", () => {
    useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-1");
    useThreadStore.getState().setActiveThread("another-thread");
    useThreadStore.getState().recordFinishedTurn("thread-1", "assistant-2");

    expect(hasUnreadFinishedTurn(
      useThreadStore.getState().finishedTurnNotifications,
      "thread-1",
    )).toBe(true);
  });

  it("returns the renamed thread and updates every active index", async () => {
    const renamed = makeThread({ title: "Renamed" });
    mockIpc.renameThread.mockResolvedValue(renamed);

    await expect(
      useThreadStore.getState().renameThread(renamed.id, renamed.title),
    ).resolves.toEqual(renamed);

    expect(useThreadStore.getState().threads).toEqual([renamed]);
    expect(useThreadStore.getState().threadsByWorkspace[renamed.workspaceId]).toEqual([
      renamed,
    ]);

    mockIpc.renameThread.mockRejectedValueOnce(new Error("rename failed"));
    await expect(
      useThreadStore.getState().renameThread(renamed.id, "Another title"),
    ).resolves.toBeNull();
    expect(useThreadStore.getState().error).toContain("rename failed");
  });

  it("reports archive success and returns the restored thread to its workspace", async () => {
    const thread = makeThread();
    mockIpc.archiveThread.mockResolvedValue(undefined);

    await expect(
      useThreadStore.getState().removeThread(thread.id),
    ).resolves.toBe(true);
    expect(useThreadStore.getState().activeThreadId).toBeNull();
    expect(useThreadStore.getState().threadsByWorkspace[thread.workspaceId]).toEqual([]);
    expect(useThreadStore.getState().archivedThreadsByWorkspace[thread.workspaceId]).toEqual([
      thread,
    ]);

    mockIpc.restoreThread.mockResolvedValue(thread);
    await expect(
      useThreadStore.getState().restoreThread(thread.id),
    ).resolves.toEqual(thread);
    expect(useThreadStore.getState().threadsByWorkspace[thread.workspaceId]).toEqual([
      thread,
    ]);
    expect(useThreadStore.getState().archivedThreadsByWorkspace[thread.workspaceId]).toEqual([]);
  });

  it("loads archived sessions for all workspaces and preserves cached data on partial failure", async () => {
    const archivedA = makeThread({ id: "archived-a", workspaceId: "workspace-a" });
    const cachedB = makeThread({ id: "cached-b", workspaceId: "workspace-b" });
    useThreadStore.setState({
      archivedThreadsByWorkspace: { "workspace-b": [cachedB] },
    });
    mockIpc.listArchivedThreads.mockImplementation(async (workspaceId: string) => {
      if (workspaceId === "workspace-a") return [archivedA];
      throw new Error("workspace-b unavailable");
    });

    const pending = useThreadStore
      .getState()
      .refreshAllArchivedThreads(["workspace-a", "workspace-b"]);
    expect(useThreadStore.getState().archivedLoading).toBe(true);
    await pending;

    expect(useThreadStore.getState().archivedLoading).toBe(false);
    expect(useThreadStore.getState().archivedThreadsByWorkspace).toEqual({
      "workspace-a": [archivedA],
      "workspace-b": [cachedB],
    });
    expect(useThreadStore.getState().error).toContain("workspace-b unavailable");
  });
});
