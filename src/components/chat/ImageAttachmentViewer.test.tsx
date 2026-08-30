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

  it("requests and decodes the full image when opened with only a thumbnail", async () => {
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
    const requestPreview = vi.fn(async () => "asset://full-on-open");

    await renderViewer({
      originalSrc: null,
      previewSrc: "asset://thumbnail",
      requestPreview,
    });
    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://thumbnail",
    );

    await act(async () => {
      pendingImage?.onload?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "asset://full-on-open",
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

  it("supports keyboard zoom, reset, and close", async () => {
    const onClose = vi.fn();
    await renderViewer({
      originalSrc: "asset://thumbnail",
      previewSrc: "asset://thumbnail",
      onClose,
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
    });
    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("120%");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    });
    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("100%");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fits an oversized portrait image and still allows zooming out", async () => {
    await renderViewer({
      originalSrc: "asset://large-portrait",
      previewSrc: "asset://large-portrait",
    });

    const stage = document.body.querySelector(".chat-image-viewer-stage") as HTMLDivElement;
    const image = document.body.querySelector(".chat-image-viewer-image") as HTMLImageElement;
    Object.defineProperties(stage, {
      clientWidth: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 700 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 2_000 },
      naturalHeight: { configurable: true, value: 3_000 },
    });

    await act(async () => {
      image.dispatchEvent(new Event("load"));
    });

    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("23%");
    expect(image.style.transform).toContain("scale(0.22533333333333333)");

    const zoomOut = document.body.querySelector(
      '[aria-label="attachments.viewer.zoomOut"]',
    ) as HTMLButtonElement;
    expect(zoomOut.disabled).toBe(false);
    await act(async () => {
      zoomOut.click();
    });
    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("19%");

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[aria-label="attachments.viewer.resetZoom"]',
      )?.click();
    });
    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("23%");
  });

  it("reveals the first viewer frame at fit scale before enabling zoom transitions", async () => {
    let pendingAnimationFrame: FrameRequestCallback | null = null;
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        pendingAnimationFrame = callback;
        return 1;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);

    await renderViewer({
      originalSrc: "asset://large-portrait",
      previewSrc: "asset://large-portrait",
    });

    const stage = document.body.querySelector(".chat-image-viewer-stage") as HTMLDivElement;
    const image = document.body.querySelector(".chat-image-viewer-image") as HTMLImageElement;
    Object.defineProperties(stage, {
      clientWidth: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 700 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 2_000 },
      naturalHeight: { configurable: true, value: 3_000 },
    });

    expect(image.className).not.toContain("is-fit-ready");

    await act(async () => {
      image.dispatchEvent(new Event("load"));
    });

    expect(document.body.querySelector(".chat-image-viewer-zoom-label")?.textContent).toBe("23%");
    expect(image.style.transform).toContain("scale(0.22533333333333333)");
    expect(image.className).toContain("is-fit-ready");
    expect(image.className).not.toContain("can-transition");

    const animationFrame = pendingAnimationFrame as FrameRequestCallback | null;
    expect(animationFrame).not.toBeNull();
    await act(async () => {
      animationFrame?.(performance.now());
    });

    expect(image.className).toContain("can-transition");

    requestAnimationFrameSpy.mockRestore();
    cancelAnimationFrameSpy.mockRestore();
  });

  it("closes from translucent space outside the image", async () => {
    const onClose = vi.fn();
    await renderViewer({
      originalSrc: "asset://thumbnail",
      previewSrc: "asset://thumbnail",
      onClose,
    });

    await act(async () => {
      document.body.querySelector<HTMLElement>(".chat-image-viewer-toolbar")?.click();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.querySelector<HTMLElement>(".chat-image-viewer-image")?.click();
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document.body.querySelector<HTMLElement>(".chat-image-viewer-dialog")?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.body.querySelector<HTMLElement>(".chat-image-viewer-stage")?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    await act(async () => {
      document.body.querySelector<HTMLElement>(".chat-image-viewer-backdrop")?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("locks background scrolling while open", async () => {
    document.body.style.overflow = "auto";
    await renderViewer({
      originalSrc: "asset://thumbnail",
      previewSrc: "asset://thumbnail",
    });
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => {
      root.render(
        <ImageAttachmentViewer
          open={false}
          filePath="C:/images/cat.png"
          fileName="cat.png"
          mimeType="image/png"
          originalSrc={null}
          previewSrc={null}
          onClose={() => {}}
        />,
      );
    });
    expect(document.body.style.overflow).toBe("auto");
  });

  async function renderViewer({
    originalSrc,
    previewSrc,
    requestPreview,
    onClose = () => {},
  }: {
    originalSrc: string | null;
    previewSrc: string | null;
    requestPreview?: () => Promise<string | null>;
    onClose?: () => void;
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
          onClose={onClose}
        />,
      );
    });
  }
});
