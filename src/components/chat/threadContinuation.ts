import type { Thread } from "../../types";

interface ResolveChatSubmitTargetInput {
  activeThread: Thread | null;
  boundThreadId: string | null;
  threads: Thread[];
  activeWorkspaceId: string | null;
  startupRestorePending: boolean;
  selectedEngineId: string | null;
}

export type ChatSubmitTarget =
  | { kind: "continue"; thread: Thread }
  | { kind: "block_engine_switch"; thread: Thread }
  | { kind: "create" };

export function resolveChatSubmitTarget(
  input: ResolveChatSubmitTargetInput,
): ChatSubmitTarget {
  const boundThread = input.boundThreadId
    ? input.threads.find((thread) => thread.id === input.boundThreadId) ?? null
    : null;
  const visibleThread = input.activeThread ?? boundThread;

  if (!visibleThread) {
    return { kind: "create" };
  }

  if (!input.startupRestorePending && visibleThread.workspaceId !== input.activeWorkspaceId) {
    return { kind: "create" };
  }

  if (input.selectedEngineId && input.selectedEngineId !== visibleThread.engineId) {
    return { kind: "block_engine_switch", thread: visibleThread };
  }

  return { kind: "continue", thread: visibleThread };
}
