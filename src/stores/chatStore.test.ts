import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTurnFinishedEvent } from "../lib/ipc";
import type { ApprovalResponse, Message, StreamEvent, Thread } from "../types";

const mockIpc = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  steerMessage: vi.fn(),
  cancelTurn: vi.fn(),
  getThreadMessagesWindow: vi.fn(),
  getActionOutput: vi.fn(),
  respondApproval: vi.fn(),
  syncThreadFromEngine: vi.fn(),
}));

const mockListenThreadEvents = vi.hoisted(() => vi.fn());
const mockRecordPerfMetric = vi.hoisted(() => vi.fn());
const mockPlanImplementationPromptState = vi.hoisted(() => ({
  arm: vi.fn(),
  disarm: vi.fn(),
}));
const mockToast = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: mockIpc,
  listenThreadEvents: mockListenThreadEvents,
}));

vi.mock("../lib/perfTelemetry", () => ({
  recordPerfMetric: mockRecordPerfMetric,
}));

vi.mock("../lib/planImplementationPromptState", () => ({
  armPlanImplementationPrompt: mockPlanImplementationPromptState.arm,
  disarmPlanImplementationPrompt: mockPlanImplementationPromptState.disarm,
  listPendingPlanImplementationPromptThreadIds: () => [],
}));

vi.mock("./toastStore", () => ({
  toast: mockToast,
}));

import {
  acceptTurnFinishedRuntimeEvent,
  resetUsageLimitCachesForTests,
  useChatStore,
} from "./chatStore";
import { useThreadStore } from "./threadStore";
import { useThreadPlanModeStore } from "./threadPlanModeStore";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeThread(id: string, status: Thread["status"] = "completed"): Thread {
  return {
    id,
    workspaceId: "workspace-1",
    repoId: null,
    engineId: "codex",
    modelId: "gpt-5.3-codex",
    engineThreadId: `engine-${id}`,
    title: id,
    status,
    messageCount: 0,
    totalTokens: 0,
    createdAt: "2026-05-19T12:00:00.000Z",
    lastActivityAt: "2026-05-19T12:00:00.000Z",
  };
}

function seedThreads(...threads: Thread[]) {
  useThreadStore.setState({
    threads,
    threadsByWorkspace: { "workspace-1": threads },
  });
}

function makeTurnFinishedEvent(
  overrides: Partial<ChatTurnFinishedEvent> = {},
): ChatTurnFinishedEvent {
  return {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    repoId: null,
    engineId: "codex",
    threadTitle: "Thread 1",
    assistantMessageId: "assistant-message-id",
    clientTurnId: "client-turn-id",
    threadStatus: "completed",
    status: "completed",
    preview: null,
    ...overrides,
  };
}

