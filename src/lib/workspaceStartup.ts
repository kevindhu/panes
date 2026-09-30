import { useEngineStore } from "../stores/engineStore";
import { useThreadStore } from "../stores/threadStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { recordPerfMetric } from "./perfTelemetry";
import { activateThreadContext } from "./threadActivation";

let startup: Promise<void> | undefined;

/** One startup per webview, including React StrictMode's effect replay. */
export function initializeCodexWorkspace(): Promise<void> {
  startup ??= loadWorkspace().catch((error) => {
    startup = undefined;
    throw error;
  });
  return startup;
}

async function loadWorkspace(): Promise<void> {
  const started = performance.now();
  // Runtime discovery may launch Codex, query models, or time out. Local
  // navigation and saved history do not depend on it.
  const engineLoad = useEngineStore.getState().load().then(() => {
    recordPerfMetric("startup.engine_catalog.ms", performance.now() - started);
  });
  await useWorkspaceStore.getState().loadWorkspaces();
  const workspacesReady = performance.now();
  const workspaceState = useWorkspaceStore.getState();
  const workspaceId = workspaceState.activeWorkspaceId;
  const workspaceIds = workspaceState.workspaces.map((workspace) => workspace.id);
  await useThreadStore.getState().refreshAllThreads(workspaceIds);
  const threadsReady = performance.now();
  const state = useThreadStore.getState();
  const selected = state.threads.find((thread) => thread.id === state.activeThreadId)
    ?? (workspaceId ? state.threadsByWorkspace[workspaceId]?.[0] : null)
    ?? null;
  await activateThreadContext(selected);
  const historyReady = performance.now();
  recordPerfMetric("startup.local_workspace.ms", historyReady - started, {
    workspacesMs: workspacesReady - started,
    threadsMs: threadsReady - workspacesReady,
    historyMs: historyReady - threadsReady,
  });
  if (workspaceIds.length) {
    void engineLoad.then(() => useEngineStore.getState().ensureHealth("codex"));
  }
}
