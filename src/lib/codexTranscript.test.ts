import { describe, expect, it } from "vitest";
import type {
  CodexItemStreamChunkRecord,
  CodexTurnEventRecord,
  CodexTurnItemRecord,
  CodexTurnSnapshot,
} from "../types";
import {
  commandOutputParts,
  mergeCodexTurnSnapshot,
  projectCodexTranscript,
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
): CodexTurnEventRecord {
  return {
    id,
    sourceSequence,
    eventKind: "notification",
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
      title: "Searched Codex app-server ThreadItem schema",
    });
    expect(projected.entries.at(-1)).toMatchObject({ kind: "message", text: "Finished." });
    expect(projected.usage?.turn).toMatchObject({ input: 12, cachedInput: 2, output: 4, total: 16 });
    expect(projected.usage?.thread?.total).toBe(160);
    expect(projected.plan).toMatchObject({ completed: 1, total: 2, activeStep: "Render" });
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
