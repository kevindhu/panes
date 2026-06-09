// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";

const mockReadAttachmentPreview = vi.hoisted(() =>
  vi.fn(async () => null as { mimeType: string; dataBase64: string } | null),
);
const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    onDragDropEvent: vi.fn(async () => () => undefined),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("../../lib/ipc", () => ({
  ipc: {
    readAttachmentPreview: mockReadAttachmentPreview,
    appendBranchProfileLog: vi.fn(async () => undefined),
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

import {
  MessageRowView,
  getActiveTextSelectionRangeInsideElement,
  hasActiveTextSelectionInsideElement,
  restoreTextSelectionRange,
  shouldVirtualizeMessages,
} from "./ChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createUserMessage(): Message {
  return {
    id: "user-1",
    threadId: "thread-1",
    role: "user",
    content: "Please revise this",
    blocks: [
      {
        type: "attachment",
        fileName: "cat.png",
        filePath: "C:/images/cat.png",
        sizeBytes: 128,
        mimeType: "image/png",
      },
      {
        type: "text",
        content: "Please revise this",
      },
    ],
    status: "completed",
    schemaVersion: 1,
    createdAt: "2026-05-19T12:00:00.000Z",
  };
}

function createAssistantMessage(): Message {
  return {
    id: "assistant-1",
    threadId: "thread-1",
    role: "assistant",
    blocks: [
      {
        type: "notice",
        kind: "turn_status",
        level: "info",
        title: "Turn completed",
        message: "The turn reached a terminal completion.",
        status: "completed",
        durationMs: 123000,
      },
    ],
    status: "completed",
    schemaVersion: 1,
    createdAt: "2026-05-19T12:00:01.000Z",
  };
}

describe("MessageRowView editing attachments", () => {
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
    document.body.innerHTML = "";
  });

  it("removes inline edit attachments from the row", async () => {
    function Harness() {
      const [attachments, setAttachments] = useState([
        {
          id: "draft-1",
          fileName: "cat.png",
          filePath: "C:/images/cat.png",
          sizeBytes: 128,
          mimeType: "image/png",
        },
      ]);

      return (
        <MessageRowView
          message={createUserMessage()}
          index={0}
          isHighlighted={false}
          assistantLabel=""
          assistantEngineId="codex"
          canEditUserMessages
          editingMessageId="user-1"
          editingMode="branch"
          editingDraftText="Please revise this"
          editingDraftAttachments={attachments}
          editingRollbackTurns={null}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onStartRollback={vi.fn()}
          onChangeEditText={vi.fn()}
          onRemoveEditAttachment={(attachmentId) =>
            setAttachments((current) =>
              current.filter((attachment) => attachment.id !== attachmentId),
            )
          }
          onPasteEditAttachments={vi.fn()}
          onCancelEdit={vi.fn()}
          onSubmitEdit={vi.fn(async () => undefined)}
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    expect(container.textContent).toContain("cat.png");

    const removeButton = container.querySelector(
      ".chat-attachment-chip-remove",
    ) as HTMLButtonElement | null;
    expect(removeButton).not.toBeNull();

    await act(async () => {
      removeButton?.click();
    });

    expect(container.textContent).not.toContain("cat.png");
  });

  it("routes pasted images from the edit textarea into the edit attachment callback", async () => {
    const onPasteEditAttachments = vi.fn();

    await act(async () => {
      root.render(
        <MessageRowView
          message={createUserMessage()}
          index={0}
          isHighlighted={false}
          assistantLabel=""
          assistantEngineId="codex"
          canEditUserMessages
          editingMessageId="user-1"
          editingMode="branch"
          editingDraftText="Please revise this"
          editingDraftAttachments={[]}
          editingRollbackTurns={null}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onStartRollback={vi.fn()}
          onChangeEditText={vi.fn()}
          onRemoveEditAttachment={vi.fn()}
          onPasteEditAttachments={onPasteEditAttachments}
          onCancelEdit={vi.fn()}
          onSubmitEdit={vi.fn(async () => undefined)}
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(container.textContent).not.toContain("cat.png");

    const file = new File(["image"], "pasted.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
        files: [file],
      },
    });

    await act(async () => {
      textarea?.dispatchEvent(pasteEvent);
    });

    expect(onPasteEditAttachments).toHaveBeenCalledTimes(1);
    expect(onPasteEditAttachments).toHaveBeenCalledWith([file]);
  });

  it("shows task duration at the bottom of completed assistant messages", async () => {
    await act(async () => {
      root.render(
        <MessageRowView
          message={createAssistantMessage()}
          index={0}
          isHighlighted={false}
          assistantLabel=""
          assistantEngineId="codex"
          canEditUserMessages
          editingMessageId={null}
          editingMode={null}
          editingDraftText=""
          editingDraftAttachments={[]}
          editingRollbackTurns={null}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onStartRollback={vi.fn()}
          onChangeEditText={vi.fn()}
          onRemoveEditAttachment={vi.fn()}
          onPasteEditAttachments={vi.fn()}
          onCancelEdit={vi.fn()}
          onSubmitEdit={vi.fn(async () => undefined)}
          onApproval={vi.fn()}
          onLoadActionOutput={vi.fn(async () => undefined)}
        />,
      );
    });

    expect(container.textContent).toContain("Task took 2m 3s.");
  });
});

describe("shouldVirtualizeMessages", () => {
  it("keeps long transcripts fully mounted", () => {
    expect(shouldVirtualizeMessages(114, false)).toBe(false);
    expect(shouldVirtualizeMessages(80, true)).toBe(false);
  });
});

describe("hasActiveTextSelectionInsideElement", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("detects non-collapsed selections anchored inside the chat viewport", () => {
    const viewport = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = "selected chat text";
    viewport.appendChild(paragraph);
    document.body.appendChild(viewport);

    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 8);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(hasActiveTextSelectionInsideElement(viewport)).toBe(true);
    expect(getActiveTextSelectionRangeInsideElement(viewport)?.toString()).toBe(
      "selected",
    );

    selection?.removeAllRanges();
    document.body.removeChild(viewport);
  });

  it("restores a preserved selection range after the current selection changes", () => {
    const viewport = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.textContent = "selected chat text";
    viewport.appendChild(paragraph);
    document.body.appendChild(viewport);

    const originalRange = document.createRange();
    originalRange.setStart(paragraph.firstChild!, 0);
    originalRange.setEnd(paragraph.firstChild!, 8);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(originalRange);
    const preservedRange = getActiveTextSelectionRangeInsideElement(viewport);

    const changedRange = document.createRange();
    changedRange.setStart(paragraph.firstChild!, 0);
    changedRange.setEnd(paragraph.firstChild!, paragraph.textContent!.length);
    selection?.removeAllRanges();
    selection?.addRange(changedRange);

    expect(selection?.toString()).toBe("selected chat text");
    expect(restoreTextSelectionRange(preservedRange)).toBe(true);
    expect(selection?.toString()).toBe("selected");

    selection?.removeAllRanges();
    document.body.removeChild(viewport);
  });

  it("ignores collapsed and outside selections", () => {
    const viewport = document.createElement("div");
    const outside = document.createElement("p");
    viewport.textContent = "chat";
    outside.textContent = "outside";
    document.body.appendChild(viewport);
    document.body.appendChild(outside);

    const selection = window.getSelection();
    const collapsedRange = document.createRange();
    collapsedRange.setStart(viewport.firstChild!, 1);
    collapsedRange.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(collapsedRange);

    expect(hasActiveTextSelectionInsideElement(viewport)).toBe(false);

    const outsideRange = document.createRange();
    outsideRange.setStart(outside.firstChild!, 0);
    outsideRange.setEnd(outside.firstChild!, 4);
    selection?.removeAllRanges();
    selection?.addRange(outsideRange);

    expect(hasActiveTextSelectionInsideElement(viewport)).toBe(false);

    document.body.removeChild(viewport);
    document.body.removeChild(outside);
  });
});
