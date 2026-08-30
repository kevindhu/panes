import type { Thread } from "../types";

export const CODEX_REMOTE_TURN_ACTIVE_METADATA_KEY = "codexRemoteTurnActive";
export const CODEX_ENGINE_FORK_PENDING_METADATA_KEY = "engineForkPending";
export const CODEX_ENGINE_ROLLBACK_PENDING_METADATA_KEY = "engineRollbackPending";
export const CODEX_COMPATIBILITY_FORK_METADATA_KEY = "codexCompatibilityFork";
export const CODEX_COMPATIBILITY_HISTORY_COMPLETE_METADATA_KEY =
  "codexCompatibilityHistoryComplete";

export function isCodexThreadSyncRequired(
  thread: Thread | null | undefined,
): boolean {
  return (
    thread?.engineId === "codex" &&
    (thread.engineMetadata?.codexSyncRequired === true ||
      thread.engineMetadata?.[CODEX_ENGINE_FORK_PENDING_METADATA_KEY] === true ||
      thread.engineMetadata?.[CODEX_ENGINE_ROLLBACK_PENDING_METADATA_KEY] === true ||
      (thread.engineMetadata?.[CODEX_COMPATIBILITY_FORK_METADATA_KEY] === true &&
        thread.engineMetadata?.[CODEX_COMPATIBILITY_HISTORY_COMPLETE_METADATA_KEY] !== true))
  );
}

export function hasVerifiedCodexCompatibilityHistory(
  thread: Thread | null | undefined,
): boolean {
  return (
    thread?.engineMetadata?.[CODEX_COMPATIBILITY_FORK_METADATA_KEY] !== true ||
    thread.engineMetadata?.[CODEX_COMPATIBILITY_HISTORY_COMPLETE_METADATA_KEY] === true
  );
}

export function hasConfirmedCodexRemoteTurn(
  thread: Thread | null | undefined,
): boolean {
  return (
    thread?.engineId === "codex" &&
    thread.engineMetadata?.[CODEX_REMOTE_TURN_ACTIVE_METADATA_KEY] === true
  );
}
