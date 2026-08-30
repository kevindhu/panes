// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConvertFileSrc = vi.hoisted(() =>
  vi.fn((filePath: string) => `asset://${filePath.replaceAll("\\", "/")}`),
);
const mockIsTauri = vi.hoisted(() => vi.fn(() => true));
const mockPrepareAttachmentImageAsset = vi.hoisted(() => vi.fn(async (
  filePath: string,
  mimeType?: string | null,
  maxWidth?: number | null,
  maxHeight?: number | null,
) => ({
  filePath: maxWidth || maxHeight ? `${filePath}.thumb.png` : filePath,
  mimeType: maxWidth || maxHeight ? "image/png" : mimeType ?? "image/png",
  version: maxWidth || maxHeight ? "thumb" : "full",
})));
const mockReadAttachmentImageBytes = vi.hoisted(() => vi.fn(async () => (
  new Uint8Array([97, 98, 99]).buffer
)));
const mockCreateObjectURL = vi.hoisted(() => vi.fn(() => "blob:raw-fallback"));
const mockRevokeObjectURL = vi.hoisted(() => vi.fn());
const mockOpenExternal = vi.hoisted(() => vi.fn(async () => undefined));
const mockClipboardWriteText = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mockConvertFileSrc,
  isTauri: mockIsTauri,
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: mockOpenExternal,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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

import MarkdownContent from "./MarkdownContent";
import { resetAttachmentImageCachesForTests } from "../../lib/attachmentImages";
import { useTranscriptSelection } from "../../lib/transcriptSelection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function StreamingSelectionHarness({ content, streaming }: { content: string; streaming: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useTranscriptSelection({ rootRef, resetKey: "thread:stable" });
  return (
    <div ref={rootRef}>
      <MarkdownContent
        content={content}
        streaming={streaming}
        selectionScopeId="message:stable"
      />
    </div>
  );
}

function findTextNode(root: Node, text: string): Text {
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(text)) return node;
  }
  throw new Error(`Could not find text node containing ${JSON.stringify(text)}`);
}

