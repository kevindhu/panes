import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { ipc } from "./codexIpc";
import { recordPerfMetric } from "./perfTelemetry";
import type { PreparedAttachmentImageAsset } from "../types";

const ASSET_CACHE_LIMIT = 256;
const FALLBACK_CACHE_LIMIT = 24;
const IMAGE_BLOB_CACHE_LIMIT = 64;
const EMBEDDED_IMAGE_CACHE_LIMIT = 64;
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_BLOB_SOURCE_CHARS = 8_192;

const attachmentAssetUrlCache = new Map<string, Promise<string | null>>();
const attachmentAssetUrlResolvedCache = new Map<string, string | null>();
const attachmentAssetUrlResolvedAt = new Map<string, number>();
const attachmentFallbackUrlCache = new Map<string, Promise<string | null>>();
const attachmentFallbackUrlResolvedCache = new Map<string, string | null>();
const attachmentFallbackUrlResolvedAt = new Map<string, number>();
const attachmentObjectUrls = new Set<string>();
const attachmentImageBlobCache = new Map<string, Promise<Blob>>();
const embeddedImageAssetCache = new Map<string, Promise<PreparedAttachmentImageAsset | null>>();

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
  expireImageCacheEntry(
    cacheKey,
    attachmentAssetUrlCache,
    attachmentAssetUrlResolvedCache,
    attachmentAssetUrlResolvedAt,
  );
  const cachedAsset = touchMapEntry(attachmentAssetUrlCache, cacheKey);
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
      attachmentAssetUrlResolvedAt.set(cacheKey, Date.now());
      trimImageUrlCache(
        attachmentAssetUrlCache,
        attachmentAssetUrlResolvedCache,
        attachmentAssetUrlResolvedAt,
        ASSET_CACHE_LIMIT,
      );
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
  trimMap(attachmentAssetUrlCache, ASSET_CACHE_LIMIT);
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
  const cacheKey = getAttachmentImageCacheKey(normalizedFilePath, mimeType, options);
  expireImageCacheEntry(
    cacheKey,
    attachmentAssetUrlCache,
    attachmentAssetUrlResolvedCache,
    attachmentAssetUrlResolvedAt,
  );
  return touchMapEntry(attachmentAssetUrlResolvedCache, cacheKey);
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
  expireImageCacheEntry(
    cacheKey,
    attachmentFallbackUrlCache,
    attachmentFallbackUrlResolvedCache,
    attachmentFallbackUrlResolvedAt,
  );
  const cachedFallback = touchMapEntry(attachmentFallbackUrlCache, cacheKey);
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
      attachmentFallbackUrlResolvedAt.set(cacheKey, Date.now());
      trimImageUrlCache(
        attachmentFallbackUrlCache,
        attachmentFallbackUrlResolvedCache,
        attachmentFallbackUrlResolvedAt,
        FALLBACK_CACHE_LIMIT,
        true,
      );
      return fallbackUrl;
    })
    .catch((error) => {
      attachmentFallbackUrlCache.delete(cacheKey);
      attachmentFallbackUrlResolvedCache.delete(cacheKey);
      throw error;
    });

  attachmentFallbackUrlCache.set(cacheKey, fallbackPromise);
  trimMap(attachmentFallbackUrlCache, FALLBACK_CACHE_LIMIT);
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
  const cacheKey = getAttachmentImageCacheKey(normalizedFilePath, mimeType);
  expireImageCacheEntry(
    cacheKey,
    attachmentFallbackUrlCache,
    attachmentFallbackUrlResolvedCache,
    attachmentFallbackUrlResolvedAt,
  );
  return touchMapEntry(attachmentFallbackUrlResolvedCache, cacheKey);
}

