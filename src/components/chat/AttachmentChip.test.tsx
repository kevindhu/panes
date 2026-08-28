// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
) => ({ filePath, mimeType: mimeType ?? "image/png", version: "v1" })));
const mockReadAttachmentImageBytes = vi.hoisted(() => vi.fn(async () => (
  new Uint8Array([97, 98, 99]).buffer
)));
const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockCreateObjectURL = vi.hoisted(() => vi.fn(() => "blob:raw-fallback"));
const mockRevokeObjectURL = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("../../lib/codexIpc", () => ({
  ipc: {
    prepareAttachmentImageAsset: mockPrepareAttachmentImageAsset,
    readAttachmentImageBytes: mockReadAttachmentImageBytes,
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
    Object.defineProperty(URL, "createObjectURL", {
      value: mockCreateObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: mockRevokeObjectURL,
      configurable: true,
    });
    resetAttachmentImageCachesForTests();
    mockIsTauri.mockReturnValue(true);
    mockConvertFileSrc.mockImplementation((filePath: string) => `asset://${filePath}`);
    mockPrepareAttachmentImageAsset.mockImplementation(async (
      filePath: string,
      mimeType?: string | null,
    ) => ({ filePath, mimeType: mimeType ?? "image/png", version: "v1" }));
    mockReadAttachmentImageBytes.mockResolvedValue(new Uint8Array([97, 98, 99]).buffer);
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

  it("authorizes the native asset without loading the binary fallback", async () => {
    await renderChip({
      fileName: "cat.png",
      filePath: "C:/images/cat.png",
      mimeType: "image/png",
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(1);
    expect(mockReadAttachmentImageBytes).not.toHaveBeenCalled();
  });

  it("uses the loaded fallback in the viewer without retrying a failed asset", async () => {
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
      await Promise.resolve();
    });

    expect(mockReadAttachmentImageBytes).toHaveBeenCalledTimes(1);
    expect(mockReadAttachmentImageBytes).toHaveBeenCalledWith("C:/images/cat.png", "image/png");

    const preview = container.querySelector("[role='button']") as HTMLDivElement | null;
    await act(async () => {
      preview?.click();
    });

    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "blob:raw-fallback",
    );
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(1);
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
