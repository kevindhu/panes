// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "../../types";

const mockReadAttachmentPreview = vi.hoisted(() =>
  vi.fn(async () => null as { mimeType: string; dataBase64: string } | null),
);
const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => undefined),
}));

vi.mock("../../lib/ipc", () => ({
  ipc: {
    readAttachmentPreview: mockReadAttachmentPreview,
  },
}));

vi.mock("../../stores/toastStore", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("./MarkdownContent", () => ({
  default: ({
    content,
    streaming,
  }: {
    content: string;
    streaming?: boolean;
  }) => (
    <div data-markdown-streaming={streaming ? "true" : "false"}>
      {content}
    </div>
  ),
}));

import { MessageBlocks } from "./MessageBlocks";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MessageBlocks streaming text", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps the final real text block in streaming mode when a live status notice is appended", async () => {
    const blocks: ContentBlock[] = [{ type: "text", content: "partial response" }];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="streaming"
          engineId="codex"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    const renderedMarkdown = container.querySelector("[data-markdown-streaming]");
    expect(renderedMarkdown?.getAttribute("data-markdown-streaming")).toBe("true");
    expect(container.textContent).toContain("Turn still open");
  });

  it.each([
    ["completed", "Turn completed", "The turn reached a terminal completion."],
    ["interrupted", "Turn interrupted", "The turn ended before a normal completion."],
    ["error", "Turn failed", "The turn ended with an error."],
  ] as const)(
    "shows a %s terminal card for legacy messages without a status notice",
    async (status, title, message) => {
      const blocks: ContentBlock[] = [
        { type: "text", content: "Response stored before terminal notices were persisted" },
      ];

      await act(async () => {
        root.render(
          <MessageBlocks
            blocks={blocks}
            status={status}
            engineId="codex"
            onApproval={vi.fn()}
            onLoadActionOutput={vi.fn(async () => undefined)}
          />,
        );
      });

      expect(container.textContent).toContain(title);
      expect(container.textContent).toContain(message);
    },
  );

  it("keeps a persisted terminal notice authoritative over the compatibility fallback", async () => {
    const blocks: ContentBlock[] = [
      {
        type: "notice",
        kind: "turn_status",
        level: "warning",
        title: "Persisted terminal outcome",
        message: "Loaded from the backend snapshot.",
        status: "interrupted",
      },
    ];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="interrupted"
          engineId="codex"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("Persisted terminal outcome");
    expect(container.textContent).not.toContain("The turn ended before a normal completion.");
  });
});
