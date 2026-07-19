import type { Thread } from "../types";

export const CODEX_REMOTE_TURN_ACTIVE_METADATA_KEY = "codexRemoteTurnActive";

export function isCodexThreadSyncRequired(
  thread: Thread | null | undefined,
): boolean {
  return (
    thread?.engineId === "codex" &&
    thread.engineMetadata?.codexSyncRequired === true
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
