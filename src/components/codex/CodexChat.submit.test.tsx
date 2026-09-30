// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishTranscriptRows } from "./transcriptRows";
import type { ContentBlock, Message, Thread } from "../../types";

const mockIpc = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  savePastedImageAttachment: vi.fn(),
  forkCodexThreadAtTurn: vi.fn(),
  rollbackCodexThread: vi.fn(),
  setThreadCodexConfig: vi.fn(),
  respondApproval: vi.fn(),
  listCodexSkills: vi.fn(),
  listCodexApps: vi.fn(),
}));
const mockListeners = vi.hoisted(() => ({
  transcriptUpdated: null as null | ((event: {
    threadId: string;
    assistantMessageId: string;
    lastSourceSequence: number;
  }) => void),
  assistantTurnRenderCount: 0,
  messageBlocksRenderCount: 0,
}));

const mockDialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => mockDialog);

vi.mock("../../lib/codexIpc", () => ({
  ipc: mockIpc,
  listenThreadEvents: vi.fn(async () => () => {}),
  listenCodexRollbackMaterialized: vi.fn(async () => () => {}),
  listenCodexTranscriptUpdated: vi.fn(async (listener) => {
    mockListeners.transcriptUpdated = listener;
    return () => {};
  }),
}));

vi.mock("../chat/MessageBlocks", () => ({
  MessageBlocks: ({ blocks }: { blocks: ContentBlock[] }) => {
    mockListeners.messageBlocksRenderCount += 1;
    return <>{blocks.map((block, index) => block.type === "text"
      ? <span key={index}>{block.content}</span>
      : null)}</>;
  },
}));

vi.mock("../chat/CodexTurnTranscript", () => ({
  CodexTurnTranscript: ({ messageId, refreshSequence, onRows }: { messageId: string; refreshSequence: number; onRows?: PublishTranscriptRows }) => {
    mockListeners.assistantTurnRenderCount += 1;
    useEffect(() => { onRows?.(messageId, [{ key: messageId, messageId, estimatedHeight: 100,
      content: <div data-testid="assistant-turn" data-refresh-sequence={refreshSequence} /> }]); }, [messageId, refreshSequence, onRows]);
    return onRows ? null : <div data-testid="assistant-turn" data-refresh-sequence={refreshSequence} />;
  },
}));

import { useChatStore } from "../../stores/chatStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { initializeCodexI18n } from "../../i18n/codex";
import { CodexChat } from "./CodexChat";
import { resetLiveQuestionnaireDraftsForTests } from "../chat/ToolInputQuestionnaire";

