// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, Message, Thread } from "../../types";

const mockIpc = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  savePastedImageAttachment: vi.fn(),
  forkCodexThreadAtTurn: vi.fn(),
  setThreadCodexConfig: vi.fn(),
  respondApproval: vi.fn(),
}));
const mockListeners = vi.hoisted(() => ({
  transcriptUpdated: null as null | ((event: {
    threadId: string;
    assistantMessageId: string;
    lastSourceSequence: number;
  }) => void),
  assistantTurnRenderCount: 0,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

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
  MessageBlocks: ({ blocks }: { blocks: ContentBlock[] }) => (
    <>{blocks.map((block, index) => block.type === "text"
      ? <span key={index}>{block.content}</span>
      : null)}</>
  ),
}));

vi.mock("../chat/CodexTurnTranscript", () => ({
  CodexTurnTranscript: ({ refreshSequence }: { refreshSequence: number }) => {
    mockListeners.assistantTurnRenderCount += 1;
    return <div data-testid="assistant-turn" data-refresh-sequence={refreshSequence} />;
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
  mockListeners.transcriptUpdated = null;
  mockListeners.assistantTurnRenderCount = 0;
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
    expect(viewport.scrollTop).toBe(500);
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
