// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PreviewPayload = {
  mimeType: string;
  dataBase64: string;
};

const mockConvertFileSrc = vi.hoisted(() =>
  vi.fn((filePath: string) => `asset://${filePath.replaceAll("\\", "/")}`),
);
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockReadAttachmentPreview = vi.hoisted(() =>
  vi.fn<(filePath: string, mimeType?: string | null) => Promise<PreviewPayload | null>>(
    async () => ({ mimeType: "image/png", dataBase64: "YWJj" }),
  ),
);
const mockCreateObjectURL = vi.hoisted(() => vi.fn(() => "blob:mock-preview"));
const mockRevokeObjectURL = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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

import MarkdownContent from "./MarkdownContent";
import { resetAttachmentImageCachesForTests } from "../../lib/attachmentImages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MarkdownContent local images", () => {
  let container: HTMLDivElement;
  let root: Root;

  function setImageNaturalSize(image: HTMLImageElement, width: number, height: number) {
    Object.defineProperty(image, "naturalWidth", {
      value: width,
      configurable: true,
    });
    Object.defineProperty(image, "naturalHeight", {
      value: height,
      configurable: true,
    });
  }

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

  it("resolves workspace-relative markdown images to Tauri asset URLs", async () => {
    mockReadAttachmentPreview.mockResolvedValueOnce(null);

    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page 8 screenshot](screenshots/kim_toxic_cafe_cuties_korean-page-8-local.png)"
          workspaceRootPath={"C:\\Users\\lemondoo\\PROJECTS\\manga_reader"}
        />,
      );
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(container.querySelector("img[data-panes-markdown-local-image-path]")).toBeNull();
    expect(button?.getAttribute("data-panes-markdown-local-image-path")).toBe(
      "C:\\Users\\lemondoo\\PROJECTS\\manga_reader\\screenshots\\kim_toxic_cafe_cuties_korean-page-8-local.png",
    );
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("aria-label")).toBe("Open image");
    expect(mockConvertFileSrc).toHaveBeenCalledWith(
      "C:\\Users\\lemondoo\\PROJECTS\\manga_reader\\screenshots\\kim_toxic_cafe_cuties_korean-page-8-local.png",
    );
  });

  it("loads a native preview object URL for local markdown images", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    expect(container.querySelector(".markdown-local-image-button")).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(image).not.toBeNull();
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
    );
    expect(image?.getAttribute("src")).toBe("blob:mock-preview");
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it("loads absolute sibling images through the native preview pipeline", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![translated](<C:/Users/dev/Downloads/translated panels/page 07.png>)"
          workspaceRootPath={"C:\\Users\\dev\\Downloads\\current-project"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    const absolutePath = "C:\\Users\\dev\\Downloads\\translated panels\\page 07.png";
    expect(button?.getAttribute("data-panes-markdown-local-image-path")).toBe(absolutePath);
    expect(image?.getAttribute("src")).toBe("blob:mock-preview");
    expect(mockConvertFileSrc).toHaveBeenCalledWith(absolutePath);
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(absolutePath, "image/png");
  });

  it("loads UNC images without requiring a workspace root", async () => {
    const uncPath = String.raw`\\media-server\translations\translated page.webp`;

    await act(async () => {
      root.render(
        <MarkdownContent
          content={String.raw`![translated](<\\media-server\translations\translated page.webp>)`}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector(".markdown-local-image-button")?.getAttribute(
        "data-panes-markdown-local-image-path",
      ),
    ).toBe(uncPath);
    expect(container.querySelector(".markdown-local-image-thumbnail")?.getAttribute("src")).toBe(
      "blob:mock-preview",
    );
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(uncPath, "image/webp");
  });

  it("does not route remote images through native attachment previews", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content={[
            "![remote](https://cdn.example.com/page.png)",
            "![protocol-relative](//cdn.example.com/page.webp)",
          ].join(" ")}
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "https://cdn.example.com/page.png",
      "//cdn.example.com/page.webp",
    ]);
    expect(container.querySelector(".markdown-local-image-button")).toBeNull();
    expect(mockReadAttachmentPreview).not.toHaveBeenCalled();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
  });

  it("sizes the thumbnail frame to the image aspect ratio", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(button).not.toBeNull();
    expect(image).not.toBeNull();

    await act(async () => {
      if (image) {
        setImageNaturalSize(image, 360, 720);
        image.dispatchEvent(new Event("load", { bubbles: true }));
      }
    });

    expect(button?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("110px");
    expect(button?.style.getPropertyValue("--markdown-local-image-frame-height")).toBe("auto");
    expect(button?.style.getPropertyValue("--markdown-local-image-aspect")).toBe("360 / 720");
  });

  it("opens local markdown images in the image viewer", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      button?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.querySelector(".chat-image-viewer-backdrop")).not.toBeNull();
    expect(document.body.textContent).toContain("page.png");
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "blob:mock-preview",
    );
  });

  it("reuses a cached thumbnail source after remounting", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const firstImage = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(firstImage?.getAttribute("src")).toBe("blob:mock-preview");

    await act(async () => {
      if (firstImage) {
        setImageNaturalSize(firstImage, 360, 720);
        firstImage.dispatchEvent(new Event("load", { bubbles: true }));
      }
    });

    await act(async () => {
      root.render(<div />);
    });

    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    const remountedImage = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    const remountedButton = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    expect(remountedImage?.getAttribute("src")).toBe("blob:mock-preview");
    expect(remountedButton?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("110px");
    expect(remountedButton?.style.getPropertyValue("--markdown-local-image-aspect")).toBe("360 / 720");
    expect(mockReadAttachmentPreview).toHaveBeenCalledTimes(1);
  });

  it("reloads an absolute image preview after transient preview state is cleared", async () => {
    const content = "![translated](C:/Users/dev/sibling/translated.png)";
    const absolutePath = "C:\\Users\\dev\\sibling\\translated.png";

    await act(async () => {
      root.render(<MarkdownContent content={content} workspaceRootPath={"C:\\Users\\dev\\repo"} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".markdown-local-image-thumbnail")?.getAttribute("src")).toBe(
      "blob:mock-preview",
    );

    await act(async () => {
      root.render(<div />);
    });
    resetAttachmentImageCachesForTests();
    await act(async () => {
      root.render(<MarkdownContent content={content} workspaceRootPath={"C:\\Users\\dev\\repo"} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector(".markdown-local-image-button")?.getAttribute(
        "data-panes-markdown-local-image-path",
      ),
    ).toBe(absolutePath);
    expect(container.querySelector(".markdown-local-image-thumbnail")?.getAttribute("src")).toBe(
      "blob:mock-preview",
    );
    expect(mockReadAttachmentPreview).toHaveBeenCalledTimes(2);
  });

  it("still converts relative images when Tauri asset detection is unavailable", async () => {
    mockIsTauri.mockReturnValue(false);

    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-panes-markdown-local-image-path")).toBe(
      "C:\\repo\\screenshots\\page.png",
    );
    expect(image?.getAttribute("src")).toBe("blob:mock-preview");
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
    );
  });

  it("still converts relative images when Tauri asset URL conversion fails", async () => {
    mockConvertFileSrc.mockImplementationOnce(() => {
      throw new Error("asset unavailable");
    });

    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(button).not.toBeNull();
    expect(image?.getAttribute("src")).toBe("blob:mock-preview");
    expect(mockConvertFileSrc).toHaveBeenCalledWith("C:\\repo\\screenshots\\page.png");
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
    );
  });

  it("still converts relative images when Tauri detection fails", async () => {
    mockIsTauri.mockImplementationOnce(() => {
      throw new Error("tauri unavailable");
    });

    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page](screenshots/page.png)"
          workspaceRootPath={"C:\\repo"}
        />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container.querySelector(".markdown-local-image-button") as HTMLButtonElement | null;
    const image = container.querySelector(".markdown-local-image-thumbnail") as HTMLImageElement | null;
    expect(button).not.toBeNull();
    expect(button?.getAttribute("data-panes-markdown-local-image-path")).toBe(
      "C:\\repo\\screenshots\\page.png",
    );
    expect(image?.getAttribute("src")).toBe("blob:mock-preview");
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
    expect(mockReadAttachmentPreview).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
    );
  });
});
