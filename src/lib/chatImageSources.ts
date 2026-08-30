import {
  hasSupportedLocalImageExtension,
  resolveLocalImagePath,
} from "./localImageSources";
import {
  guessAttachmentImageMimeType,
  isImageAttachmentMimeType,
} from "./attachmentImages";

export type ChatImageOrigin =
  | "attachment"
  | "markdown"
  | "image-view"
  | "generated"
  | "mcp"
  | "dynamic-tool"
  | "tool";

export interface ChatImageDescriptor {
  id: string;
  origin: ChatImageOrigin;
  fileName: string;
  alt: string;
  mimeType?: string;
  filePath?: string;
  sourceUrl?: string;
  caption?: string;
}

interface ChatImageDescriptorOptions {
  id?: string;
  origin: ChatImageOrigin;
  source?: string | null;
  fallbackSource?: string | null;
  filePath?: string | null;
  fileName?: string | null;
  alt?: string | null;
  caption?: string | null;
  mimeType?: string | null;
  workspaceRootPath?: string | null;
}

interface ExtractChatImagesOptions {
  itemType?: string | null;
  itemId?: string | null;
  title?: string | null;
  workspaceRootPath?: string | null;
  origin?: ChatImageOrigin;
}

const MAX_EXTRACTED_IMAGES = 32;
const MAX_CONTENT_DEPTH = 6;
const MAX_CONTENT_NODES = 512;
const MAX_STABLE_HASH_INPUT_CHARS = 8_192;
const BASE64_IMAGE_RE = /^[a-z0-9+/]+={0,2}$/i;
const MARKDOWN_IMAGE_DESTINATION_RE = /!\[[^\]]*\]\(\s*<?([^\s)>]+(?:\s+[^)>]+)?)>?\s*\)/i;

export function chatImageKey(image: ChatImageDescriptor): string {
  const identity = image.filePath?.trim() || image.sourceUrl?.trim() || image.id;
  return `${image.origin}:${stableHash(identity)}`;
}

export function createChatImageDescriptor({
  id,
  origin,
  source,
  fallbackSource,
  filePath,
  fileName,
  alt,
  caption,
  mimeType,
  workspaceRootPath,
}: ChatImageDescriptorOptions): ChatImageDescriptor | null {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const normalizedExplicitPath = normalizeExplicitLocalPath(filePath, workspaceRootPath);
  const primarySource = normalizeCandidateSource(source, normalizedMimeType, workspaceRootPath);
  const fallback = normalizeCandidateSource(fallbackSource, normalizedMimeType, workspaceRootPath);
  const resolvedPath = normalizedExplicitPath ?? primarySource.filePath ?? fallback.filePath;
  const resolvedUrl = primarySource.sourceUrl ?? fallback.sourceUrl;

  if (!resolvedPath && !resolvedUrl) {
    return null;
  }

  const resolvedMimeType = normalizedMimeType
    ?? guessAttachmentImageMimeType(resolvedPath ?? resolvedUrl ?? "")
    ?? mimeTypeFromDataUrl(resolvedUrl);
  const resolvedFileName = fileName?.trim()
    || fileNameFromSource(resolvedPath ?? resolvedUrl ?? "")
    || defaultImageFileName(origin, resolvedMimeType);
  const resolvedAlt = alt?.trim() || caption?.trim() || resolvedFileName;
  const identity = resolvedPath ?? resolvedUrl ?? resolvedFileName;

  return {
    id: id?.trim() || `${origin}-${stableHash(identity)}`,
    origin,
    fileName: resolvedFileName,
    alt: resolvedAlt,
    ...(resolvedMimeType ? { mimeType: resolvedMimeType } : {}),
    ...(resolvedPath ? { filePath: resolvedPath } : {}),
    ...(resolvedUrl ? { sourceUrl: resolvedUrl } : {}),
    ...(caption?.trim() ? { caption: caption.trim() } : {}),
  };
}

