// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTurnSnapshot } from "../../types";
import { CodexTranscriptRenderer } from "./CodexTurnTranscript";
import { MessageBlocks } from "./MessageBlocks";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === "messageBlocks.actionGroup.summary") return `${values?.count ?? 0} actions completed`;
      if (key.startsWith("messageBlocks.actionGroup.types.")) return key.split(".").at(-1) ?? "action";
      if (key === "messageBlocks.actionGroup.errorCount") return `${values?.count ?? 0} failed`;
      return key;
    },
  }),
}));

function snapshot(): CodexTurnSnapshot {
  const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'New-Item -ItemType Directory -Force scripts | Out-Null\'';
  return {
    turn: {
      id: "assistant-1",
      threadId: "thread-1",
      messageId: "assistant-1",
      nativeThreadId: "native-thread-1",
      nativeTurnId: "native-turn-1",
      status: "completed",
      startedAtMs: 1_000,
      completedAtMs: 4_000,
      firstEventAtMs: 1_000,
      lastEventAtMs: 4_000,
      lastSourceSequence: 6,
      startedJson: null,
      completedJson: null,
      planJson: JSON.stringify({
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Render", status: "inProgress" },
        ],
      }),
      usageJson: JSON.stringify({
        total: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
        last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, totalTokens: 16 },
      }),
    },
    items: [
      {
        itemId: "command-1",
        itemType: "commandExecution",
        status: "completed",
        phase: null,
        firstSourceSequence: 2,
        lastSourceSequence: 3,
        startedAtMs: 1_200,
        completedAtMs: 1_405,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "command-1",
          type: "commandExecution",
          command,
          cwd: "C:\\workspace",
          status: "completed",
          aggregatedOutput: "",
          exitCode: 0,
          durationMs: 205,
        }),
      },
      {
        itemId: "search-1",
        itemType: "webSearch",
        status: "completed",
        phase: null,
        firstSourceSequence: 4,
        lastSourceSequence: 5,
        startedAtMs: 2_000,
        completedAtMs: 2_100,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "search-1",
          type: "webSearch",
          query: "Codex app-server webSearch schema",
          action: { type: "search", queries: ["Codex webSearch", "app-server schema"] },
          status: "completed",
        }),
      },
    ],
    events: [
      {
        id: 1,
        sourceSequence: 1,
        eventKind: "notification",
        method: "turn/started",
        requestId: null,
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: "{ \"turn\": { \"status\": \"inProgress\" } }",
        observedAtMs: 1_000,
      },
      {
        id: 6,
        sourceSequence: 6,
        eventKind: "notification",
        method: "turn/completed",
        requestId: null,
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: "{ \"turn\": { \"status\": \"completed\" } }",
        observedAtMs: 4_000,
      },
    ],
    chunks: [],
  };
}

describe("CodexTranscriptRenderer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("always expands a zero-output command and exposes its complete invocation", async () => {
    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={snapshot()}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".codex-native-group-header")?.textContent).toContain("Used 2 tools");
    const row = container.querySelector<HTMLElement>('[data-item-type="commandExecution"]');
    const button = row?.querySelector<HTMLButtonElement>(".codex-native-activity-header");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.textContent).toContain("New-Item -ItemType Directory -Force scripts");

    await act(async () => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(row?.textContent).toContain("powershell.exe");
    expect(row?.textContent).toContain("New-Item -ItemType Directory -Force scripts | Out-Null");
    expect(row?.textContent).toContain("C:\\workspace");
    expect(row?.textContent).toContain("No output was emitted.");
    expect(row?.textContent).toContain("Exit code 0");
  });

  it("shows the actual web-search query and expandable execution details", async () => {
    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={snapshot()}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });

    const row = container.querySelector<HTMLElement>('[data-item-type="webSearch"]');
    const button = row?.querySelector<HTMLButtonElement>(".codex-native-activity-header");
    expect(button?.textContent).toContain("Searched Codex app-server webSearch schema");
    await act(async () => button?.click());
    expect(row?.textContent).toContain("Query");
    expect(row?.textContent).toContain("Codex app-server webSearch schema");
    expect(row?.textContent).toContain("Search action");
    expect(row?.textContent).toContain("Codex webSearch");
  });

  it("renders elapsed time, per-turn tokens, plan progress, and completion state", async () => {
    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={snapshot()}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });
    const footer = container.querySelector(".codex-native-footer");
    expect(footer?.textContent).toContain("3.0s");
    expect(footer?.textContent).toContain("16 tokens");
    expect(footer?.textContent).toContain("1/2 steps");
    expect(footer?.textContent).toContain("Completed");
  });

  it("keeps pre-v2 command and web-search rows expandable when they have no output", async () => {
    await act(async () => {
      root.render(
        <MessageBlocks
          status="completed"
          messageRole="assistant"
          onApproval={vi.fn()}
          blocks={[
            {
              type: "action",
              actionId: "legacy-command",
              actionType: "command",
              summary: "Run command",
              details: { command: "New-Item -ItemType Directory -Force scripts | Out-Null" },
              outputChunks: [],
              status: "done",
            },
            {
              type: "action",
              actionId: "legacy-search",
              actionType: "search",
              summary: "Web search",
              details: { query: "Codex app-server webSearch", action: { type: "search" } },
              outputChunks: [],
              status: "done",
            },
          ]}
        />,
      );
    });

    const group = [...container.querySelectorAll<HTMLElement>(".msg-block-header")]
      .find((button) => button.textContent?.includes("actions"));
    if (group?.getAttribute("aria-expanded") === "false") await act(async () => group.click());

    const command = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((button) => button.textContent?.includes("Run command"));
    const search = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((button) => button.textContent?.includes("Web search"));
    expect(command?.getAttribute("aria-expanded")).toBe("false");
    expect(search?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => command?.click());
    await act(async () => search?.click());
    expect(container.textContent).toContain("New-Item -ItemType Directory -Force scripts | Out-Null");
    expect(container.textContent).toContain("query: Codex app-server webSearch");
    expect(container.textContent).toContain("No output was emitted.");
  });

  it("keeps large output out of the DOM preview while allowing the complete value to be revealed", async () => {
    const large = `${"x".repeat(170_000)}END-SENTINEL`;
    const largeSnapshot = snapshot();
    largeSnapshot.chunks = [{
      id: 3,
      eventId: 3,
      itemId: "command-1",
      sourceSequence: 3,
      chunkIndex: 0,
      streamKind: "command_output",
      summaryIndex: null,
      content: large,
      metadataJson: JSON.stringify({ stream: "stdout" }),
      observedAtMs: 1_300,
    }];
    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={largeSnapshot}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });
    const row = container.querySelector<HTMLElement>('[data-item-type="commandExecution"]');
    await act(async () => row?.querySelector<HTMLButtonElement>(".codex-native-activity-header")?.click());
    expect(row?.textContent).not.toContain("END-SENTINEL");
    const showAll = row?.querySelector<HTMLButtonElement>(".codex-native-show-all");
    expect(showAll?.textContent).toContain("Show all");
    await act(async () => showAll?.click());
    expect(row?.textContent).toContain("END-SENTINEL");
  });
});
