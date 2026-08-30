import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { ipc } from "./codexIpc";
import { recordPerfMetric } from "./perfTelemetry";

const attachmentAssetUrlCache = new Map<string, Promise<string | null>>();
const attachmentAssetUrlResolvedCache = new Map<string, string | null>();
const attachmentFallbackUrlCache = new Map<string, Promise<string | null>>();
const attachmentFallbackUrlResolvedCache = new Map<string, string | null>();
const attachmentObjectUrls = new Set<string>();
const attachmentImageBlobCache = new Map<string, Promise<Blob>>();

export interface AttachmentImageAssetOptions {
  maxWidth?: number;
  maxHeight?: number;
}

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

export function loadAttachmentImageAssetUrl(
  filePath: string,
  mimeType?: string | null,
  options: AttachmentImageAssetOptions = {},
): Promise<string | null> {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath || !isTauriEnvironment()) {
    return Promise.resolve(null);
  }

  const cacheKey = getAttachmentImageCacheKey(normalizedFilePath, mimeType, options);
  const cachedAsset = attachmentAssetUrlCache.get(cacheKey);
  if (cachedAsset) {
    return cachedAsset;
  }

  const startedAt = performance.now();
  const assetPromise = ipc.prepareAttachmentImageAsset(
    normalizedFilePath,
    mimeType ?? null,
    options.maxWidth ?? null,
    options.maxHeight ?? null,
  )
    .then((asset) => {
      const baseUrl = convertFileSrc(asset.filePath);
      const separator = baseUrl.includes("?") ? "&" : "?";
      const assetUrl = `${baseUrl}${separator}v=${encodeURIComponent(asset.version)}`;
      attachmentAssetUrlResolvedCache.set(cacheKey, assetUrl);
      recordPerfMetric("chat.image.asset_prepare.ms", performance.now() - startedAt, {
        kind: options.maxWidth || options.maxHeight ? "thumbnail" : "full",
      });
      return assetUrl;
    })
    .catch((error) => {
      attachmentAssetUrlCache.delete(cacheKey);
      attachmentAssetUrlResolvedCache.delete(cacheKey);
      recordPerfMetric("chat.image.asset_prepare.ms", performance.now() - startedAt, {
        kind: options.maxWidth || options.maxHeight ? "thumbnail" : "full",
        failed: true,
      });
      throw error;
    });

  attachmentAssetUrlCache.set(cacheKey, assetPromise);
  return assetPromise;
}

export function getCachedAttachmentImageAssetUrl(
  filePath: string,
  mimeType?: string | null,
  options: AttachmentImageAssetOptions = {},
): string | null | undefined {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    return null;
  }
  return attachmentAssetUrlResolvedCache.get(
    getAttachmentImageCacheKey(normalizedFilePath, mimeType, options),
  );
}

export function loadAttachmentImageFallbackUrl(
  filePath: string,
  mimeType?: string | null,
): Promise<string | null> {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath || !isTauriEnvironment()) {
    return Promise.resolve(null);
  }

  const cacheKey = getAttachmentImageCacheKey(normalizedFilePath, mimeType);
  const cachedFallback = attachmentFallbackUrlCache.get(cacheKey);
  if (cachedFallback) {
    return cachedFallback;
  }

  const fallbackPromise = ipc.readAttachmentImageBytes(normalizedFilePath, mimeType ?? null)
    .then((rawBytes) => {
      const bytes = rawBytes instanceof ArrayBuffer
        ? new Uint8Array(rawBytes)
        : Uint8Array.from(rawBytes);
      if (bytes.byteLength === 0) {
        return null;
      }
      const resolvedMimeType = resolveAttachmentImageMimeType(normalizedFilePath, mimeType);
      if (!resolvedMimeType) {
        return null;
      }
      const fallbackUrl = createTrackedObjectUrl(new Blob([bytes], { type: resolvedMimeType }));
      attachmentFallbackUrlResolvedCache.set(cacheKey, fallbackUrl);
      return fallbackUrl;
    })
    .catch((error) => {
      attachmentFallbackUrlCache.delete(cacheKey);
      attachmentFallbackUrlResolvedCache.delete(cacheKey);
      throw error;
    });

  attachmentFallbackUrlCache.set(cacheKey, fallbackPromise);
  return fallbackPromise;
}

export function getCachedAttachmentImageFallbackUrl(
  filePath: string,
  mimeType?: string | null,
): string | null | undefined {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    return null;
  }
  return attachmentFallbackUrlResolvedCache.get(
    getAttachmentImageCacheKey(normalizedFilePath, mimeType),
  );
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

  if (normalizedFilePath && isTauriEnvironment()) {
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
  attachmentAssetUrlCache.clear();
  attachmentAssetUrlResolvedCache.clear();
  attachmentFallbackUrlCache.clear();
  attachmentFallbackUrlResolvedCache.clear();
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    for (const objectUrl of attachmentObjectUrls) {
      URL.revokeObjectURL(objectUrl);
    }
  }
  attachmentObjectUrls.clear();
  attachmentImageBlobCache.clear();
}

function createTrackedObjectUrl(blob: Blob): string | null {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  const objectUrl = URL.createObjectURL(blob);
  attachmentObjectUrls.add(objectUrl);
  return objectUrl;
}

function isTauriEnvironment(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
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

function getAttachmentImageCacheKey(
  filePath: string,
  mimeType?: string | null,
  options: AttachmentImageAssetOptions = {},
): string {
  const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
  return [
    filePath,
    normalizedMimeType,
    options.maxWidth ?? "",
    options.maxHeight ?? "",
  ].join("\u0000");
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