export function extractChatImagesFromPayload(
  payload: unknown,
  options: ExtractChatImagesOptions = {},
): ChatImageDescriptor[] {
  const record = asRecord(payload);
  if (!record) {
    return [];
  }

  const itemType = options.itemType?.trim() || readString(record, "type") || "";
  const itemId = options.itemId?.trim() || readString(record, "id") || itemType || "tool-image";
  const title = options.title?.trim() || imageTitleForPayload(record, itemType);
  const origin = options.origin ?? originForItemType(itemType);
  const images: ChatImageDescriptor[] = [];
  const seen = new Set<string>();
  const traversalBudget = { remaining: MAX_CONTENT_NODES };

  const add = (
    candidate: Omit<ChatImageDescriptorOptions, "origin" | "workspaceRootPath"> & {
      origin?: ChatImageOrigin;
    },
  ) => {
    if (images.length >= MAX_EXTRACTED_IMAGES) {
      return;
    }
    const descriptor = createChatImageDescriptor({
      ...candidate,
      origin: candidate.origin ?? origin,
      workspaceRootPath: options.workspaceRootPath,
    });
    if (!descriptor) {
      return;
    }
    const identity = descriptor.filePath?.trim().toLowerCase()
      || descriptor.sourceUrl?.trim()
      || descriptor.id;
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    images.push(descriptor);
  };

  if (itemType === "imageView") {
    add({
      id: `${itemId}:view`,
      source: readString(record, "path"),
      fileName: fileNameFromSource(readString(record, "path") ?? ""),
      alt: title,
      caption: title,
      origin: "image-view",
    });
    return images;
  }

  if (itemType === "imageGeneration") {
    const result = readString(record, "result");
    add({
      id: `${itemId}:generated`,
      filePath: readString(record, "savedPath", "saved_path"),
      source: extractImageSourceFromResult(result),
      fileName: fileNameFromSource(readString(record, "savedPath", "saved_path") ?? ""),
      mimeType: readString(record, "mimeType", "mime_type"),
      alt: readString(record, "revisedPrompt", "revised_prompt") || title,
      caption: readString(record, "revisedPrompt", "revised_prompt") || title,
      origin: "generated",
    });
    return images;
  }

  if (itemType === "dynamicToolCall") {
    collectImageContent(record.contentItems, {
      add,
      baseId: itemId,
      defaultAlt: title,
      origin: "dynamic-tool",
      depth: 0,
      budget: traversalBudget,
    });
    return images;
  }

  if (itemType === "mcpToolCall") {
    collectImageContent(record.result, {
      add,
      baseId: itemId,
      defaultAlt: title,
      origin: "mcp",
      depth: 0,
      budget: traversalBudget,
    });
    return images;
  }

  // Legacy action blocks keep the authoritative app-server item in `details`.
  // When its type was omitted, inspect only the protocol fields that can carry
  // media rather than recursively treating arbitrary strings as images.
  collectImageContent(record.contentItems, {
    add,
    baseId: itemId,
    defaultAlt: title,
    origin,
    depth: 0,
    budget: traversalBudget,
  });
  collectImageContent(record.result, {
    add,
    baseId: itemId,
    defaultAlt: title,
    origin,
    depth: 0,
    budget: traversalBudget,
  });
  collectImageContent(record.content, {
    add,
    baseId: itemId,
    defaultAlt: title,
    origin,
    depth: 0,
    budget: traversalBudget,
  });

  return images;
}

export function isLikelyInlineImagePayload(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("data:image/")
    || (normalized.length >= 256 && normalizeRawBase64(normalized) !== null);
}

