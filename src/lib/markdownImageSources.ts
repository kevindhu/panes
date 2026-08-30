import {
  hasSupportedLocalImageExtension,
  resolveLocalImagePath,
  splitLocalImageSource,
} from "./localImageSources";
import { createChatImageDescriptor } from "./chatImageSources";

export const MARKDOWN_LOCAL_IMAGE_PATH_ATTR = "data-panes-markdown-local-image-path";
export const MARKDOWN_LOCAL_IMAGE_MIME_ATTR = "data-panes-markdown-local-image-mime";
export const MARKDOWN_LOCAL_IMAGE_FALLBACK_ATTR = "data-panes-markdown-local-image-fallback";
export const MARKDOWN_CHAT_IMAGE_SOURCE_ATTR = "data-panes-chat-image-source";

const IMAGE_MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

const STANDALONE_MARKDOWN_IMAGE_RE =
  /^!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))\s*\)$/;

function promoteStandaloneLocalImageFences(
  root: DocumentFragment,
  workspaceRootPath?: string | null,
): boolean {
  let changed = false;

  for (const code of root.querySelectorAll("pre > code")) {
    const isMarkdownFence = Array.from(code.classList).some(
      (className) => className === "language-md" || className === "language-markdown",
    );
    if (!isMarkdownFence) {
      continue;
    }

    const match = code.textContent?.trim().match(STANDALONE_MARKDOWN_IMAGE_RE);
    const source = match?.[2]?.trim() || match?.[3]?.trim();
    if (!match || !source) {
      continue;
    }

    const descriptor = createChatImageDescriptor({
      origin: "markdown",
      source,
      alt: match[1]?.trim(),
      workspaceRootPath,
    });
    if (!descriptor?.filePath) {
      continue;
    }

    const image = document.createElement("img");
    image.setAttribute("src", source);
    image.setAttribute("alt", match[1]?.trim() || descriptor.fileName);
    code.parentElement?.replaceWith(image);
    changed = true;
  }

  return changed;
}

function guessImageMimeType(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const filename = normalizedPath.split("/").filter(Boolean).pop() ?? "";
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex < 0 || dotIndex === filename.length - 1) {
    return null;
  }

  return IMAGE_MIME_TYPES_BY_EXTENSION[filename.slice(dotIndex + 1).toLowerCase()] ?? null;
}

export function resolveWorkspaceMarkdownImage(
  source: string,
  workspaceRootPath?: string | null,
): { filePath: string; mimeType: string | null; source: string } | null {
  const filePath = resolveLocalImagePath(source, workspaceRootPath);

  if (!filePath) {
    return null;
  }

  return {
    filePath,
    mimeType: guessImageMimeType(filePath),
    source,
  };
}

export function resolveWorkspaceMarkdownImageSrc(
  source: string,
  workspaceRootPath?: string | null,
): string | null {
  return resolveWorkspaceMarkdownImage(source, workspaceRootPath)?.source ?? null;
}

export function rewriteMarkdownImageSources(
  html: string,
  workspaceRootPath?: string | null,
): string {
  if (typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  let changed = promoteStandaloneLocalImageFences(template.content, workspaceRootPath);

  for (const anchor of template.content.querySelectorAll("a[href]")) {
    const source = anchor.getAttribute("href")?.trim() ?? "";
    if (!hasSupportedLocalImageExtension(splitLocalImageSource(source).path)) {
      continue;
    }
    const descriptor = createChatImageDescriptor({
      origin: "markdown",
      source,
      alt: anchor.textContent,
      workspaceRootPath,
    });
    if (!descriptor) {
      continue;
    }

    const image = document.createElement("img");
    image.setAttribute("src", source);
    image.setAttribute("alt", anchor.textContent?.trim() || descriptor.fileName);
    const title = anchor.getAttribute("title");
    if (title) {
      image.setAttribute("title", title);
    }
    const inlineCode = anchor.parentElement;
    const imageIsOnlyInlineCodeContent =
      inlineCode?.tagName.toLowerCase() === "code"
      && inlineCode.parentElement?.tagName.toLowerCase() !== "pre"
      && Array.from(inlineCode.childNodes).every(
        (child) => child === anchor || (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()),
      );
    (imageIsOnlyInlineCodeContent ? inlineCode : anchor)?.replaceWith(image);
    changed = true;
  }

  for (const image of template.content.querySelectorAll("img[src]")) {
    const source = image.getAttribute("src") ?? "";
    const resolvedImage = resolveWorkspaceMarkdownImage(source, workspaceRootPath);
    const descriptor = createChatImageDescriptor({
      origin: "markdown",
      source,
      filePath: resolvedImage?.filePath,
      mimeType: resolvedImage?.mimeType,
      alt: image.getAttribute("alt"),
      workspaceRootPath,
    });

    if (!descriptor) {
      continue;
    }

    image.setAttribute(MARKDOWN_CHAT_IMAGE_SOURCE_ATTR, source);
    if (descriptor.filePath) {
      image.setAttribute(MARKDOWN_LOCAL_IMAGE_PATH_ATTR, descriptor.filePath);
    }
    image.setAttribute("role", "button");
    image.setAttribute("tabindex", "0");
    image.setAttribute("aria-label", "Open image");
    if (descriptor.mimeType) {
      image.setAttribute(MARKDOWN_LOCAL_IMAGE_MIME_ATTR, descriptor.mimeType);
    }
    changed = true;
  }

  return changed ? template.innerHTML : html;
}
