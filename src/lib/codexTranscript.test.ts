import { describe, expect, it } from "vitest";
import type {
  CodexItemStreamChunkRecord,
  CodexTurnEventRecord,
  CodexTurnItemRecord,
  CodexTurnSnapshot,
} from "../types";
import {
  commandOutputParts,
  interleaveLegacyTranscriptBlocks,
  mergeCodexTurnSnapshot,
  projectCodexTranscript,
  reasoningText,
  webSearchDetails,
} from "./codexTranscript";

function turn(lastSourceSequence: number): CodexTurnSnapshot["turn"] {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    messageId: "assistant-1",
    nativeThreadId: "native-thread-1",
    nativeTurnId: "native-turn-1",
    status: lastSourceSequence >= 8 ? "completed" : "in_progress",
    startedAtMs: 1_000,
    completedAtMs: lastSourceSequence >= 8 ? 4_000 : null,
    firstEventAtMs: 1_000,
    lastEventAtMs: 4_000,
    lastSourceSequence,
    startedJson: null,
    completedJson: null,
    planJson: JSON.stringify({
      explanation: "Tracking the current implementation sequence.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Render", status: "inProgress" },
      ],
    }),
    usageJson: JSON.stringify({
      total: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 40, totalTokens: 160 },
      last: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 4, totalTokens: 16 },
      modelContextWindow: 258_400,
    }),
  };
}

function item(
  itemId: string,
  itemType: string,
  firstSourceSequence: number,
  payload: Record<string, unknown>,
): CodexTurnItemRecord {
  return {
    itemId,
    itemType,
    status: String(payload.status ?? "completed"),
    phase: typeof payload.phase === "string" ? payload.phase : null,
    firstSourceSequence,
    lastSourceSequence: firstSourceSequence + 1,
    startedAtMs: 1_000 + firstSourceSequence,
    completedAtMs: 1_100 + firstSourceSequence,
    startedJson: null,
    completedJson: JSON.stringify({ id: itemId, type: itemType, ...payload }),
  };
}

function event(
  id: number,
  sourceSequence: number,
  method: string,
  params: Record<string, unknown>,
  eventKind: CodexTurnEventRecord["eventKind"] = "notification",
): CodexTurnEventRecord {
  return {
    id,
    sourceSequence,
    eventKind,
    method,
    requestId: null,
    nativeThreadId: "native-thread-1",
    nativeTurnId: "native-turn-1",
    paramsJson: JSON.stringify(params),
    observedAtMs: 1_000 + sourceSequence,
  };
}

function chunk(
  id: number,
  sourceSequence: number,
  itemId: string,
  content: string,
  stream = "stdout",
): CodexItemStreamChunkRecord {
  return {
    id,
    eventId: id,
    itemId,
    sourceSequence,
    chunkIndex: 0,
    streamKind: "command_output",
    summaryIndex: null,
    content,
    metadataJson: JSON.stringify({ stream }),
    observedAtMs: 1_000 + sourceSequence,
  };
}