export function cacheEmbeddedImageDataUrl(
  source: string,
  mimeType?: string | null,
): Promise<PreparedAttachmentImageAsset | null> {
  const parsed = parseEmbeddedImageDataUrl(source, mimeType);
  if (!parsed || !isTauriEnvironment()) {
    return Promise.resolve(null);
  }
  const cacheKey = embeddedImageCacheKey(parsed.mimeType, parsed.dataBase64);
  const cached = touchMapEntry(embeddedImageAssetCache, cacheKey);
  if (cached) {
    return cached;
  }
  const request = ipc.cacheEmbeddedChatImage(parsed.mimeType, parsed.dataBase64)
    .catch((error) => {
      embeddedImageAssetCache.delete(cacheKey);
      throw error;
    });
  embeddedImageAssetCache.set(cacheKey, request);
  trimMap(embeddedImageAssetCache, EMBEDDED_IMAGE_CACHE_LIMIT);
  return request;
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
  attachmentAssetUrlResolvedAt.clear();
  attachmentFallbackUrlCache.clear();
  attachmentFallbackUrlResolvedCache.clear();
  attachmentFallbackUrlResolvedAt.clear();
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    for (const objectUrl of attachmentObjectUrls) {
      URL.revokeObjectURL(objectUrl);
    }
  }
  attachmentObjectUrls.clear();
  attachmentImageBlobCache.clear();
  embeddedImageAssetCache.clear();
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
  const shouldCache = source.length <= MAX_CACHED_BLOB_SOURCE_CHARS;
  const cachedBlob = shouldCache ? touchMapEntry(attachmentImageBlobCache, source) : undefined;
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
      if (shouldCache) {
        attachmentImageBlobCache.delete(source);
      }
      throw error;
    });

  if (shouldCache) {
    attachmentImageBlobCache.set(source, blobPromise);
    trimMap(attachmentImageBlobCache, IMAGE_BLOB_CACHE_LIMIT);
  }
  return blobPromise;
}

function parseEmbeddedImageDataUrl(
  source: string,
  fallbackMimeType?: string | null,
): { mimeType: string; dataBase64: string } | null {
  const match = source.trim().match(/^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }
  const mimeType = resolveClipboardImageMimeType(match[1], fallbackMimeType);
  const dataBase64 = match[2]?.replace(/\s+/g, "");
  return mimeType && dataBase64 ? { mimeType, dataBase64 } : null;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function embeddedImageCacheKey(mimeType: string, dataBase64: string): string {
  const edgeLength = 96;
  return [
    mimeType,
    dataBase64.length,
    hashString(dataBase64),
    dataBase64.slice(0, edgeLength),
    dataBase64.slice(-edgeLength),
  ].join("\u0000");
}

function touchMapEntry<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) {
    return undefined;
  }
  map.delete(key);
  map.set(key, value);
  return value;
}

function trimMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) {
      break;
    }
    map.delete(oldestKey);
  }
}

function expireImageCacheEntry(
  cacheKey: string,
  pending: Map<string, Promise<string | null>>,
  resolved: Map<string, string | null>,
  resolvedAt: Map<string, number>,
): void {
  const timestamp = resolvedAt.get(cacheKey);
  if (timestamp === undefined || Date.now() - timestamp <= IMAGE_CACHE_TTL_MS) {
    return;
  }
  const source = resolved.get(cacheKey);
  pending.delete(cacheKey);
  resolved.delete(cacheKey);
  resolvedAt.delete(cacheKey);
  if (source?.startsWith("blob:")) {
    revokeTrackedObjectUrl(source);
  }
}

function trimImageUrlCache(
  pending: Map<string, Promise<string | null>>,
  resolved: Map<string, string | null>,
  resolvedAt: Map<string, number>,
  maxEntries: number,
  revokeObjectUrls = false,
): void {
  while (resolved.size > maxEntries) {
    const oldestKey = resolved.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    const source = resolved.get(oldestKey);
    pending.delete(oldestKey);
    resolved.delete(oldestKey);
    resolvedAt.delete(oldestKey);
    if (revokeObjectUrls && source?.startsWith("blob:")) {
      revokeTrackedObjectUrl(source);
    }
  }
}

function revokeTrackedObjectUrl(source: string): void {
  if (
    attachmentObjectUrls.delete(source)
    && typeof URL !== "undefined"
    && typeof URL.revokeObjectURL === "function"
  ) {
    URL.revokeObjectURL(source);
  }
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
