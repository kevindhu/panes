import type { Thread } from "../types";
import {
  hasVerifiedCodexCompatibilityHistory,
  isCodexThreadSyncRequired,
} from "./codexThreadRuntime";

export function hasCodexTranscriptForNativeTools(
  thread: Thread | null | undefined,
): boolean {
  if (!thread) {
    return false;
  }

  if (thread.engineMetadata?.codexTranscriptImported !== false) {
    return true;
  }

  return !isCodexThreadSyncRequired(thread) && thread.messageCount > 0;
}

export function hasCodexLocalHistoryForMessageEditing(
  thread: Thread | null | undefined,
): boolean {
  return (
    hasCodexTranscriptForNativeTools(thread) &&
    !isCodexThreadSyncRequired(thread)
  );
}

export function canUseNativeCodexHistoryTools(
  thread: Thread | null | undefined,
  busy = false,
): boolean {
  return (
    canForkCodexMessageHistory(thread) &&
    !busy
  );
}

export function canForkCodexMessageHistory(
  thread: Thread | null | undefined,
): boolean {
  return (
    thread?.engineId === "codex" &&
    !!thread.engineThreadId &&
    hasVerifiedCodexCompatibilityHistory(thread) &&
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
