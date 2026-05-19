import type { Thread } from "../types";

export function hasCodexTranscriptForNativeTools(
  thread: Thread | null | undefined,
): boolean {
  if (!thread) {
    return false;
  }

  if (thread.engineMetadata?.codexTranscriptImported !== false) {
    return true;
  }

  return thread.engineMetadata?.codexSyncRequired !== true && thread.messageCount > 0;
}

export function hasCodexLocalHistoryForMessageEditing(
  thread: Thread | null | undefined,
): boolean {
  return (
    hasCodexTranscriptForNativeTools(thread) &&
    thread?.engineMetadata?.codexSyncRequired !== true
  );
}

export function canUseNativeCodexHistoryTools(
  thread: Thread | null | undefined,
  busy = false,
): boolean {
  return (
    thread?.engineId === "codex" &&
    !!thread.engineThreadId &&
    !busy &&
    hasCodexTranscriptForNativeTools(thread)
  );
}

export function canEditCodexMessageHistory(
  thread: Thread | null | undefined,
  busy = false,
): boolean {
  return (
    thread?.engineId === "codex" &&
    !!thread.engineThreadId &&
    !busy &&
    hasCodexLocalHistoryForMessageEditing(thread)
  );
}
