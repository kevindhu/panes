// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THREAD_PLAN_MODE_STORAGE_KEY,
  readComposerModeForResolvedScope,
  readStoredThreadPlanModes,
  readThreadComposerMode,
  resolveComposerModeScope,
  useThreadPlanModeStore,
} from "./threadPlanModeStore";
import {
  armPlanImplementationPrompt,
  isPlanImplementationPromptArmed,
} from "../lib/planImplementationPromptState";

describe("threadPlanModeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useThreadPlanModeStore.setState({
      threadModes: {},
      newThreadModesByWorkspaceId: {},
    });
  });

  it("isolates plan mode by thread", () => {
    useThreadPlanModeStore.getState().setThreadMode("thread-a", "plan");

    const state = useThreadPlanModeStore.getState();
    expect(readThreadComposerMode(state, "thread-a")).toBe("plan");
    expect(readThreadComposerMode(state, "thread-b")).toBe("default");
  });

  it("keeps a separate mode for a not-yet-created thread", () => {
    useThreadPlanModeStore.getState().setNewThreadMode("workspace-1", "plan");

    const state = useThreadPlanModeStore.getState();
    expect(
      readComposerModeForResolvedScope(state, {
        kind: "new-thread",
        workspaceId: "workspace-1",
      }),
    ).toBe("plan");
    expect(
      readComposerModeForResolvedScope(state, {
        kind: "new-thread",
        workspaceId: "workspace-2",
      }),
    ).toBe("default");
  });

  it("persists both scopes for reload hydration", () => {
    useThreadPlanModeStore.getState().setThreadMode("thread-a", "plan");
    useThreadPlanModeStore.getState().setThreadMode("thread-b", "default");
    useThreadPlanModeStore.getState().setNewThreadMode("workspace-1", "plan");

    expect(readStoredThreadPlanModes()).toEqual({
      threadModes: {
        "thread-a": "plan",
        "thread-b": "default",
      },
      newThreadModesByWorkspaceId: {
        "workspace-1": "plan",
      },
    });
  });

  it("persists an explicit default after leaving plan mode", () => {
    const store = useThreadPlanModeStore.getState();
    store.setThreadMode("thread-a", "plan");
    useThreadPlanModeStore.getState().setThreadMode("thread-a", "default");

    const hydrated = readStoredThreadPlanModes();
    expect(hydrated.threadModes["thread-a"]).toBe("default");
  });

  it("hydrates the effective thread mode synchronously after a module reload", async () => {
    localStorage.setItem(
      THREAD_PLAN_MODE_STORAGE_KEY,
      JSON.stringify({
        threadModes: { "thread-a": "plan", "thread-b": "default" },
        newThreadModesByWorkspaceId: {},
      }),
    );
    vi.resetModules();

    const reloaded = await import("./threadPlanModeStore");
    const state = reloaded.useThreadPlanModeStore.getState();
    expect(reloaded.readThreadComposerMode(state, "thread-a")).toBe(
      "plan",
    );
    expect(reloaded.readThreadComposerMode(state, "thread-b")).toBe(
      "default",
    );
  });

  it("does not let a stale handoff promote a default thread into plan mode", async () => {
    localStorage.setItem(
      "panes:pendingPlanImplementationPrompts:v1",
      JSON.stringify({
        "thread-a": {
          threadId: "thread-a",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    vi.resetModules();

    const reloaded = await import("./threadPlanModeStore");
    const state = reloaded.useThreadPlanModeStore.getState();
    expect(reloaded.readThreadComposerMode(state, "thread-a")).toBe(
      "default",
    );
    expect(isPlanImplementationPromptArmed("thread-a")).toBe(false);
  });

  it("keeps a handoff only when the v2 composer state explicitly owns plan mode", async () => {
    localStorage.setItem(
      THREAD_PLAN_MODE_STORAGE_KEY,
      JSON.stringify({
        threadModes: { "thread-a": "plan" },
        newThreadModesByWorkspaceId: {},
      }),
    );
    localStorage.setItem(
      "panes:pendingPlanImplementationPrompts:v1",
      JSON.stringify({
        "thread-a": {
          threadId: "thread-a",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    vi.resetModules();

    const reloaded = await import("./threadPlanModeStore");
    const state = reloaded.useThreadPlanModeStore.getState();
    expect(reloaded.readThreadComposerMode(state, "thread-a")).toBe(
      "plan",
    );
    expect(isPlanImplementationPromptArmed("thread-a")).toBe(true);
  });

  it("drops the unreliable v1 mode map instead of carrying false positives forward", async () => {
    localStorage.setItem(
      "panes:threadPlanModes:v1",
      JSON.stringify({
        threadModes: { "thread-a": "plan", "thread-b": "plan" },
        newThreadModesByWorkspaceId: { "workspace-1": "plan" },
      }),
    );
    vi.resetModules();

    const reloaded = await import("./threadPlanModeStore");
    expect(reloaded.readStoredThreadPlanModes()).toEqual({
      threadModes: {},
      newThreadModesByWorkspaceId: {},
    });
    expect(localStorage.getItem("panes:threadPlanModes:v1")).toBeNull();
  });

  it("keeps explicit default authoritative over a stale pending handoff", async () => {
    localStorage.setItem(
      THREAD_PLAN_MODE_STORAGE_KEY,
      JSON.stringify({
        threadModes: { "thread-a": "default" },
        newThreadModesByWorkspaceId: {},
      }),
    );
    localStorage.setItem(
      "panes:pendingPlanImplementationPrompts:v1",
      JSON.stringify({
        "thread-a": {
          threadId: "thread-a",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    vi.resetModules();

    const reloaded = await import("./threadPlanModeStore");
    const state = reloaded.useThreadPlanModeStore.getState();
    expect(reloaded.readThreadComposerMode(state, "thread-a")).toBe(
      "default",
    );
    expect(isPlanImplementationPromptArmed("thread-a")).toBe(false);
  });

  it("clears consumed new-thread state and prunes deleted threads", () => {
    const store = useThreadPlanModeStore.getState();
    store.setNewThreadMode("workspace-1", "plan");
    store.setThreadMode("thread-a", "plan");
    store.setThreadMode("thread-b", "plan");
    armPlanImplementationPrompt("thread-a");

    useThreadPlanModeStore.getState().clearNewThreadMode("workspace-1");
    useThreadPlanModeStore.getState().pruneThreadModes(["thread-b"]);

    expect(readStoredThreadPlanModes()).toEqual({
      threadModes: { "thread-b": "plan" },
      newThreadModesByWorkspaceId: {},
    });
    expect(isPlanImplementationPromptArmed("thread-a")).toBe(false);
  });

  it("clears a pending handoff immediately when a thread is toggled off", () => {
    useThreadPlanModeStore.getState().setThreadMode("thread-a", "plan");
    armPlanImplementationPrompt("thread-a");

    useThreadPlanModeStore.getState().setThreadMode("thread-a", "default");

    expect(isPlanImplementationPromptArmed("thread-a")).toBe(false);
  });

  it("uses the newly selected thread while its previous transcript is still bound", () => {
    const scope = resolveComposerModeScope({
      activeThreadId: "thread-b",
      boundThreadId: "thread-a",
      activeWorkspaceId: "workspace-1",
      threads: [
        { id: "thread-a", workspaceId: "workspace-1" },
        { id: "thread-b", workspaceId: "workspace-1" },
      ],
    });
    const state = {
      threadModes: { "thread-a": "plan", "thread-b": "default" } as const,
      newThreadModesByWorkspaceId: { "workspace-1": "plan" } as const,
    };

    expect(scope).toEqual({ kind: "thread", threadId: "thread-b" });
    expect(readComposerModeForResolvedScope(state, scope)).toBe("default");
  });

  it("never falls through to new-chat plan mode during a workspace transition", () => {
    const scope = resolveComposerModeScope({
      activeThreadId: "thread-a",
      boundThreadId: "thread-a",
      activeWorkspaceId: "workspace-2",
      threads: [{ id: "thread-a", workspaceId: "workspace-1" }],
    });
    const state = {
      threadModes: { "thread-a": "plan" } as const,
      newThreadModesByWorkspaceId: { "workspace-2": "plan" } as const,
    };

    expect(scope).toEqual({ kind: "transitioning" });
    expect(readComposerModeForResolvedScope(state, scope)).toBe("default");
  });

  it("does not apply new-chat mode while an old transcript is unbinding", () => {
    const scope = resolveComposerModeScope({
      activeThreadId: null,
      boundThreadId: "thread-a",
      activeWorkspaceId: "workspace-2",
      threads: [{ id: "thread-a", workspaceId: "workspace-1" }],
    });

    expect(scope).toEqual({ kind: "transitioning" });
  });

  it("uses workspace mode only for a settled new-chat composer", () => {
    const scope = resolveComposerModeScope({
      activeThreadId: null,
      boundThreadId: null,
      activeWorkspaceId: "workspace-2",
      threads: [],
    });
    const state = {
      threadModes: {},
      newThreadModesByWorkspaceId: { "workspace-2": "plan" } as const,
    };

    expect(scope).toEqual({ kind: "new-thread", workspaceId: "workspace-2" });
    expect(readComposerModeForResolvedScope(state, scope)).toBe("plan");
  });

  it("never borrows another session or new-chat mode across a full swap sequence", () => {
    const threads = [
      { id: "thread-a", workspaceId: "workspace-1" },
      { id: "thread-b", workspaceId: "workspace-2" },
    ];
    const state = {
      threadModes: { "thread-a": "plan", "thread-b": "default" } as const,
      newThreadModesByWorkspaceId: { "workspace-2": "plan" } as const,
    };
    const modeAt = (input: {
      activeThreadId: string | null;
      boundThreadId: string | null;
      activeWorkspaceId: string | null;
    }) =>
      readComposerModeForResolvedScope(
        state,
        resolveComposerModeScope({ ...input, threads }),
      );

    expect(
      [
        modeAt({
          activeThreadId: "thread-a",
          boundThreadId: "thread-a",
          activeWorkspaceId: "workspace-1",
        }),
        modeAt({
          activeThreadId: "thread-b",
          boundThreadId: "thread-a",
          activeWorkspaceId: "workspace-1",
        }),
        modeAt({
          activeThreadId: "thread-b",
          boundThreadId: "thread-a",
          activeWorkspaceId: "workspace-2",
        }),
        modeAt({
          activeThreadId: "thread-b",
          boundThreadId: "thread-b",
          activeWorkspaceId: "workspace-2",
        }),
        modeAt({
          activeThreadId: "thread-a",
          boundThreadId: "thread-b",
          activeWorkspaceId: "workspace-2",
        }),
        modeAt({
          activeThreadId: "thread-a",
          boundThreadId: "thread-b",
          activeWorkspaceId: "workspace-1",
        }),
      ],
    ).toEqual(["plan", "default", "default", "default", "default", "plan"]);
  });
});
