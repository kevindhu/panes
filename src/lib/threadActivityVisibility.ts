export type ThreadActivityView = "chat" | "harnesses" | "workspace-settings" | string;

export interface ThreadActivityVisibilityInput {
  windowFocused: boolean;
  activeView: ThreadActivityView;
  activeWorkspaceId: string | null;
  activeRepoId: string | null;
  activeThreadId: string | null;
  activityWorkspaceId: string;
  activityRepoId?: string | null;
  activityThreadId: string;
  chatSurfaceVisible: boolean;
}

function normalizeRepoId(repoId: string | null | undefined): string | null {
  return repoId ?? null;
}

export function isThreadActivityVisible({
  windowFocused,
  activeView,
  activeWorkspaceId,
  activeRepoId,
  activeThreadId,
  activityWorkspaceId,
  activityRepoId,
  activityThreadId,
  chatSurfaceVisible,
}: ThreadActivityVisibilityInput): boolean {
  return (
    windowFocused &&
    activeView === "chat" &&
    chatSurfaceVisible &&
    activeWorkspaceId === activityWorkspaceId &&
    activeThreadId === activityThreadId &&
    normalizeRepoId(activeRepoId) === normalizeRepoId(activityRepoId)
  );
}
