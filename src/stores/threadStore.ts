import { create } from "zustand";
import { ipc } from "../lib/codexIpc";
import {
  NEW_THREAD_FALLBACK_RUNTIME,
  resolveNewThreadRuntime,
  type NewThreadServiceTier,
} from "../lib/newThreadRuntime";
import type { Thread, ThreadStatus } from "../types";
import { useEngineStore } from "./engineStore";

interface CreateThreadInput {
  workspaceId: string;
  repoId: string | null;
  engineId?: string;
  modelId?: string;
  reasoningEffort?: string | null;
  serviceTier?: NewThreadServiceTier | null;
  title?: string;
}

interface ThreadState {
  threads: Thread[];
  threadsByWorkspace: Record<string, Thread[]>;
  archivedThreadsByWorkspace: Record<string, Thread[]>;
  activeThreadId: string | null;
  startupRestorePending: boolean;
  loading: boolean;
  error?: string;
  createThread: (input: CreateThreadInput) => Promise<string | null>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  refreshThreads: (workspaceId: string) => Promise<void>;
  refreshArchivedThreads: (workspaceId: string) => Promise<void>;
  refreshAllThreads: (workspaceIds: string[]) => Promise<void>;
  removeThread: (threadId: string) => Promise<void>;
  restoreThread: (threadId: string) => Promise<void>;
  forkCodexThread: (threadId: string, profileOperationId?: string | null) => Promise<Thread | null>;
  forkCodexThreadAtTurn: (
    threadId: string,
    lastTurnId: string | null,
    turnsAfter: number,
    profileOperationId?: string | null,
  ) => Promise<Thread | null>;
  rollbackCodexThread: (
    threadId: string,
    numTurns: number,
    profileOperationId?: string | null,
  ) => Promise<Thread | null>;
  compactCodexThread: (threadId: string) => Promise<Thread | null>;
  attachCodexRemoteThread: (
    workspaceId: string,
    engineThreadId: string,
    modelId: string,
  ) => Promise<Thread | null>;
  setActiveThread: (threadId: string | null) => void;
  setStartupRestorePending: (pending: boolean) => void;
  applyThreadUpdateLocal: (thread: Thread) => boolean;
  setThreadStatusLocal: (threadId: string, status: ThreadStatus) => void;
  setThreadReasoningEffortLocal: (threadId: string, reasoningEffort: string | null) => void;
  setThreadLastModelLocal: (threadId: string, modelId: string | null) => void;
}

const DEFAULT_ENGINE = NEW_THREAD_FALLBACK_RUNTIME.engineId;
const DEFAULT_MODEL = NEW_THREAD_FALLBACK_RUNTIME.modelId;

function mergeWorkspaceThreads(
  current: Record<string, Thread[]>,
  workspaceId: string,
  threads: Thread[],
): Record<string, Thread[]> {
  return {
    ...current,
    [workspaceId]: threads,
  };
}

function flattenThreadsByWorkspace(threadsByWorkspace: Record<string, Thread[]>): Thread[] {
  return Object.values(threadsByWorkspace)
    .flat()
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
}

