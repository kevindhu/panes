import { create } from "zustand";
import type { Repo, TrustLevel, Workspace } from "../types";
import { ipc } from "../lib/codexIpc";

interface SetActiveRepoOptions {
  remember?: boolean;
}

interface WorkspaceState {
  workspaces: Workspace[];
  archivedWorkspaces: Workspace[];
  activeWorkspaceId: string | null;
  repos: Repo[];
  activeRepoId: string | null;
  reposLoading: boolean;
  loading: boolean;
  error?: string;
  loadWorkspaces: () => Promise<void>;
  refreshArchivedWorkspaces: () => Promise<void>;
  openWorkspace: (path: string, scanDepth?: number) => Promise<Workspace | null>;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  restoreWorkspace: (workspaceId: string) => Promise<void>;
  reorderWorkspaces: (workspaceIds: string[]) => Promise<void>;
  loadRepos: (workspaceId: string) => Promise<void>;
  setActiveWorkspace: (workspaceId: string) => Promise<void>;
  setActiveRepo: (repoId: string | null, options?: SetActiveRepoOptions) => void;
  setRepoTrustLevel: (repoId: string, trustLevel: TrustLevel) => Promise<void>;
  setAllReposTrustLevel: (trustLevel: TrustLevel) => Promise<void>;
  rescanWorkspace: (workspaceId: string, scanDepth?: number) => Promise<Workspace | null>;
  changeWorkspaceDirectory: (workspaceId: string, path: string) => Promise<Workspace | null>;
}

const LAST_WORKSPACE_KEY = "panes:lastActiveWorkspaceId";
const LAST_REPO_BY_WORKSPACE_KEY = "panes:lastActiveRepoByWorkspace";
let reposLoadSeq = 0;

type LastRepoByWorkspace = Record<string, string>;

function isTransientLinuxAppImageRoot(rootPath: string): boolean {
  return /^\/(?:var\/tmp|tmp)\/\.mount_[^/]+(?:\/|$)/.test(rootPath);
}

function resolveStartupWorkspaceId(
  workspaces: Workspace[],
  savedId: string | null,
): string | null {
  const savedWorkspace = savedId
    ? workspaces.find((workspace) => workspace.id === savedId) ?? null
    : null;

  if (savedWorkspace && !isTransientLinuxAppImageRoot(savedWorkspace.rootPath)) {
    return savedWorkspace.id;
  }

  if (!savedId) {
    return null;
  }

  return (
    workspaces.find((workspace) => !isTransientLinuxAppImageRoot(workspace.rootPath))?.id ?? null
  );
}

