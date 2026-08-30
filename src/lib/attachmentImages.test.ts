import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
) => ({
  filePath,
  mimeType: mimeType ?? "image/png",
  version: "abc123",
})));
const mockReadAttachmentImageBytes = vi.hoisted(() => vi.fn(async () => (
  new Uint8Array([97, 98, 99]).buffer
)));
const mockCopyAttachmentImageToClipboard = vi.hoisted(() => vi.fn(async () => undefined));
const mockCacheEmbeddedChatImage = vi.hoisted(() => vi.fn(async () => ({
  filePath: "C:/cache/embedded.png",
  mimeType: "image/png",
  version: "embedded",
})));
const mockCreateObjectURL = vi.hoisted(() => vi.fn<(blob: Blob) => string>(() => "blob:raw-fallback"));
const mockRevokeObjectURL = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("./codexIpc", () => ({
  ipc: {
    prepareAttachmentImageAsset: mockPrepareAttachmentImageAsset,
    readAttachmentImageBytes: mockReadAttachmentImageBytes,
    copyAttachmentImageToClipboard: mockCopyAttachmentImageToClipboard,
    cacheEmbeddedChatImage: mockCacheEmbeddedChatImage,
  },
}));

import {
  copyAttachmentImage,
  cacheEmbeddedImageDataUrl,
  copyImageFromSources,
  getCachedAttachmentImageAssetUrl,
  loadAttachmentImageAssetUrl,
  loadAttachmentImageFallbackUrl,
  prewarmImageBlobFromSources,
  resetAttachmentImageCachesForTests,
} from "./attachmentImages";

describe("attachmentImages", () => {
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
    ) => ({
      filePath,
      mimeType: mimeType ?? "image/png",
      version: "abc123",
    }));
    mockReadAttachmentImageBytes.mockResolvedValue(new Uint8Array([97, 98, 99]).buffer);
    mockCopyAttachmentImageToClipboard.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetAttachmentImageCachesForTests();
    vi.unstubAllGlobals();
  });

  it("authorizes and caches a versioned Tauri asset URL", async () => {
    const [firstSource, secondSource] = await Promise.all([
      loadAttachmentImageAssetUrl("C:/images/cat.png", "image/png"),
      loadAttachmentImageAssetUrl("C:/images/cat.png", "image/png"),
    ]);

    expect(firstSource).toBe("asset://C:/images/cat.png?v=abc123");
    expect(secondSource).toBe(firstSource);
    expect(getCachedAttachmentImageAssetUrl("C:/images/cat.png", "image/png")).toBe(firstSource);
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(1);
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      "C:/images/cat.png",
      "image/png",
      null,
      null,
    );
    expect(mockConvertFileSrc).toHaveBeenCalledWith("C:/images/cat.png");
  });

  it("requests a bounded native thumbnail independently from the full asset", async () => {
    await loadAttachmentImageAssetUrl("C:/images/cat.png", "image/png", {
      maxWidth: 720,
      maxHeight: 440,
    });

    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      "C:/images/cat.png",
      "image/png",
      720,
      440,
    );
  });

  it("returns null without invoking native APIs outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false);

    await expect(loadAttachmentImageAssetUrl("C:/images/cat.png", "image/png")).resolves.toBeNull();
    expect(mockPrepareAttachmentImageAsset).not.toHaveBeenCalled();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
  });

  it("builds and deduplicates an object URL from the raw binary fallback", async () => {
    const [firstFallback, secondFallback] = await Promise.all([
      loadAttachmentImageFallbackUrl("C:/images/cat.png", "image/png"),
      loadAttachmentImageFallbackUrl("C:/images/cat.png", "image/png"),
    ]);

    expect(firstFallback).toBe("blob:raw-fallback");
    expect(secondFallback).toBe(firstFallback);
    expect(mockReadAttachmentImageBytes).toHaveBeenCalledTimes(1);
    expect(mockReadAttachmentImageBytes).toHaveBeenCalledWith("C:/images/cat.png", "image/png");
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = mockCreateObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
  });

  it("persists embedded image data through the native cache once", async () => {
    const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const [first, second] = await Promise.all([
      cacheEmbeddedImageDataUrl(source, "image/png"),
      cacheEmbeddedImageDataUrl(source, "image/png"),
    ]);

    expect(first?.filePath).toBe("C:/cache/embedded.png");
    expect(second).toEqual(first);
    expect(mockCacheEmbeddedChatImage).toHaveBeenCalledTimes(1);
    expect(mockCacheEmbeddedChatImage).toHaveBeenCalledWith(
      "image/png",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    );
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

  it("does not retain oversized inline image sources in the blob cache", async () => {
    mockIsTauri.mockReturnValue(false);
    const mockWrite = vi.fn(async () => undefined);
    class MockClipboardItem {
      constructor(public items: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", MockClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: mockWrite } });
    const fetchMock = vi.fn().mockImplementation(async () => (
      new Response(new Blob(["image"], { type: "image/png" }), { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const oversizedSource = `data:image/png;base64,${"A".repeat(9_000)}`;

    await copyImageFromSources([oversizedSource], "image/png");
    await copyImageFromSources([oversizedSource], "image/png");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenCalledTimes(2);
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
      ["asset://broken", "blob:fallback"],
      "image/png",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenCalledTimes(1);
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
