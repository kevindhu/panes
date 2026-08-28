// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});