const thread: Thread = {
  id: "thread-1",
  workspaceId: "workspace-1",
  repoId: null,
  engineId: "codex",
  modelId: "gpt-5.6-codex",
  engineThreadId: "engine-thread-1",
  title: "Rollback test",
  status: "idle",
  messageCount: 0,
  totalTokens: 0,
  createdAt: "2026-08-29T00:00:00.000Z",
  lastActivityAt: "2026-08-29T00:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await initializeCodexI18n();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIpc.setThreadCodexConfig.mockResolvedValue(thread);
  mockIpc.respondApproval.mockResolvedValue(undefined);
  mockIpc.listCodexSkills.mockResolvedValue([]);
  mockIpc.listCodexApps.mockResolvedValue([]);
  mockListeners.transcriptUpdated = null;
  mockListeners.assistantTurnRenderCount = 0;
  mockListeners.messageBlocksRenderCount = 0;
  localStorage.clear();
  sessionStorage.clear();
  resetLiveQuestionnaireDraftsForTests();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  useWorkspaceStore.setState({
    workspaces: [{
      id: "workspace-1",
      name: "Workspace",
      rootPath: "C:\\workspace",
      scanDepth: 2,
      createdAt: "2026-08-29T00:00:00.000Z",
      lastOpenedAt: "2026-08-29T00:00:00.000Z",
    }],
    activeWorkspaceId: "workspace-1",
  });
  useThreadStore.setState({
    threads: [thread],
    threadsByWorkspace: { "workspace-1": [thread] },
    archivedThreadsByWorkspace: {},
    activeThreadId: thread.id,
    loading: false,
    error: undefined,
  });
  useEngineStore.setState({
    engines: [{
      id: "codex",
      name: "Codex",
      models: [{
        id: "gpt-5.6-codex",
        displayName: "GPT-5.6 Codex",
        description: "",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        attachmentModalities: [],
        supportsPersonality: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
      }],
      capabilities: {
        permissionModes: [],
        sandboxModes: [],
        approvalDecisions: [],
      },
    }],
  });
  useThreadPlanModeStore.setState({
    threadModes: {},
    newThreadModesByWorkspaceId: {},
  });
  useChatStore.setState({
    threadId: thread.id,
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

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

it.each([null, "native-turn-1"])("shows one message timestamp with or without a native turn (%s)", async (nativeTurnId) => {
  useChatStore.setState({
    messages: [{
      id: "assistant-date", schemaVersion: 1, threadId: thread.id,
      role: "assistant", status: "completed", content: "Response",
      nativeTurnId, createdAt: "2026-08-26 18:00:00",
    }],
  });
  await act(async () => root.render(<CodexChat />));
  const dates = container.querySelectorAll<HTMLTimeElement>('.codex-message-footer time');
  expect(dates).toHaveLength(1);
  expect(dates[0].dateTime).toBe("2026-08-26T18:00:00.000Z");
  expect(dates[0].closest('.codex-message')?.getAttribute('data-message-id')).toBe("assistant-date");
  await act(async () => useChatStore.setState((state) => ({
    messages: state.messages.map((message) => ({ ...message, status: "streaming" })),
  })));
  expect(container.querySelector('.codex-message-timestamp')).toBeNull();
});

it("shows multiple async questions alongside steering and submits only the selected request", async () => {
  useChatStore.setState({
    streaming: true, status: "streaming",
    messages: [{ id: "assistant-questions", schemaVersion: 1, threadId: thread.id, role: "assistant", content: "", status: "streaming", createdAt: thread.createdAt,
      blocks: ["one", "two"].map((id) => ({ type: "approval", approvalId: id, actionType: "other", summary: `Question ${id}`, status: "pending",
        details: { _serverMethod: "item/tool/requestUserInput", isBlocking: false,
          questions: [{ id: "scope", header: "Scope", question: `Choose ${id}`, options: [{ label: "Small", description: "Focused" }] }] } })) }],
  });
  await act(async () => root.render(<CodexChat />));
  expect(container.querySelector('textarea[placeholder="Steer the current turn…"]')).not.toBeNull();
  expect(container.querySelectorAll('.codex-pending-questions details')).toHaveLength(2);
  expect(mockIpc.respondApproval).not.toHaveBeenCalled();
  const send = [...container.querySelectorAll('.codex-pending-questions button')].find((button) => button.textContent === "Send answers");
  await act(async () => (send as HTMLButtonElement)?.click());
  expect(mockIpc.respondApproval).toHaveBeenCalledWith(thread.id, "one", { answers: { scope: { answers: ["Small"] } } });
  expect(container.querySelectorAll('.codex-pending-questions details')).toHaveLength(1);
  expect(useChatStore.getState().status).toBe("streaming");
  expect(useThreadPlanModeStore.getState().threadModes[thread.id]).toBeUndefined();
});

it("retains blocking composer takeover in default mode", async () => {
  useChatStore.setState({ streaming: true, status: "awaiting_approval",
    messages: [{ id: "assistant-blocking", schemaVersion: 1, threadId: thread.id, role: "assistant", content: "", status: "streaming", createdAt: thread.createdAt,
      blocks: [{ type: "approval", approvalId: "blocking", actionType: "other", summary: "Required", status: "pending",
        details: { _serverMethod: "item/tool/requestUserInput", isBlocking: true,
          questions: [{ id: "scope", header: "Scope", question: "Required scope?", options: null }] } }] }],
  });
  await act(async () => root.render(<CodexChat />));
  expect(container.querySelector('textarea[placeholder="Steer the current turn…"]')).toBeNull();
  expect(container.textContent).toContain("Required scope?");
  expect(container.querySelector('.codex-pending-questions')).toBeNull();
  const answer = container.querySelector<HTMLTextAreaElement>('.codex-questionnaire-answer');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(answer, "Keep this draft");
    answer?.dispatchEvent(new Event("input", { bubbles: true }));
    root.render(<div>Another thread</div>);
  });
  await act(async () => root.render(<CodexChat />));
  expect(container.querySelector<HTMLTextAreaElement>('.codex-questionnaire-answer')?.value).toBe("Keep this draft");
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.getSelection()?.removeAllRanges();
  container.remove();
  vi.unstubAllGlobals();
});

describe("CodexChat submission", () => {
  async function typeDraft(text: string) {
    const textarea = container.querySelector<HTMLTextAreaElement>(".codex-composer textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return textarea;
  }

  it.each([false, true])("keeps typing local to the composer in a long thread (streaming: %s)", async (streaming) => {
    const messages: Message[] = Array.from({ length: 100 }, (_, index) => ({
      id: `long-thread-${index}`,
      threadId: thread.id,
      schemaVersion: 1,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}: ${"Long transcript content. ".repeat(100)}`,
      status: streaming && index === 99 ? "streaming" : "completed",
      createdAt: thread.createdAt,
    }));
    useChatStore.setState({ messages, streaming, status: streaming ? "streaming" : "idle" });
    await act(async () => root.render(<CodexChat />));
    expect(container.querySelectorAll(".codex-message").length).toBeLessThan(30);
    expect(container.querySelector(".is-virtualized")).not.toBeNull();
    const rendersBeforeTyping = {
      assistant: mockListeners.assistantTurnRenderCount,
      user: mockListeners.messageBlocksRenderCount,
    };
    expect(rendersBeforeTyping.assistant).toBeGreaterThan(0);
    expect(rendersBeforeTyping.user).toBeGreaterThan(0);
    const textarea = container.querySelector<HTMLTextAreaElement>(".codex-composer textarea")!;
    expect(container.querySelector<HTMLButtonElement>("button.send")?.disabled).toBe(true);
    for (const character of "Follow up") {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, textarea.value + character);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    expect(textarea.value).toBe("Follow up");
    expect(container.querySelector<HTMLButtonElement>("button.send")?.disabled).toBe(false);
    expect(mockListeners.assistantTurnRenderCount).toBe(rendersBeforeTyping.assistant);
    expect(mockListeners.messageBlocksRenderCount).toBe(rendersBeforeTyping.user);

    // A real transcript update must still render without losing the draft.
    await act(async () => mockListeners.transcriptUpdated?.({
      threadId: thread.id,
      assistantMessageId: "long-thread-99",
      lastSourceSequence: 42,
    }));
    expect(container.querySelector('[data-message-id="long-thread-99"] [data-testid="assistant-turn"]')?.getAttribute("data-refresh-sequence")).toBe("42");
    expect(textarea.value).toBe("Follow up");
  });

  it.each(["visible", "hidden", "missing"])("groups available GPT-6 models first without changing the selected model (%s)", async (availability) => {
    const engine = useEngineStore.getState().engines[0];
    const otherModelIds = ["gpt-5.6-sol", "future-model", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
    const gpt6ModelIds = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
    const catalogIds = [...otherModelIds];
    if (availability !== "missing") {
      catalogIds.splice(1, 0, "gpt-6-luna");
      catalogIds.splice(3, 0, "gpt-6-sol");
      catalogIds.push("gpt-6-astra");
    }
    const catalog = catalogIds.map((id) => ({
      ...engine.models[0],
      id,
      displayName: id,
      isDefault: id === "gpt-5.6-sol",
      hidden: gpt6ModelIds.includes(id) && availability === "hidden",
    }));
    useEngineStore.setState({ engines: [{ ...engine, models: catalog }] });
    useThreadStore.setState({ threads: [{ ...thread, modelId: "gpt-5.6-luna" }] });

    await act(async () => root.render(<CodexChat />));

    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]');
    expect(Array.from(picker?.options ?? [], (option) => option.value)).toEqual(
      availability === "visible" ? [...gpt6ModelIds, ...otherModelIds] : otherModelIds,
    );
    expect(picker?.value).toBe("gpt-5.6-luna");
    expect(catalog.map((model) => model.id)).toEqual(catalogIds);
    expect(mockIpc.setThreadCodexConfig).not.toHaveBeenCalled();
  });

  it.each([
    { modelId: "gpt-6-sol", displayName: "GPT-6 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium", expectedEffort: "ultra" },
    { modelId: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", expectedEffort: "high" },
  ])("submits $modelId with the reasoning options from its catalog", async ({ modelId, displayName, efforts, defaultEffort, expectedEffort }) => {
    const engine = useEngineStore.getState().engines[0];
    const previousModel = {
      ...engine.models[0],
      id: "gpt-5.6-sol",
      supportedReasoningEfforts: [{ reasoningEffort: "ultra", description: "" }],
    };
    useEngineStore.setState({ engines: [{ ...engine, models: [previousModel, {
      ...previousModel,
      id: modelId,
      displayName,
      isDefault: false,
      defaultReasoningEffort: defaultEffort,
      supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
    }] }] });
    useThreadStore.setState({ threads: [{
      ...thread,
      modelId: previousModel.id,
      engineMetadata: { reasoningEffort: "ultra" },
    }] });
    mockIpc.sendMessage.mockResolvedValueOnce("assistant-new-model");
    await act(async () => root.render(<CodexChat />));
    const picker = container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')!;
    await act(async () => {
      picker.value = modelId;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(picker.selectedOptions[0].textContent).toBe(displayName);
    const effortPicker = container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]')!;
    expect(Array.from(effortPicker.options, (option) => option.value)).toEqual(efforts);
    expect(effortPicker.value).toBe(expectedEffort);
    const textarea = await typeDraft("Use the selected model");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    expect(mockIpc.sendMessage).toHaveBeenCalledOnce();
    expect(mockIpc.sendMessage.mock.calls[0].slice(0, 4)).toEqual([
      thread.id, "Use the selected model", modelId, expectedEffort,
    ]);
  });

  it("shows compatibility rollback progress before the user tries to send", async () => {
    const pendingThread: Thread = {
      ...thread,
      engineMetadata: {
        codexCompatibilityFork: true,
        engineRollbackPending: true,
      },
    };
    useThreadStore.setState({
      threads: [pendingThread],
      threadsByWorkspace: { "workspace-1": [pendingThread] },
    });

    await act(async () => root.render(<CodexChat />));

    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain("Confirming compatibility rollback in Codex");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>("button.send")?.disabled).toBe(true);
    const textarea = container.querySelector("textarea");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Keep this draft");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(mockIpc.sendMessage).not.toHaveBeenCalled();
    expect(textarea?.value).toBe("Keep this draft");
  });

  it("shows a persisted background rollback failure without waiting for send", async () => {
    const failedThread: Thread = {
      ...thread,
      engineMetadata: {
        codexCompatibilityFork: true,
        engineRollbackPending: true,
        engineRollbackError: "durable marker missing",
      },
    };
    useThreadStore.setState({
      threads: [failedThread],
      threadsByWorkspace: { "workspace-1": [failedThread] },
    });

    await act(async () => root.render(<CodexChat />));

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain("History edit needs recovery");
    expect(container.querySelector<HTMLButtonElement>("button.send")?.disabled).toBe(true);
    expect(container.textContent).toContain("Recover history");
  });

  it("toggles Fast mode from the composer toolbar", async () => {
    mockIpc.setThreadCodexConfig.mockResolvedValueOnce({
      ...thread,
      engineMetadata: { serviceTier: "fast" },
    });

    await act(async () => root.render(<CodexChat />));
    const fastButton = container.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]');

    expect(fastButton).not.toBeNull();
    expect(fastButton?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fastButton?.click();
      await Promise.resolve();
    });

    expect(mockIpc.setThreadCodexConfig).toHaveBeenCalledWith(thread.id, {
      serviceTier: "fast",
    });
    expect(fastButton?.getAttribute("aria-pressed")).toBe("true");
  });

  it("lets a new conversation select Fast mode before its first message", async () => {
    useThreadStore.setState({
      threads: [],
      threadsByWorkspace: { "workspace-1": [] },
      activeThreadId: null,
    });
    useChatStore.setState({ threadId: null });

    await act(async () => root.render(<CodexChat />));
    const fastButton = container.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]');

    expect(fastButton?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => fastButton?.click());
    expect(fastButton?.getAttribute("aria-pressed")).toBe("true");
    expect(mockIpc.setThreadCodexConfig).not.toHaveBeenCalled();
  });

  it("selects GPT-6 Sol for a new conversation when the catalog still defaults to GPT-5.6 Sol", async () => {
    const engine = useEngineStore.getState().engines[0];
    const oldDefault = { ...engine.models[0], id: "gpt-5.6-sol", isDefault: true };
    const gpt6Sol = { ...oldDefault, id: "gpt-6-sol", displayName: "GPT-6 Sol", isDefault: false };
    useEngineStore.setState({ engines: [{ ...engine, models: [oldDefault, gpt6Sol] }] });
    useThreadStore.setState({ threads: [], threadsByWorkspace: { "workspace-1": [] }, activeThreadId: null });
    useChatStore.setState({ threadId: null });

    await act(async () => root.render(<CodexChat />));

    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe("gpt-6-sol");
  });

  it("does not rerender the visible transcript for a background thread status update", async () => {
    const backgroundThread: Thread = {
      ...thread,
      id: "thread-background",
      engineThreadId: "engine-thread-background",
      title: "Background turn",
      status: "idle",
    };
    const assistant: Message = {
      id: "assistant-message-current",
      threadId: thread.id,
      role: "assistant",
      content: "Current answer",
      status: "completed",
      schemaVersion: 1,
      createdAt: "2026-08-29T00:00:01.000Z",
    };
    useThreadStore.setState({
      threads: [thread, backgroundThread],
      threadsByWorkspace: { "workspace-1": [thread, backgroundThread] },
      activeThreadId: thread.id,
    });
    useChatStore.setState({ messages: [assistant] });
    await act(async () => {
      root.render(<CodexChat />);
      await Promise.resolve();
    });
    const renderCount = mockListeners.assistantTurnRenderCount;

    await act(async () => {
      useThreadStore.getState().setThreadStatusLocal(backgroundThread.id, "streaming");
      await Promise.resolve();
    });

    expect(mockListeners.assistantTurnRenderCount).toBe(renderCount);
  });

  it("ignores transcript refresh events from a different running thread", async () => {
    const assistant: Message = {
      id: "assistant-message-current",
      threadId: thread.id,
      role: "assistant",
      content: "Current answer",
      status: "streaming",
      schemaVersion: 1,
      createdAt: "2026-08-29T00:00:01.000Z",
    };
    useChatStore.setState({
      messages: [assistant],
      status: "streaming",
      streaming: true,
    });
    await act(async () => {
      root.render(<CodexChat />);
      await Promise.resolve();
    });

    expect(mockListeners.transcriptUpdated).not.toBeNull();
    const turn = () => container.querySelector('[data-testid="assistant-turn"]');
    expect(turn()?.getAttribute("data-refresh-sequence")).toBe("0");
    const viewport = container.querySelector(".codex-message-viewport") as HTMLDivElement;
    Object.defineProperty(viewport, "scrollHeight", { value: 1_000, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    viewport.scrollTop = 300;
    await act(async () => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));

    await act(async () => {
      mockListeners.transcriptUpdated?.({
        threadId: "thread-running-in-background",
        assistantMessageId: assistant.id,
        lastSourceSequence: 50,
      });
      await Promise.resolve();
    });
    expect(turn()?.getAttribute("data-refresh-sequence")).toBe("0");
    expect(viewport.scrollTop).toBe(300);
    expect(container.querySelector(".codex-jump-latest")).toBeNull();

    await act(async () => {
      mockListeners.transcriptUpdated?.({
        threadId: thread.id,
        assistantMessageId: assistant.id,
        lastSourceSequence: 51,
      });
      await Promise.resolve();
    });
    expect(turn()?.getAttribute("data-refresh-sequence")).toBe("51");
  });

  it("pauses live auto-follow for a selection until Jump to latest is used", async () => {
    const message: Message = {
      id: "user-message-selection",
      threadId: thread.id,
      role: "user",
      content: "Keep this highlighted",
      status: "streaming",
      schemaVersion: 1,
      createdAt: "2026-08-29T00:00:01.000Z",
    };
    useChatStore.setState({
      messages: [message],
      status: "streaming",
      streaming: true,
    });

    await act(async () => root.render(<CodexChat />));
    const viewport = container.querySelector(".codex-message-viewport") as HTMLDivElement;
    Object.defineProperty(viewport, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { value: 100, configurable: true });
    viewport.scrollTop = 0;

    const textNode = container.querySelector(".codex-message.user span")?.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.setEnd(textNode, 9);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
    });

    await act(async () => {
      useChatStore.setState({
        messages: [{ ...message, content: "Keep this highlighted while output grows" }],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.getSelection()?.toString()).toBe("this");
    const jumpButton = container.querySelector<HTMLButtonElement>(".codex-jump-latest");
    expect(jumpButton?.textContent).toContain("Jump to latest");

    await act(async () => jumpButton?.click());

    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(container.querySelector(".codex-jump-latest")).toBeNull();
    expect(viewport.scrollTop).toBe(400);
  });

  it("forks a completed prior turn while the newest turn keeps streaming", async () => {
    const streamingThread: Thread = {
      ...thread,
      status: "streaming",
      messageCount: 4,
    };
    const messages: Message[] = [
      {
        id: "user-message-1",
        threadId: thread.id,
        role: "user",
        content: "first prompt",
        status: "completed",
        schemaVersion: 1,
        createdAt: "2026-08-29T00:00:01.000Z",
      },
      {
        id: "assistant-message-1",
        threadId: thread.id,
        role: "assistant",
        content: "first answer",
        nativeTurnId: "native-turn-1",
        status: "completed",
        schemaVersion: 1,
        createdAt: "2026-08-29T00:00:02.000Z",
      },
      {
        id: "user-message-2",
        threadId: thread.id,
        role: "user",
        content: "second prompt",
        status: "completed",
        schemaVersion: 1,
        createdAt: "2026-08-29T00:00:03.000Z",
      },
      {
        id: "assistant-message-2",
        threadId: thread.id,
        role: "assistant",
        content: "partial answer",
        status: "streaming",
        schemaVersion: 1,
        createdAt: "2026-08-29T00:00:04.000Z",
      },
    ];

    useThreadStore.setState({
      threads: [streamingThread],
      threadsByWorkspace: { "workspace-1": [streamingThread] },
      activeThreadId: streamingThread.id,
    });
    useChatStore.setState({
      threadId: streamingThread.id,
      messages,
      status: "streaming",
      streaming: true,
    });
    mockIpc.forkCodexThreadAtTurn.mockReturnValue(new Promise<Thread>(() => {}));

    await act(async () => root.render(<CodexChat />));

    const forkButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Fork from here"]',
    );
    expect(forkButtons).toHaveLength(1);

    await act(async () => {
      forkButtons[0]?.click();
      await Promise.resolve();
    });

    expect(mockIpc.forkCodexThreadAtTurn).toHaveBeenCalledWith(
      thread.id,
      "assistant-message-1",
      "native-turn-1",
      1,
      null,
    );
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it("removes only the selected pasted image", async () => {
    useChatStore.setState({ messages: [{
      id: "assistant-attachments", threadId: thread.id, schemaVersion: 1,
      role: "assistant", content: "Existing history", status: "completed", createdAt: thread.createdAt,
    }] });
    class TestFileReader {
      result: string | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL() {
        this.result = "data:image/png;base64,aW1hZ2U=";
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("FileReader", TestFileReader);
    mockIpc.savePastedImageAttachment.mockImplementation(async (fileName: string) => ({
      fileName,
      filePath: `C:/attachments/${fileName}`,
      sizeBytes: 10,
      mimeType: "image/png",
    }));

    await act(async () => root.render(<CodexChat />));
    const rendersBeforeAttachments = mockListeners.assistantTurnRenderCount;
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    const files = ["first.png", "second.png", "third.png"].map(
      (name) => new File([name], name, { type: "image/png" }),
    );
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { files },
    });

    await act(async () => {
      textarea?.dispatchEvent(pasteEvent);
      expect(pasteEvent.defaultPrevented).toBe(true);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".chat-attachment-chip-remove")).toHaveLength(3);
    });

    const secondRemove = container.querySelector<HTMLButtonElement>(
      '[aria-label="Remove second.png"]',
    );
    expect(secondRemove).not.toBeNull();

    await act(async () => secondRemove?.click());

    expect(container.querySelectorAll(".chat-attachment-chip-remove")).toHaveLength(2);
    expect(container.querySelector('[aria-label="Remove first.png"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Remove second.png"]')).toBeNull();
    expect(container.querySelector('[aria-label="Remove third.png"]')).not.toBeNull();
    expect(mockListeners.assistantTurnRenderCount).toBe(rendersBeforeAttachments);
  });

  it("preserves the ordinary draft and attachments while a blocking question takes over", async () => {
    await act(async () => root.render(<CodexChat />));
    await typeDraft("Unsent follow-up");
    mockDialog.open.mockResolvedValueOnce(["C:/attachments/notes.txt"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Attach files"]')?.click());

    await act(async () => useChatStore.setState({
      streaming: true, status: "awaiting_approval",
      messages: [{
        id: "blocking-draft", threadId: thread.id, schemaVersion: 1, role: "assistant",
        content: "", status: "streaming", createdAt: thread.createdAt,
        blocks: [{ type: "approval", approvalId: "draft-question", actionType: "other", summary: "Question", status: "pending",
          details: { _serverMethod: "item/tool/requestUserInput", isBlocking: true,
            questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: null }] } }],
      }],
    }));
    expect(container.querySelector('.codex-questionnaire-answer')).not.toBeNull();
    expect(container.querySelector('[aria-label="Remove notes.txt"]')).toBeNull();
    await act(async () => useChatStore.setState({ messages: [], status: "streaming" }));
    expect(container.querySelector<HTMLTextAreaElement>('.codex-composer textarea')?.value).toBe("Unsent follow-up");
    expect(container.querySelector('[aria-label="Remove notes.txt"]')).not.toBeNull();
  });

  it("loads references once while typing a mention and keeps the transcript untouched", async () => {
    let resolveApps!: (apps: []) => void;
    mockIpc.listCodexApps.mockReturnValueOnce(new Promise<[]>((resolve) => { resolveApps = resolve; }));
    useChatStore.setState({ messages: [{
      id: "assistant-reference", threadId: thread.id, schemaVersion: 1, role: "assistant",
      content: "Existing history", status: "completed", createdAt: thread.createdAt,
    }] });
    await act(async () => root.render(<CodexChat />));
    const rendersBeforeTyping = mockListeners.assistantTurnRenderCount;
    for (const text of ["$", "$s", "$sk", "$skill"]) await typeDraft(text);
    expect(mockIpc.listCodexSkills).toHaveBeenCalledExactlyOnceWith("C:\\workspace");
    expect(mockIpc.listCodexApps).toHaveBeenCalledOnce();
    await act(async () => resolveApps([]));
    expect(mockListeners.assistantTurnRenderCount).toBe(rendersBeforeTyping);
    expect(container.querySelector<HTMLTextAreaElement>('.codex-composer textarea')?.value).toBe("$skill");
  });

  it("preserves keyboard behavior with a local draft", async () => {
    mockIpc.sendMessage.mockReturnValueOnce(new Promise<string>(() => {}));
    await act(async () => root.render(<CodexChat />));
    const textarea = await typeDraft("Plan this change");
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ...options }));
      });
    }
    expect(mockIpc.sendMessage).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey: true })));
    expect(useThreadPlanModeStore.getState().threadModes[thread.id]).toBe("plan");
    expect(textarea.value).toBe("Plan this change");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    expect(mockIpc.sendMessage).toHaveBeenCalledOnce();
    expect(textarea.value).toBe("");
  });

  it("restores a failed submission without losing text or attachments added while sending", async () => {
    let rejectSend!: (error: Error) => void;
    mockIpc.sendMessage.mockReturnValueOnce(new Promise<string>((_resolve, reject) => { rejectSend = reject; }));
    await act(async () => root.render(<CodexChat />));
    await typeDraft("Original draft");
    mockDialog.open.mockResolvedValueOnce(["C:/attachments/original.txt"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Attach files"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button.send')?.click());
    expect(container.querySelector<HTMLTextAreaElement>('.codex-composer textarea')?.value).toBe("");
    expect(container.querySelector('[aria-label="Remove original.txt"]')).toBeNull();
    await typeDraft("More thoughts");
    mockDialog.open.mockResolvedValueOnce(["C:/attachments/new.txt"]);
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Attach files"]')?.click());
    await act(async () => rejectSend(new Error("Connection failed")));
    expect(container.querySelector<HTMLTextAreaElement>('.codex-composer textarea')?.value).toBe("Original draft\nMore thoughts");
    expect(container.querySelector('[aria-label="Remove original.txt"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Remove new.txt"]')).not.toBeNull();
  });

  it("restores a history edit into the local composer with its attachments", async () => {
    useChatStore.setState({ messages: [{
      id: "rollback-user", threadId: thread.id, schemaVersion: 1, role: "user",
      content: "Original message", status: "completed", createdAt: thread.createdAt,
      blocks: [{ type: "attachment", fileName: "notes.txt", filePath: "C:/attachments/notes.txt", sizeBytes: 10, mimeType: "text/plain" }],
    }] });
    mockIpc.rollbackCodexThread.mockReturnValueOnce(new Promise<Thread>(() => {}));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await act(async () => root.render(<CodexChat />));
      await typeDraft("Replace this draft");
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Roll back to here"]')?.click());
      expect(mockIpc.rollbackCodexThread).toHaveBeenCalledWith(thread.id, 1, null);
      expect(container.querySelector<HTMLTextAreaElement>('.codex-composer textarea')?.value).toBe("Original message");
      expect(container.querySelector('[aria-label="Remove notes.txt"]')).not.toBeNull();
      expect(document.activeElement).toBe(container.querySelector('.codex-composer textarea'));
      expect(container.querySelector<HTMLButtonElement>('button.send')?.disabled).toBe(true);
    } finally {
      confirm.mockRestore();
    }
  });

  it("removes a rollback-restored draft as soon as its optimistic bubble appears", async () => {
    let resolveSend!: (assistantMessageId: string) => void;
    mockIpc.sendMessage.mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveSend = resolve;
    }));

    await act(async () => root.render(<CodexChat />));
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setValue?.call(textarea, "heyyy dude 123 123");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea?.value).toBe("heyyy dude 123 123");

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
      }));
      await Promise.resolve();
    });

    expect(mockIpc.sendMessage).toHaveBeenCalledOnce();
    expect(container.querySelector(".codex-message.user")?.textContent)
      .toContain("heyyy dude 123 123");
    expect(textarea?.value).toBe("");

    await act(async () => {
      resolveSend("assistant-message-1");
      await Promise.resolve();
    });
  });
});
