import { describe, expect, it } from "vitest";
import type { Thread } from "../types";
import {
  hasConfirmedCodexRemoteTurn,
  isCodexThreadSyncRequired,
} from "./codexThreadRuntime";

function makeThread(
  engineMetadata: Record<string, unknown>,
  engineId: Thread["engineId"] = "codex",
): Thread {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    repoId: null,
    engineId,
    modelId: "gpt-5.4",
    engineThreadId: "engine-thread-1",
    engineMetadata,
    title: "Thread",
    status: "streaming",
    messageCount: 1,
    totalTokens: 0,
    createdAt: "2026-07-10T09:00:00.000Z",
    lastActivityAt: "2026-07-10T09:01:00.000Z",
  };
}

describe("Codex thread runtime metadata", () => {
  it("recognizes only typed Codex sync state", () => {
    expect(isCodexThreadSyncRequired(makeThread({ codexSyncRequired: true }))).toBe(true);
    expect(isCodexThreadSyncRequired(makeThread({ codexSyncRequired: "true" }))).toBe(false);
    expect(isCodexThreadSyncRequired(makeThread({ codexSyncRequired: true }, "claude"))).toBe(
      false,
    );
  });

  it("does not infer an active remote turn from a diagnostic reason", () => {
    expect(
      hasConfirmedCodexRemoteTurn(makeThread({ codexRemoteTurnActive: true })),
    ).toBe(true);
    expect(
      hasConfirmedCodexRemoteTurn(
        makeThread({
          codexSyncRequired: true,
          codexSyncReason: "remote thread has an active turn",
        }),
      ),
    ).toBe(false);
    expect(
      hasConfirmedCodexRemoteTurn(makeThread({ codexRemoteTurnActive: "true" })),
    ).toBe(false);
  });
});
