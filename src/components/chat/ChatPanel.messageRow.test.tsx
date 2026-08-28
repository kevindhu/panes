// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../types";

const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
) => ({ filePath, mimeType: mimeType ?? "image/png", version: "v1" })));
const mockReadAttachmentImageBytes = vi.hoisted(() => vi.fn(async () => (
  new ArrayBuffer(0)
)));
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
    prepareAttachmentImageAsset: mockPrepareAttachmentImageAsset,
    readAttachmentImageBytes: mockReadAttachmentImageBytes,
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

import { MessageRowView } from "./ChatPanel";
import {
  areMessageRowsMeasured,
  buildVirtualizedMessageLayout,
  computeVirtualMessageWindow,
  resolveVirtualMessageWindow,
  retainedMessageRangeForIndexes,
  shouldVirtualizeMessages,
} from "./messageVirtualization";
import { hasActiveTextSelectionInsideElement } from "./useVirtualizedMessageSelection";

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
          canForkAssistantMessages={false}
          forkingMessageId={null}
          editingMessageId="user-1"
          editingDraftText="Please revise this"
          editingDraftAttachments={attachments}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onForkMessage={vi.fn()}
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
          canForkAssistantMessages={false}
          forkingMessageId={null}
          editingMessageId="user-1"
          editingDraftText="Please revise this"
          editingDraftAttachments={[]}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onForkMessage={vi.fn()}
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
    const message = createAssistantMessage();
    const onForkMessage = vi.fn();
    await act(async () => {
      root.render(
        <MessageRowView
          message={message}
          index={0}
          isHighlighted={false}
          assistantLabel=""
          assistantEngineId="codex"
          canEditUserMessages
          canForkAssistantMessages
          forkingMessageId={null}
          editingMessageId={null}
          editingDraftText=""
          editingDraftAttachments={[]}
          editingBusy={false}
          onStartEdit={vi.fn()}
          onForkMessage={onForkMessage}
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
    const forkButton = container.querySelector(
      '[aria-label="panel.messageActions.fork"]',
    ) as HTMLButtonElement | null;
    expect(forkButton).not.toBeNull();

    await act(async () => {
      forkButton?.click();
    });
    expect(onForkMessage).toHaveBeenCalledWith(message);
  });
});
describe("shouldVirtualizeMessages", () => {
  const readyLargeTranscript = {
    messageCount: 120,
    streaming: false,
    allRowsMeasured: true,
    editing: false,
    loadingOlderMessages: false,
  };

  it("virtualizes only large completed transcripts with exact row measurements", () => {
    expect(shouldVirtualizeMessages({ ...readyLargeTranscript, messageCount: 119 })).toBe(false);
    expect(shouldVirtualizeMessages(readyLargeTranscript)).toBe(true);
    expect(shouldVirtualizeMessages({ ...readyLargeTranscript, streaming: true })).toBe(false);
    expect(shouldVirtualizeMessages({ ...readyLargeTranscript, allRowsMeasured: false })).toBe(false);
  });

  it("does not virtualize while editing or older-message loading can move DOM nodes", () => {
    expect(shouldVirtualizeMessages({ ...readyLargeTranscript, editing: true })).toBe(false);
    expect(shouldVirtualizeMessages({ ...readyLargeTranscript, loadingOlderMessages: true })).toBe(false);
  });
});

describe("virtualized message layout", () => {
  it("refuses to build a layout until every row has a real measured height", () => {
    const messages = Array.from({ length: 120 }, (_, index) => ({ id: `message-${index}` }));
    const measuredHeights = new Map<string, number>();
    for (let index = 0; index < messages.length - 1; index += 1) {
      measuredHeights.set(messages[index].id, 120);
    }

    expect(areMessageRowsMeasured(messages, measuredHeights)).toBe(false);
    expect(buildVirtualizedMessageLayout(messages, measuredHeights)).toBeNull();

    measuredHeights.set(messages[messages.length - 1].id, 120);

    expect(areMessageRowsMeasured(messages, measuredHeights)).toBe(true);
    expect(buildVirtualizedMessageLayout(messages, measuredHeights)).not.toBeNull();
  });

  it("keeps the actual tall row mounted when the viewport is inside it", () => {
    const messages = Array.from({ length: 130 }, (_, index) => ({ id: `message-${index}` }));
    const measuredHeights = new Map<string, number>();
    for (const message of messages) {
      measuredHeights.set(message.id, 96);
    }
    measuredHeights.set("message-64", 5200);

    const layout = buildVirtualizedMessageLayout(messages, measuredHeights);
    expect(layout).not.toBeNull();

    const tallRowTop = layout!.offsets[64];
    const window = computeVirtualMessageWindow(layout!, tallRowTop + 2600, 700, 700);

    expect(window.startIndex).toBeLessThanOrEqual(64);
    expect(window.endIndexExclusive).toBeGreaterThan(64);
  });

  it("preserves the hidden gap below the last rendered row in the bottom spacer", () => {
    const messages = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const layout = buildVirtualizedMessageLayout(
      messages,
      new Map([
        ["a", 100],
        ["b", 100],
        ["c", 100],
      ]),
    );

    expect(layout).not.toBeNull();

    const window = computeVirtualMessageWindow(layout!, 113, 1, 0);

    expect(window.startIndex).toBe(1);
    expect(window.endIndexExclusive).toBe(2);
    expect(window.topSpacerHeight).toBe(112);
    expect(window.bottomSpacerHeight).toBe(112);
  });

  it("unions the viewport with the message range retained by native selection", () => {
    const messages = Array.from({ length: 140 }, (_, index) => ({ id: `message-${index}` }));
    const measuredHeights = new Map<string, number>();
    for (const message of messages) {
      measuredHeights.set(message.id, 100);
    }

    const layout = buildVirtualizedMessageLayout(messages, measuredHeights);
    expect(layout).not.toBeNull();

    const previousWindow = computeVirtualMessageWindow(layout!, 1200, 700, 300);
    const retainedRange = retainedMessageRangeForIndexes(
      messages,
      previousWindow.startIndex,
      previousWindow.endIndexExclusive,
    );
    const mergedWindow = resolveVirtualMessageWindow({
      virtualizationEnabled: true,
      layout,
      messages,
      retainedRange,
      viewportScrollTop: 6000,
      viewportHeight: 700,
      overscanPx: 300,
    });
    const viewportOnlyWindow = resolveVirtualMessageWindow({
      virtualizationEnabled: true,
      layout,
      messages,
      retainedRange: null,
      viewportScrollTop: 6000,
      viewportHeight: 700,
      overscanPx: 300,
    });

    expect(mergedWindow?.startIndex).toBe(previousWindow.startIndex);
    expect(mergedWindow?.endIndexExclusive).toBe(viewportOnlyWindow?.endIndexExclusive);
    expect(viewportOnlyWindow?.startIndex).toBeGreaterThan(previousWindow.startIndex);
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
