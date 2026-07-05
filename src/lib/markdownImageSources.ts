import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { resolveWorkspaceRelativeLocalImagePath } from "./localImageSources";

export const MARKDOWN_LOCAL_IMAGE_PATH_ATTR = "data-panes-markdown-local-image-path";
export const MARKDOWN_LOCAL_IMAGE_MIME_ATTR = "data-panes-markdown-local-image-mime";
export const MARKDOWN_LOCAL_IMAGE_FALLBACK_ATTR = "data-panes-markdown-local-image-fallback";

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

function guessImageMimeType(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const filename = normalizedPath.split("/").filter(Boolean).pop() ?? "";
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex < 0 || dotIndex === filename.length - 1) {
    return null;
  }

  return IMAGE_MIME_TYPES_BY_EXTENSION[filename.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function resolveTauriAssetSource(filePath: string, fallbackSource: string): string {
  try {
    return isTauri() ? convertFileSrc(filePath) : fallbackSource;
  } catch {
    return fallbackSource;
  }
}

export function resolveWorkspaceMarkdownImage(
  source: string,
  workspaceRootPath?: string | null,
): { filePath: string; mimeType: string | null; source: string } | null {
  const filePath = resolveWorkspaceRelativeLocalImagePath(source, workspaceRootPath);

  if (!filePath) {
    return null;
  }

  return {
    filePath,
    mimeType: guessImageMimeType(filePath),
    source: resolveTauriAssetSource(filePath, source),
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
  if (!workspaceRootPath?.trim() || typeof document === "undefined") {
    return html;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  let changed = false;

  for (const image of template.content.querySelectorAll("img[src]")) {
    const source = image.getAttribute("src") ?? "";
    const resolvedImage = resolveWorkspaceMarkdownImage(source, workspaceRootPath);

    if (!resolvedImage) {
      continue;
    }

    image.setAttribute("src", resolvedImage.source);
    image.setAttribute(MARKDOWN_LOCAL_IMAGE_PATH_ATTR, resolvedImage.filePath);
    image.setAttribute("role", "button");
    image.setAttribute("tabindex", "0");
    image.setAttribute("aria-label", "Open image");
    if (resolvedImage.mimeType) {
      image.setAttribute(MARKDOWN_LOCAL_IMAGE_MIME_ATTR, resolvedImage.mimeType);
    }
    changed = true;
  }

  return changed ? template.innerHTML : html;
}