function applyThreadReasoningEffort(
  thread: Thread,
  reasoningEffort: string | null
): Thread {
  const metadata = { ...(thread.engineMetadata ?? {}) };
  if (reasoningEffort) {
    metadata.reasoningEffort = reasoningEffort;
  } else {
    delete metadata.reasoningEffort;
  }

  return {
    ...thread,
    engineMetadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

function applyThreadLastModel(
  thread: Thread,
  modelId: string | null
): Thread {
  const metadata = { ...(thread.engineMetadata ?? {}) };
  if (modelId) {
    metadata.lastModelId = modelId;
  } else {
    delete metadata.lastModelId;
  }

  return {
    ...thread,
    engineMetadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

const LAST_THREAD_KEY = "panes:lastActiveThreadId";

function resolveImplicitNewThreadRuntime(
  _state: Pick<ThreadState, "threads" | "activeThreadId">,
  _workspaceId: string,
) {
  const engines = useEngineStore.getState().engines;
  return resolveNewThreadRuntime({ engines });
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  threadsByWorkspace: {},
  archivedThreadsByWorkspace: {},
  activeThreadId: null,
  startupRestorePending: true,
  loading: false,
  createThread: async ({
    workspaceId,
    repoId,
    engineId,
    modelId,
    reasoningEffort,
    serviceTier,
    title,
  }) => {
    const effectiveRuntime =
      engineId || modelId || reasoningEffort || serviceTier
        ? {
            engineId: DEFAULT_ENGINE,
            modelId: modelId ?? DEFAULT_MODEL,
            reasoningEffort: reasoningEffort ?? null,
            serviceTier: serviceTier ?? null,
          }
        : resolveImplicitNewThreadRuntime(get(), workspaceId);

    set({ loading: true, error: undefined });

    try {
      const created = await ipc.createThread(
        workspaceId,
        repoId,
        effectiveRuntime.engineId,
        effectiveRuntime.modelId,
        title ?? (repoId ? "Repo Chat" : "Workspace Chat"),
        effectiveRuntime.reasoningEffort,
        effectiveRuntime.serviceTier,
      );

      const existingWorkspaceThreads = get().threadsByWorkspace[workspaceId] ?? [];
      const workspaceThreads = [created, ...existingWorkspaceThreads.filter((thread) => thread.id !== created.id)];
      const threadsByWorkspace = mergeWorkspaceThreads(get().threadsByWorkspace, workspaceId, workspaceThreads);
      const threads = flattenThreadsByWorkspace(threadsByWorkspace);

      localStorage.setItem(LAST_THREAD_KEY, created.id);
      set({
        threadsByWorkspace,
        threads,
        activeThreadId: created.id,
        loading: false,
      });

      return created.id;
    } catch (error) {
      set({ loading: false, error: String(error) });
      return null;
    }
  },
  renameThread: async (threadId, title) => {
    set({ loading: true, error: undefined });
    try {
      const updated = await ipc.renameThread(threadId, title);
      set((state) => {
        const updateThread = (thread: Thread) => (thread.id === updated.id ? updated : thread);
        const threadsByWorkspace = Object.entries(state.threadsByWorkspace).reduce<
          Record<string, Thread[]>
        >((acc, [workspaceId, threads]) => {
          acc[workspaceId] = threads.map(updateThread);
          return acc;
        }, {});
        const threads = flattenThreadsByWorkspace(threadsByWorkspace);

        return {
          threadsByWorkspace,
          threads,
          loading: false,
        };
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  refreshThreads: async (workspaceId) => {
    set({ loading: true, error: undefined });
    try {
      const workspaceThreads = await ipc.listThreads(workspaceId);
      const threadsByWorkspace = mergeWorkspaceThreads(get().threadsByWorkspace, workspaceId, workspaceThreads);
      const threads = flattenThreadsByWorkspace(threadsByWorkspace);
      const active = get().activeThreadId;
      set({
        threadsByWorkspace,
        threads,
        activeThreadId:
          active && threads.some((item) => item.id === active)
            ? active
            : workspaceThreads[0]?.id ?? null,
        loading: false
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  refreshArchivedThreads: async (workspaceId) => {
    try {
      const archivedThreads = await ipc.listArchivedThreads(workspaceId);
      set((state) => ({
        archivedThreadsByWorkspace: {
          ...state.archivedThreadsByWorkspace,
          [workspaceId]: archivedThreads,
        },
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  refreshAllThreads: async (workspaceIds) => {
    if (!workspaceIds.length) {
      set({
        threads: [],
        threadsByWorkspace: {},
        archivedThreadsByWorkspace: {},
        activeThreadId: null,
        loading: false,
        error: undefined,
      });
      return;
    }

    set({ loading: true, error: undefined });
    try {
      const results = await Promise.all(
        workspaceIds.map(async (workspaceId) => ({
          workspaceId,
          threads: await ipc.listThreads(workspaceId),
        })),
      );

      const threadsByWorkspace = results.reduce<Record<string, Thread[]>>((acc, item) => {
        acc[item.workspaceId] = item.threads;
        return acc;
      }, {});
      const threads = flattenThreadsByWorkspace(threadsByWorkspace);
      const active = get().activeThreadId;
      const savedId = localStorage.getItem(LAST_THREAD_KEY);
      const restoredId =
        (active && threads.some((item) => item.id === active)) ? active
        : (savedId && threads.some((item) => item.id === savedId)) ? savedId
        : null;

      set({
        threadsByWorkspace,
        threads,
        activeThreadId: restoredId,
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  removeThread: async (threadId) => {
    set({ loading: true, error: undefined });
    try {
      await ipc.archiveThread(threadId);
      let archivedThread: Thread | null = null;
      let archivedWorkspaceId: string | null = null;
      const nextThreadsByWorkspace = Object.entries(get().threadsByWorkspace).reduce<
        Record<string, Thread[]>
      >((acc, [workspaceId, threads]) => {
        const target = threads.find((thread) => thread.id === threadId);
        if (target) {
          archivedThread = target;
          archivedWorkspaceId = workspaceId;
        }
        const remaining = threads.filter((thread) => thread.id !== threadId);
        acc[workspaceId] = remaining;
        return acc;
      }, {});
      const threads = flattenThreadsByWorkspace(nextThreadsByWorkspace);
      const active = get().activeThreadId;

      set((state) => {
        const archivedThreadsByWorkspace = { ...state.archivedThreadsByWorkspace };
        if (archivedThread && archivedWorkspaceId) {
          const currentArchived = archivedThreadsByWorkspace[archivedWorkspaceId] ?? [];
          archivedThreadsByWorkspace[archivedWorkspaceId] = [
            archivedThread,
            ...currentArchived.filter((thread) => thread.id !== threadId),
          ];
        }

        return {
          threadsByWorkspace: nextThreadsByWorkspace,
          archivedThreadsByWorkspace,
          threads,
          activeThreadId: active === threadId ? null : active,
          loading: false,
        };
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  restoreThread: async (threadId) => {
    set({ loading: true, error: undefined });
    try {
      const restored = await ipc.restoreThread(threadId);
      set((state) => {
        const workspaceId = restored.workspaceId;
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = [
          restored,
          ...workspaceThreads.filter((thread) => thread.id !== threadId),
        ];
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );
        const archivedThreads = state.archivedThreadsByWorkspace[workspaceId] ?? [];
        const archivedThreadsByWorkspace = {
          ...state.archivedThreadsByWorkspace,
          [workspaceId]: archivedThreads.filter((thread) => thread.id !== threadId),
        };

        return {
          threadsByWorkspace,
          archivedThreadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          loading: false,
        };
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  forkCodexThread: async (threadId, profileOperationId) => {
    set({ loading: true, error: undefined });
    try {
      const forked = await ipc.forkCodexThread(threadId, profileOperationId ?? null);
      localStorage.setItem(LAST_THREAD_KEY, forked.id);
      set((state) => {
        const workspaceId = forked.workspaceId;
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = [
          forked,
          ...workspaceThreads.filter((thread) => thread.id !== forked.id),
        ];
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );

        return {
          threadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          activeThreadId: forked.id,
          loading: false,
        };
      });
      return forked;
    } catch (error) {
      set({ loading: false, error: String(error) });
      return null;
    }
  },
  forkCodexThreadAtTurn: async (
    threadId,
    lastTurnId,
    turnsAfter,
    profileOperationId,
  ) => {
    set({ error: undefined });
    try {
      const forked = await ipc.forkCodexThreadAtTurn(
        threadId,
        lastTurnId,
        turnsAfter,
        profileOperationId ?? null,
      );
      localStorage.setItem(LAST_THREAD_KEY, forked.id);
      set((state) => {
        const workspaceId = forked.workspaceId;
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = [
          forked,
          ...workspaceThreads.filter((thread) => thread.id !== forked.id),
        ];
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );

        return {
          threadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          activeThreadId: forked.id,
        };
      });
      return forked;
    } catch (error) {
      set({ error: String(error) });
      return null;
    }
  },
  rollbackCodexThread: async (threadId, numTurns, profileOperationId) => {
    set({ loading: true, error: undefined });
    try {
      const rolledBack = await ipc.rollbackCodexThread(
        threadId,
        numTurns,
        profileOperationId ?? null,
      );
      set((state) => {
        const workspaceId = rolledBack.workspaceId;
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = workspaceThreads.map((thread) =>
          thread.id === rolledBack.id ? rolledBack : thread,
        );
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );

        return {
          threadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          loading: false,
        };
      });
      return rolledBack;
    } catch (error) {
      set({ loading: false, error: String(error) });
      throw error;
    }
  },
  compactCodexThread: async (threadId) => {
    set({ loading: true, error: undefined });
    try {
      const compacted = await ipc.compactCodexThread(threadId);
      set((state) => {
        const workspaceId = compacted.workspaceId;
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = workspaceThreads.map((thread) =>
          thread.id === compacted.id ? compacted : thread,
        );
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );

        return {
          threadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          loading: false,
        };
      });
      return compacted;
    } catch (error) {
      set({ loading: false, error: String(error) });
      return null;
    }
  },
  attachCodexRemoteThread: async (workspaceId, engineThreadId, modelId) => {
    set({ loading: true, error: undefined });
    try {
      const attached = await ipc.attachCodexRemoteThread(workspaceId, engineThreadId, modelId);
      localStorage.setItem(LAST_THREAD_KEY, attached.id);
      set((state) => {
        const workspaceThreads = state.threadsByWorkspace[workspaceId] ?? [];
        const nextWorkspaceThreads = [
          attached,
          ...workspaceThreads.filter((thread) => thread.id !== attached.id),
        ];
        const threadsByWorkspace = mergeWorkspaceThreads(
          state.threadsByWorkspace,
          workspaceId,
          nextWorkspaceThreads,
        );
        const archivedThreads = state.archivedThreadsByWorkspace[workspaceId] ?? [];
        const archivedThreadsByWorkspace = {
          ...state.archivedThreadsByWorkspace,
          [workspaceId]: archivedThreads.filter((thread) => thread.id !== attached.id),
        };

        return {
          threadsByWorkspace,
          archivedThreadsByWorkspace,
          threads: flattenThreadsByWorkspace(threadsByWorkspace),
          activeThreadId: attached.id,
          loading: false,
        };
      });
      return attached;
    } catch (error) {
      set({ loading: false, error: String(error) });
      return null;
    }
  },
  setActiveThread: (threadId) => {
    if (threadId) {
      localStorage.setItem(LAST_THREAD_KEY, threadId);
    } else {
      localStorage.removeItem(LAST_THREAD_KEY);
    }
    set({ activeThreadId: threadId });
  },
  setStartupRestorePending: (pending) => {
    set({ startupRestorePending: pending });
  },
  applyThreadUpdateLocal: (updatedThread) => {
    let applied = false;

    set((state) => {
      const workspaceThreads = state.threadsByWorkspace[updatedThread.workspaceId];
      if (!workspaceThreads?.some((thread) => thread.id === updatedThread.id)) {
        return state;
      }

      applied = true;
      const nextWorkspaceThreads = workspaceThreads.map((thread) =>
        thread.id === updatedThread.id ? updatedThread : thread,
      );
      const threadsByWorkspace = mergeWorkspaceThreads(
        state.threadsByWorkspace,
        updatedThread.workspaceId,
        nextWorkspaceThreads,
      );
      const archivedThreads = state.archivedThreadsByWorkspace[updatedThread.workspaceId] ?? [];
      const archivedThreadsByWorkspace = archivedThreads.some(
        (thread) => thread.id === updatedThread.id,
      )
        ? {
            ...state.archivedThreadsByWorkspace,
            [updatedThread.workspaceId]: archivedThreads.map((thread) =>
              thread.id === updatedThread.id ? updatedThread : thread,
            ),
          }
        : state.archivedThreadsByWorkspace;

      return {
        threadsByWorkspace,
        archivedThreadsByWorkspace,
        threads: flattenThreadsByWorkspace(threadsByWorkspace),
      };
    });

    return applied;
  },
  setThreadStatusLocal: (threadId, status) =>
    set((state) => {
      let changed = false;
      const updateThread = (thread: Thread) => {
        if (thread.id !== threadId || thread.status === status) {
          return thread;
        }
        changed = true;
        return { ...thread, status };
      };

      const threadsByWorkspace = Object.entries(state.threadsByWorkspace).reduce<
        Record<string, Thread[]>
      >((acc, [workspaceId, threads]) => {
        acc[workspaceId] = threads.map(updateThread);
        return acc;
      }, {});
      const threads = state.threads.map(updateThread);

      return changed ? { threadsByWorkspace, threads } : state;
    }),
  setThreadReasoningEffortLocal: (threadId, reasoningEffort) =>
    set((state) => {
      const updateThread = (thread: Thread) =>
        thread.id === threadId
          ? applyThreadReasoningEffort(thread, reasoningEffort)
          : thread;

      const threadsByWorkspace = Object.entries(state.threadsByWorkspace).reduce<
        Record<string, Thread[]>
      >((acc, [workspaceId, threads]) => {
        acc[workspaceId] = threads.map(updateThread);
        return acc;
      }, {});

      return {
        threadsByWorkspace,
        threads: state.threads.map(updateThread),
      };
    }),
  setThreadLastModelLocal: (threadId, modelId) =>
    set((state) => {
      const updateThread = (thread: Thread) =>
        thread.id === threadId
          ? applyThreadLastModel(thread, modelId)
          : thread;

      const threadsByWorkspace = Object.entries(state.threadsByWorkspace).reduce<
        Record<string, Thread[]>
      >((acc, [workspaceId, threads]) => {
        acc[workspaceId] = threads.map(updateThread);
        return acc;
      }, {});

      return {
        threadsByWorkspace,
        threads: state.threads.map(updateThread),
      };
    }),
}));
