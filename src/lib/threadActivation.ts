import { useChatStore } from "../stores/chatStore";
import { useThreadStore } from "../stores/threadStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { Thread } from "../types";

interface ActivateThreadContextOptions {
  forceChatReload?: boolean;
}

interface RestoreStartupThreadContextInput {
  activeThreadId: string | null;
  threads: Thread[];
  workspaceLoading: boolean;
  reposLoading: boolean;
  threadLoading: boolean;
}

interface WorkspaceThreadActivationState {
  activeWorkspaceId: string | null;
  setActiveWorkspace: (workspaceId: string) => Promise<void>;
  setActiveRepo: (repoId: string | null, options?: { remember?: boolean }) => void;
}

interface ThreadActivationState {
  activeThreadId: string | null;
  setActiveThread: (threadId: string | null) => void;
}

interface ChatThreadActivationState {
  setActiveThread: (
    threadId: string | null,
    options?: { forceReload?: boolean },
  ) => Promise<void>;
}

let activeThreadActivationSeq = 0;

function readStoreState<T>(store: { getState?: () => T } | (() => T)): T {
  if (typeof (store as { getState?: () => T }).getState === "function") {
    return (store as { getState: () => T }).getState();
  }
  if (typeof store === "function") {
    return store();
  }
  throw new TypeError("Unsupported store shape");
}

export async function activateThreadContext(
  thread: Thread | null,
  options?: ActivateThreadContextOptions,
): Promise<void> {
  const activationSeq = ++activeThreadActivationSeq;
  const workspaceStore = readStoreState<WorkspaceThreadActivationState>(
    useWorkspaceStore as unknown as
      | { getState?: () => WorkspaceThreadActivationState }
      | (() => WorkspaceThreadActivationState),
  );
  const threadStore = readStoreState<ThreadActivationState>(
    useThreadStore as unknown as
      | { getState?: () => ThreadActivationState }
      | (() => ThreadActivationState),
  );
  const chatStore = readStoreState<ChatThreadActivationState>(
    useChatStore as unknown as
      | { getState?: () => ChatThreadActivationState }
      | (() => ChatThreadActivationState),
  );

  if (!thread) {
    if (threadStore.activeThreadId !== null) {
      threadStore.setActiveThread(null);
    }
    await chatStore.setActiveThread(null);
    return;
  }

  // Both stores publish their synchronous selection state before the first
  // await. React therefore never observes the target thread paired with the
  // previous workspace, even though workspace preparation continues async.
  let workspaceActivation: Promise<void> | null = null;
  if (workspaceStore.activeWorkspaceId !== thread.workspaceId) {
    workspaceActivation = workspaceStore.setActiveWorkspace(thread.workspaceId);
  }
  threadStore.setActiveThread(thread.id);
  if (workspaceActivation) {
    await workspaceActivation;
  }

  if (activationSeq !== activeThreadActivationSeq) {
    return;
  }

  if (thread.repoId) {
    workspaceStore.setActiveRepo(thread.repoId);
  } else {
    workspaceStore.setActiveRepo(null, { remember: false });
  }

  if (options?.forceChatReload) {
    await chatStore.setActiveThread(thread.id, { forceReload: true });
    return;
  }

  await chatStore.setActiveThread(thread.id);
}

export async function restoreStartupThreadContext(
  input: RestoreStartupThreadContextInput,
): Promise<boolean> {
  if (input.workspaceLoading || input.reposLoading || input.threadLoading) {
    return false;
  }

  const activeThread = input.activeThreadId
    ? input.threads.find((thread) => thread.id === input.activeThreadId) ?? null
    : null;

  if (activeThread) {
    await activateThreadContext(activeThread);
  }

  return true;
}
