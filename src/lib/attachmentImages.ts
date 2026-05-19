import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { ipc } from "./ipc";
import type { AttachmentPreview } from "../types";

const attachmentPreviewUrlCache = new Map<string, Promise<string | null>>();
const attachmentImageBlobCache = new Map<string, Promise<Blob>>();

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot + 1).toLowerCase() : "";
}

export function guessAttachmentImageMimeType(fileName: string): string | undefined {
  switch (getFileExtension(fileName)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
    default:
      return undefined;
  }
}

export function isImageAttachmentMimeType(mimeType?: string | null): boolean {
  return Boolean(mimeType?.trim().toLowerCase().startsWith("image/"));
}

export function resolveAttachmentImageMimeType(
  fileName: string,
  mimeType?: string | null,
): string | undefined {
  const guessedMimeType = guessAttachmentImageMimeType(fileName);
  if (isImageAttachmentMimeType(guessedMimeType) && !isImageAttachmentMimeType(mimeType)) {
    return guessedMimeType;
  }
  return mimeType?.trim() || guessedMimeType;
}

export function attachmentPreviewToDataUrl(preview?: AttachmentPreview | null): string | null {
  if (!preview?.mimeType || !preview.dataBase64) {
    return null;
  }
  return `data:${preview.mimeType};base64,${preview.dataBase64}`;
}

export function loadAttachmentPreviewDataUrl(
  filePath: string,
  mimeType?: string | null,
): Promise<string | null> {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    return Promise.resolve(null);
  }

  const cacheKey = getAttachmentPreviewCacheKey(normalizedFilePath, mimeType);
  const cachedPreview = attachmentPreviewUrlCache.get(cacheKey);
  if (cachedPreview) {
    return cachedPreview;
  }

  const previewPromise = ipc.readAttachmentPreview(normalizedFilePath, mimeType ?? null)
    .then((preview) => attachmentPreviewToDataUrl(preview))
    .catch((error) => {
      attachmentPreviewUrlCache.delete(cacheKey);
      throw error;
    });

  attachmentPreviewUrlCache.set(cacheKey, previewPromise);
  return previewPromise;
}

export function getAttachmentOriginalImageSrc(filePath: string): string | null {
  const normalizedPath = filePath.trim();
  if (!normalizedPath || !isTauri()) {
    return null;
  }
  return convertFileSrc(normalizedPath);
}

export function getAttachmentImageSources(
  originalSrc: string | null,
  previewSrc: string | null,
): { primarySrc: string | null; fallbackSrc: string | null } {
  const normalizedOriginal = normalizeSource(originalSrc);
  const normalizedPreview = normalizeSource(previewSrc);

  if (!normalizedOriginal) {
    return {
      primarySrc: normalizedPreview,
      fallbackSrc: null,
    };
  }

  if (!normalizedPreview || normalizedPreview === normalizedOriginal) {
    return {
      primarySrc: normalizedOriginal,
      fallbackSrc: null,
    };
  }

  return {
    primarySrc: normalizedOriginal,
    fallbackSrc: normalizedPreview,
  };
}

export async function loadImageBlobFromSources(
  sources: Array<string | null | undefined>,
  mimeType?: string | null,
): Promise<Blob> {
  let lastError: unknown;

  for (const source of uniqueSources(sources)) {
    try {
      const blob = await loadImageBlobFromSource(source);
      const resolvedMimeType = resolveClipboardImageMimeType(blob.type, mimeType);
      if (!resolvedMimeType) {
        throw new Error("Resolved attachment source is not an image.");
      }

      return blob.type === resolvedMimeType
        ? blob
        : blob.slice(0, blob.size, resolvedMimeType);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to load an image source.");
}

export function prewarmImageBlobFromSources(
  sources: Array<string | null | undefined>,
  mimeType?: string | null,
): void {
  void loadImageBlobFromSources(sources, mimeType).catch(() => {});
}

export async function copyImageFromSources(
  sources: Array<string | null | undefined>,
  mimeType?: string | null,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
    throw new Error("Clipboard image write unavailable.");
  }
  if (typeof ClipboardItem === "undefined") {
    throw new Error("ClipboardItem unavailable.");
  }

  const blob = await loadImageBlobFromSources(sources, mimeType);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export async function copyAttachmentImage(
  filePath: string,
  sources: Array<string | null | undefined>,
  mimeType?: string | null,
): Promise<void> {
  const normalizedFilePath = filePath.trim();
  let nativeCopyError: unknown;

  if (normalizedFilePath && isTauri()) {
    try {
      await ipc.copyAttachmentImageToClipboard(normalizedFilePath, mimeType ?? null);
      return;
    } catch (error) {
      nativeCopyError = error;
    }
  }

  try {
    await copyImageFromSources(sources, mimeType);
  } catch (error) {
    throw nativeCopyError ?? error;
  }
}

export function resetAttachmentImageCachesForTests(): void {
  attachmentPreviewUrlCache.clear();
  attachmentImageBlobCache.clear();
}

function normalizeSource(value?: string | null): string | null {
  const normalizedValue = value?.trim();
  return normalizedValue ? normalizedValue : null;
}

function uniqueSources(sources: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      sources
        .map(normalizeSource)
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function getAttachmentPreviewCacheKey(filePath: string, mimeType?: string | null): string {
  const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
  return `${filePath}\u0000${normalizedMimeType}`;
}

function loadImageBlobFromSource(source: string): Promise<Blob> {
  const cachedBlob = attachmentImageBlobCache.get(source);
  if (cachedBlob) {
    return cachedBlob;
  }

  const blobPromise = fetch(source)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load image source (${response.status}).`);
      }
      return response.blob();
    })
    .catch((error) => {
      attachmentImageBlobCache.delete(source);
      throw error;
    });

  attachmentImageBlobCache.set(source, blobPromise);
  return blobPromise;
}

function resolveClipboardImageMimeType(
  blobType?: string | null,
  fallbackMimeType?: string | null,
): string | null {
  const candidate = blobType?.trim() || fallbackMimeType?.trim() || "";
  if (!candidate.toLowerCase().startsWith("image/")) {
    return null;
  }
  return candidate.toLowerCase() === "image/jpg" ? "image/jpeg" : candidate;
}
