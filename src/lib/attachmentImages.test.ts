import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PreviewPayload = {
  mimeType: string;
  dataBase64: string;
};

const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockReadAttachmentPreview = vi.hoisted(() =>
  vi.fn<(filePath: string, mimeType?: string | null) => Promise<PreviewPayload | null>>(async () => null)
);
const mockCopyAttachmentImageToClipboard = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("./ipc", () => ({
  ipc: {
    readAttachmentPreview: mockReadAttachmentPreview,
    copyAttachmentImageToClipboard: mockCopyAttachmentImageToClipboard,
  },
}));

import {
  attachmentPreviewToDataUrl,
  copyAttachmentImage,
  copyImageFromSources,
  getAttachmentImageSources,
  getAttachmentOriginalImageSrc,
  loadAttachmentPreviewDataUrl,
  prewarmImageBlobFromSources,
  resetAttachmentImageCachesForTests,
} from "./attachmentImages";

describe("attachmentImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttachmentImageCachesForTests();
    mockIsTauri.mockReturnValue(true);
    mockConvertFileSrc.mockImplementation((filePath: string) => `asset://${filePath}`);
    mockCopyAttachmentImageToClipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetAttachmentImageCachesForTests();
    vi.unstubAllGlobals();
  });

  it("prefers a Tauri file source when available", () => {
    expect(getAttachmentOriginalImageSrc("C:/images/cat.png")).toBe("asset://C:/images/cat.png");
    expect(mockConvertFileSrc).toHaveBeenCalledWith("C:/images/cat.png");
  });

  it("returns null for original image sources outside Tauri", () => {
    mockIsTauri.mockReturnValue(false);

    expect(getAttachmentOriginalImageSrc("C:/images/cat.png")).toBeNull();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
  });

  it("builds a data URL from an attachment preview payload", () => {
    expect(
      attachmentPreviewToDataUrl({
        mimeType: "image/png",
        dataBase64: "YWJj",
      }),
    ).toBe("data:image/png;base64,YWJj");
  });

  it("uses the preview as a fallback when the original file source exists", () => {
    expect(
      getAttachmentImageSources("asset://cat.png", "data:image/png;base64,YWJj"),
    ).toEqual({
      primarySrc: "asset://cat.png",
      fallbackSrc: "data:image/png;base64,YWJj",
    });
  });

  it("deduplicates attachment preview reads", async () => {
    mockReadAttachmentPreview.mockResolvedValue({
      mimeType: "image/png",
      dataBase64: "YWJj",
    });

    const [firstPreview, secondPreview] = await Promise.all([
      loadAttachmentPreviewDataUrl("C:/images/cat.png", "image/png"),
      loadAttachmentPreviewDataUrl("C:/images/cat.png", "image/png"),
    ]);

    expect(firstPreview).toBe("data:image/png;base64,YWJj");
    expect(secondPreview).toBe("data:image/png;base64,YWJj");
    expect(mockReadAttachmentPreview).toHaveBeenCalledTimes(1);
  });

  it("reuses a warmed image blob when copying to the clipboard", async () => {
    mockIsTauri.mockReturnValue(false);
    const mockWrite = vi.fn(async () => undefined);

    class MockClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: mockWrite,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image"], { type: "image/png" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    prewarmImageBlobFromSources(["asset://cat.png"], "image/png");
    await Promise.resolve();
    await copyImageFromSources(["asset://cat.png"], "image/png");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("copies image data after falling back to a secondary source", async () => {
    mockIsTauri.mockReturnValue(false);
    const mockWrite = vi.fn(async () => undefined);

    class MockClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: mockWrite,
      },
    });

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("primary failed"))
      .mockResolvedValueOnce(
        new Response(new Blob(["image"], { type: "image/png" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await copyImageFromSources(
      ["asset://broken", "data:image/png;base64,YWJj"],
      "image/png",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenCalledTimes(1);

    const clipboardItems = (
      mockWrite.mock.calls[0] as unknown as [Array<{ items: Record<string, Blob> }>]
    )[0];
    expect(Object.keys(clipboardItems[0].items)).toEqual(["image/png"]);
  });

  it("uses the native desktop clipboard path when available", async () => {
    await copyAttachmentImage("C:/images/cat.png", ["asset://cat.png"], "image/png");

    expect(mockCopyAttachmentImageToClipboard).toHaveBeenCalledTimes(1);
    expect(mockCopyAttachmentImageToClipboard).toHaveBeenCalledWith(
      "C:/images/cat.png",
      "image/png",
    );
  });

  it("falls back to the browser clipboard path when native copy fails", async () => {
    mockCopyAttachmentImageToClipboard.mockRejectedValueOnce(new Error("native failed"));

    const mockWrite = vi.fn(async () => undefined);

    class MockClipboardItem {
      items: Record<string, Blob>;

      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    }

    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", {
      clipboard: {
        write: mockWrite,
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image"], { type: "image/png" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await copyAttachmentImage("C:/images/cat.png", ["asset://cat.png"], "image/png");

    expect(mockCopyAttachmentImageToClipboard).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});
