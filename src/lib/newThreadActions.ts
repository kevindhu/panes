import { useThreadStore } from "../stores/threadStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { activateThreadContext } from "./threadActivation";

export async function createAndActivateWorkspaceThread(
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (!workspaceId) {
    return null;
  }

  const workspaceStore = useWorkspaceStore.getState();
  const activeWorkspaceId = workspaceStore.activeWorkspaceId;
  // New Chat is an explicit scope. Clear the previous session before any
  // workspace or creation awaits so its composer state cannot bleed through.
  await activateThreadContext(null);

  if (activeWorkspaceId !== workspaceId) {
    await workspaceStore.setActiveWorkspace(workspaceId);
  }

  useWorkspaceStore.getState().setActiveRepo(null, { remember: false });

  const threadId = await useThreadStore.getState().createThread({
    workspaceId,
    repoId: null,
    engineId: "codex",
    title: "New conversation",
  });

  if (!threadId) {
    return null;
  }

  const createdThread =
    useThreadStore.getState().threads.find((thread) => thread.id === threadId) ?? null;
  await activateThreadContext(createdThread);
  return threadId;
}
