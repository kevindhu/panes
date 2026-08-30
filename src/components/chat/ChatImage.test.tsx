// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCacheEmbeddedChatImage = vi.hoisted(() => vi.fn(async () => ({
  filePath: "C:/cache/embedded.png",
  mimeType: "image/png",
  version: "embedded-v1",
})));
const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
) => ({ filePath, mimeType: mimeType ?? "image/png", version: "asset-v1" })));
const mockConvertFileSrc = vi.hoisted(() => vi.fn((filePath: string) => `asset://${filePath}`));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: () => true,
}));

vi.mock("../../lib/codexIpc", () => ({
  ipc: {
    cacheEmbeddedChatImage: mockCacheEmbeddedChatImage,
    prepareAttachmentImageAsset: mockPrepareAttachmentImageAsset,
    readAttachmentImageBytes: vi.fn(async () => new ArrayBuffer(0)),
    copyAttachmentImageToClipboard: vi.fn(async () => undefined),
  },
}));

vi.mock("../../stores/toastStore", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { resetAttachmentImageCachesForTests } from "../../lib/attachmentImages";
import { ChatImagePreview } from "./ChatImage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatImagePreview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheEmbeddedChatImage.mockResolvedValue({
      filePath: "C:/cache/embedded.png",
      mimeType: "image/png",
      version: "embedded-v1",
    });
    resetAttachmentImageCachesForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    resetAttachmentImageCachesForTests();
    container.remove();
  });

  it("materializes an embedded image once without retriggering its own load effect", async () => {
    await act(async () => {
      root.render(
        <ChatImagePreview
          image={{
            id: "embedded-1",
            origin: "mcp",
            fileName: "embedded.png",
            alt: "Embedded image",
            mimeType: "image/png",
            sourceUrl: "data:image/png;base64,iVBORw0KGgo=",
          }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mockCacheEmbeddedChatImage).toHaveBeenCalledTimes(1);
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "asset://C:/cache/embedded.png",
    );
  });

  it("ignores an older embedded load when the descriptor changes", async () => {
    type EmbeddedAsset = Awaited<ReturnType<typeof mockCacheEmbeddedChatImage>>;
    let resolveFirst: ((asset: EmbeddedAsset) => void) | undefined;
    mockCacheEmbeddedChatImage
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        filePath: "C:/cache/second.png",
        mimeType: "image/png",
        version: "second-v1",
      });

    await act(async () => {
      root.render(
        <ChatImagePreview image={{
          id: "first",
          origin: "mcp",
          fileName: "first.png",
          alt: "First",
          mimeType: "image/png",
          sourceUrl: "data:image/png;base64,iVBORw0KGgoFIRST=",
        }} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <ChatImagePreview image={{
          id: "second",
          origin: "mcp",
          fileName: "second.png",
          alt: "Second",
          mimeType: "image/png",
          sourceUrl: "data:image/png;base64,iVBORw0KGgoSECOND=",
        }} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst?.({
        filePath: "C:/cache/first.png",
        mimeType: "image/png",
        version: "first-v1",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "asset://C:/cache/second.png",
    );
    expect(mockPrepareAttachmentImageAsset).not.toHaveBeenCalledWith(
      "C:/cache/first.png",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