describe("Codex transcript projection", () => {
  it("keeps zero-output commands and web searches explicit and expandable", () => {
    const fullCommand = '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'New-Item -ItemType Directory -Force scripts | Out-Null\'';
    const snapshot: CodexTurnSnapshot = {
      turn: turn(8),
      items: [
        item("cmd-1", "commandExecution", 2, {
          command: fullCommand,
          cwd: "C:\\workspace",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "",
        }),
        item("search-1", "webSearch", 4, {
          query: "Codex app-server ThreadItem schema",
          action: { type: "search", queries: ["Codex app-server", "ThreadItem schema"] },
          status: "completed",
        }),
        item("agent-1", "agentMessage", 6, {
          text: "Finished.",
          phase: "final_answer",
          status: "completed",
        }),
      ],
      chunks: [],
      events: [
        event(1, 1, "turn/started", { turn: { status: "inProgress" } }),
        event(8, 8, "turn/completed", { turn: { status: "completed" } }),
      ],
    };

    const projected = projectCodexTranscript(snapshot);
    const activities = projected.entries.filter((entry) => entry.kind === "activity");
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({
      itemType: "commandExecution",
      title: fullCommand,
      status: "done",
    });
    expect(commandOutputParts(activities[0]!)).toEqual([]);
    expect(activities[1]).toMatchObject({
      itemType: "webSearch",
      title: "Searched Codex app-server +1 more",
    });
    expect(projected.entries.at(-1)).toMatchObject({ kind: "message", text: "Finished." });
    expect(projected.usage?.turn).toMatchObject({ input: 12, cachedInput: 2, output: 4, total: 16 });
    expect(projected.usage?.thread?.total).toBe(160);
    expect(projected.plan).toMatchObject({
      completed: 1,
      total: 2,
      activeStep: "Render",
      explanation: "Tracking the current implementation sequence.",
    });
  });

  it("places plan progress at its native source sequence instead of hoisting it", () => {
    const snapshot: CodexTurnSnapshot = {
      turn: turn(7),
      items: [
        item("cmd-before-plan", "commandExecution", 2, {
          command: "inspect",
          status: "completed",
          exitCode: 0,
        }),
        item("answer-after-plan", "agentMessage", 5, {
          text: "Continuing after the plan update.",
          status: "completed",
        }),
      ],
      chunks: [],
      events: [
        event(1, 1, "turn/started", { turn: { status: "inProgress" } }),
        event(4, 4, "turn/plan/updated", JSON.parse(turn(7).planJson!)),
        event(7, 7, "turn/completed", { turn: { status: "completed" } }),
      ],
    };

    expect(projectCodexTranscript(snapshot).entries.map((entry) => [entry.kind, entry.sequence])).toEqual([
      ["activity", 2],
      ["planProgress", 4],
      ["message", 5],
    ]);
  });

  it("uses the authoritative completed web-search payload when the started item is empty", () => {
    const search = item("search-real", "webSearch", 2, {});
    search.startedJson = JSON.stringify({
      id: "search-real",
      type: "webSearch",
      query: "",
      action: null,
      results: null,
    });
    search.completedJson = JSON.stringify({
      id: "search-real",
      type: "webSearch",
      query: "Shiro no Yakata Zell2323 ...",
      action: {
        type: "search",
        query: null,
        queries: ["Shiro no Yakata game", "site:zell23.livedoor.blog シロノヤカタ"],
      },
      results: [{
        type: "text_result",
        domain: "zell23.livedoor.blog",
        ref_id: "turn1search2",
        title: "ぶるーすきん工場",
        url: "https://zell23.livedoor.blog/?p=5",
        snippet: "The developer discussed Shiro no Yakata.",
      }],
    });
    const snapshot: CodexTurnSnapshot = {
      turn: turn(4),
      events: [],
      chunks: [],
      items: [search],
    };

    const activity = projectCodexTranscript(snapshot).entries.find(
      (entry) => entry.kind === "activity",
    );
    expect(activity).toMatchObject({
      title: "Searched Shiro no Yakata game +1 more",
      subtitle: "1 result",
      payload: {
        query: "Shiro no Yakata Zell2323 ...",
        action: { type: "search" },
      },
    });
    expect(activity?.kind === "activity" && webSearchDetails(activity.payload)).toEqual({
      actionType: "search",
      query: "Shiro no Yakata Zell2323 ...",
      queries: ["Shiro no Yakata game", "site:zell23.livedoor.blog シロノヤカタ"],
      results: [{
        title: "ぶるーすきん工場",
        url: "https://zell23.livedoor.blog/?p=5",
        domain: "zell23.livedoor.blog",
        snippet: "The developer discussed Shiro no Yakata.",
        refId: "turn1search2",
        resultType: "text_result",
        raw: expect.objectContaining({ ref_id: "turn1search2" }),
      }],
    });
  });

  it("merges committed incremental slices deterministically", () => {
    const commandStarted = item("cmd-1", "commandExecution", 2, {
      command: "printf hello",
      status: "inProgress",
    });
    commandStarted.completedJson = null;
    commandStarted.startedJson = JSON.stringify({
      id: "cmd-1",
      type: "commandExecution",
      command: "printf hello",
      status: "inProgress",
    });
    commandStarted.lastSourceSequence = 2;
    commandStarted.completedAtMs = null;

    const initial: CodexTurnSnapshot = {
      turn: turn(2),
      events: [event(1, 1, "turn/started", {}), event(2, 2, "item/started", {})],
      items: [commandStarted],
      chunks: [],
    };
    const completed = item("cmd-1", "commandExecution", 2, {
      command: "printf hello",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "hello\n",
    });
    completed.lastSourceSequence = 4;
    const tail: CodexTurnSnapshot = {
      turn: turn(4),
      events: [event(3, 3, "item/commandExecution/outputDelta", { delta: "hello\n" }), event(4, 4, "item/completed", {})],
      items: [completed],
      chunks: [chunk(3, 3, "cmd-1", "hello\n")],
    };

    const merged = mergeCodexTurnSnapshot(initial, tail);
    expect(merged.events.map((entry) => entry.sourceSequence)).toEqual([1, 2, 3, 4]);
    expect(merged.items).toHaveLength(1);
    expect(merged.items[0]?.completedJson).toContain("completed");
    expect(merged.chunks.map((entry) => entry.content)).toEqual(["hello\n"]);
    expect(mergeCodexTurnSnapshot(merged, tail)).toEqual(merged);
  });

  it("rejects a conflicting event at an existing source sequence", () => {
    const initial: CodexTurnSnapshot = {
      turn: turn(1),
      events: [event(1, 1, "turn/started", { value: "original" })],
      items: [],
      chunks: [],
    };
    const conflicting: CodexTurnSnapshot = {
      turn: turn(1),
      events: [event(1, 1, "turn/started", { value: "different" })],
      items: [],
      chunks: [],
    };
    expect(() => mergeCodexTurnSnapshot(initial, conflicting)).toThrow("source sequence 1");
  });

  it("preserves stdout and stderr ordering in command details", () => {
    const snapshot: CodexTurnSnapshot = {
      turn: turn(5),
      items: [item("cmd-1", "commandExecution", 2, { command: "test", status: "completed" })],
      events: [],
      chunks: [
        chunk(3, 3, "cmd-1", "one\n", "stdout"),
        chunk(4, 4, "cmd-1", "warning\n", "stderr"),
        chunk(5, 5, "cmd-1", "two\n", "stdout"),
      ],
    };
    const activity = projectCodexTranscript(snapshot).entries.find((entry) => entry.kind === "activity");
    expect(activity && commandOutputParts(activity)).toEqual([
      { stream: "stdout", content: "one\n" },
      { stream: "stderr", content: "warning\n" },
      { stream: "stdout", content: "two\n" },
    ]);
  });

  it("places durable steer markers at their exact native source sequence", () => {
    const snapshot: CodexTurnSnapshot = {
      turn: turn(10),
      items: [
        item("cmd-1", "commandExecution", 2, { command: "inspect", status: "completed" }),
        item("search-1", "webSearch", 6, { query: "after steering", status: "completed" }),
        item("agent-1", "agentMessage", 8, { text: "Done.", phase: "final_answer", status: "completed" }),
      ],
      chunks: [],
      events: [
        event(1, 1, "turn/started", {}),
        event(4, 4, "turn/steer", {
          steerId: "client-steer-1",
          messageId: "persisted-steer-1",
          status: "submitted",
          display: {
            content: "Focus on the failing test.",
            planMode: false,
            blocks: [{ type: "text", content: "Focus on the failing test.", isSteer: true }],
          },
          request: { method: "turn/steer", params: { expectedTurnId: "native-turn-1" } },
        }, "client_request"),
        event(5, 5, "turn/steer", {
          steerId: "client-steer-1",
          messageId: "persisted-steer-1",
          status: "accepted",
          result: { turnId: "native-turn-1" },
        }, "client_response"),
      ],
    };

    const projected = projectCodexTranscript(snapshot);
    expect(projected.entries.map((entry) => [entry.kind, entry.sequence])).toEqual([
      ["activity", 2],
      ["steer", 4],
      ["activity", 6],
      ["message", 8],
    ]);
    const steer = projected.entries.find((entry) => entry.kind === "steer");
    expect(steer).toMatchObject({
      exact: true,
      block: {
        steerId: "client-steer-1",
        persistedMessageId: "persisted-steer-1",
        content: "Focus on the failing test.",
        status: "accepted",
      },
    });
  });

  it("keeps failed steer attempts in the ordered transcript with their error", () => {
    const snapshot: CodexTurnSnapshot = {
      turn: turn(4),
      items: [],
      chunks: [],
      events: [
        event(2, 2, "turn/steer", {
          steerId: "failed-steer",
          messageId: "failed-message",
          status: "submitted",
          display: { content: "Too late", blocks: [] },
        }, "client_request"),
        event(3, 3, "turn/steer", {
          steerId: "failed-steer",
          messageId: "failed-message",
          status: "failed",
          error: "no active turn",
        }, "client_response"),
      ],
    };
    expect(projectCodexTranscript(snapshot).entries).toMatchObject([{
      kind: "steer",
      sequence: 2,
      block: { content: "Too late", status: "failed", error: "no active turn" },
    }]);
  });

  it("uses streamed multipart reasoning when the completed arrays are empty", () => {
    const reasoning = item("reason-1", "reasoning", 2, { summary: [], content: [], status: "completed" });
    reasoning.startedJson = JSON.stringify({ id: "reason-1", type: "reasoning", summary: [], content: [] });
    const chunks: CodexItemStreamChunkRecord[] = [
      { ...chunk(3, 3, "reason-1", ""), streamKind: "reasoning_summary_boundary", summaryIndex: 0, metadataJson: null },
      { ...chunk(4, 4, "reason-1", "Inspecting events."), streamKind: "reasoning_summary", summaryIndex: 0, metadataJson: null },
      { ...chunk(5, 5, "reason-1", ""), streamKind: "reasoning_summary_boundary", summaryIndex: 1, metadataJson: null },
      { ...chunk(6, 6, "reason-1", "Checking ordering."), streamKind: "reasoning_summary", summaryIndex: 1, metadataJson: null },
      { ...chunk(7, 7, "reason-1", "Raw reasoning stream."), streamKind: "reasoning", summaryIndex: null, metadataJson: null },
    ];
    const snapshot: CodexTurnSnapshot = { turn: turn(8), items: [reasoning], chunks, events: [] };
    const activity = projectCodexTranscript(snapshot).entries.find(
      (entry) => entry.kind === "activity" && entry.activityKind === "reasoning",
    );
    expect(activity && reasoningText(activity)).toEqual({
      summarySections: ["Inspecting events.", "Checking ordering."],
      content: "Raw reasoning stream.",
      plan: "",
      hasReadableText: true,
    });
    expect(activity).toMatchObject({ title: "Inspecting events.", subtitle: null });
  });

  it("marks genuinely textless reasoning without inventing hidden content", () => {
    const snapshot: CodexTurnSnapshot = {
      turn: turn(4),
      items: [item("reason-empty", "reasoning", 2, { summary: [], content: [], status: "completed" })],
      chunks: [],
      events: [],
    };
    const activity = projectCodexTranscript(snapshot).entries.find((entry) => entry.kind === "activity");
    expect(activity).toMatchObject({ title: "Thought", subtitle: "No readable summary emitted" });
    expect(activity && reasoningText(activity)).toMatchObject({ hasReadableText: false, summarySections: [], content: "" });
  });

  it("deduplicates persisted steer blocks and estimates only legacy V2 placement", () => {
    const native = projectCodexTranscript({
      turn: turn(5),
      items: [],
      chunks: [],
      events: [
        event(1, 1, "turn/started", {}),
        event(2, 2, "turn/steer", {
          steerId: "client-1",
          messageId: "persisted-1",
          display: { content: "native", blocks: [] },
        }, "client_request"),
        event(3, 3, "item/started", {}),
      ],
    });
    const result = interleaveLegacyTranscriptBlocks(native.entries, native.events, [
      { type: "steer", steerId: "persisted-1", persistedMessageId: "persisted-1", content: "duplicate" },
      { type: "steer", steerId: "legacy-2", content: "legacy", observedAtMs: 1_002.5 },
    ]);
    expect(result.entries.filter((entry) => entry.kind === "steer")).toHaveLength(2);
    expect(result.consumedSteerIds.has("persisted-1")).toBe(true);
    expect(result.consumedSteerIds.has("legacy-2")).toBe(true);
    expect(result.entries.find((entry) => entry.id === "legacy-steer:legacy-2")).toMatchObject({ exact: false });
  });

  it("places persisted approval blocks at their exact native request sequence", () => {
    const native = projectCodexTranscript({
      turn: turn(8),
      items: [
        item("reason-before", "reasoning", 2, { summary: ["Before question"] }),
        item("reason-after", "reasoning", 6, { summary: ["After answer"] }),
      ],
      chunks: [],
      events: [
        event(4, 4, "item/tool/requestUserInput", {
          itemId: "question-1",
          questions: [{ id: "scope", question: "Which scope?" }],
        }, "request"),
      ],
    });
    const result = interleaveLegacyTranscriptBlocks(native.entries, native.events, [{
      type: "approval",
      approvalId: "question-1",
      actionType: "other",
      summary: "Which scope?",
      details: {},
      status: "answered",
      decision: "custom",
    }]);

    expect(result.entries.map((entry) => [entry.kind, entry.sequence])).toEqual([
      ["activity", 2],
      ["approval", 4],
      ["activity", 6],
    ]);
    expect(result.consumedApprovalIds.has("question-1")).toBe(true);
  });

  it("keeps notices and recoverable errors at their native positions", () => {
    const native = projectCodexTranscript({
      turn: turn(12),
      items: [
        item("before", "reasoning", 2, { summary: ["Before"] }),
        item("middle", "reasoning", 6, { summary: ["Middle"] }),
        item("after", "reasoning", 10, { summary: ["After"] }),
      ],
      chunks: [],
      events: [
        event(4, 4, "warning", { message: "Check this" }),
        event(8, 8, "error", { message: "Retrying" }),
      ],
    });
    const result = interleaveLegacyTranscriptBlocks(native.entries, native.events, [
      {
        type: "notice",
        kind: "codex_warning",
        level: "warning",
        title: "Codex warning",
        message: "Check this",
      },
      { type: "error", message: "Retrying" },
    ]);

    expect(result.entries.map((entry) => [entry.kind, entry.sequence])).toEqual([
      ["activity", 2],
      ["notice", 4],
      ["activity", 6],
      ["error", 8],
      ["activity", 10],
    ]);
    expect(result.consumedNoticeKinds.has("codex_warning")).toBe(true);
    expect(result.consumedErrorBlockIndexes.has(1)).toBe(true);
  });

  it("retains every reviewed non-message item and an unknown future item as an activity", () => {
    const itemTypes = [
      "hookPrompt",
      "plan",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "collabAgentToolCall",
      "subAgentActivity",
      "webSearch",
      "imageView",
      "sleep",
      "imageGeneration",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
      "futureToolType",
    ];
    const snapshot: CodexTurnSnapshot = {
      turn: turn(itemTypes.length + 1),
      events: [],
      chunks: [],
      items: itemTypes.map((itemType, index) => item(
        `item-${index}`,
        itemType,
        index + 1,
        { status: "completed", tool: "example", query: "example query" },
      )),
    };
    const activities = projectCodexTranscript(snapshot).entries
      .filter((entry) => entry.kind === "activity")
      .map((entry) => entry.itemType);
    expect(activities).toEqual(itemTypes);
  });
});
