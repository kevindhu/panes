import { create } from "zustand";
import {
  disarmPlanImplementationPrompt,
  listPendingPlanImplementationPromptThreadIds,
} from "../lib/planImplementationPromptState";

export const THREAD_PLAN_MODE_STORAGE_KEY = "panes:threadPlanModes:v2";
const LEGACY_THREAD_PLAN_MODE_STORAGE_KEY = "panes:threadPlanModes:v1";

export type ThreadComposerMode = "default" | "plan";

interface StoredThreadPlanModes {
  threadModes: Record<string, ThreadComposerMode>;
  newThreadModesByWorkspaceId: Record<string, ThreadComposerMode>;
}

interface ThreadPlanModeState extends StoredThreadPlanModes {
  setThreadMode: (threadId: string, mode: ThreadComposerMode) => void;
  setNewThreadMode: (workspaceId: string, mode: ThreadComposerMode) => void;
  clearNewThreadMode: (workspaceId: string) => void;
  pruneThreadModes: (validThreadIds: string[]) => void;
}

export type ComposerModeScope =
  | { kind: "thread"; threadId: string }
  | { kind: "new-thread"; workspaceId: string }
  | { kind: "transitioning" }
  | { kind: "unavailable" };

interface ResolveComposerModeScopeInput {
  activeThreadId: string | null;
  boundThreadId: string | null;
  activeWorkspaceId: string | null;
  threads: Array<{ id: string; workspaceId: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeModeRecord(value: unknown): Record<string, ThreadComposerMode> {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, ThreadComposerMode> = {};
  for (const [key, mode] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (normalizedKey && (mode === "default" || mode === "plan")) {
      normalized[normalizedKey] = mode;
    }
  }
  return normalized;
}

export function readStoredThreadPlanModes(): StoredThreadPlanModes {
  try {
    const raw = globalThis.localStorage?.getItem(THREAD_PLAN_MODE_STORAGE_KEY);
    if (!raw) {
      return {
        threadModes: {},
        newThreadModesByWorkspaceId: {},
      };
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        threadModes: {},
        newThreadModesByWorkspaceId: {},
      };
    }

    return {
      threadModes: normalizeModeRecord(parsed.threadModes),
      newThreadModesByWorkspaceId: normalizeModeRecord(
        parsed.newThreadModesByWorkspaceId,
      ),
    };
  } catch {
    return {
      threadModes: {},
      newThreadModesByWorkspaceId: {},
    };
  }
}

function persistThreadPlanModes(state: StoredThreadPlanModes): void {
  try {
    globalThis.localStorage?.setItem(
      THREAD_PLAN_MODE_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    // A failed preference write must never prevent chat from remaining usable.
  }
}

function persistAndReturn(state: StoredThreadPlanModes): StoredThreadPlanModes {
  persistThreadPlanModes(state);
  return state;
}

const initialState = readStoredThreadPlanModes();
for (const threadId of listPendingPlanImplementationPromptThreadIds()) {
  if (initialState.threadModes[threadId] !== "plan") {
    // A handoff record can restore a prompt, but it must never promote a
    // composer into plan mode. The persisted composer mode is authoritative.
    disarmPlanImplementationPrompt(threadId);
  }
}
persistThreadPlanModes(initialState);
try {
  globalThis.localStorage?.removeItem(LEGACY_THREAD_PLAN_MODE_STORAGE_KEY);
} catch {
  // Ignore cleanup failures; the v2 key remains the only source of truth.
}

export const useThreadPlanModeStore = create<ThreadPlanModeState>((set) => ({
  ...initialState,

  setThreadMode: (threadId, mode) => {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return;
    }

    if (mode === "default") {
      disarmPlanImplementationPrompt(normalizedThreadId);
    }

    set((state) =>
      persistAndReturn({
        threadModes: {
          ...state.threadModes,
          [normalizedThreadId]: mode,
        },
        newThreadModesByWorkspaceId: state.newThreadModesByWorkspaceId,
      }),
    );
  },

  setNewThreadMode: (workspaceId, mode) => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }

    set((state) =>
      persistAndReturn({
        threadModes: state.threadModes,
        newThreadModesByWorkspaceId: {
          ...state.newThreadModesByWorkspaceId,
          [normalizedWorkspaceId]: mode,
        },
      }),
    );
  },

  clearNewThreadMode: (workspaceId) => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!normalizedWorkspaceId) {
      return;
    }

    set((state) => {
      if (!(normalizedWorkspaceId in state.newThreadModesByWorkspaceId)) {
        return state;
      }
      const {
        [normalizedWorkspaceId]: _removed,
        ...newThreadModesByWorkspaceId
      } = state.newThreadModesByWorkspaceId;
      return persistAndReturn({
        threadModes: state.threadModes,
        newThreadModesByWorkspaceId,
      });
    });
  },

  pruneThreadModes: (validThreadIds) => {
    const valid = new Set(validThreadIds);
    for (const threadId of listPendingPlanImplementationPromptThreadIds()) {
      if (!valid.has(threadId)) {
        disarmPlanImplementationPrompt(threadId);
      }
    }
    set((state) => {
      const threadModes = Object.fromEntries(
        Object.entries(state.threadModes).filter(([threadId]) => valid.has(threadId)),
      ) as Record<string, ThreadComposerMode>;
      if (Object.keys(threadModes).length === Object.keys(state.threadModes).length) {
        return state;
      }
      return persistAndReturn({
        threadModes,
        newThreadModesByWorkspaceId: state.newThreadModesByWorkspaceId,
      });
    });
  },
}));

export function resolveComposerModeScope(
  input: ResolveComposerModeScopeInput,
): ComposerModeScope {
  if (input.activeThreadId) {
    const activeThread = input.threads.find(
      (thread) => thread.id === input.activeThreadId,
    );
    if (
      activeThread &&
      activeThread.workspaceId === input.activeWorkspaceId
    ) {
      return { kind: "thread", threadId: input.activeThreadId };
    }

    // A selected thread that does not belong to the active workspace means the
    // stores are between activation commits. Never fall through to new-chat
    // preferences while an existing session is still being switched.
    return { kind: "transitioning" };
  }

  if (input.boundThreadId) {
    // The transcript has not unbound yet after selecting New Chat or another
    // workspace. Treat the scope as unresolved until that transition finishes.
    return { kind: "transitioning" };
  }

  if (input.activeWorkspaceId) {
    return { kind: "new-thread", workspaceId: input.activeWorkspaceId };
  }

  return { kind: "unavailable" };
}

export function readComposerModeForResolvedScope(
  state: Pick<
    ThreadPlanModeState,
    "threadModes" | "newThreadModesByWorkspaceId"
  >,
  scope: ComposerModeScope,
): ThreadComposerMode {
  if (scope.kind === "thread") {
    return state.threadModes[scope.threadId] ?? "default";
  }
  if (scope.kind === "new-thread") {
    return state.newThreadModesByWorkspaceId[scope.workspaceId] ?? "default";
  }
  return "default";
}

export function readThreadComposerMode(
  state: Pick<ThreadPlanModeState, "threadModes">,
  threadId: string | null | undefined,
): ThreadComposerMode {
  return threadId ? state.threadModes[threadId] ?? "default" : "default";
}
