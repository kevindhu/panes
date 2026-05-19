// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PreviewPayload = {
  mimeType: string;
  dataBase64: string;
};

const mockReadAttachmentPreview = vi.hoisted(() =>
  vi.fn<(filePath: string, mimeType?: string | null) => Promise<PreviewPayload | null>>(async () => null)
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

vi.mock("../../lib/ipc", () => ({
  ipc: {
    readAttachmentPreview: mockReadAttachmentPreview,
    copyAttachmentImageToClipboard: vi.fn(async () => undefined),
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

import { AttachmentChip } from "./AttachmentChip";
import { resetAttachmentImageCachesForTests } from "../../lib/attachmentImages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AttachmentChip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAttachmentImageCachesForTests();
    mockIsTauri.mockReturnValue(true);
    mockConvertFileSrc.mockImplementation((filePath: string) => `asset://${filePath}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    resetAttachmentImageCachesForTests();
    container.remove();
    document.body.innerHTML = "";
  });

  it("opens the viewer for image attachments", async () => {
    await renderChip({
      fileName: "cat.png",
      filePath: "C:/images/cat.png",
      mimeType: "image/png",
    });

    const preview = container.querySelector("[role='button']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();

    await act(async () => {
      preview?.click();
    });

    expect(document.body.querySelector(".chat-image-viewer-backdrop")).not.toBeNull();
  });

  it("does not make non-image attachments interactive", async () => {
    await renderChip({
      fileName: "notes.md",
      filePath: "C:/notes.md",
      mimeType: "text/markdown",
    });

    expect(container.querySelector("[role='button']")).toBeNull();
    expect(document.body.querySelector(".chat-image-viewer-backdrop")).toBeNull();
  });

  it("does not load image previews eagerly when the original file source is available", async () => {
    await renderChip({
      fileName: "cat.png",
      filePath: "C:/images/cat.png",
      mimeType: "image/png",
    });

    expect(mockReadAttachmentPreview).not.toHaveBeenCalled();
  });

  it("loads a preview only after the original image source fails", async () => {
    mockReadAttachmentPreview.mockResolvedValue({
      mimeType: "image/png",
      dataBase64: "YWJj",
    });

    await renderChip({
      fileName: "cat.png",
      filePath: "C:/images/cat.png",
      mimeType: "image/png",
    });

    const thumbnail = container.querySelector(".chat-attachment-thumbnail") as HTMLImageElement | null;
    expect(thumbnail).not.toBeNull();

    await act(async () => {
      thumbnail?.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect(mockReadAttachmentPreview).toHaveBeenCalledTimes(1);
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith("C:/images/cat.png", "image/png");
  });

  it("opens on keyboard activation and closes on Escape", async () => {
    await renderChip({
      fileName: "cat.png",
      filePath: "C:/images/cat.png",
      mimeType: "image/png",
    });

    const preview = container.querySelector("[role='button']") as HTMLDivElement | null;
    expect(preview).not.toBeNull();

    await act(async () => {
      preview?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(document.body.querySelector(".chat-image-viewer-backdrop")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(document.body.querySelector(".chat-image-viewer-backdrop")).toBeNull();
  });

  it("does not open the viewer when removing an attachment", async () => {
    const onRemove = vi.fn();

    await renderChip(
      {
        fileName: "cat.png",
        filePath: "C:/images/cat.png",
        mimeType: "image/png",
      },
      {
        onRemove,
        removeLabel: "Remove attachment",
      },
    );

    const removeButton = container.querySelector(".chat-attachment-chip-remove") as HTMLButtonElement | null;
    expect(removeButton).not.toBeNull();

    await act(async () => {
      removeButton?.click();
    });

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".chat-image-viewer-backdrop")).toBeNull();
  });

  async function renderChip(
    attachment: {
      fileName: string;
      filePath: string;
      mimeType?: string;
    },
    props: {
      onRemove?: () => void;
      removeLabel?: string;
    } = {},
  ) {
    await act(async () => {
      root.render(
        <AttachmentChip
          attachment={attachment}
          onRemove={props.onRemove}
          removeLabel={props.removeLabel}
        />,
      );
    });
  }
});