export function redactChatImagePayload(value: unknown, depth = 0): unknown {
  if (depth > 10) {
    return "[nested value omitted]";
  }
  if (typeof value === "string") {
    return isLikelyInlineImagePayload(value)
      ? `[embedded image data omitted: ${value.length.toLocaleString()} characters]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactChatImagePayload(item, depth + 1));
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, redactChatImagePayload(child, depth + 1)]),
  );
}

function collectImageContent(
  value: unknown,
  context: {
    add: (
      candidate: Omit<ChatImageDescriptorOptions, "origin" | "workspaceRootPath"> & {
        origin?: ChatImageOrigin;
      },
    ) => void;
    baseId: string;
    defaultAlt: string;
    origin: ChatImageOrigin;
    depth: number;
    budget: { remaining: number };
  },
): void {
  if (
    value === null
    || value === undefined
    || context.depth > MAX_CONTENT_DEPTH
    || context.budget.remaining <= 0
  ) {
    return;
  }
  context.budget.remaining -= 1;

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && context.budget.remaining > 0; index += 1) {
      collectImageContent(value[index], {
        ...context,
        baseId: `${context.baseId}:${index}`,
        depth: context.depth + 1,
      });
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const type = readString(record, "type")?.toLowerCase() ?? "";
  const mimeType = readString(record, "mimeType", "mime_type", "mediaType", "media_type");
  const explicitImageMime = isImageAttachmentMimeType(mimeType);
  const name = readString(record, "name", "fileName", "filename");
  const alt = readString(record, "alt", "description", "title") || context.defaultAlt;
  const directImageType = new Set([
    "image",
    "inputimage",
    "outputimage",
    "output_image",
    "image_url",
    "imageurl",
  ]).has(type);

  if (directImageType || explicitImageMime) {
    const nestedImageUrl = asRecord(record.image_url);
    const source = readString(record, "imageUrl", "image_url", "url", "uri")
      || readString(nestedImageUrl, "url")
      || dataUrlFromBase64(
        readString(record, "data", "blob", "base64", "b64_json"),
        mimeType,
      );
    context.add({
      id: context.baseId,
      source,
      fileName: name,
      mimeType,
      alt,
      caption: alt,
      origin: context.origin,
    });
  }

  if (type === "resource" || type === "embeddedresource" || type === "embedded_resource") {
    const resource = asRecord(record.resource);
    if (resource) {
      const resourceMime = readString(resource, "mimeType", "mime_type", "mediaType", "media_type");
      const resourceUri = readString(resource, "uri", "url");
      if (isImageAttachmentMimeType(resourceMime) || hasSupportedLocalImageExtension(resourceUri ?? "")) {
        context.add({
          id: `${context.baseId}:resource`,
          source: dataUrlFromBase64(readString(resource, "blob", "data", "base64"), resourceMime)
            || resourceUri,
          fileName: readString(resource, "name") || name,
          mimeType: resourceMime,
          alt,
          caption: alt,
          origin: context.origin,
        });
      }
    }
  }

  if (type === "resource_link" || type === "resourcelink") {
    const uri = readString(record, "uri", "url");
    if (isImageAttachmentMimeType(mimeType) || hasSupportedLocalImageExtension(uri ?? "")) {
      context.add({
        id: `${context.baseId}:resource-link`,
        source: uri,
        fileName: name,
        mimeType,
        alt,
        caption: alt,
        origin: context.origin,
      });
    }
  }

  for (const key of ["content", "contentItems", "items", "images", "image", "output", "structuredContent"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      collectImageContent(record[key], {
        ...context,
        baseId: `${context.baseId}:${key}`,
        depth: context.depth + 1,
      });
    }
  }
}

function normalizeCandidateSource(
  value: string | null | undefined,
  mimeType: string | undefined,
  workspaceRootPath?: string | null,
): { filePath?: string; sourceUrl?: string } {
  const normalized = value?.trim();
  if (!normalized) {
    return {};
  }

  const localPath = resolveLocalImagePath(normalized, workspaceRootPath);
  if (localPath) {
    return { filePath: localPath };
  }

  const safeUrl = normalizeSafeImageUrl(normalized);
  if (safeUrl) {
    return { sourceUrl: safeUrl };
  }

  const base64 = normalizeRawBase64(normalized);
  if (base64) {
    return {
      sourceUrl: `data:${mimeType ?? inferBase64ImageMimeType(base64) ?? "image/png"};base64,${base64}`,
    };
  }

  return {};
}

function normalizeExplicitLocalPath(
  value?: string | null,
  workspaceRootPath?: string | null,
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return resolveLocalImagePath(normalized, workspaceRootPath)
    ?? (hasSupportedLocalImageExtension(normalized) ? normalized : undefined);
}

function normalizeSafeImageUrl(value: string): string | null {
  const lower = value.toLowerCase();
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (
    lower.startsWith("https://")
    || lower.startsWith("http://")
    || lower.startsWith("blob:")
    || lower.startsWith("asset:")
  ) {
    return value;
  }
  if (/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,/i.test(value)) {
    return value;
  }
  return null;
}

function normalizeRawBase64(value: string): string | null {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 32 || compact.length % 4 !== 0 || !BASE64_IMAGE_RE.test(compact)) {
    return null;
  }
  return compact;
}

function dataUrlFromBase64(value?: string | null, mimeType?: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  const safeUrl = normalizeSafeImageUrl(normalized);
  if (safeUrl?.startsWith("data:image/")) {
    return safeUrl;
  }
  const base64 = normalizeRawBase64(normalized);
  if (!base64) {
    return null;
  }
  return `data:${normalizeImageMimeType(mimeType) ?? inferBase64ImageMimeType(base64) ?? "image/png"};base64,${base64}`;
}

function inferBase64ImageMimeType(base64: string): string | undefined {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("R0lGOD")) return "image/gif";
  if (base64.startsWith("UklGR")) return "image/webp";
  if (base64.startsWith("Qk")) return "image/bmp";
  if (base64.startsWith("SUkq") || base64.startsWith("TU0AK")) return "image/tiff";
  if (base64.startsWith("PHN2Zy") || base64.startsWith("PD94bW")) return "image/svg+xml";
  return undefined;
}

function extractImageSourceFromResult(result?: string | null): string | null {
  const normalized = result?.trim();
  if (!normalized) {
    return null;
  }
  const markdownMatch = normalized.match(MARKDOWN_IMAGE_DESTINATION_RE)?.[1]?.trim();
  return markdownMatch || normalized;
}

function normalizeImageMimeType(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized?.startsWith("image/")) {
    return undefined;
  }
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function mimeTypeFromDataUrl(value?: string | null): string | undefined {
  return normalizeImageMimeType(value?.match(/^data:([^;,]+)/i)?.[1]);
}

function fileNameFromSource(value: string): string {
  const withoutSuffix = value.split(/[?#]/, 1)[0] ?? value;
  const normalized = withoutSuffix.replace(/\\/g, "/").replace(/\/+$/g, "");
  const candidate = normalized.split("/").filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function defaultImageFileName(origin: ChatImageOrigin, mimeType?: string): string {
  const extension = mimeType === "image/jpeg"
    ? "jpg"
    : mimeType?.split("/")[1]?.replace("svg+xml", "svg") || "png";
  return `${origin === "generated" ? "generated-image" : "image"}.${extension}`;
}

function imageTitleForPayload(record: Record<string, unknown>, itemType: string): string {
  if (itemType === "imageView") {
    return `Viewed ${fileNameFromSource(readString(record, "path") ?? "image")}`;
  }
  if (itemType === "imageGeneration") {
    return readString(record, "revisedPrompt", "revised_prompt") || "Generated image";
  }
  return readString(record, "tool", "name", "title") || "Tool image";
}

function originForItemType(itemType: string): ChatImageOrigin {
  switch (itemType) {
    case "imageView":
      return "image-view";
    case "imageGeneration":
      return "generated";
    case "mcpToolCall":
      return "mcp";
    case "dynamicToolCall":
      return "dynamic-tool";
    default:
      return "tool";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function stableHash(value: string): string {
  const input = value.length <= MAX_STABLE_HASH_INPUT_CHARS
    ? value
    : `${value.length}\u0000${value.slice(0, MAX_STABLE_HASH_INPUT_CHARS / 2)}\u0000${value.slice(-(MAX_STABLE_HASH_INPUT_CHARS / 2))}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
