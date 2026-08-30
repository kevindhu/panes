// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexUiStore } from "../../stores/codexUiStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Thread, Workspace } from "../../types";
import { CodexSidebar } from "./CodexSidebar";

const mocks = vi.hoisted(() => ({
  activateThreadContext: vi.fn(async (_thread: Thread | null) => {}),
  createAndActivateWorkspaceThread: vi.fn(async (_workspaceId: string) => "new-thread" as string | null),
  forkThread: vi.fn(async (_threadId: string) => null as Thread | null),
  refreshArchived: vi.fn(async (_workspaceIds: string[]) => {}),
  removeThread: vi.fn(async (_threadId: string) => true),
  renameThread: vi.fn(async (_threadId: string, _title: string) => null as Thread | null),
  reorderWorkspaces: vi.fn(async (_workspaceIds: string[]) => {}),
  restoreThread: vi.fn(async (_threadId: string) => null as Thread | null),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../lib/threadActivation", () => ({
  activateThreadContext: mocks.activateThreadContext,
}));

vi.mock("../../lib/newThreadActions", () => ({
  createAndActivateWorkspaceThread: mocks.createAndActivateWorkspaceThread,
}));

vi.mock("../../stores/toastStore", () => ({
  toast: mocks.toast,
}));

let container: HTMLDivElement;
let root: Root | null = null;

function makeWorkspace(id: string, name = id): Workspace {
  return {
    id,
    name,
    rootPath: `C:\\workspaces\\${id}`,
    scanDepth: 0,
    createdAt: "2026-08-01T00:00:00Z",
    lastOpenedAt: "2026-08-01T00:00:00Z",
  };
}

function makeThread(overrides: Partial<Thread> & Pick<Thread, "id" | "workspaceId">): Thread {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    repoId: null,
    engineId: "codex",
    modelId: "gpt-5.6-codex",
    engineThreadId: `engine-${overrides.id}`,
    title: overrides.id,
    status: "completed",
    messageCount: 1,
    totalTokens: 1,
    createdAt: "2026-08-01T00:00:00Z",
    lastActivityAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function setWorkspaceState(workspaces: Workspace[], activeWorkspaceId: string | null = null) {
  useWorkspaceStore.setState({
    workspaces,
    archivedWorkspaces: [],
    activeWorkspaceId,
    repos: [],
    activeRepoId: null,
    reposLoading: false,
    loading: false,
    error: undefined,
    reorderWorkspaces: mocks.reorderWorkspaces,
  });
}

function setThreadState(
  threadsByWorkspace: Record<string, Thread[]>,
  activeThreadId: string | null = null,
  archivedThreadsByWorkspace: Record<string, Thread[]> = {},
) {
  useThreadStore.setState({
    threads: Object.values(threadsByWorkspace).flat(),
    threadsByWorkspace,
    archivedThreadsByWorkspace,
    finishedTurnNotifications: {},
    activeThreadId,
    loading: false,
    archivedLoading: false,
    error: undefined,
    forkCodexThread: mocks.forkThread,
    refreshAllArchivedThreads: mocks.refreshArchived,
    removeThread: mocks.removeThread,
    renameThread: mocks.renameThread,
    restoreThread: mocks.restoreThread,
  });
}

async function renderSidebar() {
  root = createRoot(container);
  await act(async () => {
    root?.render(<CodexSidebar />);
  });
}

function buttonWithText(scope: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Could not find button: ${text}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makePointerEvent(
  type: string,
  options: {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    button?: number;
    buttons?: number;
  } = {},
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    button: options.button ?? 0,
    buttons: options.buttons ?? (type === "pointerup" ? 0 : 1),
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    isPrimary: { value: true },
    pointerType: { value: "mouse" },
  });
  return event;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  vi.clearAllMocks();

  mocks.createAndActivateWorkspaceThread.mockResolvedValue("new-thread");
  mocks.refreshArchived.mockResolvedValue(undefined);
  mocks.removeThread.mockResolvedValue(true);
  mocks.reorderWorkspaces.mockResolvedValue(undefined);
  mocks.renameThread.mockImplementation(async (threadId, title) => {
    const thread = useThreadStore.getState().threads.find((item) => item.id === threadId);
    return thread ? { ...thread, title } : null;
  });

  setWorkspaceState([]);
  setThreadState({});
  useThreadPlanModeStore.setState({
    threadModes: {},
    newThreadModesByWorkspaceId: {},
  });
  useCodexUiStore.setState({ searchOpen: false });
  useEngineStore.setState({ health: {} });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  container.remove();
});