function readLastRepoByWorkspace(): LastRepoByWorkspace {
  try {
    const raw = localStorage.getItem(LAST_REPO_BY_WORKSPACE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const next: LastRepoByWorkspace = {};
    for (const [workspaceId, repoId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof workspaceId !== "string" || typeof repoId !== "string") {
        continue;
      }
      const normalizedRepoId = repoId.trim();
      if (!normalizedRepoId) {
        continue;
      }
      next[workspaceId] = normalizedRepoId;
    }
    return next;
  } catch {
    return {};
  }
}

function writeLastRepoByWorkspace(next: LastRepoByWorkspace): void {
  try {
    localStorage.setItem(LAST_REPO_BY_WORKSPACE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable or full; ignore persistence failure.
  }
}

function rememberLastRepo(workspaceId: string, repoId: string): void {
  const current = readLastRepoByWorkspace();
  if (current[workspaceId] === repoId) {
    return;
  }
  current[workspaceId] = repoId;
  writeLastRepoByWorkspace(current);
}

export function resolveActiveRepoId(
  workspaceId: string,
  repos: Repo[],
  currentActiveRepoId: string | null,
): string | null {
  if (!repos.length) {
    return null;
  }

  if (currentActiveRepoId && repos.some((repo) => repo.id === currentActiveRepoId)) {
    return currentActiveRepoId;
  }

  const persisted = readLastRepoByWorkspace()[workspaceId];
  if (persisted && repos.some((repo) => repo.id === persisted && repo.isActive)) {
    return persisted;
  }

  return repos.find((repo) => repo.isActive)?.id ?? repos[0]?.id ?? null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  archivedWorkspaces: [],
  activeWorkspaceId: null,
  repos: [],
  activeRepoId: null,
  reposLoading: false,
  loading: false,
  loadWorkspaces: async () => {
    set({ loading: true, error: undefined });
    try {
      const workspaces = await ipc.listWorkspaces();
      const savedId = localStorage.getItem(LAST_WORKSPACE_KEY);
      const activeWorkspaceId = resolveStartupWorkspaceId(workspaces, savedId);
      set({ workspaces, activeWorkspaceId, loading: false });
      if (activeWorkspaceId) {
        await get().loadRepos(activeWorkspaceId);
      }
      await get().refreshArchivedWorkspaces();
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  refreshArchivedWorkspaces: async () => {
    try {
      const archivedWorkspaces = await ipc.listArchivedWorkspaces();
      set({ archivedWorkspaces });
    } catch (error) {
      set({ error: String(error) });
    }
  },
  openWorkspace: async (path, scanDepth) => {
    set({ loading: true, error: undefined });
    try {
      const workspace = await ipc.openWorkspace(path, scanDepth);
      const current = get().workspaces;
      const existingIndex = current.findIndex((item) => item.id === workspace.id);
      const workspaces =
        existingIndex === -1
          ? [workspace, ...current]
          : current.map((item) => (item.id === workspace.id ? workspace : item));
      set((state) => ({
        workspaces,
        archivedWorkspaces: state.archivedWorkspaces.filter((item) => item.id !== workspace.id),
        activeWorkspaceId: workspace.id,
        loading: false,
      }));
      await get().loadRepos(workspace.id);
      return workspace;
    } catch (error) {
      set({ loading: false, error: String(error) });
      return null;
    }
  },
  removeWorkspace: async (workspaceId) => {
    set({ loading: true, error: undefined });
    try {
      await ipc.archiveWorkspace(workspaceId);
      const wasActiveWorkspace = get().activeWorkspaceId === workspaceId;
      const removed = get().workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
      const remaining = get().workspaces.filter((workspace) => workspace.id !== workspaceId);
      const nextActive =
        wasActiveWorkspace
          ? remaining[0]?.id ?? null
          : get().activeWorkspaceId;

      set((state) => ({
        workspaces: remaining,
        archivedWorkspaces: removed
          ? [
              removed,
              ...state.archivedWorkspaces.filter((workspace) => workspace.id !== workspaceId),
            ]
          : state.archivedWorkspaces,
        activeWorkspaceId: nextActive,
        loading: false,
      }));

      if (nextActive) {
        await get().loadRepos(nextActive);
      } else {
        set({ repos: [], activeRepoId: null, reposLoading: false });
      }
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  restoreWorkspace: async (workspaceId) => {
    set({ loading: true, error: undefined });
    try {
      const restored = await ipc.restoreWorkspace(workspaceId);
      set((state) => {
        const workspaces = [
          restored,
          ...state.workspaces.filter((workspace) => workspace.id !== workspaceId),
        ];
        const nextActiveWorkspaceId = state.activeWorkspaceId ?? restored.id;
        return {
          workspaces,
          archivedWorkspaces: state.archivedWorkspaces.filter(
            (workspace) => workspace.id !== workspaceId,
          ),
          activeWorkspaceId: nextActiveWorkspaceId,
          loading: false,
        };
      });

      if (!get().activeWorkspaceId || get().activeWorkspaceId === restored.id) {
        await get().loadRepos(restored.id);
      }
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  reorderWorkspaces: async (workspaceIds) => {
    const previous = get().workspaces;
    const byId = new Map(previous.map((workspace) => [workspace.id, workspace]));
    const next = workspaceIds.map((workspaceId) => byId.get(workspaceId));

    if (
      next.length !== previous.length ||
      next.some((workspace): workspace is undefined => workspace === undefined)
    ) {
      const error = new Error("workspace order must include every active workspace exactly once");
      set({ error: error.message });
      throw error;
    }

    const orderedWorkspaces = next as Workspace[];
    set({ workspaces: orderedWorkspaces, error: undefined });

    try {
      await ipc.setWorkspaceOrder(workspaceIds);
    } catch (error) {
      set({ workspaces: previous, error: String(error) });
      throw error;
    }
  },
  loadRepos: async (workspaceId) => {
    const requestSeq = ++reposLoadSeq;
    set({ reposLoading: true });
    try {
      const repos = await ipc.getRepos(workspaceId);
      if (requestSeq !== reposLoadSeq) {
        return;
      }
      if (get().activeWorkspaceId !== workspaceId) {
        set({ reposLoading: false });
        return;
      }
      const fallbackActiveRepoId = resolveActiveRepoId(
        workspaceId,
        repos,
        get().activeRepoId,
      );
      if (fallbackActiveRepoId) {
        rememberLastRepo(workspaceId, fallbackActiveRepoId);
      }
      set({
        repos,
        activeRepoId: fallbackActiveRepoId,
        reposLoading: false,
      });
    } catch (error) {
      if (requestSeq !== reposLoadSeq) {
        return;
      }
      if (get().activeWorkspaceId !== workspaceId) {
        set({ reposLoading: false });
        return;
      }
      set({ error: String(error), reposLoading: false });
    }
  },
  setActiveWorkspace: async (workspaceId) => {
    localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
    set({ activeWorkspaceId: workspaceId, activeRepoId: null, repos: [], error: undefined });
    await get().loadRepos(workspaceId);
  },
  setActiveRepo: (repoId, options) => {
    set({ activeRepoId: repoId });

    if (options?.remember === false || !repoId) {
      return;
    }

    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      return;
    }

    const repoExistsInWorkspace = get().repos.some(
      (repo) => repo.id === repoId && repo.workspaceId === workspaceId,
    );
    if (!repoExistsInWorkspace) {
      return;
    }

    rememberLastRepo(workspaceId, repoId);
  },
  setRepoTrustLevel: async (repoId, trustLevel) => {
    try {
      await ipc.setRepoTrustLevel(repoId, trustLevel);
      set((state) => ({
        repos: state.repos.map((repo) =>
          repo.id === repoId
            ? {
                ...repo,
                trustLevel
              }
            : repo
        )
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },
  rescanWorkspace: async (workspaceId, scanDepth) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return null;

    try {
      const updatedWorkspace = await ipc.openWorkspace(
        workspace.rootPath,
        scanDepth ?? workspace.scanDepth,
      );
      set((state) => ({
        workspaces: state.workspaces.map((item) =>
          item.id === updatedWorkspace.id ? updatedWorkspace : item
        ),
        archivedWorkspaces: state.archivedWorkspaces.filter(
          (item) => item.id !== updatedWorkspace.id,
        ),
      }));

      if (get().activeWorkspaceId === workspaceId) {
        await get().loadRepos(workspaceId);
      }

      return updatedWorkspace;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  changeWorkspaceDirectory: async (workspaceId, path) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return null;

    try {
      const updatedWorkspace = await ipc.retargetWorkspace(workspaceId, path);
      set((state) => ({
        workspaces: state.workspaces.map((item) =>
          item.id === workspaceId ? updatedWorkspace : item
        ),
      }));

      if (get().activeWorkspaceId === workspaceId) {
        await get().loadRepos(workspaceId);
      }

      return updatedWorkspace;
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },
  setAllReposTrustLevel: async (trustLevel) => {
    const repos = get().repos;
    if (!repos.length) {
      return;
    }

    try {
      await Promise.all(
        repos.map((repo) => ipc.setRepoTrustLevel(repo.id, trustLevel))
      );
      set((state) => ({
        repos: state.repos.map((repo) => ({
          ...repo,
          trustLevel
        }))
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  }
}));
