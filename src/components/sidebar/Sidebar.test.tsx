// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread, Workspace } from "../../types";

const mockI18n = vi.hoisted(() => ({
  language: "en",
  changeLanguage: vi.fn(async (language: string) => language),
}));

const mockOpenDialog = vi.hoisted(() => vi.fn(async () => null));
const mockGetTerminalAcceleratedRendering = vi.hoisted(() => vi.fn(async () => true));
const mockCreateAndActivateWorkspaceThread = vi.hoisted(() => vi.fn(async () => null));
const mockToastSuccess = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());

const workspace = vi.hoisted((): Workspace => ({
  id: "ws-1",
  name: "Workspace 1",
  rootPath: "C:/workspace",
  scanDepth: 3,
  createdAt: "2026-05-19T00:00:00.000Z",
  lastOpenedAt: "2026-05-19T00:00:00.000Z",
}));

const workspaceTwo = vi.hoisted((): Workspace => ({
  id: "ws-2",
  name: "Workspace 2",
  rootPath: "C:/workspace-two",
  scanDepth: 3,
  createdAt: "2026-05-19T00:00:00.000Z",
  lastOpenedAt: "2026-05-19T00:00:00.000Z",
}));

const workspaceThree = vi.hoisted((): Workspace => ({
  id: "ws-3",
  name: "Workspace 3",
  rootPath: "C:/workspace-three",
  scanDepth: 3,
  createdAt: "2026-05-19T00:00:00.000Z",
  lastOpenedAt: "2026-05-19T00:00:00.000Z",
}));

const codexThread = vi.hoisted((): Thread => ({
  id: "codex-1",
  workspaceId: "ws-1",
  repoId: null,
  engineId: "codex",
  modelId: "gpt-5",
  engineThreadId: "engine-codex-1",
  engineMetadata: {},
  title: "Codex conversation",
  status: "completed",
  messageCount: 3,
  totalTokens: 0,
  createdAt: "2026-05-19T00:00:00.000Z",
  lastActivityAt: "2026-05-19T00:00:00.000Z",
}));

const claudeThread = vi.hoisted((): Thread => ({
  id: "claude-1",
  workspaceId: "ws-1",
  repoId: null,
  engineId: "claude",
  modelId: "claude-sonnet-4",
  engineThreadId: "engine-claude-1",
  engineMetadata: {},
  title: "Claude conversation",
  status: "completed",
  messageCount: 2,
  totalTokens: 0,
  createdAt: "2026-05-19T00:00:00.000Z",
  lastActivityAt: "2026-05-19T00:00:00.000Z",
}));

const forkedThread = vi.hoisted((): Thread => ({
  ...codexThread,
  id: "forked-1",
  title: "Forked conversation",
}));

const workspaceState = vi.hoisted(() => ({
  workspaces: [workspace],
  archivedWorkspaces: [] as Workspace[],
  activeWorkspaceId: "ws-1" as string | null,
  setActiveWorkspace: vi.fn(async (workspaceId: string) => {
    workspaceState.activeWorkspaceId = workspaceId;
  }),
  setActiveRepo: vi.fn(),
  openWorkspace: vi.fn(async () => workspace),
  removeWorkspace: vi.fn(async () => undefined),
  restoreWorkspace: vi.fn(async () => workspace),
  reorderWorkspaces: vi.fn(async () => undefined),
  refreshArchivedWorkspaces: vi.fn(async () => undefined),
  error: undefined as string | undefined,
}));

const threadState = vi.hoisted(() => ({
  threads: [codexThread, claudeThread] as Thread[],
  archivedThreadsByWorkspace: {} as Record<string, Thread[]>,
  activeThreadId: "claude-1" as string | null,
  setActiveThread: vi.fn((threadId: string | null) => {
    threadState.activeThreadId = threadId;
  }),
  forkCodexThread: vi.fn(async (threadId: string) => {
    if (threadId !== codexThread.id) {
      return null;
    }
    threadState.activeThreadId = forkedThread.id;
    return forkedThread;
  }),
  removeThread: vi.fn(async () => undefined),
  restoreThread: vi.fn(async () => undefined),
  refreshArchivedThreads: vi.fn(async () => undefined),
}));

const chatState = vi.hoisted(() => ({
  threadId: "claude-1" as string | null,
  status: "completed" as Thread["status"],
  streaming: false,
  setActiveThread: vi.fn(async (threadId: string | null) => {
    chatState.threadId = threadId;
  }),
}));

