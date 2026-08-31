// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock } from "../../types";

const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
) => ({ filePath, mimeType: mimeType ?? "image/png", version: "v1" })));
const mockReadAttachmentImageBytes = vi.hoisted(() => vi.fn(async () => (
  new ArrayBuffer(0)
)));
const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));

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
  open: mockOpenExternal,
}));

vi.mock("../../lib/ipc", () => ({
  ipc: {
    prepareAttachmentImageAsset: mockPrepareAttachmentImageAsset,
    readAttachmentImageBytes: mockReadAttachmentImageBytes,
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
    selectionScopeId,
  }: {
    content: string;
    streaming?: boolean;
    selectionScopeId?: string;
  }) => (
    <div
      data-markdown-streaming={streaming ? "true" : "false"}
      data-transcript-selection-scope={selectionScopeId}
    >
      {content}
    </div>
  ),
}));

import { LinkifiedPlainText, MessageBlocks } from "./MessageBlocks";

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
    globalThis.getSelection?.()?.removeAllRanges();
    container.remove();
    document.body.innerHTML = "";
  });

  it("opens a plain-text web link on a plain click despite an unrelated text selection", async () => {
    const selectedText = document.createElement("div");
    selectedText.textContent = "previous selection";
    document.body.appendChild(selectedText);
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    globalThis.getSelection?.()?.addRange(range);

    await act(async () => {
      root.render(<LinkifiedPlainText text="https://example.com/docs" />);
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 10,
      }));
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 10,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("opens a plain-text web link on an unmodified click", async () => {
    await act(async () => {
      root.render(<LinkifiedPlainText text="https://example.com/docs" />);
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("keeps a text selection scope stable when another block is inserted before it", async () => {
    const textBlock: ContentBlock = { type: "text", content: "Stable text" };
    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={[textBlock]}
          selectionNamespace="message:stable"
          onApproval={vi.fn()}
        />,
      );
    });
    const initialScope = container
      .querySelector("[data-markdown-streaming]")
      ?.getAttribute("data-transcript-selection-scope");

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={[
            {
              type: "notice",
              kind: "system",
              level: "info",
              title: "Earlier event",
              message: "Inserted before the text",
            },
            textBlock,
          ]}
          selectionNamespace="message:stable"
          onApproval={vi.fn()}
        />,
      );
    });

    expect(initialScope).toBe("message:stable:text:0");
    expect(container
      .querySelector("[data-markdown-streaming]")
      ?.getAttribute("data-transcript-selection-scope")).toBe(initialScope);
  });

  it("keeps the final real text block in streaming mode without synthesizing a status card", async () => {
    const blocks: ContentBlock[] = [{ type: "text", content: "partial response" }];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="streaming"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    const renderedMarkdown = container.querySelector("[data-markdown-streaming]");
    expect(renderedMarkdown?.getAttribute("data-markdown-streaming")).toBe("true");
    expect(container.textContent).toContain("partial response");
    expect(container.textContent).not.toContain("Turn still open");
  });

  it("never reveals answered secret tool-input values", async () => {
    const blocks: ContentBlock[] = [{
      type: "approval",
      approvalId: "secret-input",
      actionType: "other",
      summary: "Codex requested input",
      details: {
        _serverMethod: "item/tool/requestUserInput",
        questions: [{
          id: "token",
          header: "Token",
          question: "Enter the token",
          isOther: false,
          isSecret: true,
          options: null,
        }],
      },
      status: "answered",
      decision: "custom",
      responseData: {
        answers: {
          token: { answers: ["super-secret"] },
        },
      },
    }];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="completed"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    const header = container.querySelector('[role="button"]');
    expect(header).not.toBeNull();
    await act(async () => {
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("••••••");
    expect(container.textContent).not.toContain("super-secret");
  });

  it("keeps an interrupted questionnaire inspectable without calling it answered", async () => {
    const blocks: ContentBlock[] = [{
      type: "approval",
      approvalId: "interrupted-input",
      actionType: "other",
      summary: "Codex requested input",
      details: {
        _serverMethod: "item/tool/requestUserInput",
        questions: [{
          id: "scope",
          question: "Which scope should the plan cover?",
          options: null,
        }],
      },
      status: "answered",
      decision: "cancel",
    }];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="interrupted"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("messageBlocks.approval.unsubmittedQuestions");
    expect(container.textContent).not.toContain("messageBlocks.approval.answeredQuestions");
    const header = container.querySelector('[role="button"]');
    expect(header).not.toBeNull();

    await act(async () => {
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Which scope should the plan cover?");
    expect(container.textContent).toContain("messageBlocks.approval.answerNotSubmitted");
  });

  it("does not render a removed status notice from persisted blocks", async () => {
    const blocks: ContentBlock[] = [
      { type: "text", content: "This is only the user prompt" },
      {
        type: "notice",
        kind: "turn_status",
        level: "info",
        title: "Turn completed",
        message: "The turn reached a terminal completion.",
      },
    ];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="completed"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("This is only the user prompt");
    expect(container.textContent).not.toContain("Turn completed");
    expect(container.textContent).not.toContain("terminal completion");
  });

  it.each(["completed", "interrupted", "error"] as const)(
    "does not synthesize a terminal card for a %s compatibility message",
    async (status) => {
      const blocks: ContentBlock[] = [
        { type: "text", content: "Stored response" },
      ];

      await act(async () => {
        root.render(
          <MessageBlocks
            blocks={blocks}
            status={status}
            onApproval={vi.fn()}
            onLoadActionOutput={vi.fn(async () => undefined)}
          />,
        );
      });

      expect(container.textContent).toContain("Stored response");
      expect(container.textContent).not.toContain("Turn completed");
      expect(container.textContent).not.toContain("Turn interrupted");
      expect(container.textContent).not.toContain("Turn failed");
    },
  );

  it("ignores a persisted legacy terminal notice", async () => {
    const blocks: ContentBlock[] = [
      { type: "text", content: "Stored response" },
      {
        type: "notice",
        kind: "turn_status",
        level: "warning",
        title: "Persisted terminal outcome",
        message: "Loaded from the backend snapshot.",
      },
    ];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="interrupted"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("Stored response");
    expect(container.textContent).not.toContain("Persisted terminal outcome");
    expect(container.textContent).not.toContain("Loaded from the backend snapshot.");
  });

  it("never groups completed actions across intervening thought boundaries", async () => {
    const action = (actionId: string, summary: string): ContentBlock => ({
      type: "action",
      actionId,
      actionType: "command",
      summary,
      details: {},
      outputChunks: [],
      status: "done",
      result: { success: true, durationMs: 1 },
    });
    const blocks: ContentBlock[] = [
      action("action-1", "Action one"),
      { type: "thinking", content: "First boundary" },
      action("action-2", "Action two"),
      { type: "thinking", content: "Second boundary" },
      action("action-3", "Action three"),
    ];

    await act(async () => {
      root.render(
        <MessageBlocks
          blocks={blocks}
          status="completed"
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    const text = container.textContent ?? "";
    const firstThought = text.indexOf("messageBlocks.thinking");
    const secondThought = text.indexOf("messageBlocks.thinking", firstThought + 1);
    expect(text.indexOf("Action one")).toBeLessThan(firstThought);
    expect(firstThought).toBeLessThan(text.indexOf("Action two"));
    expect(text.indexOf("Action two")).toBeLessThan(secondThought);
    expect(secondThought).toBeLessThan(text.indexOf("Action three"));
    expect(text).not.toContain("messageBlocks.actionGroup.summary");
  });
});