describe("MarkdownContent", () => {
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
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockClipboardWriteText },
      configurable: true,
    });
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
    mockConvertFileSrc.mockImplementation(
      (filePath: string) => `asset://${filePath.replaceAll("\\", "/")}`,
    );
    mockPrepareAttachmentImageAsset.mockImplementation(async (
      filePath: string,
      mimeType?: string | null,
      maxWidth?: number | null,
      maxHeight?: number | null,
    ) => ({
      filePath: maxWidth || maxHeight ? `${filePath}.thumb.png` : filePath,
      mimeType: maxWidth || maxHeight ? "image/png" : mimeType ?? "image/png",
      version: maxWidth || maxHeight ? "thumb" : "full",
    }));
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
    globalThis.getSelection?.()?.removeAllRanges();
    container.remove();
    document.body.innerHTML = "";
  });

  it("resolves workspace-relative markdown images to Tauri asset URLs", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content="![page 8 screenshot](screenshots/kim_toxic_cafe_cuties_korean-page-8-local.png)"
          workspaceRootPath={"C:\\Users\\lemondoo\\PROJECTS\\manga_reader"}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
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
      "C:\\Users\\lemondoo\\PROJECTS\\manga_reader\\screenshots\\kim_toxic_cafe_cuties_korean-page-8-local.png.thumb.png",
    );
  });

  it("copies only the selected fenced code block", async () => {
    await act(async () => {
      root.render(
        <MarkdownContent
          content={[
            "```ts",
            "const first = '<one>';",
            "```",
            "",
            "```bash",
            "echo second",
            "```",
          ].join("\n")}
        />,
      );
    });

    const codeBlocks = container.querySelectorAll(".markdown-code-block");
    const copyButtons = container.querySelectorAll<HTMLButtonElement>(".markdown-code-copy");
    expect(codeBlocks).toHaveLength(2);
    expect(copyButtons).toHaveLength(2);
    expect(copyButtons[1]?.getAttribute("aria-label")).toBe("Copy code");

    await act(async () => {
      copyButtons[1]?.click();
      await Promise.resolve();
    });

    expect(mockClipboardWriteText).toHaveBeenCalledTimes(1);
    expect(mockClipboardWriteText).toHaveBeenCalledWith("echo second\n");
    expect(copyButtons[1]?.getAttribute("aria-label")).toBe("Code copied");
    expect(copyButtons[0]?.getAttribute("aria-label")).toBe("Copy code");
  });

  it("keeps native selection nodes mounted while streamed text grows", async () => {
    await act(async () => {
      root.render(<StreamingSelectionHarness content="Keep this highlighted" streaming />);
    });

    const highlighted = findTextNode(container, "highlighted");
    const range = document.createRange();
    const highlightedOffset = highlighted.data.indexOf("highlighted");
    range.setStart(highlighted, highlightedOffset);
    range.setEnd(highlighted, highlightedOffset + "highlighted".length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      highlighted.parentElement?.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
      }));
    });

    await act(async () => {
      root.render(
        <StreamingSelectionHarness
          content="Keep this highlighted while output continues to grow."
          streaming
        />,
      );
      await Promise.resolve();
    });

    expect(findTextNode(container, "highlighted")).toBe(highlighted);
    expect(document.getSelection()?.toString()).toBe("highlighted");

    await act(async () => {
      document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
      root.render(
        <StreamingSelectionHarness
          content="Keep this highlighted while output continues to grow. More output."
          streaming={false}
        />,
      );
      await Promise.resolve();
    });

    expect(findTextNode(container, "highlighted")).toBe(highlighted);
    expect(document.getSelection()?.toString()).toBe("highlighted");
  });

  it("keeps the selected text node when the current word is extended", async () => {
    await act(async () => {
      root.render(<StreamingSelectionHarness content="Keep this high" streaming />);
    });

    const growingWord = findTextNode(container, "high");
    const range = document.createRange();
    const growingWordOffset = growingWord.data.indexOf("high");
    range.setStart(growingWord, growingWordOffset);
    range.setEnd(growingWord, growingWordOffset + "high".length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      growingWord.parentElement?.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
      }));
      root.render(<StreamingSelectionHarness content="Keep this highlighted" streaming />);
      await Promise.resolve();
    });

    expect(findTextNode(container, "high")).toBe(growingWord);
    expect(container.textContent).toContain("Keep this highlighted");
    expect(document.getSelection()?.toString()).toBe("high");
  });

  it("keeps deferred large-stream text append-only", async () => {
    const prefix = "Earlier output. ".repeat(500);
    await act(async () => {
      root.render(<StreamingSelectionHarness content={`${prefix}Keep this high`} streaming />);
    });

    const growingWord = findTextNode(container, "high");
    const start = growingWord.data.lastIndexOf("high");
    const range = document.createRange();
    range.setStart(growingWord, start);
    range.setEnd(growingWord, start + "high".length);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    await act(async () => {
      root.render(
        <StreamingSelectionHarness content={`${prefix}Keep this highlighted`} streaming />,
      );
      await Promise.resolve();
    });

    expect(findTextNode(container, "high")).toBe(growingWord);
    expect(container.textContent).toContain("Keep this highlighted");
    expect(document.getSelection()?.toString()).toBe("high");
  });

  it("opens a markdown web link on a plain click when unrelated text remains selected", async () => {
    const selectedText = document.createElement("div");
    selectedText.textContent = "previous selection";
    document.body.appendChild(selectedText);
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    globalThis.getSelection?.()?.addRange(range);

    await act(async () => {
      root.render(
        <MarkdownContent
          content="[Demo footage](https://www.youtube.com/watch?v=t6ZLKt4vthQ)"
        />,
      );
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 20,
        clientY: 10,
      }));
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 20,
        clientY: 10,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(globalThis.getSelection?.()?.toString()).toBe("previous selection");
    expect(mockOpenExternal).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=t6ZLKt4vthQ",
    );
  });

  it("opens a markdown web link on a plain click", async () => {
    await act(async () => {
      root.render(<MarkdownContent content="[Demo footage](https://example.com/demo)" />);
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }));
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 24,
        clientY: 10,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/demo");
  });

  it("does not open a markdown link when the selection intersects it", async () => {
    await act(async () => {
      root.render(<MarkdownContent content="[Demo footage](https://example.com/demo)" />);
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    const textNode = anchor.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 4);
    globalThis.getSelection?.()?.addRange(range);

    expect(globalThis.getSelection?.()?.toString()).toBe("Demo");
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
      }));
      globalThis.getSelection?.()?.removeAllRanges();
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
      }));
      await Promise.resolve();
    });

    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it("keeps keyboard activation available for markdown links", async () => {
    await act(async () => {
      root.render(<MarkdownContent content="[Demo footage](https://example.com/demo)" />);
    });

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await act(async () => {
      anchor.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 0,
      }));
      await Promise.resolve();
    });

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/demo");
  });

  it("loads a bounded native asset thumbnail for local markdown images", async () => {
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
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
      1120,
      840,
    );
    expect(image?.getAttribute("src")).toBe(
      "asset://C:/repo/screenshots/page.png.thumb.png?v=thumb",
    );
    expect(mockReadAttachmentImageBytes).not.toHaveBeenCalled();
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
    expect(image?.getAttribute("src")).toBe(
      "asset://C:/Users/dev/Downloads/translated%20panels/page%2007.png.thumb.png?v=thumb".replaceAll("%20", " "),
    );
    expect(mockConvertFileSrc).toHaveBeenCalledWith(`${absolutePath}.thumb.png`);
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      absolutePath,
      "image/png",
      1120,
      840,
    );
  });

  it("promotes plain local image links, including encoded Windows file URLs", async () => {
    const windowsPath = String.raw`C:\Users\lemondoo\Pictures\Kimtoxic\유나라 (01).png`;
    const fileUrl = "file:///C:/%5CUsers%5Clemondoo%5CPictures%5CKimtoxic%5C%EC%9C%A0%EB%82%98%EB%9D%BC%20(01).png";

    await act(async () => {
      root.render(
        <MarkdownContent
          content={[
            String.raw`[유나라 raw](<C:\Users\lemondoo\Pictures\Kimtoxic\유나라 (01).png>)`,
            `[유나라 file URL](<${fileUrl}>)`,
          ].join("\n\n")}
          workspaceRootPath={"C:\\Users\\lemondoo\\PROJECTS\\manga_reader"}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".markdown-local-image-button"),
    );
    expect(buttons, container.innerHTML).toHaveLength(2);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(buttons.map((button) => (
      button.getAttribute("data-panes-markdown-local-image-path")
    ))).toEqual([windowsPath, windowsPath]);
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      windowsPath,
      "image/png",
      1120,
      840,
    );
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
      "asset:////media-server/translations/translated page.webp.thumb.png?v=thumb",
    );
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledWith(
      uncPath,
      "image/webp",
      1120,
      840,
    );
  });

  it("routes remote images through the shared viewer without native file APIs", async () => {
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
      "https://cdn.example.com/page.webp",
    ]);
    expect(container.querySelectorAll(".markdown-local-image-button")).toHaveLength(2);
    expect(mockPrepareAttachmentImageAsset).not.toHaveBeenCalled();
    expect(mockReadAttachmentImageBytes).not.toHaveBeenCalled();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();

    await act(async () => {
      (container.querySelector(".markdown-local-image-button") as HTMLButtonElement).click();
    });
    expect(document.body.querySelector(".chat-image-viewer-image")?.getAttribute("src")).toBe(
      "https://cdn.example.com/page.png",
    );
  });

  it("fits Markdown thumbnails inside 560 by 420 without upscaling small images", async () => {
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
        setImageNaturalSize(image, 120, 80);
        image.dispatchEvent(new Event("load", { bubbles: true }));
      }
    });
    expect(button?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("120px");

    await act(async () => {
      if (image) {
        setImageNaturalSize(image, 2_000, 1_000);
        image.dispatchEvent(new Event("load", { bubbles: true }));
      }
    });
    expect(button?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("560px");

    await act(async () => {
      if (image) {
        setImageNaturalSize(image, 360, 720);
        image.dispatchEvent(new Event("load", { bubbles: true }));
      }
    });

    expect(button?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("210px");
    expect(button?.style.getPropertyValue("--markdown-local-image-frame-height")).toBe("");
    expect(button?.style.getPropertyValue("--markdown-local-image-aspect")).toBe("");
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
      "asset://C:/repo/screenshots/page.png.thumb.png?v=thumb",
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
    expect(firstImage?.getAttribute("src")).toBe(
      "asset://C:/repo/screenshots/page.png.thumb.png?v=thumb",
    );

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
    expect(remountedImage?.getAttribute("src")).toBe(
      "asset://C:/repo/screenshots/page.png.thumb.png?v=thumb",
    );
    expect(remountedButton?.style.getPropertyValue("--markdown-local-image-frame-width")).toBe("210px");
    expect(remountedButton?.style.getPropertyValue("--markdown-local-image-aspect")).toBe("");
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(1);
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
      "asset://C:/Users/dev/sibling/translated.png.thumb.png?v=thumb",
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
      "asset://C:/Users/dev/sibling/translated.png.thumb.png?v=thumb",
    );
    expect(mockPrepareAttachmentImageAsset).toHaveBeenCalledTimes(2);
  });

  it("keeps a local-image placeholder outside Tauri", async () => {
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
    expect(image).toBeNull();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
    expect(mockPrepareAttachmentImageAsset).not.toHaveBeenCalled();
    expect(mockReadAttachmentImageBytes).not.toHaveBeenCalled();
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
    expect(image?.getAttribute("src")).toBe("blob:raw-fallback");
    expect(mockConvertFileSrc).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png.thumb.png",
    );
    expect(mockReadAttachmentImageBytes).toHaveBeenCalledWith(
      "C:\\repo\\screenshots\\page.png",
      "image/png",
    );
  });

  it("keeps a local-image placeholder when Tauri detection fails", async () => {
    mockIsTauri.mockImplementation(() => {
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
    expect(image).toBeNull();
    expect(mockConvertFileSrc).not.toHaveBeenCalled();
    expect(mockReadAttachmentImageBytes).not.toHaveBeenCalled();
  });
});