const uiState = vi.hoisted(() => ({
  sidebarPinned: true,
  toggleSidebarPin: vi.fn(),
  activeView: "harnesses" as "chat" | "harnesses" | "workspace-settings",
  setActiveView: vi.fn((view: "chat" | "harnesses" | "workspace-settings") => {
    uiState.activeView = view;
  }),
  openWorkspaceSettings: vi.fn(),
  openCommandPalette: vi.fn(),
}));

const onboardingState = vi.hoisted(() => ({
  openOnboarding: vi.fn(),
}));

const updateState = vi.hoisted(() => ({
  status: "idle" as const,
  snoozed: false,
}));

const keepAwakeState = vi.hoisted(() => ({
  state: null,
  loading: false,
  toggle: vi.fn(async () => undefined),
  openPowerSettings: vi.fn(),
}));

const terminalNotificationState = vi.hoisted(() => ({
  settings: null,
  loading: false,
  loadedOnce: false,
  updatingChatEnabled: false,
  updatingTerminalEnabled: false,
  toggle: vi.fn(async () => undefined),
  openModal: vi.fn(),
}));

const threadNotificationState = vi.hoisted(() => ({
  notificationsByThreadId: {} as Record<string, { workspaceId: string; status?: string }>,
}));

const threadPlanModeState = vi.hoisted(() => ({
  threadModes: {} as Record<string, "default" | "plan">,
}));

function applySelector<TState, TResult>(
  state: TState,
  selector?: ((state: TState) => TResult) | undefined,
): TState | TResult {
  return selector ? selector(state) : state;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: mockI18n,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mockOpenDialog,
}));

vi.mock("../../lib/ipc", () => ({
  ipc: {
    getTerminalAcceleratedRendering: mockGetTerminalAcceleratedRendering,
  },
}));

vi.mock("../../lib/formatters", () => ({
  formatRelativeTime: vi.fn(() => "now"),
}));

vi.mock("../../lib/newThreadActions", () => ({
  createAndActivateWorkspaceThread: mockCreateAndActivateWorkspaceThread,
}));

vi.mock("../../stores/toastStore", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../../stores/workspaceStore", () => ({
  useWorkspaceStore: (selector?: (state: typeof workspaceState) => unknown) =>
    applySelector(workspaceState, selector),
}));

vi.mock("../../stores/threadStore", () => ({
  useThreadStore: (selector?: (state: typeof threadState) => unknown) =>
    applySelector(threadState, selector),
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: (selector?: (state: typeof chatState) => unknown) =>
    applySelector(chatState, selector),
}));

vi.mock("../../stores/uiStore", () => ({
  useUiStore: (selector?: (state: typeof uiState) => unknown) =>
    applySelector(uiState, selector),
}));

vi.mock("../../stores/onboardingStore", () => ({
  useOnboardingStore: (selector?: (state: typeof onboardingState) => unknown) =>
    applySelector(onboardingState, selector),
}));

vi.mock("../../stores/updateStore", () => ({
  useUpdateStore: (selector?: (state: typeof updateState) => unknown) =>
    applySelector(updateState, selector),
}));

vi.mock("../../stores/keepAwakeStore", () => ({
  canToggleKeepAwake: () => false,
  useKeepAwakeStore: (selector?: (state: typeof keepAwakeState) => unknown) =>
    applySelector(keepAwakeState, selector),
}));

vi.mock("../../stores/terminalNotificationSettingsStore", () => ({
  useTerminalNotificationSettingsStore: (
    selector?: (state: typeof terminalNotificationState) => unknown,
  ) => applySelector(terminalNotificationState, selector),
}));

vi.mock("../../stores/threadNotificationStore", () => ({
  useThreadNotificationStore: (
    selector?: (state: typeof threadNotificationState) => unknown,
  ) => applySelector(threadNotificationState, selector),
  countWorkspaceThreadNotifications: (
    notificationsByThreadId: Record<string, { workspaceId: string; status?: string }>,
    workspaceId: string,
  ) =>
    Object.values(notificationsByThreadId).filter(
      (notification) => notification.workspaceId === workspaceId,
    ).length,
  countWorkspacePendingApprovalNotifications: (
    notificationsByThreadId: Record<string, { workspaceId: string; status?: string }>,
    workspaceId: string,
  ) =>
    Object.values(notificationsByThreadId).filter(
      (notification) =>
        notification.workspaceId === workspaceId && notification.status === "pending_approval",
    ).length,
}));

