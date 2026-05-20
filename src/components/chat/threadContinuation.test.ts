import { describe, expect, it } from "vitest";
import type { Thread } from "../../types";
import { resolveChatSubmitTarget } from "./threadContinuation";

function buildThread(overrides?: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    workspaceId: "ws-1",
    repoId: null,
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

describe("resolveChatSubmitTarget", () => {
  it("continues the visible thread when the engine stays the same", () => {
    const thread = buildThread({ repoId: "repo-a" });

    expect(
      resolveChatSubmitTarget({
        activeThread: thread,
        boundThreadId: thread.id,
        threads: [thread],
        activeWorkspaceId: "ws-1",
        startupRestorePending: false,
        selectedEngineId: "codex",
      }),
    ).toEqual({
      kind: "continue",
      thread,
    });
  });

  it("blocks cross-engine sends on the visible thread", () => {
    const thread = buildThread({ engineId: "codex" });

    expect(
      resolveChatSubmitTarget({
        activeThread: thread,
        boundThreadId: thread.id,
        threads: [thread],
        activeWorkspaceId: "ws-1",
        startupRestorePending: false,
        selectedEngineId: "claude",
      }),
    ).toEqual({
      kind: "block_engine_switch",
      thread,
    });
  });

  it("preserves the restored thread during startup even before workspace reconciliation finishes", () => {
    const thread = buildThread({ workspaceId: "ws-restored" });

    expect(
      resolveChatSubmitTarget({
        activeThread: thread,
        boundThreadId: null,
        threads: [thread],
        activeWorkspaceId: "ws-other",
        startupRestorePending: true,
        selectedEngineId: "codex",
      }),
    ).toEqual({
      kind: "continue",
      thread,
    });
  });

  it("creates a new thread after startup when no visible thread matches the active workspace", () => {
    const thread = buildThread({ workspaceId: "ws-other" });

    expect(
      resolveChatSubmitTarget({
        activeThread: thread,
        boundThreadId: null,
        threads: [thread],
        activeWorkspaceId: "ws-1",
        startupRestorePending: false,
        selectedEngineId: "codex",
      }),
    ).toEqual({
      kind: "create",
    });
  });
});
