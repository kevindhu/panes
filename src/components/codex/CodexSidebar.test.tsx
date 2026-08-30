// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { useThreadStore } from "../../stores/threadStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { CodexSidebar } from "./CodexSidebar";

let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  useWorkspaceStore.setState({ activeWorkspaceId: null, workspaces: [] });
  useThreadStore.setState({ activeThreadId: null, threadsByWorkspace: {} });
  useThreadPlanModeStore.setState({
    threadModes: {},
    newThreadModesByWorkspaceId: {},
  });
});

afterEach(() => {
  container.remove();
});

describe("CodexSidebar", () => {
  it("renders when no workspace has been selected", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(<CodexSidebar />);
    });

    expect(container.textContent).toContain("No workspace");
    expect(container.textContent).not.toContain("Files");

    await act(async () => {
      root.unmount();
    });
  });

  it("resizes from the right edge and persists the chosen width", async () => {
    localStorage.setItem("panes:sidebar-width", "280");
    const root = createRoot(container);

    await act(async () => {
      root.render(<CodexSidebar />);
    });

    const sidebar = container.querySelector<HTMLElement>(".codex-sidebar");
    const handle = container.querySelector<HTMLElement>(".codex-sidebar-resize-handle");
    expect(sidebar?.style.width).toBe("280px");
    expect(handle).not.toBeNull();

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

    await act(async () => {
      root.unmount();
    });
  });

  it("uses yellow status circles for Plan mode and threads awaiting a question", async () => {
    const timestamp = new Date().toISOString();
    const makeThread = (id: string, status: "streaming" | "awaiting_approval") => ({
      id,
      workspaceId: "workspace-1",
      repoId: null,
      engineId: "codex" as const,
      modelId: "gpt-5.6-codex",
      engineThreadId: `engine-${id}`,
      title: id,
      status,
      messageCount: 1,
      totalTokens: 1,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    });
    const threads = [
      makeThread("plan-thread", "streaming"),
      makeThread("question-thread", "awaiting_approval"),
      makeThread("regular-thread", "streaming"),
    ];
    useWorkspaceStore.setState({
      activeWorkspaceId: "workspace-1",
      workspaces: [{
        id: "workspace-1",
        name: "Workspace",
        path: "C:\\workspace",
        createdAt: timestamp,
        lastOpenedAt: timestamp,
      }],
    });
    useThreadStore.setState({
      threads,
      threadsByWorkspace: { "workspace-1": threads },
      activeThreadId: "plan-thread",
    });
    useThreadPlanModeStore.setState({
      threadModes: { "plan-thread": "plan" },
    });
    const root = createRoot(container);

    await act(async () => root.render(<CodexSidebar />));

    expect(container.querySelectorAll(".codex-thread-status.attention")).toHaveLength(2);
    expect(container.querySelectorAll(".codex-thread-status.streaming")).toHaveLength(1);

    await act(async () => root.unmount());
  });
});