describe("chatStore send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetUsageLimitCachesForTests();
    mockIpc.getThreadMessagesWindow.mockResolvedValue({
      messages: [],
      nextCursor: null,
    });
    mockIpc.getActionOutput.mockResolvedValue({
      found: true,
      outputChunks: [],
      truncated: false,
    });
    mockIpc.cancelTurn.mockResolvedValue(undefined);
    mockIpc.steerMessage.mockResolvedValue(undefined);
    mockIpc.syncThreadFromEngine.mockResolvedValue({
      id: "thread-1",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex",
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-1",
      engineMetadata: {
        codexSyncRequired: false,
      },
      title: "Thread 1",
      status: "idle",
      messageCount: 0,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    mockListenThreadEvents.mockResolvedValue(() => {});
    useThreadStore.setState({
      threads: [],
      threadsByWorkspace: {},
      archivedThreadsByWorkspace: {},
      activeThreadId: null,
      loading: false,
      error: undefined,
    });
    useChatStore.setState({
      threadId: "thread-1",
      messages: [],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "idle",
      streaming: false,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });
    useThreadPlanModeStore.setState({
      threadModes: {},
      newThreadModesByWorkspaceId: {},
    });
  });

  it("adds an assistant placeholder immediately while the turn request is in flight", async () => {
    const pendingRequest = deferred<string>();
    mockIpc.sendMessage.mockReturnValueOnce(pendingRequest.promise);

    const sendPromise = useChatStore.getState().send("hello", {
      engineId: "codex",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    const state = useChatStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      status: "completed",
    });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      status: "streaming",
      turnEngineId: "codex",
      turnModelId: "gpt-5.3-codex",
      turnReasoningEffort: "high",
    });

    pendingRequest.resolve("assistant-message-id");
    await expect(sendPromise).resolves.toBe(true);
  });

  it("accepts a matching fast terminal event before the send IPC response settles", async () => {
    const pendingRequest = deferred<string>();
    mockIpc.sendMessage.mockReturnValueOnce(pendingRequest.promise);

    const sendPromise = useChatStore.getState().send("finish immediately");
    const clientTurnId = mockIpc.sendMessage.mock.calls[0]?.[7] as string;

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "backend-assistant-id",
          clientTurnId,
        }),
      ),
    ).toBe(true);

    pendingRequest.resolve("backend-assistant-id");
    await expect(sendPromise).resolves.toBe(true);
  });

  it("rejects an older terminal event after a newer turn has started", async () => {
    mockIpc.sendMessage.mockResolvedValueOnce("assistant-a");
    await expect(useChatStore.getState().send("turn a")).resolves.toBe(true);
    const clientTurnA = mockIpc.sendMessage.mock.calls[0]?.[7] as string;

    useChatStore.setState({ status: "completed", streaming: false });
    mockIpc.sendMessage.mockResolvedValueOnce("assistant-b");
    await expect(useChatStore.getState().send("turn b")).resolves.toBe(true);
    const clientTurnB = mockIpc.sendMessage.mock.calls[1]?.[7] as string;

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "assistant-a",
          clientTurnId: clientTurnA,
        }),
      ),
    ).toBe(false);
    expect(useChatStore.getState()).toMatchObject({
      status: "streaming",
      streaming: true,
    });

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "assistant-b",
          clientTurnId: clientTurnB,
          threadStatus: "streaming",
        }),
      ),
    ).toBe(false);

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "assistant-b",
          clientTurnId: clientTurnB,
        }),
      ),
    ).toBe(true);
  });

  it("rejects a terminal event for an older assistant when a newer transcript is streaming", () => {
    useChatStore.setState({
      messages: [
        {
          id: "assistant-b",
          threadId: "thread-1",
          role: "assistant",
          blocks: [],
          status: "streaming",
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      status: "streaming",
      streaming: true,
    });

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "assistant-a",
          clientTurnId: null,
        }),
      ),
    ).toBe(false);
  });

  it("rejects a delayed terminal event after the newer live turn also completed", () => {
    useChatStore.setState({
      messages: [
        {
          id: "optimistic-assistant-b",
          threadId: "thread-1",
          role: "assistant",
          clientTurnId: "client-turn-b",
          blocks: [{ type: "text", content: "Newer result" }],
          status: "completed",
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      status: "completed",
      streaming: false,
    });

    expect(
      acceptTurnFinishedRuntimeEvent(
        makeTurnFinishedEvent({
          assistantMessageId: "assistant-a",
          clientTurnId: "client-turn-a",
        }),
      ),
    ).toBe(false);
  });

  it("keeps a background thread marked running and clears it on terminal completion", async () => {
    const threadOne = makeThread("thread-1", "idle");
    const threadTwo = makeThread("thread-2");
    seedThreads(threadOne, threadTwo);

    const handlers = new Map<string, (event: StreamEvent) => void>();
    mockListenThreadEvents.mockImplementation(
      async (threadId: string, handler: (event: StreamEvent) => void) => {
        handlers.set(threadId, handler);
        return vi.fn();
      },
    );
    useChatStore.setState({ unlisten: vi.fn() });
    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");

    await expect(useChatStore.getState().send("keep working")).resolves.toBe(true);
    expect(
      useThreadStore.getState().threads.find((thread) => thread.id === "thread-1")?.status,
    ).toBe("streaming");

    await useChatStore.getState().setActiveThread("thread-2");

    expect(useChatStore.getState().threadId).toBe("thread-2");
    expect(
      useThreadStore.getState().threads.find((thread) => thread.id === "thread-1")?.status,
    ).toBe("streaming");

    handlers.get("thread-1")?.({
      type: "TurnCompleted",
      status: "completed",
    });

    expect(
      useThreadStore.getState().threads.find((thread) => thread.id === "thread-1")?.status,
    ).toBe("completed");
  });

  it("clears a stale running thread cache before switching away from a completed transcript", async () => {
    const threadOne = makeThread("thread-1", "streaming");
    const threadTwo = makeThread("thread-2");
    seedThreads(threadOne, threadTwo);
    useChatStore.setState({
      threadId: "thread-1",
      status: "completed",
      streaming: false,
      unlisten: vi.fn(),
    });

    await useChatStore.getState().setActiveThread("thread-2");

    expect(
      useThreadStore.getState().threads.find((thread) => thread.id === "thread-1")?.status,
    ).toBe("completed");
  });

  it("notifies when a submitted turn is accepted into local chat state", async () => {
    const pendingRequest = deferred<string>();
    const onAccepted = vi.fn();
    mockIpc.sendMessage.mockReturnValueOnce(pendingRequest.promise);

    const sendPromise = useChatStore.getState().send("hello", {
      onAccepted,
    });

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages).toHaveLength(2);

    pendingRequest.resolve("assistant-message-id");
    await expect(sendPromise).resolves.toBe(true);
  });

  it("removes the optimistic turn if the turn request fails", async () => {
    mockIpc.sendMessage.mockRejectedValueOnce(new Error("send failed"));

    await expect(useChatStore.getState().send("hello")).resolves.toBe(false);

    const state = useChatStore.getState();
    expect(state.streaming).toBe(false);
    expect(state.status).toBe("error");
    expect(state.messages).toEqual([]);
  });

  it("refuses a thread override that is not the currently bound transcript", async () => {
    await expect(
      useChatStore.getState().send("implement", {
        threadIdOverride: "thread-2",
        planMode: false,
      }),
    ).resolves.toBe(false);

    expect(mockIpc.sendMessage).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().error).toBe(
      "Cannot send a turn to a thread that is not currently active",
    );
  });

  it("persists and arms the exact plan mode sent to the backend", async () => {
    mockIpc.sendMessage.mockResolvedValueOnce(undefined);

    await expect(
      useChatStore.getState().send("plan this", {
        threadIdOverride: "thread-1",
        planMode: true,
      }),
    ).resolves.toBe(true);

    expect(useThreadPlanModeStore.getState().threadModes["thread-1"]).toBe("plan");
    expect(mockPlanImplementationPromptState.arm).toHaveBeenCalledWith("thread-1");
    expect(mockIpc.sendMessage).toHaveBeenCalledWith(
      "thread-1",
      "plan this",
      null,
      null,
      null,
      null,
      true,
      expect.any(String),
    );
  });

  it("persists explicit default and clears stale plan handoff state", async () => {
    mockIpc.sendMessage.mockResolvedValueOnce(undefined);
    useThreadPlanModeStore.getState().setThreadMode("thread-1", "plan");

    await expect(
      useChatStore.getState().send("anything at all", {
        threadIdOverride: "thread-1",
        planMode: false,
      }),
    ).resolves.toBe(true);

    expect(useThreadPlanModeStore.getState().threadModes["thread-1"]).toBe("default");
    expect(mockPlanImplementationPromptState.disarm).toHaveBeenCalledWith("thread-1");
    expect(mockIpc.sendMessage).toHaveBeenCalledWith(
      "thread-1",
      "anything at all",
      null,
      null,
      null,
      null,
      false,
      expect.any(String),
    );
  });

  it("immediately clears streaming state and terminalizes retained assistant blocks on cancel", async () => {
    const pendingCancel = deferred<void>();
    mockIpc.cancelTurn.mockReturnValueOnce(pendingCancel.promise);
    useChatStore.setState({
      threadId: "thread-1",
      status: "streaming",
      streaming: true,
      messages: [
        {
          id: "user-1",
          threadId: "thread-1",
          role: "user",
          content: "run tests",
          blocks: [{ type: "text", content: "run tests" }],
          status: "completed",
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        },
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          blocks: [
            {
              type: "action",
              actionId: "action-running",
              engineActionId: "item-running",
              actionType: "command",
              summary: "pnpm test",
              details: {},
              outputChunks: [],
              outputDeferred: false,
              outputDeferredLoaded: true,
              status: "running",
            },
          ],
        },
      ],
    });

    const cancelPromise = useChatStore.getState().cancel();
    const state = useChatStore.getState();
    const assistant = state.messages[state.messages.length - 1];

    expect(state.status).toBe("idle");
    expect(state.streaming).toBe(false);
    expect(assistant).toMatchObject({
      role: "assistant",
      status: "interrupted",
    });
    expect(assistant?.blocks?.[0]).toMatchObject({
      type: "action",
      status: "error",
      result: {
        success: false,
        error: "The turn was interrupted before this action reported completion.",
        durationMs: 0,
      },
    });

    pendingCancel.resolve();
    await expect(cancelPromise).resolves.toBeUndefined();
  });

  it("reloads the current thread when forceReload is requested", async () => {
    const firstUnlisten = vi.fn();
    const secondUnlisten = vi.fn();
    mockListenThreadEvents
      .mockResolvedValueOnce(firstUnlisten)
      .mockResolvedValueOnce(secondUnlisten);
    mockIpc.getThreadMessagesWindow
      .mockResolvedValueOnce({
        messages: [
          {
            id: "message-1",
            threadId: "thread-1",
            role: "user",
            content: "before",
            blocks: [{ type: "text", content: "before" }],
            status: "completed",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "message-2",
            threadId: "thread-1",
            role: "user",
            content: "after",
            blocks: [{ type: "text", content: "after" }],
            status: "completed",
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });

    await useChatStore.getState().setActiveThread("thread-1");
    await useChatStore.getState().setActiveThread("thread-1", { forceReload: true });

    expect(firstUnlisten).toHaveBeenCalledTimes(1);
    expect(mockIpc.getThreadMessagesWindow).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().messages[0]?.id).toBe("message-2");
  });

  it("routes streamed content to the matching optimistic assistant via clientTurnId", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.3-codex",
      }),
    ).resolves.toBe(true);

    const optimisticAssistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.clientTurnId);
    expect(optimisticAssistant?.clientTurnId).toBeTruthy();
    expect(streamHandler).not.toBeNull();
    const emitStreamEvent = streamHandler!;

    useChatStore.setState((state) => ({
      ...state,
      messages: [
        ...state.messages,
        {
          id: "assistant-other",
          threadId: "thread-1",
          role: "assistant",
          clientTurnId: "client-turn-other",
          status: "streaming",
          schemaVersion: 1,
          blocks: [],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
    }));

    emitStreamEvent({
      type: "TurnStarted",
      client_turn_id: optimisticAssistant?.clientTurnId ?? null,
    });
    emitStreamEvent({
      type: "TextDelta",
      content: "matched content",
    });

    await vi.advanceTimersByTimeAsync(20);

    const state = useChatStore.getState();
    const matchedAssistant = state.messages.find((message) => message.id === optimisticAssistant?.id);
    const trailingAssistant = state.messages.find((message) => message.id === "assistant-other");

    expect(matchedAssistant?.blocks).toEqual([{ type: "text", content: "matched content" }]);
    expect(trailingAssistant?.blocks ?? []).toEqual([]);
    expect(mockRecordPerfMetric).toHaveBeenCalledWith(
      "chat.turn.first_text.ms",
      expect.any(Number),
      expect.objectContaining({
        threadId: "thread-1",
        clientTurnId: optimisticAssistant?.clientTurnId,
      }),
    );

    vi.useRealTimers();
  });

  it("updates the assistant model label and inserts a reroute notice when the model is rerouted", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.1-codex-mini",
      }),
    ).resolves.toBe(true);

    const optimisticAssistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.clientTurnId);
    expect(streamHandler).not.toBeNull();

    streamHandler!({
      type: "ModelRerouted",
      from_model: "gpt-5.1-codex-mini",
      to_model: "gpt-5.3-codex",
      reason: "highRiskCyberActivity",
    });

    await vi.advanceTimersByTimeAsync(20);

    const reroutedAssistant = useChatStore
      .getState()
      .messages.find((message) => message.id === optimisticAssistant?.id);
    expect(reroutedAssistant?.turnModelId).toBe("gpt-5.3-codex");
    expect(mockRecordPerfMetric).toHaveBeenCalledWith(
      "chat.turn.first_content.ms",
      expect.any(Number),
      expect.objectContaining({
        threadId: "thread-1",
        modelId: "gpt-5.3-codex",
      }),
    );
    expect(reroutedAssistant?.blocks).toEqual([
      {
        type: "notice",
        kind: "model_rerouted",
        level: "info",
        title: "Model rerouted",
        message: "Switched from gpt-5.1-codex-mini to gpt-5.3-codex (highRiskCyberActivity).",
      },
    ]);

    vi.useRealTimers();
  });

  it("stores generic notice events as notice blocks", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.3-codex",
      }),
    ).resolves.toBe(true);

    streamHandler!({
      type: "Notice",
      kind: "deprecation_notice",
      level: "warning",
      title: "Deprecation notice",
      message: "Use the newer approval API.",
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    expect(assistant?.blocks).toEqual([
      {
        type: "notice",
        kind: "deprecation_notice",
        level: "warning",
        title: "Deprecation notice",
        message: "Use the newer approval API.",
      },
    ]);

    vi.useRealTimers();
  });

  it("stores turn completion diagnostics as terminal notice blocks", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.3-codex",
      }),
    ).resolves.toBe(true);

    streamHandler!({
      type: "TurnCompleted",
      status: "completed",
      duration_ms: 123456,
      token_usage: {
        input: 12,
        output: 34,
      },
      diagnostics: {
        source: "engine",
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    expect(assistant?.status).toBe("completed");
    expect(assistant?.blocks).toEqual([
      expect.objectContaining({
        type: "notice",
        kind: "turn_status",
        level: "info",
        title: "Turn completed",
        message: "Codex reported a normal terminal completion.",
        status: "completed",
        source: "engine",
        durationMs: 123456,
        details: expect.arrayContaining([
          "Completion source: explicit engine terminal event",
          "Token usage: 12 input, 34 output",
        ]),
      }),
    ]);

    vi.useRealTimers();
  });

  it("terminalizes unresolved action blocks before turn completion stats are stored", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    streamHandler!({
      type: "ActionStarted",
      action_id: "action-done",
      engine_action_id: "item-done",
      action_type: "command",
      summary: "pnpm test",
      details: {},
    });
    streamHandler!({
      type: "ActionStarted",
      action_id: "action-lost",
      engine_action_id: "item-lost",
      action_type: "command",
      summary: "pnpm lint",
      details: {},
    });
    streamHandler!({
      type: "ActionCompleted",
      action_id: "action-done",
      result: {
        success: true,
        durationMs: 25,
      },
    });
    streamHandler!({
      type: "TurnCompleted",
      status: "interrupted",
      diagnostics: {
        source: "reconciled_stream_lost",
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    const actionBlocks = assistant?.blocks?.filter((block) => block.type === "action") ?? [];
    expect(actionBlocks).toHaveLength(2);
    expect(actionBlocks[0]).toMatchObject({
      actionId: "action-done",
      status: "done",
    });
    expect(actionBlocks[1]).toMatchObject({
      actionId: "action-lost",
      status: "error",
      result: {
        success: false,
        error: "Panes lost the live Codex stream before this action reported completion.",
        durationMs: 0,
      },
    });
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notice",
          kind: "turn_status",
          title: "Turn interrupted",
          status: "interrupted",
          source: "reconciled_stream_lost",
          details: expect.arrayContaining([
            "Actions: 2 total, 1 done, 1 error, 0 running, 0 pending",
          ]),
        }),
      ]),
    );

    vi.useRealTimers();
  });

  it("uses recovered turn snapshots before terminal completion stats are stored", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    streamHandler!({
      type: "ActionStarted",
      action_id: "action-live",
      engine_action_id: "item-1",
      action_type: "command",
      summary: "pnpm test",
      details: {},
    });
    streamHandler!({
      type: "TurnSnapshotRecovered",
      blocks: [
        {
          type: "action",
          actionId: "codex-import-item-1",
          engineActionId: "item-1",
          actionType: "command",
          summary: "Run `pnpm test`",
          details: {},
          outputChunks: [],
          status: "done",
          result: {
            success: true,
            output: "ok",
            durationMs: 25,
          },
        },
      ],
    });
    streamHandler!({
      type: "TurnCompleted",
      status: "completed",
      diagnostics: {
        source: "recovered_snapshot",
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    const actionBlocks = assistant?.blocks?.filter((block) => block.type === "action") ?? [];
    expect(actionBlocks).toHaveLength(1);
    expect(actionBlocks[0]).toMatchObject({
      actionId: "codex-import-item-1",
      status: "done",
      result: {
        success: true,
        output: "ok",
        durationMs: 25,
      },
    });
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notice",
          kind: "turn_status",
          level: "info",
          title: "Turn completed",
          status: "completed",
          source: "recovered_snapshot",
          details: expect.arrayContaining([
            "Completion source: recovered from Codex thread history",
            "Actions: 1 total, 1 done, 0 error, 0 running, 0 pending",
          ]),
        }),
      ]),
    );

    vi.useRealTimers();
  });

  it("normalizes stale running action blocks when terminal messages are loaded", async () => {
    const staleMessage: Message = {
      id: "assistant-stale",
      threadId: "thread-1",
      role: "assistant",
      status: "interrupted",
      schemaVersion: 1,
      createdAt: "2026-06-05T12:00:00.000Z",
      blocks: [
        {
          type: "action",
          actionId: "action-stale",
          engineActionId: "item-stale",
          actionType: "command",
          summary: "pnpm test",
          details: {},
          outputChunks: [],
          outputDeferred: false,
          outputDeferredLoaded: true,
          status: "running",
        },
        {
          type: "notice",
          kind: "turn_status",
          level: "warning",
          title: "Turn interrupted",
          message: "The turn ended before a normal completion.",
          status: "interrupted",
          source: "reconciled_stream_lost",
          details: [
            "Completion source: reconciled from thread history after live stream loss",
            "Actions: 1 total, 0 done, 0 error, 1 running, 0 pending",
          ],
        },
      ],
    };

    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [staleMessage],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    const assistant = useChatStore.getState().messages[0];
    expect(assistant.blocks?.[0]).toMatchObject({
      type: "action",
      actionId: "action-stale",
      status: "error",
      result: {
        success: false,
        error: "Panes lost the live Codex stream before this action reported completion.",
        durationMs: 0,
      },
    });
    expect(assistant.blocks?.[1]).toMatchObject({
      type: "notice",
      kind: "turn_status",
      details: [
        "Completion source: reconciled from thread history after live stream loss",
        "Actions: 1 total, 0 done, 1 error, 0 running, 0 pending",
      ],
    });
  });

  it("normalizes stale pending approval blocks when terminal messages are loaded", async () => {
    const staleMessage: Message = {
      id: "assistant-stale-approval",
      threadId: "thread-1",
      role: "assistant",
      status: "completed",
      schemaVersion: 1,
      createdAt: "2026-06-05T12:00:00.000Z",
      blocks: [
        {
          type: "approval",
          approvalId: "approval-stale",
          actionType: "command",
          summary: "Run command",
          details: {},
          status: "pending",
        },
        {
          type: "notice",
          kind: "turn_status",
          level: "warning",
          title: "Approval still pending",
          message:
            "A terminal result was recorded, but Panes still has unresolved approvals. The turn may have ended early or the approval protocol may be out of sync.",
          status: "awaiting_approval",
          source: "engine",
          details: [
            "Completion source: explicit engine terminal event",
            "Approvals: 1 pending, 0 answered",
            "Protocol warning: terminal result arrived while 1 approval(s) were still pending.",
          ],
        },
      ],
    };

    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [staleMessage],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    const assistant = useChatStore.getState().messages[0];
    expect(assistant.blocks?.[0]).toMatchObject({
      type: "approval",
      approvalId: "approval-stale",
      status: "answered",
      decision: "cancel",
    });
    expect(assistant.blocks?.[1]).toMatchObject({
      type: "notice",
      kind: "turn_status",
      level: "info",
      title: "Turn completed",
      message: "Codex reported a normal terminal completion.",
      status: "completed",
      source: "engine",
      details: [
        "Completion source: explicit engine terminal event",
        "Approvals: 0 pending, 1 answered",
      ],
    });
  });

  it("derives context usage from current context tokens instead of cumulative totals", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "UsageLimitsUpdated",
      usage: {
        current_tokens: 30000,
        max_context_tokens: 200000,
        context_window_percent: 45,
        five_hour_percent: 17,
        weekly_percent: 42,
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useChatStore.getState().usageLimits).toEqual({
      currentTokens: 30000,
      maxContextTokens: 200000,
      contextPercent: 90,
      windowFiveHourPercent: 83,
      windowWeeklyPercent: 58,
      windowFiveHourResetsAt: null,
      windowWeeklyResetsAt: null,
    });

    vi.useRealTimers();
  });

  it("hydrates cached context usage from thread metadata when binding an old Codex thread", async () => {
    const thread = {
      id: "thread-1",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-1",
      engineMetadata: {
        codexSyncRequired: false,
        contextUsageCache: {
          currentTokens: 30000,
          maxContextTokens: 200000,
          contextWindowPercent: 90,
        },
      },
      title: "Thread 1",
      status: "completed" as const,
      messageCount: 4,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    useThreadStore.setState({
      threads: [thread],
      threadsByWorkspace: {
        "workspace-1": [thread],
      },
      archivedThreadsByWorkspace: {},
      activeThreadId: "thread-1",
      loading: false,
      error: undefined,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(useChatStore.getState().usageLimits).toEqual({
      currentTokens: 30000,
      maxContextTokens: 200000,
      contextPercent: 90,
      windowFiveHourPercent: null,
      windowWeeklyPercent: null,
      windowFiveHourResetsAt: null,
      windowWeeklyResetsAt: null,
    });
  });

  it("updates the in-memory thread cache when streamed context usage arrives", async () => {
    vi.useFakeTimers();

    const thread = {
      id: "thread-1",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-1",
      engineMetadata: {
        codexSyncRequired: false,
      },
      title: "Thread 1",
      status: "completed" as const,
      messageCount: 4,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    useThreadStore.setState({
      threads: [thread],
      threadsByWorkspace: {
        "workspace-1": [thread],
      },
      archivedThreadsByWorkspace: {},
      activeThreadId: "thread-1",
      loading: false,
      error: undefined,
    });

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "UsageLimitsUpdated",
      usage: {
        current_tokens: 30000,
        max_context_tokens: 200000,
        context_window_percent: 90,
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useThreadStore.getState().threads[0]?.engineMetadata).toMatchObject({
      contextUsageCache: {
        currentTokens: 30000,
        maxContextTokens: 200000,
        contextWindowPercent: 90,
      },
    });

    vi.useRealTimers();
  });

  it("preserves last-known context usage when a refresh only returns account windows", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(streamHandler).not.toBeNull();

    streamHandler!({
      type: "UsageLimitsUpdated",
      usage: {
        current_tokens: 30000,
        max_context_tokens: 200000,
        context_window_percent: 45,
        five_hour_percent: 17,
        weekly_percent: 42,
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    streamHandler!({
      type: "UsageLimitsUpdated",
      usage: {
        five_hour_percent: 25,
        weekly_percent: 50,
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useChatStore.getState().usageLimits).toEqual({
      currentTokens: 30000,
      maxContextTokens: 200000,
      contextPercent: 90,
      windowFiveHourPercent: 75,
      windowWeeklyPercent: 50,
      windowFiveHourResetsAt: null,
      windowWeeklyResetsAt: null,
    });

    vi.useRealTimers();
  });

  it("preserves last-known account windows when binding another Codex thread", async () => {
    vi.useFakeTimers();

    const thread1 = {
      id: "thread-1",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-1",
      engineMetadata: {
        codexSyncRequired: false,
      },
      title: "Thread 1",
      status: "completed" as const,
      messageCount: 4,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    const thread2 = {
      id: "thread-2",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-2",
      engineMetadata: {
        codexSyncRequired: false,
        contextUsageCache: {
          currentTokens: 40000,
          maxContextTokens: 200000,
          contextWindowPercent: 84,
        },
      },
      title: "Thread 2",
      status: "completed" as const,
      messageCount: 3,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    useThreadStore.setState({
      threads: [thread1, thread2],
      threadsByWorkspace: {
        "workspace-1": [thread1, thread2],
      },
      archivedThreadsByWorkspace: {},
      activeThreadId: "thread-1",
      loading: false,
      error: undefined,
    });

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents
      .mockImplementationOnce(async (_threadId, onEvent) => {
        streamHandler = onEvent;
        return () => {};
      })
      .mockImplementationOnce(async () => () => {});

    await useChatStore.getState().setActiveThread("thread-1");

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "UsageLimitsUpdated",
      usage: {
        five_hour_percent: 17,
        weekly_percent: 42,
        five_hour_resets_at: 1735689600,
        weekly_resets_at: 1736294400000,
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    await useChatStore.getState().setActiveThread("thread-2");

    expect(useChatStore.getState().usageLimits).toEqual({
      currentTokens: 40000,
      maxContextTokens: 200000,
      contextPercent: 85,
      windowFiveHourPercent: 83,
      windowWeeklyPercent: 58,
      windowFiveHourResetsAt: "2025-01-01T00:00:00.000Z",
      windowWeeklyResetsAt: "2025-01-08T00:00:00.000Z",
    });

    vi.useRealTimers();
  });

  it("preserves stdin action output chunks from streamed events", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.3-codex",
      }),
    ).resolves.toBe(true);

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "ActionStarted",
      action_id: "action-stdin",
      engine_action_id: "cmd-stdin",
      action_type: "command",
      summary: "pnpm test",
      details: {},
    });
    streamHandler!({
      type: "ActionOutputDelta",
      action_id: "action-stdin",
      stream: "stdin",
      content: "pnpm test\n",
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    expect(assistant?.blocks).toEqual([
      {
        type: "action",
        actionId: "action-stdin",
        engineActionId: "cmd-stdin",
        actionType: "command",
        summary: "pnpm test",
        details: {},
        outputChunks: [
          {
            stream: "stdin",
            content: "pnpm test\n",
          },
        ],
        outputDeferred: false,
        outputDeferredLoaded: true,
        status: "running",
      },
    ]);

    vi.useRealTimers();
  });

  it("collapses existing duplicate diff blocks for same-scope stream updates", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-diff",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          content: "",
          blocks: [
            { type: "diff", diff: "old diff 1", scope: "turn" },
            { type: "text", content: "kept" },
            { type: "diff", diff: "old diff 2", scope: "turn" },
            {
              type: "action",
              actionId: "action-1",
              engineActionId: "cmd-1",
              actionType: "command",
              summary: "pnpm test",
              details: {},
              outputChunks: [],
              status: "done",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      status: "streaming",
      streaming: true,
    });

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "DiffUpdated",
      diff: "new diff",
      scope: "turn",
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useChatStore.getState().messages[0]?.blocks).toEqual([
      { type: "text", content: "kept" },
      { type: "diff", diff: "new diff", scope: "turn" },
      {
        type: "action",
        actionId: "action-1",
        engineActionId: "cmd-1",
        actionType: "command",
        summary: "pnpm test",
        details: {},
        outputChunks: [],
        status: "done",
      },
    ]);

    vi.useRealTimers();
  });

  it("marks approvals as answered when the runtime resolves them externally", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "assistant-approval",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-runtime-1",
              actionType: "command",
              summary: "Run command",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "ApprovalResolved",
      approval_id: "approval-runtime-1",
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useChatStore.getState().messages[0]?.blocks).toEqual([
      {
        type: "approval",
        approvalId: "approval-runtime-1",
        actionType: "command",
        summary: "Run command",
        details: {},
        status: "answered",
      },
    ]);

    vi.useRealTimers();
  });

  it("preserves stdin chunks when hydrating deferred action output", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-action",
          threadId: "thread-1",
          role: "assistant",
          status: "completed",
          schemaVersion: 1,
          blocks: [
            {
              type: "action",
              actionId: "action-hydrate",
              engineActionId: "cmd-hydrate",
              actionType: "command",
              summary: "pnpm test",
              details: {},
              outputChunks: [],
              outputDeferred: true,
              outputDeferredLoaded: false,
              status: "done",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: true,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "idle",
      streaming: false,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });
    mockIpc.getActionOutput.mockResolvedValueOnce({
      found: true,
      outputChunks: [
        {
          stream: "stdin",
          content: "pnpm test\n",
        },
      ],
      truncated: false,
    });

    await useChatStore.getState().hydrateActionOutput("assistant-action", "action-hydrate");

    expect(useChatStore.getState().messages[0]?.blocks).toEqual([
      {
        type: "action",
        actionId: "action-hydrate",
        engineActionId: "cmd-hydrate",
        actionType: "command",
        summary: "pnpm test",
        details: {},
        outputChunks: [
          {
            stream: "stdin",
            content: "pnpm test\n",
          },
        ],
        outputDeferred: false,
        outputDeferredLoaded: true,
        status: "done",
      },
    ]);
  });

  it("infers accept_for_session for permission approval responses", async () => {
    mockIpc.respondApproval.mockResolvedValueOnce(undefined);
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-approval",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-1",
              actionType: "other",
              summary: "Codex requested network access",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await useChatStore.getState().respondApproval("approval-1", {
      permissions: {
        network: {
          enabled: true,
        },
      },
      scope: "session",
    });

    expect(mockIpc.respondApproval).toHaveBeenCalledWith("thread-1", "approval-1", {
      permissions: {
        network: {
          enabled: true,
        },
      },
      scope: "session",
    });
    expect(useChatStore.getState().messages[0]?.blocks).toMatchObject([
      {
        type: "approval",
        approvalId: "approval-1",
        actionType: "other",
        summary: "Codex requested network access",
        details: {},
        status: "answered",
        decision: "accept_for_session",
      },
    ]);
  });

  it("treats 'none' permission values as a decline", async () => {
    mockIpc.respondApproval.mockResolvedValueOnce(undefined);
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-approval-none",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-none",
              actionType: "other",
              summary: "Network access",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await useChatStore.getState().respondApproval("approval-none", {
      permissions: {
        network: "none",
      },
      scope: "turn",
    });

    expect(useChatStore.getState().messages[0]?.blocks).toMatchObject([
      {
        type: "approval",
        approvalId: "approval-none",
        actionType: "other",
        summary: "Network access",
        details: {},
        status: "answered",
        decision: "decline",
      },
    ]);
  });

  it("infers MCP elicitation decisions from action responses", async () => {
    mockIpc.respondApproval.mockResolvedValueOnce(undefined);
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-approval-2",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-2",
              actionType: "other",
              summary: "docs requested input",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await useChatStore.getState().respondApproval("approval-2", {
      action: "decline",
    });

    expect(useChatStore.getState().messages[0]?.blocks).toMatchObject([
      {
        type: "approval",
        approvalId: "approval-2",
        actionType: "other",
        summary: "docs requested input",
        details: {},
        status: "answered",
        decision: "decline",
      },
    ]);
  });

  it("restores completed runtime state after answering the last pending approval on a terminal message", async () => {
    mockIpc.respondApproval.mockResolvedValueOnce(undefined);
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-terminal-approval",
          threadId: "thread-1",
          role: "assistant",
          status: "completed",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-terminal",
              actionType: "command",
              summary: "Run command",
              details: {},
              status: "pending",
            },
            {
              type: "notice",
              kind: "turn_status",
              level: "warning",
              title: "Approval still pending",
              message:
                "A terminal result was recorded, but Panes still has unresolved approvals. The turn may have ended early or the approval protocol may be out of sync.",
              status: "awaiting_approval",
              source: "engine",
              details: [
                "Completion source: explicit engine terminal event",
                "Approvals: 1 pending, 0 answered",
              ],
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "awaiting_approval",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await useChatStore
      .getState()
      .respondApproval("approval-terminal", { decision: "accept" } as ApprovalResponse);

    expect(useChatStore.getState()).toMatchObject({
      status: "completed",
      streaming: false,
    });
    expect(useChatStore.getState().messages[0]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval",
          approvalId: "approval-terminal",
          status: "answered",
          decision: "accept",
        }),
      ]),
    );
  });

  it("stores only the latest MCP progress message on the matching action block", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    mockIpc.sendMessage.mockResolvedValueOnce("assistant-message-id");
    await expect(
      useChatStore.getState().send("hello", {
        engineId: "codex",
        modelId: "gpt-5.3-codex",
      }),
    ).resolves.toBe(true);

    expect(streamHandler).not.toBeNull();
    streamHandler!({
      type: "ActionStarted",
      action_id: "action-1",
      engine_action_id: "item-1",
      action_type: "other",
      summary: "search_docs",
      details: {},
    });
    streamHandler!({
      type: "ActionProgressUpdated",
      action_id: "action-1",
      message: "Connecting",
    });
    streamHandler!({
      type: "ActionProgressUpdated",
      action_id: "action-1",
      message: "Fetching results",
    });

    await vi.advanceTimersByTimeAsync(20);

    const assistant = useChatStore
      .getState()
      .messages.find((message) => message.role === "assistant" && message.blocks?.length);
    expect(assistant?.blocks).toEqual([
      {
        type: "action",
        actionId: "action-1",
        engineActionId: "item-1",
        actionType: "other",
        summary: "search_docs",
        details: {
          progressKind: "mcp",
          progressMessage: "Fetching results",
        },
        outputChunks: [],
        outputDeferred: false,
        outputDeferredLoaded: true,
        status: "running",
      },
    ]);

    vi.useRealTimers();
  });

  it("adds a steer block to the active assistant while steering an active turn", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await expect(
      useChatStore.getState().steer("follow up", {
        inputItems: [{ type: "mention", name: "Docs", path: "app://docs" }],
      }),
    ).resolves.toBe(true);

    expect(mockIpc.steerMessage).toHaveBeenCalledWith(
      "thread-1",
      "follow up",
      null,
      [{ type: "mention", name: "Docs", path: "app://docs" }],
      false,
    );
    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        {
          type: "steer",
          content: "follow up",
          mentions: [{ type: "mention", name: "Docs", path: "app://docs" }],
        },
      ],
    });
  });

  it("rolls back the optimistic steer block when the steer request fails", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });
    mockIpc.steerMessage.mockRejectedValueOnce(new Error("steer failed"));

    await expect(useChatStore.getState().steer("follow up")).resolves.toBe(false);

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        blocks: [],
      }),
    ]);
    expect(useChatStore.getState().error).toContain("steer failed");
  });

  it("notifies when a steer is accepted into local chat state", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "streaming",
          schemaVersion: 1,
          blocks: [],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "streaming",
      streaming: true,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });
    const pendingRequest = deferred<void>();
    const onAccepted = vi.fn();
    mockIpc.steerMessage.mockReturnValueOnce(pendingRequest.promise);

    const steerPromise = useChatStore.getState().steer("follow up", {
      onAccepted,
    });

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages[0].blocks).toHaveLength(1);

    pendingRequest.resolve();
    await expect(steerPromise).resolves.toBe(true);
  });

  it("folds persisted steer messages into the preceding completed assistant when binding", async () => {
    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          content: null,
          blocks: [{ type: "text", content: "Working on it" }],
          turnEngineId: "codex",
          turnModelId: "gpt-5.3-codex",
          turnReasoningEffort: "medium",
          schemaVersion: 1,
          status: "completed",
          tokenUsage: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: "steer-user-1",
          threadId: "thread-1",
          role: "user",
          content: "focus on the failing test",
          blocks: [{ type: "text", content: "focus on the failing test", isSteer: true }],
          turnEngineId: "codex",
          turnModelId: "gpt-5.3-codex",
          turnReasoningEffort: "medium",
          schemaVersion: 1,
          status: "completed",
          tokenUsage: null,
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(useChatStore.getState().messages).toHaveLength(1);
    expect(useChatStore.getState().messages[0]).toMatchObject({
      role: "assistant",
      status: "completed",
      blocks: [
        {
          type: "text",
          content: "Working on it",
        },
        {
          type: "steer",
          steerId: "steer-user-1",
          content: "focus on the failing test",
        },
      ],
    });
  });

  it("sorts bound message windows chronologically before rendering", async () => {
    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "assistant-late",
          threadId: "thread-1",
          role: "assistant",
          content: null,
          blocks: [{ type: "text", content: "late" }],
          turnEngineId: "codex",
          turnModelId: "gpt-5.3-codex",
          turnReasoningEffort: "medium",
          schemaVersion: 1,
          status: "completed",
          tokenUsage: null,
          createdAt: "2026-05-19 12:00:01.000",
        },
        {
          id: "user-early",
          threadId: "thread-1",
          role: "user",
          content: "first",
          blocks: [{ type: "text", content: "first" }],
          turnEngineId: "codex",
          turnModelId: "gpt-5.3-codex",
          turnReasoningEffort: "medium",
          schemaVersion: 1,
          status: "completed",
          tokenUsage: null,
          createdAt: "2026-05-19T11:59:59.000Z",
        },
        {
          id: "assistant-mid",
          threadId: "thread-1",
          role: "assistant",
          content: null,
          blocks: [{ type: "text", content: "mid" }],
          turnEngineId: "codex",
          turnModelId: "gpt-5.3-codex",
          turnReasoningEffort: "medium",
          schemaVersion: 1,
          status: "completed",
          tokenUsage: null,
          createdAt: "2026-05-19T12:00:00.500Z",
        },
      ],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      "user-early",
      "assistant-mid",
      "assistant-late",
    ]);
  });

  it("keeps regular user turns intact when loading older history", async () => {
    mockIpc.getThreadMessagesWindow
      .mockResolvedValueOnce({
        messages: [
          {
            id: "assistant-latest",
            threadId: "thread-1",
            role: "assistant",
            content: null,
            blocks: [{ type: "text", content: "Latest reply" }],
            turnEngineId: "codex",
            turnModelId: "gpt-5.3-codex",
            turnReasoningEffort: "medium",
            schemaVersion: 1,
            status: "completed",
            tokenUsage: null,
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: {
          createdAt: "2026-03-13T00:00:00.000Z",
          id: "cursor-1",
          rowId: 1,
        },
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "assistant-earlier",
            threadId: "thread-1",
            role: "assistant",
            content: null,
            blocks: [{ type: "text", content: "Earlier reply" }],
            turnEngineId: "codex",
            turnModelId: "gpt-5.3-codex",
            turnReasoningEffort: "medium",
            schemaVersion: 1,
            status: "completed",
            tokenUsage: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: "user-regular",
            threadId: "thread-1",
            role: "user",
            content: "A normal next turn",
            blocks: [{ type: "text", content: "A normal next turn" }],
            turnEngineId: "codex",
            turnModelId: "gpt-5.3-codex",
            turnReasoningEffort: "medium",
            schemaVersion: 1,
            status: "completed",
            tokenUsage: null,
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      });

    await useChatStore.getState().setActiveThread("thread-1");
    await useChatStore.getState().loadOlderMessages();

    expect(useChatStore.getState().messages).toHaveLength(3);
    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      "assistant-earlier",
      "user-regular",
      "assistant-latest",
    ]);
  });

  it.each([
    { status: "streaming" as const, expectedStreaming: true },
    { status: "awaiting_approval" as const, expectedStreaming: true },
  ])(
    "preserves the bound thread runtime status when loading a $status thread",
    async ({ status, expectedStreaming }) => {
      const thread = {
        id: "thread-1",
        workspaceId: "workspace-1",
        repoId: null,
        engineId: "codex" as const,
        modelId: "gpt-5.3-codex",
        engineThreadId: "engine-thread-1",
        engineMetadata: {
          codexSyncRequired: false,
        },
        title: "Thread 1",
        status,
        messageCount: 0,
        totalTokens: 0,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };

      useThreadStore.setState({
        threads: [thread],
        threadsByWorkspace: {
          "workspace-1": [thread],
        },
        archivedThreadsByWorkspace: {},
        activeThreadId: "thread-1",
        loading: false,
        error: undefined,
      });

      await useChatStore.getState().setActiveThread("thread-1");

      expect(useChatStore.getState()).toMatchObject({
        status,
        streaming: expectedStreaming,
      });
    },
  );

  it("reconciles a completed transcript over a stale streaming cache on project re-entry", async () => {
    const thread = makeThread("thread-1", "streaming");
    seedThreads(thread);
    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "user-completed-turn",
          threadId: "thread-1",
          role: "user",
          content: "implement it",
          blocks: [{ type: "text", content: "implement it" }],
          status: "completed",
          schemaVersion: 1,
          createdAt: "2026-07-10T09:11:28.000Z",
        },
        {
          id: "assistant-completed-turn",
          threadId: "thread-1",
          role: "assistant",
          blocks: [{ type: "text", content: "Implemented." }],
          status: "completed",
          schemaVersion: 1,
          createdAt: "2026-07-10T09:11:42.000Z",
        },
      ],
      nextCursor: null,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(useChatStore.getState()).toMatchObject({
      status: "completed",
      streaming: false,
    });
    expect(
      useThreadStore.getState().threads.find((item) => item.id === "thread-1")?.status,
    ).toBe("completed");
  });

  it("preserves a genuinely pending local turn when re-entry only loads older terminal history", async () => {
    const threadOne = makeThread("thread-1", "idle");
    const threadTwo = makeThread("thread-2");
    seedThreads(threadOne, threadTwo);
    const pendingRequest = deferred<string>();
    mockIpc.sendMessage.mockReturnValueOnce(pendingRequest.promise);
    mockIpc.getThreadMessagesWindow
      .mockResolvedValueOnce({ messages: [], nextCursor: null })
      .mockResolvedValueOnce({
        messages: [
          {
            id: "older-terminal-assistant",
            threadId: "thread-1",
            role: "assistant",
            blocks: [{ type: "text", content: "Previous turn" }],
            status: "completed",
            schemaVersion: 1,
            createdAt: "2026-07-10T09:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    useChatStore.setState({ unlisten: vi.fn() });

    const sendPromise = useChatStore.getState().send("new pending turn");
    await useChatStore.getState().setActiveThread("thread-2");
    await useChatStore.getState().setActiveThread("thread-1");

    expect(useChatStore.getState()).toMatchObject({
      status: "streaming",
      streaming: true,
    });

    pendingRequest.resolve("backend-assistant-message");
    await expect(sendPromise).resolves.toBe(true);
  });

  it("does not let a late bind replace an active optimistic turn", async () => {
    const existingUnlisten = vi.fn();
    const lateUnlisten = vi.fn();
    mockListenThreadEvents.mockImplementationOnce(async () => {
      useChatStore.setState({
        threadId: "thread-1",
        messages: [
          {
            id: "optimistic-user",
            threadId: "thread-1",
            role: "user",
            status: "completed",
            schemaVersion: 1,
            blocks: [{ type: "text", content: "hello" }],
            createdAt: new Date().toISOString(),
            hydration: "full",
            hasDeferredContent: false,
          },
          {
            id: "optimistic-assistant",
            threadId: "thread-1",
            role: "assistant",
            status: "streaming",
            schemaVersion: 1,
            blocks: [],
            createdAt: new Date().toISOString(),
            hydration: "full",
            hasDeferredContent: false,
          },
        ],
        status: "streaming",
        streaming: true,
        unlisten: existingUnlisten,
      });
      return lateUnlisten;
    });

    await useChatStore.getState().setActiveThread("thread-1");

    const state = useChatStore.getState();
    expect(state.streaming).toBe(true);
    expect(state.status).toBe("streaming");
    expect(state.messages.map((message) => message.id)).toEqual([
      "optimistic-user",
      "optimistic-assistant",
    ]);
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    expect(existingUnlisten).not.toHaveBeenCalled();
  });

  it("merges late loaded history into an active optimistic turn", async () => {
    const existingUnlisten = vi.fn();
    const lateUnlisten = vi.fn();
    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "history-user",
          threadId: "thread-1",
          role: "user",
          status: "completed",
          schemaVersion: 1,
          blocks: [{ type: "text", content: "previous question" }],
          createdAt: "2026-05-19T12:00:00.000Z",
          hydration: "full",
          hasDeferredContent: false,
        },
        {
          id: "history-assistant",
          threadId: "thread-1",
          role: "assistant",
          status: "completed",
          schemaVersion: 1,
          blocks: [{ type: "text", content: "previous answer" }],
          createdAt: "2026-05-19T12:00:01.000Z",
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      nextCursor: null,
    });
    mockListenThreadEvents.mockImplementationOnce(async () => {
      useChatStore.setState({
        threadId: "thread-1",
        messages: [
          {
            id: "optimistic-user",
            threadId: "thread-1",
            role: "user",
            status: "completed",
            schemaVersion: 1,
            blocks: [{ type: "text", content: "hello" }],
            createdAt: "2026-05-19T12:00:02.000Z",
            hydration: "full",
            hasDeferredContent: false,
          },
          {
            id: "optimistic-assistant",
            threadId: "thread-1",
            role: "assistant",
            status: "streaming",
            schemaVersion: 1,
            blocks: [],
            createdAt: "2026-05-19T12:00:03.000Z",
            hydration: "full",
            hasDeferredContent: false,
          },
        ],
        status: "streaming",
        streaming: true,
        unlisten: existingUnlisten,
      });
      return lateUnlisten;
    });

    await useChatStore.getState().setActiveThread("thread-1");

    const state = useChatStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual([
      "history-user",
      "history-assistant",
      "optimistic-user",
      "optimistic-assistant",
    ]);
    expect(state.streaming).toBe(true);
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    expect(existingUnlisten).not.toHaveBeenCalled();
  });

  it("keeps streamed content when a late bind includes the same active assistant", async () => {
    const existingUnlisten = vi.fn();
    const lateUnlisten = vi.fn();
    mockIpc.getThreadMessagesWindow.mockResolvedValueOnce({
      messages: [
        {
          id: "persisted-user",
          threadId: "thread-1",
          role: "user",
          status: "completed",
          schemaVersion: 1,
          blocks: [{ type: "text", content: "hello" }],
          createdAt: "2026-05-19T12:00:00.000Z",
          hydration: "full",
          hasDeferredContent: false,
        },
        {
          id: "persisted-assistant",
          threadId: "thread-1",
          role: "assistant",
          clientTurnId: "turn-1",
          status: "streaming",
          schemaVersion: 1,
          blocks: [],
          createdAt: "2026-05-19T12:00:01.000Z",
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      nextCursor: null,
    });
    mockListenThreadEvents.mockImplementationOnce(async () => {
      useChatStore.setState({
        threadId: "thread-1",
        messages: [
          {
            id: "optimistic-user",
            threadId: "thread-1",
            role: "user",
            status: "completed",
            schemaVersion: 1,
            blocks: [{ type: "text", content: "hello" }],
            createdAt: "2026-05-19T12:00:00.500Z",
            hydration: "full",
            hasDeferredContent: false,
          },
          {
            id: "optimistic-assistant",
            threadId: "thread-1",
            role: "assistant",
            clientTurnId: "turn-1",
            status: "streaming",
            schemaVersion: 1,
            blocks: [{ type: "text", content: "streamed content" }],
            createdAt: "2026-05-19T12:00:01.500Z",
            hydration: "full",
            hasDeferredContent: false,
          },
        ],
        status: "streaming",
        streaming: true,
        unlisten: existingUnlisten,
      });
      return lateUnlisten;
    });

    await useChatStore.getState().setActiveThread("thread-1");

    const state = useChatStore.getState();
    expect(state.messages.map((message) => message.id)).toEqual([
      "persisted-user",
      "optimistic-assistant",
    ]);
    expect(state.messages[1]?.blocks).toEqual([
      { type: "text", content: "streamed content" },
    ]);
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    expect(existingUnlisten).not.toHaveBeenCalled();
  });

  it("marks the thread as awaiting approval while a streamed approval is pending", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    streamHandler!({
      type: "ApprovalRequested",
      approval_id: "approval-runtime-2",
      action_type: "command",
      summary: "Run command",
      details: {},
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(useChatStore.getState()).toMatchObject({
      status: "awaiting_approval",
      streaming: true,
    });

    vi.useRealTimers();
  });

  it("resolves pending approvals when TurnCompleted arrives before approval resolution", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    streamHandler!({
      type: "ApprovalRequested",
      approval_id: "approval-runtime-3",
      action_type: "command",
      summary: "Run command",
      details: {},
    });
    streamHandler!({
      type: "TurnCompleted",
      status: "completed",
      diagnostics: {
        source: "engine",
      },
    });

    await vi.advanceTimersByTimeAsync(20);

    const state = useChatStore.getState();
    expect(state).toMatchObject({
      status: "completed",
      streaming: false,
    });
    const assistant = state.messages[state.messages.length - 1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.status).toBe("completed");
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "approval",
          approvalId: "approval-runtime-3",
          status: "answered",
          decision: "cancel",
        }),
      ]),
    );
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notice",
          kind: "turn_status",
          level: "info",
          title: "Turn completed",
          status: "completed",
          source: "engine",
          details: expect.arrayContaining(["Approvals: 0 pending, 1 answered"]),
        }),
      ]),
    );

    vi.useRealTimers();
  });

  it("shows a toast and preserves details for live context compaction notices", async () => {
    vi.useFakeTimers();

    let streamHandler: ((event: StreamEvent) => void) | null = null;
    mockListenThreadEvents.mockImplementationOnce(async (_threadId, onEvent) => {
      streamHandler = onEvent;
      return () => {};
    });

    await useChatStore.getState().setActiveThread("thread-1");

    streamHandler!({
      type: "Notice",
      kind: "context_compacted",
      level: "info",
      title: "Context compacted",
      message: "Codex compacted the active thread context to keep the conversation moving.",
      details: [
        "summary::Kept the repo goal and recent edits.",
        "prompt::Continue from the persisted thread summary.",
      ],
    });

    await vi.advanceTimersByTimeAsync(20);

    expect(mockToast.info).toHaveBeenCalledWith("Context compacted");
    expect(useChatStore.getState().messages.at(-1)?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "notice",
          kind: "context_compacted",
          details: [
            "summary::Kept the repo goal and recent edits.",
            "prompt::Continue from the persisted thread summary.",
          ],
        }),
      ]),
    );

    vi.useRealTimers();
  });

  it("blocks send when pending approvals still exist even if the thread is not marked streaming", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "completed",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-1",
              actionType: "command",
              summary: "Run command",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "completed",
      streaming: false,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await expect(useChatStore.getState().send("keep going")).resolves.toBe(false);
    expect(useChatStore.getState().error).toBe(
      "Resolve the pending approval before starting a new turn.",
    );
  });

  it("syncs dirty Codex thread metadata before binding the message window", async () => {
    const thread = {
      id: "thread-1",
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.3-codex",
      engineThreadId: "engine-thread-1",
      engineMetadata: {
        codexSyncRequired: true,
      },
      title: "Thread 1",
      status: "idle" as const,
      messageCount: 0,
      totalTokens: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };

    useThreadStore.setState({
      threads: [thread],
      threadsByWorkspace: {
        "workspace-1": [thread],
      },
      archivedThreadsByWorkspace: {},
      activeThreadId: "thread-1",
      loading: false,
      error: undefined,
    });

    await useChatStore.getState().setActiveThread("thread-1");

    expect(mockIpc.syncThreadFromEngine).toHaveBeenCalledWith("thread-1");
    expect(mockIpc.getThreadMessagesWindow).toHaveBeenCalledWith("thread-1", null, 80);
  });

  it("normalizes deny approvals to decline in optimistic state", async () => {
    useChatStore.setState({
      threadId: "thread-1",
      messages: [
        {
          id: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          status: "completed",
          schemaVersion: 1,
          blocks: [
            {
              type: "approval",
              approvalId: "approval-1",
              actionType: "command",
              summary: "Run command",
              details: {},
              status: "pending",
            },
          ],
          createdAt: new Date().toISOString(),
          hydration: "full",
          hasDeferredContent: false,
        },
      ],
      olderCursor: null,
      hasOlderMessages: false,
      loadingOlderMessages: false,
      olderLoadBlockedUntil: 0,
      status: "awaiting_approval",
      streaming: false,
      usageLimits: null,
      error: undefined,
      unlisten: undefined,
    });

    await useChatStore
      .getState()
      .respondApproval("approval-1", { decision: "deny" } as ApprovalResponse);

    expect(mockIpc.respondApproval).toHaveBeenCalledWith("thread-1", "approval-1", {
      decision: "deny",
    });
    expect(useChatStore.getState().messages[0]?.blocks).toMatchObject([
      {
        type: "approval",
        approvalId: "approval-1",
        actionType: "command",
        summary: "Run command",
        details: {},
        status: "answered",
        decision: "decline",
      },
    ]);
  });

});
