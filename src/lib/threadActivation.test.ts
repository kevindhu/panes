import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";

const callOrder = vi.hoisted((): string[] => []);

const mockWorkspaceStoreState = vi.hoisted(() => ({
  activeWorkspaceId: "ws-1" as string | null,
  activeRepoId: "repo-1" as string | null,
  setActiveWorkspace: vi.fn(async (workspaceId: string) => {
    callOrder.push(`workspace:${workspaceId}`);
    mockWorkspaceStoreState.activeWorkspaceId = workspaceId;
  }),
  setActiveRepo: vi.fn((repoId: string | null) => {
    callOrder.push(`repo:${repoId ?? "null"}`);
    mockWorkspaceStoreState.activeRepoId = repoId;
  }),
}));

const mockThreadStoreState = vi.hoisted(() => ({
  activeThreadId: null as string | null,
  setActiveThread: vi.fn((threadId: string | null) => {
    callOrder.push(`thread:${threadId ?? "null"}`);
    mockThreadStoreState.activeThreadId = threadId;
  }),
}));

const mockChatStoreState = vi.hoisted(() => ({
  setActiveThread: vi.fn(async (threadId: string | null) => {
    callOrder.push(`chat:${threadId ?? "null"}`);
  }),
}));

vi.mock("../stores/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => mockWorkspaceStoreState,
  },
}));

vi.mock("../stores/threadStore", () => ({
  useThreadStore: {
    getState: () => mockThreadStoreState,
  },
}));

vi.mock("../stores/chatStore", () => ({
  useChatStore: {
    getState: () => mockChatStoreState,
  },
}));

import { activateThreadContext, restoreStartupThreadContext } from "./threadActivation";

function buildThread(overrides?: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    workspaceId: "ws-2",
    repoId: "repo-2",
    engineId: "codex",
    modelId: "gpt-5.5",
    engineThreadId: null,
    engineMetadata: undefined,
    title: "Thread",
    status: "idle",
    messageCount: 0,
    totalTokens: 0,
    createdAt: "2026-05-20T00:00:00Z",
    lastActivityAt: "2026-05-20T00:00:00Z",
    ...overrides,
  };
}

describe("threadActivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    mockWorkspaceStoreState.activeWorkspaceId = "ws-1";
    mockWorkspaceStoreState.activeRepoId = "repo-1";
    mockThreadStoreState.activeThreadId = null;
  });

  it("activates a thread context in workspace, repo, thread, chat order", async () => {
    await activateThreadContext(buildThread());

    expect(callOrder).toEqual([
      "workspace:ws-2",
      "repo:repo-2",
      "thread:thread-1",
      "chat:thread-1",
    ]);
    expect(mockWorkspaceStoreState.activeWorkspaceId).toBe("ws-2");
    expect(mockWorkspaceStoreState.activeRepoId).toBe("repo-2");
    expect(mockThreadStoreState.activeThreadId).toBe("thread-1");
  });

  it("restores a saved startup thread only after loading completes", async () => {
    const thread = buildThread({ id: "thread-startup" });

    await expect(
      restoreStartupThreadContext({
        activeThreadId: thread.id,
        threads: [thread],
        workspaceLoading: true,
        reposLoading: false,
        threadLoading: false,
      }),
    ).resolves.toBe(false);
    expect(callOrder).toEqual([]);

    await expect(
      restoreStartupThreadContext({
        activeThreadId: thread.id,
        threads: [thread],
        workspaceLoading: false,
        reposLoading: false,
        threadLoading: false,
      }),
    ).resolves.toBe(true);
    expect(callOrder).toEqual([
      "workspace:ws-2",
      "repo:repo-2",
      "thread:thread-startup",
      "chat:thread-startup",
    ]);
  });
});
