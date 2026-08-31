import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  compareRepoRoots,
  isWithinRoot,
  normalizeAbsolutePath,
} from "./fileRootUtils";
import {
  DISALLOWED_LOCAL_PREFIX_CHAR_RE,
  TEXT_LINK_PATTERN,
  isLocalFileLinkSyntax,
  parseLocalAbsolutePathTarget,
  parseLocalRelativePathTarget,
  parseLocalUrlTarget,
  trimLinkText,
  tryParseUrl,
} from "./localFileLinkPatterns";
import { ipc } from "./codexIpc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { toast } from "../stores/toastStore";
import type { Repo } from "../types";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
type LinkRepoRoot = Pick<Repo, "id" | "path"> & Partial<Pick<Repo, "isActive">>;

export interface LinkResolutionContext {
  workspaceRoot: string | null;
  repos: LinkRepoRoot[];
  activeRepoId?: string | null;
}

export interface TextLinkMatch {
  text: string;
  startIndex: number;
  endIndex: number;
  kind: LinkTargetKind;
}

export type LinkTargetKind = "local" | "external" | "other";
export type LinkNavigationResult = "system" | "external" | "ignored";

export function classifyLinkTarget(rawTarget: string): LinkTargetKind {
  if (isLocalFileLinkSyntax(rawTarget)) {
    return "local";
  }

  const url = tryParseUrl(rawTarget);
  if (url && EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return "external";
  }

  return "other";
}

export function extractTextLinkMatches(text: string): TextLinkMatch[] {
  const matches: TextLinkMatch[] = [];
  for (const match of text.matchAll(TEXT_LINK_PATTERN)) {
    const rawText = match[0];
    const startIndex = match.index ?? 0;
    const trimmedText = trimLinkText(rawText);
    if (!trimmedText) {
      continue;
    }

    const kind = classifyLinkTarget(trimmedText);
    if (kind === "other") {
      continue;
    }
    if (
      kind === "local" &&
      startIndex > 0 &&
      DISALLOWED_LOCAL_PREFIX_CHAR_RE.test(text[startIndex - 1] ?? "")
    ) {
      continue;
    }

    matches.push({
      text: trimmedText,
      startIndex,
      endIndex: startIndex + trimmedText.length,
      kind,
    });
  }
  return matches;
}

function getOrderedRelativeRoots(context: LinkResolutionContext): string[] {
  const repos = context.repos.slice();
  const activeRepo = context.activeRepoId
    ? repos.find((repo) => repo.id === context.activeRepoId) ?? null
    : null;
  const activeRepos = repos
    .filter((repo) => repo.id !== activeRepo?.id && repo.isActive)
    .sort((left, right) => compareRepoRoots(left, right, null));
  const remainingRepos = repos
    .filter((repo) => repo.id !== activeRepo?.id && !repo.isActive)
    .sort((left, right) => compareRepoRoots(left, right, null));
  const roots = [
    ...(activeRepo ? [activeRepo] : []),
    ...activeRepos,
    ...remainingRepos,
  ].map((repo) => normalizeAbsolutePath(repo.path));

  if (context.workspaceRoot) {
    roots.push(normalizeAbsolutePath(context.workspaceRoot));
  }

  return [...new Set(roots)];
}

export function resolveLocalFileLinkPath(
  rawTarget: string,
  context: LinkResolutionContext,
): string | null {
  const absoluteTarget = parseLocalAbsolutePathTarget(rawTarget) ?? parseLocalUrlTarget(rawTarget);

  const workspaceRoot = context.workspaceRoot ? normalizeAbsolutePath(context.workspaceRoot) : null;
  if (absoluteTarget) {
    const candidateRoots = context.repos
      .slice()
      .sort((left, right) => compareRepoRoots(left, right, context.activeRepoId))
      .map((repo) => normalizeAbsolutePath(repo.path));

    if (workspaceRoot) {
      candidateRoots.push(workspaceRoot);
    }

    const absolutePath = normalizeAbsolutePath(absoluteTarget.path);
    const matchedRoot = candidateRoots.find((root) => isWithinRoot(absolutePath, root));
    if (!matchedRoot) {
      return null;
    }

    const relativePath = absolutePath.slice(matchedRoot.length).replace(/^\/+/, "");
    if (!relativePath) {
      return null;
    }

    return absolutePath;
  }

  const relativeTarget = parseLocalRelativePathTarget(rawTarget);
  if (!relativeTarget) {
    return null;
  }

  for (const root of getOrderedRelativeRoots(context)) {
    const absolutePath = normalizeAbsolutePath(`${root}/${relativeTarget.path}`);
    if (!isWithinRoot(absolutePath, root)) {
      continue;
    }

    return absolutePath;
  }

  return null;
}

export async function navigateLinkTarget(rawTarget: string): Promise<LinkNavigationResult> {
  const targetKind = classifyLinkTarget(rawTarget);
  try {
    if (targetKind === "external") {
      await openExternal(rawTarget);
      return "external";
    }

    if (targetKind !== "local") {
      return "ignored";
    }

    const workspaceState = useWorkspaceStore.getState();
    const activeWorkspaceId = workspaceState.activeWorkspaceId;
    const activeWorkspace = activeWorkspaceId
      ? workspaceState.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
      : null;
    const repos = activeWorkspaceId
      ? workspaceState.repos.filter((repo) => repo.workspaceId === activeWorkspaceId)
      : workspaceState.repos;

    const localPath = resolveLocalFileLinkPath(rawTarget, {
      workspaceRoot: activeWorkspace?.rootPath ?? null,
      repos,
      activeRepoId: workspaceState.activeRepoId,
    });

    const absoluteTarget =
      localPath ??
      (parseLocalAbsolutePathTarget(rawTarget) ?? parseLocalUrlTarget(rawTarget))?.path;
    if (absoluteTarget) {
      await ipc.openPathWithDefaultApp(normalizeAbsolutePath(absoluteTarget));
      return "system";
    }
  } catch {
    toast.error(
      targetKind === "local"
        ? "That file or folder no longer exists."
        : "Could not open link.",
    );
  }

  return "ignored";
}