vi.mock("../../stores/threadPlanModeStore", () => ({
  useThreadPlanModeStore: (
    selector?: (state: typeof threadPlanModeState) => unknown,
  ) => applySelector(threadPlanModeState, selector),
}));

vi.mock("../workspace/WorkspaceMoreMenu", () => ({
  WorkspaceMoreMenu: () => null,
}));

vi.mock("../onboarding/UpdateDialog", () => ({
  UpdateDialog: () => null,
}));

vi.mock("../shared/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { Sidebar } from "./Sidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Sidebar thread context menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaces = [workspace];
    workspaceState.archivedWorkspaces = [];
    workspaceState.activeWorkspaceId = "ws-1";
    workspaceState.error = undefined;
    threadState.threads = [codexThread, claudeThread];
    threadState.activeThreadId = "claude-1";
    chatState.threadId = "claude-1";
    chatState.status = "completed";
    chatState.streaming = false;
    threadNotificationState.notificationsByThreadId = {};
    threadPlanModeState.threadModes = {};
    uiState.sidebarPinned = true;
    uiState.activeView = "harnesses";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("forks the clicked codex row instead of the globally active thread", async () => {
    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    expect(row).not.toBeNull();

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
    });

    const forkButton = findForkButton();
    expect(forkButton).not.toBeNull();
    expect(forkButton?.disabled).toBe(false);

    await act(async () => {
      forkButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(threadState.forkCodexThread).toHaveBeenCalledWith("codex-1");
    expect(threadState.setActiveThread).toHaveBeenCalledWith("forked-1");
    expect(chatState.setActiveThread).toHaveBeenCalledWith("forked-1");
    expect(uiState.setActiveView).toHaveBeenCalledWith("chat");
    expect(mockToastSuccess).toHaveBeenCalledWith("chat:panel.toasts.codexThreadForked");
  });

  it("does not expose the fork menu item for non-codex rows", async () => {
    await renderSidebar();

    const row = findThreadRow("Claude conversation");
    expect(row).not.toBeNull();

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
    });

    expect(findForkButton()).toBeNull();
  });

  it("shows fork as disabled for busy codex rows", async () => {
    threadState.threads = [{ ...codexThread, status: "streaming" }, claudeThread];
    threadState.activeThreadId = "codex-1";
    chatState.threadId = "codex-1";
    chatState.status = "streaming";
    chatState.streaming = true;

    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    expect(row).not.toBeNull();

    await act(async () => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 120,
          clientY: 80,
        }),
      );
    });

    const forkButton = findForkButton();
    expect(forkButton).not.toBeNull();
    expect(forkButton?.disabled).toBe(true);
  });

  it("reorders workspace folders by dragging a project row", async () => {
    workspaceState.workspaces = [workspace, workspaceTwo, workspaceThree];
    threadState.threads = [];
    await renderSidebar();

    const rows = findProjectRows();
    expect(rows).toHaveLength(3);
    mockProjectRects(rows);

    await act(async () => {
      dispatchPointer(rows[2], "pointerdown", { clientX: 20, clientY: 75 });
      dispatchPointer(window, "pointermove", { clientX: 20, clientY: 12 });
      dispatchPointer(window, "pointerup", { clientX: 20, clientY: 12 });
      await Promise.resolve();
    });

    expect(workspaceState.reorderWorkspaces).toHaveBeenCalledWith([
      workspaceThree.id,
      workspace.id,
      workspaceTwo.id,
    ]);
  });

  it("does not reorder workspaces when dragging a thread row", async () => {
    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    expect(row).not.toBeNull();

    await act(async () => {
      dispatchPointer(row as HTMLDivElement, "pointerdown", { clientX: 20, clientY: 90 });
      dispatchPointer(window, "pointermove", { clientX: 20, clientY: 20 });
      dispatchPointer(window, "pointerup", { clientX: 20, clientY: 20 });
      await Promise.resolve();
    });

    expect(workspaceState.reorderWorkspaces).not.toHaveBeenCalled();
  });

  it("shows unread completion badges on thread and workspace rows", async () => {
    threadNotificationState.notificationsByThreadId = {
      [codexThread.id]: {
        workspaceId: codexThread.workspaceId,
        status: "completed",
      },
    };

    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    expect(row?.querySelector(".sb-thread-notification-dot")).not.toBeNull();
    expect(container.querySelector(".sb-project-notification-badge")?.textContent).toBe("1");
  });

  it("shows yellow pending approval badges on thread and workspace rows", async () => {
    threadNotificationState.notificationsByThreadId = {
      [codexThread.id]: {
        workspaceId: codexThread.workspaceId,
        status: "pending_approval",
      },
    };

    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    expect(row?.querySelector(".sb-thread-notification-dot-pending-approval")).not.toBeNull();
    expect(container.querySelector(".sb-project-notification-badge-pending-approval")).not.toBeNull();
  });

  it("shows a terminal warning badge for an interrupted background turn", async () => {
    threadNotificationState.notificationsByThreadId = {
      [codexThread.id]: {
        workspaceId: codexThread.workspaceId,
        status: "interrupted",
      },
    };

    await renderSidebar();

    const row = findThreadRow("Codex conversation");
    const badge = row?.querySelector(".sb-thread-notification-dot-interrupted");
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute("aria-label")).toBe(
      "app:sidebar.interruptedThreadNotification",
    );
    expect(container.querySelector(".sb-project-notification-badge")?.textContent).toBe("1");
  });

  it("shows plan mode only on the thread that owns it", async () => {
    threadPlanModeState.threadModes = {
      [codexThread.id]: "plan",
      [claudeThread.id]: "default",
    };

    await renderSidebar();

    expect(findThreadRow("Codex conversation")?.querySelector(".sb-thread-plan-indicator"))
      .not.toBeNull();
    expect(findThreadRow("Claude conversation")?.querySelector(".sb-thread-plan-indicator"))
      .toBeNull();
  });

  it("shows running dots for a streaming thread while another session is focused", async () => {
    threadState.threads = [{ ...codexThread, status: "streaming" }, claudeThread];
    threadState.activeThreadId = claudeThread.id;
    chatState.threadId = claudeThread.id;
    chatState.status = "completed";
    chatState.streaming = false;

    await renderSidebar();

    expect(findThreadRow("Codex conversation")?.querySelector(".sb-thread-running-indicator"))
      .not.toBeNull();
    expect(findThreadRow("Claude conversation")?.querySelector(".sb-thread-running-indicator"))
      .toBeNull();
  });

  it("hides running dots when the focused transcript is done even if its thread cache is stale", async () => {
    threadState.threads = [{ ...codexThread, status: "streaming" }, claudeThread];
    threadState.activeThreadId = codexThread.id;
    chatState.threadId = codexThread.id;
    chatState.status = "completed";
    chatState.streaming = false;

    await renderSidebar();

    expect(findThreadRow("Codex conversation")?.querySelector(".sb-thread-running-indicator"))
      .toBeNull();
  });

  async function renderSidebar() {
    await act(async () => {
      root.render(<Sidebar />);
      await Promise.resolve();
    });
  }

  function findThreadRow(label: string): HTMLDivElement | null {
    return (
      Array.from(container.querySelectorAll(".sb-thread")).find((element) =>
        element.textContent?.includes(label),
    ) as HTMLDivElement | undefined
    ) ?? null;
  }

  function findProjectRows(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll(".sb-project")) as HTMLButtonElement[];
  }

  function mockProjectRects(rows: HTMLButtonElement[]) {
    rows.forEach((row, index) => {
      const top = index * 30;
      Object.defineProperty(row, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          top,
          bottom: top + 30,
          left: 0,
          right: 240,
          width: 240,
          height: 30,
          x: 0,
          y: top,
          toJSON: () => undefined,
        }),
      });
    });
  }

  function dispatchPointer(
    target: EventTarget,
    type: "pointerdown" | "pointermove" | "pointerup",
    options: { clientX: number; clientY: number },
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: options.clientX,
      clientY: options.clientY,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    Object.defineProperty(event, "pointerType", { value: "mouse" });
    target.dispatchEvent(event);
  }

  function findForkButton(): HTMLButtonElement | null {
    return Array.from(document.body.querySelectorAll("button")).find((element) =>
      element.textContent?.includes("commandPalette.commands.codexFork"),
    ) as HTMLButtonElement | undefined ?? null;
  }
});
