import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../types";

const mocks = vi.hoisted(() => ({
  loadEngines: vi.fn(),
  ensureHealth: vi.fn(),
  loadWorkspaces: vi.fn(),
  refreshAllThreads: vi.fn(),
  activateThreadContext: vi.fn(),
  recordPerfMetric: vi.fn(),
  workspace: { activeWorkspaceId: "ws-1", workspaces: [{ id: "ws-1" }, { id: "ws-2" }] },
  threads: {
    activeThreadId: "saved",
    threads: [{ id: "saved", workspaceId: "ws-2" }] as Thread[],
    threadsByWorkspace: { "ws-1": [{ id: "fallback", workspaceId: "ws-1" } as Thread] } as Record<string, Thread[]>,
  },
}));

vi.mock("../stores/engineStore", () => ({
  useEngineStore: { getState: () => ({ load: mocks.loadEngines, ensureHealth: mocks.ensureHealth }) },
}));
vi.mock("../stores/workspaceStore", () => ({
  useWorkspaceStore: { getState: () => ({ ...mocks.workspace, loadWorkspaces: mocks.loadWorkspaces }) },
}));
vi.mock("../stores/threadStore", () => ({
  useThreadStore: { getState: () => ({ ...mocks.threads, refreshAllThreads: mocks.refreshAllThreads }) },
}));
vi.mock("./threadActivation", () => ({ activateThreadContext: mocks.activateThreadContext }));
vi.mock("./perfTelemetry", () => ({ recordPerfMetric: mocks.recordPerfMetric }));

describe("workspace startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.loadEngines.mockResolvedValue(undefined);
    mocks.loadWorkspaces.mockResolvedValue(undefined);
    mocks.refreshAllThreads.mockResolvedValue(undefined);
    mocks.activateThreadContext.mockResolvedValue(undefined);
    mocks.threads.activeThreadId = "saved";
  });

  it("restores local history while engine discovery is still pending", async () => {
    let finishEngine!: () => void;
    mocks.loadEngines.mockReturnValue(new Promise<void>((resolve) => { finishEngine = resolve; }));
    const { initializeCodexWorkspace } = await import("./workspaceStartup");
    await initializeCodexWorkspace();
    expect(mocks.refreshAllThreads).toHaveBeenCalledWith(["ws-1", "ws-2"]);
    expect(mocks.activateThreadContext).toHaveBeenCalledWith(mocks.threads.threads[0]);
    expect(mocks.ensureHealth).not.toHaveBeenCalled();
    expect(mocks.recordPerfMetric).toHaveBeenCalledWith("startup.local_workspace.ms", expect.any(Number), {
      workspacesMs: expect.any(Number), threadsMs: expect.any(Number), historyMs: expect.any(Number),
    });
    finishEngine();
    await vi.waitFor(() => expect(mocks.ensureHealth).toHaveBeenCalledWith("codex"));
  });

  it("shares startup across StrictMode effect replay and later remounts", async () => {
    const { initializeCodexWorkspace } = await import("./workspaceStartup");
    const first = initializeCodexWorkspace();
    expect(initializeCodexWorkspace()).toBe(first);
    await first;
    await initializeCodexWorkspace();
    expect(mocks.loadWorkspaces).toHaveBeenCalledTimes(1);
    expect(mocks.loadEngines).toHaveBeenCalledTimes(1);
    expect(mocks.activateThreadContext).toHaveBeenCalledTimes(1);
  });

  it("falls back to the selected workspace when the saved thread is gone", async () => {
    mocks.threads.activeThreadId = "removed";
    const { initializeCodexWorkspace } = await import("./workspaceStartup");
    await initializeCodexWorkspace();
    expect(mocks.activateThreadContext).toHaveBeenCalledWith(mocks.threads.threadsByWorkspace["ws-1"][0]);
  });

  it("allows retry after a failed local startup", async () => {
    mocks.loadWorkspaces.mockRejectedValueOnce(new Error("local startup failed"));
    const { initializeCodexWorkspace } = await import("./workspaceStartup");
    await expect(initializeCodexWorkspace()).rejects.toThrow("local startup failed");
    await initializeCodexWorkspace();
    expect(mocks.activateThreadContext).toHaveBeenCalledTimes(1);
  });
});