describe("CodexSidebar", () => {
  it("shows compact utilities and no legacy workspace picker or brand", async () => {
    await renderSidebar();

    expect(container.textContent).toContain("Search");
    expect(container.textContent).toContain("Open workspace");
    expect(container.textContent).toContain("Open a workspace to start.");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector(".codex-brand")).toBeNull();
    expect(container.textContent).not.toContain("New conversation");
  });

  it("shows the Codex CLI version as subtle non-interactive footer text", async () => {
    useEngineStore.setState({
      health: {
        codex: {
          id: "codex",
          available: true,
          version: "codex-cli 0.150.1",
          warnings: [],
          checks: [],
          fixes: [],
        },
      },
    });
    await renderSidebar();

    const version = container.querySelector<HTMLElement>(".codex-cli-version");
    expect(version?.textContent).toBe("Codex CLI 0.150.1");
    expect(version?.closest("button")).toBeNull();
  });

  it("resizes from the right edge and persists the chosen width", async () => {
    localStorage.setItem("panes:sidebar-width", "280");
    await renderSidebar();

    const sidebar = container.querySelector<HTMLElement>(".codex-sidebar");
    const handle = container.querySelector<HTMLElement>(".codex-sidebar-resize-handle");
    expect(sidebar?.style.width).toBe("280px");

    await act(async () => {
      handle?.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        buttons: 1,
        clientX: 280,
      }));
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        clientX: 340,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true,
        clientX: 340,
      }));
    });

    expect(sidebar?.style.width).toBe("340px");
    expect(localStorage.getItem("panes:sidebar-width")).toBe("340");
  });

  it("groups sessions under workspaces, sorts by activity, and preserves status tones", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    const older = makeThread({
      id: "older",
      workspaceId: workspaceA.id,
      title: "Older session",
      status: "streaming",
      lastActivityAt: "2026-08-01T00:00:00Z",
    });
    const newer = makeThread({
      id: "newer",
      workspaceId: workspaceA.id,
      title: "Newer session",
      status: "awaiting_approval",
      lastActivityAt: "2026-08-02T00:00:00Z",
    });
    const plan = makeThread({
      id: "plan",
      workspaceId: workspaceB.id,
      title: "Plan session",
      status: "streaming",
    });
    setWorkspaceState([workspaceA, workspaceB], workspaceB.id);
    setThreadState({
      [workspaceA.id]: [older, newer],
      [workspaceB.id]: [plan],
    }, plan.id);
    useThreadPlanModeStore.setState({ threadModes: { [plan.id]: "plan" } });

    await renderSidebar();

    const groups = container.querySelectorAll<HTMLElement>(".codex-workspace-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector(".codex-workspace-toggle")?.textContent).toContain("Alpha");
    expect(groups[1]?.querySelector(".codex-workspace-toggle")?.textContent).toContain("Beta");
    expect(Array.from(groups[0]?.querySelectorAll(".codex-session-title") ?? [])
      .map((element) => element.textContent)).toEqual(["Newer session", "Older session"]);
    expect(Array.from(groups[1]?.querySelectorAll(".codex-session-title") ?? [])
      .map((element) => element.textContent)).toEqual(["Plan session"]);
    expect(container.querySelectorAll(".codex-session-status.attention")).toHaveLength(2);
    expect(container.querySelectorAll(".codex-session-status.streaming")).toHaveLength(1);
    expect(container.querySelector(".codex-session-row.active")?.textContent).toContain("Plan session");
    expect(container.querySelector(".codex-session-row small")).toBeNull();
  });

  it("shows finished-turn notifications in inactive workspaces and their session rows", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    const backgroundThread = makeThread({
      id: "background-thread",
      workspaceId: workspaceA.id,
      title: "Background session",
    });
    const activeThread = makeThread({
      id: "active-thread",
      workspaceId: workspaceB.id,
      title: "Active session",
    });
    setWorkspaceState([workspaceA, workspaceB], workspaceB.id);
    setThreadState({
      [workspaceA.id]: [backgroundThread],
      [workspaceB.id]: [activeThread],
    }, activeThread.id);
    useThreadStore.setState({
      finishedTurnNotifications: {
        [backgroundThread.id]: { "assistant-1": true },
      },
    });

    await renderSidebar();

    const groups = container.querySelectorAll<HTMLElement>(".codex-workspace-group");
    expect(groups[0]?.querySelector(".codex-workspace-notification")).not.toBeNull();
    expect(groups[1]?.querySelector(".codex-workspace-notification")).toBeNull();
    expect(
      container.querySelector('[data-thread-id="background-thread"] .codex-session-status.notification'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-thread-id="active-thread"] .codex-session-status.notification'),
    ).toBeNull();
  });

  it("reveals sessions in batches of 20 independently for each workspace", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    const makeThreads = (workspaceId: string, count: number) => Array.from(
      { length: count },
      (_, index) => makeThread({
        id: `${workspaceId}-thread-${index + 1}`,
        workspaceId,
        title: `${workspaceId} session ${index + 1}`,
        lastActivityAt: new Date(
          Date.parse("2026-08-30T00:00:00Z") - index * 1_000,
        ).toISOString(),
      }),
    );
    setWorkspaceState([workspaceA, workspaceB]);
    setThreadState({
      [workspaceA.id]: makeThreads(workspaceA.id, 43),
      [workspaceB.id]: makeThreads(workspaceB.id, 22),
    });
    await renderSidebar();

    const groups = container.querySelectorAll<HTMLElement>(".codex-workspace-group");
    const alphaGroup = groups[0];
    const betaGroup = groups[1];
    expect(alphaGroup?.querySelectorAll(".codex-session-row")).toHaveLength(20);
    expect(betaGroup?.querySelectorAll(".codex-session-row")).toHaveLength(20);
    expect(alphaGroup?.querySelector(".codex-session-show-more")?.textContent?.trim())
      .toBe("Show 20 more");
    expect(betaGroup?.querySelector(".codex-session-show-more")?.textContent?.trim())
      .toBe("Show 2 more");

    await act(async () => {
      buttonWithText(alphaGroup, "Show 20 more").click();
    });

    expect(alphaGroup?.querySelectorAll(".codex-session-row")).toHaveLength(40);
    expect(alphaGroup?.querySelector(".codex-session-show-more")?.textContent?.trim())
      .toBe("Show 3 more");
    expect(betaGroup?.querySelectorAll(".codex-session-row")).toHaveLength(20);

    await act(async () => {
      buttonWithText(alphaGroup, "Show 3 more").click();
    });

    expect(alphaGroup?.querySelectorAll(".codex-session-row")).toHaveLength(43);
    expect(alphaGroup?.querySelector(".codex-session-show-more")).toBeNull();
  });

  it("automatically reveals the page containing an older active session", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const threads = Array.from({ length: 23 }, (_, index) => makeThread({
      id: `thread-${index + 1}`,
      workspaceId: workspace.id,
      title: `Session ${index + 1}`,
      lastActivityAt: new Date(
        Date.parse("2026-08-30T00:00:00Z") - index * 1_000,
      ).toISOString(),
    }));
    const activeThread = threads[22];
    if (!activeThread) throw new Error("Expected an active thread fixture");
    setWorkspaceState([workspace], workspace.id);
    setThreadState({ [workspace.id]: threads }, activeThread.id);
    await renderSidebar();

    expect(container.querySelectorAll(".codex-session-row")).toHaveLength(23);
    expect(container.querySelector(".codex-session-row.active")?.textContent)
      .toContain("Session 23");
    expect(container.querySelector(".codex-session-show-more")).toBeNull();
  });

  it("remembers collapsed groups and toggles them without activating a workspace", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const thread = makeThread({ id: "thread-a", workspaceId: workspace.id });
    localStorage.setItem(
      "panes:sidebar-collapsed-workspace-ids",
      JSON.stringify([workspace.id]),
    );
    setWorkspaceState([workspace]);
    setThreadState({ [workspace.id]: [thread] });

    await renderSidebar();

    const toggle = container.querySelector<HTMLButtonElement>(".codex-workspace-toggle");
    const list = container.querySelector<HTMLElement>(".codex-session-list");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(list?.hidden).toBe(true);

    await act(async () => toggle?.click());

    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(list?.hidden).toBe(false);
    expect(mocks.activateThreadContext).not.toHaveBeenCalled();
    expect(JSON.parse(
      localStorage.getItem("panes:sidebar-collapsed-workspace-ids") ?? "[]",
    )).toEqual([]);
  });

  it("exposes exactly Rename, Fork, and Archive and disables an unsafe full fork", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const running = makeThread({
      id: "running",
      workspaceId: workspace.id,
      title: "Running session",
      status: "streaming",
    });
    setWorkspaceState([workspace], workspace.id);
    setThreadState({ [workspace.id]: [running] }, running.id);
    await renderSidebar();

    const actions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Running session"]',
    );
    await act(async () => actions?.click());

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    const items = Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    expect(items.map((item) => item.textContent?.trim())).toEqual(["RenameR", "ForkF", "ArchiveA"]);
    expect(items[1]?.disabled).toBe(true);
    expect(items[1]?.title).toContain("current turn finishes");

    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(actions);
  });

  it("does not show a success toast for a normal fork", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const source = makeThread({
      id: "source",
      workspaceId: workspace.id,
      title: "Source session",
    });
    const forked = makeThread({
      id: "forked",
      workspaceId: workspace.id,
      title: "Source session",
    });
    mocks.forkThread.mockResolvedValue(forked);
    setWorkspaceState([workspace], workspace.id);
    setThreadState({ [workspace.id]: [source] }, source.id);
    await renderSidebar();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Source session"]',
      )?.click();
    });
    await act(async () => {
      buttonWithText(document.body, "ForkF").click();
      await Promise.resolve();
    });

    expect(mocks.forkThread).toHaveBeenCalledWith(source.id);
    expect(mocks.activateThreadContext).toHaveBeenCalledWith(forked);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("renames a session inline with a trimmed title", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const thread = makeThread({
      id: "thread-a",
      workspaceId: workspace.id,
      title: "Original title",
    });
    setWorkspaceState([workspace], workspace.id);
    setThreadState({ [workspace.id]: [thread] }, thread.id);
    await renderSidebar();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Original title"]',
      )?.click();
    });
    await act(async () => buttonWithText(document.body, "RenameR").click());

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename conversation"]');
    expect(input?.value).toBe("Original title");
    await act(async () => {
      if (!input) return;
      setInputValue(input, "  Updated title  ");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.renameThread).toHaveBeenCalledWith(thread.id, "Updated title");
    expect(container.querySelector('input[aria-label="Rename conversation"]')).toBeNull();
  });

  it("archives the active session and activates the most recent remaining session", async () => {
    const workspace = makeWorkspace("workspace-a", "Alpha");
    const active = makeThread({
      id: "active",
      workspaceId: workspace.id,
      title: "Active session",
      lastActivityAt: "2026-08-03T00:00:00Z",
    });
    const next = makeThread({
      id: "next",
      workspaceId: workspace.id,
      title: "Next session",
      lastActivityAt: "2026-08-02T00:00:00Z",
    });
    setWorkspaceState([workspace], workspace.id);
    setThreadState({ [workspace.id]: [active, next] }, active.id);
    await renderSidebar();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Actions for Active session"]',
      )?.click();
    });
    await act(async () => {
      buttonWithText(document.body, "ArchiveA").click();
      await Promise.resolve();
    });

    expect(mocks.removeThread).toHaveBeenCalledWith(active.id);
    expect(mocks.activateThreadContext).toHaveBeenCalledWith(next);
    expect(mocks.toast.success).toHaveBeenCalledWith("Archived “Active session”.");
  });

  it("reorders workspace groups with the keyboard", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    setWorkspaceState([workspaceA, workspaceB]);
    setThreadState({ [workspaceA.id]: [], [workspaceB.id]: [] });
    await renderSidebar();

    const alphaToggle = container.querySelector<HTMLButtonElement>(
      '[aria-controls="workspace-sessions-workspace-a"]',
    );
    await act(async () => {
      alphaToggle?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        altKey: true,
        bubbles: true,
      }));
      await Promise.resolve();
    });

    expect(mocks.reorderWorkspaces).toHaveBeenCalledWith([workspaceB.id, workspaceA.id]);
  });

  it("reorders complete workspace groups with pointer dragging", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    setWorkspaceState([workspaceA, workspaceB]);
    setThreadState({
      [workspaceA.id]: [makeThread({ id: "thread-a", workspaceId: workspaceA.id })],
      [workspaceB.id]: [makeThread({ id: "thread-b", workspaceId: workspaceB.id })],
    });
    await renderSidebar();

    const groups = container.querySelectorAll<HTMLElement>(".codex-workspace-group");
    const alphaHeader = groups[0]?.querySelector<HTMLElement>(".codex-workspace-header");
    const betaGroup = groups[1];
    Object.defineProperty(betaGroup, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 100, height: 80, bottom: 180, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) }),
    });
    await act(async () => {
      alphaHeader?.dispatchEvent(makePointerEvent("pointerdown", {
        clientX: 10,
        clientY: 20,
      }));
      document.dispatchEvent(makePointerEvent("pointermove", {
        clientX: 10,
        clientY: 170,
      }));
    });

    expect(container.querySelector(".codex-workspace-group.dragging")).not.toBeNull();
    expect(Array.from(container.querySelectorAll(".codex-workspace-toggle > span"))
      .map((element) => element.textContent)).toEqual(["Beta", "Alpha"]);
    const landingPreview = container.querySelector<HTMLElement>(
      ".codex-workspace-group.drag-placeholder",
    );
    expect(landingPreview?.querySelector(".codex-workspace-toggle")
      ?.getAttribute("aria-expanded")).toBe("false");
    expect(landingPreview?.querySelector(".codex-session-list")?.hasAttribute("hidden"))
      .toBe(true);
    const dragPill = document.body.querySelector<HTMLElement>(
      '.codex-workspace-drag-overlay[data-workspace-id="workspace-a"]',
    );
    expect(dragPill?.textContent).toBe("Alpha");
    expect(dragPill?.style.transform).toContain("translate3d");
    expect(mocks.reorderWorkspaces).not.toHaveBeenCalled();

    await act(async () => {
      document.dispatchEvent(makePointerEvent("pointerup", {
        clientX: 10,
        clientY: 170,
      }));
      await Promise.resolve();
    });

    expect(mocks.reorderWorkspaces).toHaveBeenCalledWith([workspaceB.id, workspaceA.id]);
    expect(container.querySelector(".codex-workspace-group.dragging")).toBeNull();
    expect(document.body.querySelector(".codex-workspace-drag-overlay")).toBeNull();
    expect(container.querySelector('[aria-controls="workspace-sessions-workspace-a"]')
      ?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a workspace click separate from the drag threshold", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    setWorkspaceState([workspaceA, workspaceB]);
    setThreadState({ [workspaceA.id]: [], [workspaceB.id]: [] });
    await renderSidebar();

    const alphaToggle = container.querySelector<HTMLButtonElement>(
      '[aria-controls="workspace-sessions-workspace-a"]',
    );
    const alphaHeader = alphaToggle?.closest<HTMLElement>(".codex-workspace-header");

    await act(async () => {
      alphaHeader?.dispatchEvent(makePointerEvent("pointerdown", {
        clientX: 10,
        clientY: 20,
      }));
      document.dispatchEvent(makePointerEvent("pointermove", {
        clientX: 12,
        clientY: 22,
      }));
      document.dispatchEvent(makePointerEvent("pointerup", {
        clientX: 12,
        clientY: 22,
      }));
      alphaToggle?.click();
    });

    expect(mocks.reorderWorkspaces).not.toHaveBeenCalled();
    expect(alphaToggle?.getAttribute("aria-expanded")).toBe("false");
  });

  it("loads archived sessions by workspace and restores one into the active chat", async () => {
    const workspaceA = makeWorkspace("workspace-a", "Alpha");
    const workspaceB = makeWorkspace("workspace-b", "Beta");
    const archived = makeThread({
      id: "archived-thread",
      workspaceId: workspaceB.id,
      title: "Archived work",
    });
    mocks.restoreThread.mockResolvedValue(archived);
    setWorkspaceState([workspaceA, workspaceB], workspaceA.id);
    setThreadState(
      { [workspaceA.id]: [], [workspaceB.id]: [] },
      null,
      { [workspaceB.id]: [archived] },
    );
    await renderSidebar();

    const archivedFooterButton = container.querySelector<HTMLButtonElement>(
      ".codex-sidebar-footer button:first-child",
    );
    await act(async () => {
      archivedFooterButton?.click();
      await Promise.resolve();
    });

    expect(mocks.refreshArchived).toHaveBeenCalledWith([workspaceA.id, workspaceB.id]);
    expect(container.querySelector(".codex-archive-drawer")?.textContent).toContain("Beta");
    expect(container.querySelector(".codex-archive-drawer")?.textContent).toContain("Archived work");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Restore Archived work"]',
      )?.click();
      await Promise.resolve();
    });

    expect(mocks.restoreThread).toHaveBeenCalledWith(archived.id);
    expect(mocks.activateThreadContext).toHaveBeenCalledWith(archived);
    expect(container.querySelector(".codex-archive-drawer")).toBeNull();
    expect(mocks.toast.success).toHaveBeenCalledWith("Restored “Archived work”.");
  });
});
