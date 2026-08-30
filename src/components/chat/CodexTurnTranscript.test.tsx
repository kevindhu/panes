// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTurnSnapshot } from "../../types";

const mockGetCodexTurnSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../../lib/codexIpc", () => ({
  ipc: {
    getCodexTurnSnapshot: mockGetCodexTurnSnapshot,
  },
}));

import {
  CodexTranscriptRenderer,
  CodexTurnTranscript,
  resetCodexTurnSnapshotCacheForTests,
} from "./CodexTurnTranscript";
import { ACTION_HEADER_MAX_CHARS, MessageBlocks } from "./MessageBlocks";

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
        explanation: "Checking the refactored flow before rendering.",
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
        startedJson: JSON.stringify({
          id: "search-1",
          type: "webSearch",
          query: "",
          action: null,
          results: null,
        }),
        completedJson: JSON.stringify({
          id: "search-1",
          type: "webSearch",
          query: "Codex app-server webSearch schema",
          action: { type: "search", queries: ["Codex webSearch", "app-server schema"] },
          results: [{
            type: "text_result",
            domain: "developers.openai.com",
            ref_id: "turn0search0",
            title: "Codex app server",
            url: "https://developers.openai.com/codex/app-server",
            snippet: "Build rich clients with the Codex app-server protocol.",
          }],
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
    vi.clearAllMocks();
    resetCodexTurnSnapshotCacheForTests();
    mockGetCodexTurnSnapshot.mockResolvedValue(null);
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
    expect(button?.textContent).toContain("Searched Codex webSearch +1 more");
    await act(async () => button?.click());
    expect(row?.textContent).toContain("Queries (2)");
    expect(row?.textContent).toContain("Codex webSearch");
    expect(row?.textContent).toContain("app-server schema");
    expect(row?.textContent).toContain("Results (1)");
    expect(row?.textContent).toContain("Codex app server");
    expect(row?.textContent).toContain("developers.openai.com");
    expect(row?.textContent).toContain("Build rich clients with the Codex app-server protocol.");
    expect(row?.textContent).toContain("turn0search0");
    expect(row?.textContent).not.toContain("No output was emitted.");
  });

  it("renders a textless reasoning item as an honest thought record instead of a blank tool", async () => {
    const reasoningSnapshot = snapshot();
    reasoningSnapshot.items = [{
      itemId: "reason-empty",
      itemType: "reasoning",
      status: "completed",
      phase: null,
      firstSourceSequence: 2,
      lastSourceSequence: 3,
      startedAtMs: 1_000,
      completedAtMs: 2_638,
      startedJson: JSON.stringify({ id: "reason-empty", type: "reasoning", summary: [], content: [] }),
      completedJson: JSON.stringify({ id: "reason-empty", type: "reasoning", summary: [], content: [] }),
    }];
    reasoningSnapshot.events = [];
    reasoningSnapshot.chunks = [];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={reasoningSnapshot}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });

    const group = container.querySelector<HTMLElement>(".codex-native-group-header");
    expect(group?.textContent).toContain("Thought");
    expect(group?.textContent).not.toContain("Used 1 tool");
    const row = container.querySelector<HTMLElement>('[data-item-type="reasoning"]');
    expect(row?.textContent).toContain("No readable summary emitted");
    await act(async () => row?.querySelector<HTMLButtonElement>(".codex-native-activity-header")?.click());
    expect(row?.textContent).toContain("Codex reported thinking activity, but did not emit a readable summary");
    expect(row?.textContent).toContain("Raw item lifecycle");
  });

  it("breaks activity groups at each exact steer sequence and exposes its delivery record", async () => {
    const steeredSnapshot = snapshot();
    steeredSnapshot.turn.lastSourceSequence = 8;
    steeredSnapshot.items[1]!.firstSourceSequence = 6;
    steeredSnapshot.items[1]!.lastSourceSequence = 7;
    steeredSnapshot.events = [
      steeredSnapshot.events[0]!,
      {
        id: 4,
        sourceSequence: 4,
        eventKind: "client_request",
        method: "turn/steer",
        requestId: "steer-1",
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: JSON.stringify({
          steerId: "steer-1",
          messageId: "persisted-steer-1",
          status: "submitted",
          display: {
            content: "Focus on failures first.",
            blocks: [{ type: "text", content: "Focus on failures first.", isSteer: true }],
          },
          request: { method: "turn/steer", params: { expectedTurnId: "native-turn-1" } },
        }),
        observedAtMs: 1_500,
      },
      {
        id: 5,
        sourceSequence: 5,
        eventKind: "client_response",
        method: "turn/steer",
        requestId: "steer-1",
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: JSON.stringify({
          steerId: "steer-1",
          messageId: "persisted-steer-1",
          status: "accepted",
          result: { turnId: "native-turn-1" },
        }),
        observedAtMs: 1_510,
      },
      { ...steeredSnapshot.events[1]!, id: 8, sourceSequence: 8 },
    ];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={steeredSnapshot}
          status="completed"
          legacyBlocks={[{
            type: "steer",
            steerId: "persisted-steer-1",
            persistedMessageId: "persisted-steer-1",
            content: "duplicate legacy block",
          }]}
          onApproval={vi.fn()}
        />,
      );
    });

    const directChildren = [...container.querySelector(".codex-native-transcript")!.children];
    const firstGroup = directChildren.findIndex((node) => node.classList.contains("codex-native-group"));
    const steer = directChildren.findIndex((node) => node.classList.contains("codex-native-steer"));
    const secondGroup = directChildren.findIndex((node, index) => index > steer && node.classList.contains("codex-native-group"));
    expect(firstGroup).toBeGreaterThanOrEqual(0);
    expect(steer).toBeGreaterThan(firstGroup);
    expect(secondGroup).toBeGreaterThan(steer);
    expect(container.textContent).toContain("Focus on failures first.");
    expect(container.textContent).not.toContain("duplicate legacy block");

    const delivery = container.querySelector<HTMLDetailsElement>(".codex-native-steer-details");
    await act(async () => delivery?.querySelector<HTMLElement>("summary")?.click());
    expect(delivery?.textContent).toContain("Submitted request");
    expect(delivery?.textContent).toContain("App-server receipt");
  });

  it("renders answered Plan questions between the native activities that surrounded them", async () => {
    const questionedSnapshot = snapshot();
    questionedSnapshot.turn.lastSourceSequence = 8;
    questionedSnapshot.items[1]!.firstSourceSequence = 6;
    questionedSnapshot.items[1]!.lastSourceSequence = 7;
    questionedSnapshot.events = [
      questionedSnapshot.events[0]!,
      {
        id: 4,
        sourceSequence: 4,
        eventKind: "request",
        method: "item/tool/requestUserInput",
        requestId: "request-1",
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: JSON.stringify({
          itemId: "question-1",
          questions: [{ id: "scope", question: "Which scope?" }],
        }),
        observedAtMs: 1_500,
      },
      { ...questionedSnapshot.events[1]!, id: 8, sourceSequence: 8 },
    ];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={questionedSnapshot}
          status="completed"
          legacyBlocks={[{
            type: "approval",
            approvalId: "question-1",
            actionType: "other",
            summary: "Which scope?",
            details: {},
            status: "answered",
            decision: "custom",
          }]}
          onApproval={vi.fn()}
        />,
      );
    });

    const transcript = container.querySelector(".codex-native-transcript")!;
    const directChildren = [...transcript.children];
    const firstGroup = directChildren.findIndex((node) => node.classList.contains("codex-native-group"));
    const approval = directChildren.findIndex((node) => node.classList.contains("codex-native-approval"));
    const secondGroup = directChildren.findIndex(
      (node, index) => index > approval && node.classList.contains("codex-native-group"),
    );
    expect(firstGroup).toBeGreaterThanOrEqual(0);
    expect(approval).toBeGreaterThan(firstGroup);
    expect(secondGroup).toBeGreaterThan(approval);
    expect(transcript.querySelectorAll('[data-approval-id="question-1"]')).toHaveLength(1);
    expect(transcript.querySelector(".codex-native-supplements")).toBeNull();
  });

  it("renders plan progress at the update event instead of above earlier output", async () => {
    const plannedSnapshot = snapshot();
    plannedSnapshot.turn.lastSourceSequence = 7;
    plannedSnapshot.items[1] = {
      ...plannedSnapshot.items[1]!,
      firstSourceSequence: 5,
      lastSourceSequence: 6,
    };
    plannedSnapshot.events = [
      plannedSnapshot.events[0]!,
      {
        id: 4,
        sourceSequence: 4,
        eventKind: "notification",
        method: "turn/plan/updated",
        requestId: null,
        nativeThreadId: "native-thread-1",
        nativeTurnId: "native-turn-1",
        paramsJson: plannedSnapshot.turn.planJson!,
        observedAtMs: 2_000,
      },
      { ...plannedSnapshot.events[1]!, id: 7, sourceSequence: 7 },
    ];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={plannedSnapshot}
          status="completed"
          onApproval={vi.fn()}
        />,
      );
    });

    const directChildren = [...container.querySelector(".codex-native-transcript")!.children];
    const firstGroup = directChildren.findIndex((node) => node.classList.contains("codex-native-group"));
    const progress = directChildren.findIndex((node) => node.classList.contains("codex-native-plan-progress"));
    const secondGroup = directChildren.findIndex(
      (node, index) => index > progress && node.classList.contains("codex-native-group"),
    );
    expect(firstGroup).toBeGreaterThanOrEqual(0);
    expect(progress).toBeGreaterThan(firstGroup);
    expect(secondGroup).toBeGreaterThan(progress);
    expect(directChildren[progress]?.getAttribute("data-source-sequence")).toBe("4");
  });

  it("embeds generated, viewed, dynamic-tool, and MCP images in native activity rows", async () => {
    const imageSnapshot = snapshot();
    imageSnapshot.turn.planJson = null;
    imageSnapshot.items = [
      {
        itemId: "generated-1",
        itemType: "imageGeneration",
        status: "completed",
        phase: null,
        firstSourceSequence: 1,
        lastSourceSequence: 1,
        startedAtMs: 1_000,
        completedAtMs: 1_100,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "generated-1",
          type: "imageGeneration",
          status: "completed",
          result: "https://cdn.example.com/generated.png",
          revisedPrompt: "Generated poster",
        }),
      },
      {
        itemId: "view-1",
        itemType: "imageView",
        status: "completed",
        phase: null,
        firstSourceSequence: 2,
        lastSourceSequence: 2,
        startedAtMs: 1_100,
        completedAtMs: 1_200,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "view-1",
          type: "imageView",
          path: "C:\\workspace\\screenshots\\page.png",
        }),
      },
      {
        itemId: "dynamic-1",
        itemType: "dynamicToolCall",
        status: "completed",
        phase: null,
        firstSourceSequence: 3,
        lastSourceSequence: 3,
        startedAtMs: 1_200,
        completedAtMs: 1_300,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "dynamic-1",
          type: "dynamicToolCall",
          tool: "render",
          status: "completed",
          contentItems: [{
            type: "inputImage",
            imageUrl: "https://cdn.example.com/dynamic.webp",
          }],
        }),
      },
      {
        itemId: "mcp-1",
        itemType: "mcpToolCall",
        status: "completed",
        phase: null,
        firstSourceSequence: 4,
        lastSourceSequence: 4,
        startedAtMs: 1_300,
        completedAtMs: 1_400,
        startedJson: null,
        completedJson: JSON.stringify({
          id: "mcp-1",
          type: "mcpToolCall",
          server: "design",
          tool: "preview",
          status: "completed",
          result: {
            content: [{
              type: "image",
              imageUrl: "https://cdn.example.com/mcp.jpg",
              mimeType: "image/jpeg",
            }],
          },
        }),
      },
    ];
    imageSnapshot.events = [];
    imageSnapshot.chunks = [];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={imageSnapshot}
          status="completed"
          workspaceRootPath="C:\\workspace"
          onApproval={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll(".chat-image-gallery")).toHaveLength(4);
    expect(
      [...container.querySelectorAll<HTMLImageElement>(".chat-image-gallery-thumbnail")]
        .map((image) => image.src),
    ).toEqual([
      "https://cdn.example.com/generated.png",
      "https://cdn.example.com/dynamic.webp",
      "https://cdn.example.com/mcp.jpg",
    ]);
    expect(container.querySelector('[data-item-type="imageView"] .chat-image-gallery-card')).not.toBeNull();
    expect(container.querySelector('[data-item-type="imageView"] .chat-image-figure-viewed')).not.toBeNull();
    expect(container.querySelector('[data-item-type="imageGeneration"] .chat-image-figure-viewed')).toBeNull();

    const imageViewHeader = container.querySelector<HTMLButtonElement>(
      '[data-item-type="imageView"] .codex-native-activity-header',
    );
    expect(imageViewHeader?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => imageViewHeader?.click());
    expect(imageViewHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-item-type="imageView"] .chat-image-gallery-card')).toBeNull();
    await act(async () => imageViewHeader?.click());
    expect(container.querySelector('[data-item-type="imageView"] .chat-image-gallery-card')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        '[data-item-type="imageGeneration"] .chat-image-gallery-card',
      )?.click();
    });
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "https://cdn.example.com/generated.png",
    );
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
    const progress = container.querySelector(".codex-native-plan-progress");
    expect(progress?.textContent).toContain("Checking the refactored flow before rendering.");
    expect(progress?.textContent).toContain("Inspect");
    expect(progress?.textContent).toContain("Render");
    expect(footer?.textContent).toContain("3.0s");
    expect(footer?.textContent).toContain("16 tokens");
    expect(footer?.textContent).toContain("1/2 steps");
    expect(footer?.textContent).toContain("Completed");
  });

  it("settles stale native activity when the message has been stopped", async () => {
    const stoppedSnapshot = snapshot();
    stoppedSnapshot.turn.status = "in_progress";
    stoppedSnapshot.turn.completedAtMs = null;
    stoppedSnapshot.turn.completedJson = null;
    stoppedSnapshot.turn.lastEventAtMs = 2_400;
    stoppedSnapshot.turn.lastSourceSequence = 4;
    stoppedSnapshot.events = [stoppedSnapshot.events[0]!];
    stoppedSnapshot.items = [{
      ...stoppedSnapshot.items[1]!,
      status: "in_progress",
      lastSourceSequence: 4,
      completedAtMs: null,
      completedJson: null,
    }];

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={stoppedSnapshot}
          status="interrupted"
          onApproval={vi.fn()}
        />,
      );
    });

    expect(container.querySelector(".codex-native-group-header")?.textContent)
      .toContain("Stopped while using 1 tool");
    expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label="Stopped"]')).not.toHaveLength(0);

    const footer = container.querySelector(".codex-native-footer");
    expect(footer?.classList.contains("interrupted")).toBe(true);
    expect(footer?.textContent).toContain("Stopped");
    expect(footer?.textContent).not.toContain("Searching the web");

    const searchRow = container.querySelector<HTMLElement>('[data-item-type="webSearch"]');
    await act(async () => searchRow?.querySelector<HTMLButtonElement>("button")?.click());
    expect(searchRow?.textContent).toContain("Search stopped before Codex returned results.");
  });

  it("renders the authoritative completed plan prominently and reports it to the handoff", async () => {
    const planSnapshot = snapshot();
    planSnapshot.items = [{
      itemId: "plan-1",
      itemType: "plan",
      status: "completed",
      phase: null,
      firstSourceSequence: 2,
      lastSourceSequence: 3,
      startedAtMs: 1_200,
      completedAtMs: 2_000,
      startedJson: JSON.stringify({
        id: "plan-1",
        type: "plan",
        text: "<proposed_plan>\nStale draft\n</proposed_plan>",
      }),
      completedJson: JSON.stringify({
        id: "plan-1",
        type: "plan",
        text: "<proposed_plan>\n# Final plan\n\n1. Inspect\n2. Implement\n</proposed_plan>",
      }),
    }];
    planSnapshot.events = [];
    planSnapshot.chunks = [{
      id: 1,
      eventId: 1,
      itemId: "plan-1",
      sourceSequence: 2,
      chunkIndex: 0,
      streamKind: "plan",
      summaryIndex: null,
      content: "Streamed draft",
      metadataJson: null,
      observedAtMs: 1_500,
    }];
    const onPlanText = vi.fn();

    await act(async () => {
      root.render(
        <CodexTranscriptRenderer
          snapshot={planSnapshot}
          status="completed"
          onApproval={vi.fn()}
          onPlanText={onPlanText}
        />,
      );
    });

    const plan = container.querySelector(".codex-native-final-plan");
    expect(plan?.textContent).toContain("Final plan");
    expect(plan?.textContent).toContain("Inspect");
    expect(plan?.textContent).not.toContain("Stale draft");
    expect(plan?.textContent).not.toContain("Streamed draft");
    expect(plan?.textContent).not.toContain("proposed_plan");
    expect(onPlanText).toHaveBeenLastCalledWith(
      "<proposed_plan>\n# Final plan\n\n1. Inspect\n2. Implement\n</proposed_plan>",
    );

    const toggle = plan?.querySelector<HTMLButtonElement>(
      ".codex-native-final-plan-toggle",
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(plan?.textContent).not.toContain("Final plan");
    await act(async () => toggle?.click());
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(plan?.textContent).toContain("Final plan");
  });

  it("repaints a revisited native turn from memory before its refresh returns", async () => {
    mockGetCodexTurnSnapshot.mockResolvedValueOnce(snapshot());

    await act(async () => {
      root.render(
        <CodexTurnTranscript
          messageId="assistant-1"
          blocks={[]}
          status="completed"
          refreshSequence={0}
          onApproval={vi.fn()}
        />,
      );
    });
    expect(container.textContent).toContain("Used 2 tools");

    await act(async () => root.unmount());
    root = createRoot(container);
    mockGetCodexTurnSnapshot.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      root.render(
        <CodexTurnTranscript
          messageId="assistant-1"
          blocks={[]}
          status="completed"
          refreshSequence={0}
          onApproval={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Used 2 tools");
    expect(mockGetCodexTurnSnapshot).toHaveBeenLastCalledWith("assistant-1", 6);
  });

  it("keeps pre-v2 command and web-search rows expandable when they have no output", async () => {
    await act(async () => {
      root.render(
        <MessageBlocks
          status="completed"
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
              details: {
                query: "Codex app-server webSearch",
                action: { type: "search", queries: ["Codex app-server webSearch"] },
                results: [{
                  type: "text_result",
                  domain: "developers.openai.com",
                  ref_id: "turn0search0",
                  title: "Codex app server",
                  url: "https://developers.openai.com/codex/app-server",
                  snippet: "Official protocol documentation.",
                }],
              },
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
      .find((button) => button.textContent?.includes("Searched Codex app-server webSearch"));
    expect(command?.getAttribute("aria-expanded")).toBe("false");
    expect(search?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => command?.click());
    await act(async () => search?.click());
    expect(container.textContent).toContain("New-Item -ItemType Directory -Force scripts | Out-Null");
    expect(container.textContent).toContain("queries:");
    expect(container.textContent).toContain("Codex app-server webSearch");
    expect(container.textContent).toContain("Codex app server");
    expect(container.textContent).toContain("Official protocol documentation.");
    expect(container.textContent).toContain("No output was emitted.");
  });

  it("embeds image results retained in pre-v2 action details", async () => {
    await act(async () => {
      root.render(
        <MessageBlocks
          status="completed"
          onApproval={vi.fn()}
          blocks={[{
            type: "action",
            actionId: "legacy-generated",
            engineActionId: "generated-legacy-1",
            actionType: "other",
            summary: "Generate image",
            details: {
              id: "generated-legacy-1",
              type: "imageGeneration",
              status: "completed",
              result: "https://cdn.example.com/legacy-generated.png",
              revisedPrompt: "Legacy generated image",
            },
            outputChunks: [{
              stream: "stdout",
              content: "data:image/png;base64," + "A".repeat(256),
            }],
            status: "done",
          }]}
        />,
      );
    });

    expect(container.querySelector(".legacy-action-images img")?.getAttribute("src")).toBe(
      "https://cdn.example.com/legacy-generated.png",
    );
    const groupHeader = container.querySelector<HTMLElement>(".action-group > .msg-block-header");
    await act(async () => groupHeader?.click());
    const actionHeader = container.querySelector<HTMLElement>(".msg-block-header--compact");
    await act(async () => actionHeader?.click());
    expect(container.textContent).not.toContain("AAAA");
  });

  it("bounds long action headers while keeping the complete command in expanded details", async () => {
    const fullCommand = `powershell.exe -Command '${"Copy-Item -LiteralPath C:\\very\\long\\source ".repeat(12)}END-SENTINEL'`;
    await act(async () => {
      root.render(
        <MessageBlocks
          onApproval={vi.fn()}
          blocks={[{
            type: "action",
            actionId: "long-command",
            actionType: "command",
            summary: fullCommand,
            details: { command: fullCommand },
            outputChunks: [],
            status: "done",
          }]}
        />,
      );
    });

    const groupHeader = container.querySelector<HTMLElement>(".action-group > .msg-block-header");
    await act(async () => groupHeader?.click());

    const title = container.querySelector<HTMLElement>(".msg-action-title");
    expect(title?.getAttribute("title")).toBe(fullCommand);
    expect(title?.textContent?.length).toBeLessThanOrEqual(ACTION_HEADER_MAX_CHARS + 1);
    expect(title?.textContent).not.toContain("END-SENTINEL");
    expect(title?.textContent?.endsWith("…")).toBe(true);

    const actionHeader = container.querySelector<HTMLElement>(".msg-block-header--compact");
    await act(async () => actionHeader?.click());
    expect(container.querySelector(".legacy-action-input .action-output-pre")?.textContent).toBe(fullCommand);
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
