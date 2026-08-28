// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../lib/attachmentImages", () => ({
  copyAttachmentImage: vi.fn(async () => undefined),
}));

vi.mock("../../lib/perfTelemetry", () => ({
  recordPerfMetric: vi.fn(),
}));

vi.mock("../../stores/toastStore", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { ImageAttachmentViewer } from "./ImageAttachmentViewer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ImageAttachmentViewer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders an existing thumbnail on the first viewer frame", async () => {
    await renderViewer({
      originalSrc: "asset://full",
      previewSrc: "asset://thumbnail",
    });

    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://thumbnail",
    );
  });

  it("swaps to the full image only after its offscreen decode completes", async () => {
    let pendingImage: DecodingImage | null = null;
    class DecodingImage {
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor() {
        pendingImage = this;
      }

      set src(_value: string) {}

      async decode() {}
    }
    vi.stubGlobal("Image", DecodingImage);

    await renderViewer({
      originalSrc: "asset://full",
      previewSrc: "asset://thumbnail",
    });
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://thumbnail",
    );

    await act(async () => {
      pendingImage?.onload?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://full",
    );
  });

  it("keeps the thumbnail visible when full-resolution decoding fails", async () => {
    class FailingImage {
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", FailingImage);

    await renderViewer({
      originalSrc: "asset://broken-full",
      previewSrc: "asset://thumbnail",
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://thumbnail",
    );
  });

  it("replaces a failed displayed source with the requested binary fallback", async () => {
    const requestPreview = vi.fn(async () => "blob:raw-fallback");
    await renderViewer({
      originalSrc: null,
      previewSrc: "asset://broken",
      requestPreview,
    });

    const image = document.body.querySelector(".chat-image-viewer-image") as HTMLImageElement;
    await act(async () => {
      image.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });

    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "blob:raw-fallback",
    );
  });

  async function renderViewer({
    originalSrc,
    previewSrc,
    requestPreview,
  }: {
    originalSrc: string | null;
    previewSrc: string | null;
    requestPreview?: () => Promise<string | null>;
  }) {
    await act(async () => {
      root.render(
        <ImageAttachmentViewer
          open
          filePath="C:/images/cat.png"
          fileName="cat.png"
          mimeType="image/png"
          originalSrc={originalSrc}
          previewSrc={previewSrc}
          requestPreview={requestPreview}
          onClose={() => {}}
        />,
      );
    });
  }
});
