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
  });
});
