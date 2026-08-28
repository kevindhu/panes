import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  canEditCodexMessageHistory,
  canUseNativeCodexHistoryTools,
  hasCodexLocalHistoryForMessageEditing,
  hasCodexTranscriptForNativeTools,
} from "./codexThreadCapabilities";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    workspaceId: "ws-1",
    repoId: null,
    engineId: "codex",
    modelId: "gpt-5",
    engineThreadId: "engine-thread-1",
    engineMetadata: {},
    title: "Thread",
    status: "completed",
    messageCount: 3,
    totalTokens: 0,
    createdAt: "2026-05-19T00:00:00.000Z",
    lastActivityAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("codexThreadCapabilities", () => {
  it("treats codex threads as transcript-ready when the import flag is not explicitly false", () => {
    expect(
      hasCodexTranscriptForNativeTools(
        makeThread({ engineMetadata: { codexSyncRequired: true } }),
      ),
    ).toBe(true);
  });

  it("allows native history tools for imported fallback transcripts with local messages", () => {
    expect(
      hasCodexTranscriptForNativeTools(
        makeThread({
          engineMetadata: {
            codexTranscriptImported: false,
            codexSyncRequired: false,
          },
          messageCount: 2,
        }),
      ),
    ).toBe(true);
  });

  it("blocks local-history editing while codex sync is still required", () => {
    const thread = makeThread({
      engineMetadata: {
        codexTranscriptImported: true,
        codexSyncRequired: true,
      },
    });

    expect(hasCodexLocalHistoryForMessageEditing(thread)).toBe(false);
    expect(canEditCodexMessageHistory(thread, false)).toBe(false);
  });

  it("requires an idle thread with an engine thread id for native history tools", () => {
    expect(canUseNativeCodexHistoryTools(makeThread(), false)).toBe(true);
    expect(canUseNativeCodexHistoryTools(makeThread(), true)).toBe(false);
    expect(
      canUseNativeCodexHistoryTools(
        makeThread({ engineThreadId: null }),
        false,
      ),
    ).toBe(false);
  });
});
