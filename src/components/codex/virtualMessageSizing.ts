import type { ContentBlock, Message } from "../../types";

export const DEFAULT_TRANSCRIPT_WIDTH = 820;

const PROSE_LINE_HEIGHT = 23;
const MARKDOWN_IMAGE_HEIGHT = 340;
const MAX_CACHED_MESSAGE_HEIGHTS = 600;

interface CachedMessageHeight {
  height: number;
  message: Message;
  width: number;
}

const measuredMessageHeights = new Map<string, CachedMessageHeight>();
const messageSizeEstimateCache = new WeakMap<Message, Map<number, number>>();

export function normalizedTranscriptWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_TRANSCRIPT_WIDTH;
  return Math.min(
    DEFAULT_TRANSCRIPT_WIDTH,
    Math.round(Math.max(320, width) / 32) * 32,
  );
}

function imageReferenceCount(content: string): number {
  const markdownImages = content.match(
    /!?\[[^\]]*\]\(\s*(?:<[^>\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^>\n]*)?>|[^)\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^)\n]*)?(?:\s+["'][^"']*["'])?)\s*\)/gi,
  )?.length ?? 0;
  const htmlImages = content.match(/<img\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>/gi)?.length ?? 0;
  const dataImages = content.match(/data:image\/[a-z0-9.+-]+;base64,/gi)?.length ?? 0;
  const bareImageLines = content.split(/\r?\n/).filter((line) => (
    !line.includes("](") &&
    /(?:^|\s)(?:file:\/\/\/|[a-z]:[\\/]|\\\\|\/|\.{0,2}[\\/])[^<>\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#]\S*)?\s*$/i.test(line.trim())
  )).length;
  return Math.min(16, markdownImages + htmlImages + dataImages + bareImageLines);
}

function contentWithoutImageReferences(content: string): string {
  return content
    .replace(
      /!?\[[^\]]*\]\(\s*(?:<[^>\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^>\n]*)?>|[^)\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#][^)\n]*)?(?:\s+["'][^"']*["'])?)\s*\)/gi,
      "",
    )
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "")
    .split(/\r?\n/)
    .filter((line) => !/(?:file:\/\/\/|[a-z]:[\\/]|\\\\|\/|\.{0,2}[\\/])[^<>\n]*\.(?:bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#]\S*)?\s*$/i.test(line.trim()))
    .join("\n");
}

function estimatedMarkdownHeight(content: string, width: number): number {
  const images = imageReferenceCount(content);
  const text = contentWithoutImageReferences(content);
  const charsPerLine = Math.max(38, Math.floor((width - 36) / 7.4));
  let visualLines = 0;
  let fenced = false;
  let fenceCount = 0;

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (fenced) fenceCount += 1;
      continue;
    }
    if (fenced) {
      visualLines += 1;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      visualLines += 0.45;
      continue;
    }
    visualLines += Math.max(1, Math.ceil(trimmed.length / charsPerLine));
  }

  return Math.max(0, Math.ceil(visualLines * PROSE_LINE_HEIGHT))
    + fenceCount * 20
    + images * MARKDOWN_IMAGE_HEIGHT;
}

function estimatedBlockHeight(block: ContentBlock, width: number): number {
  switch (block.type) {
    case "text":
      return 12 + estimatedMarkdownHeight(block.content, width);
    case "code": {
      const lines = block.content.split(/\r?\n/).length;
      return 54 + Math.min(400, Math.max(20, lines * 20));
    }
    case "thinking":
      return 32 + imageReferenceCount(block.content) * MARKDOWN_IMAGE_HEIGHT;
    case "diff":
      return 32;
    case "action": {
      const imageCount = imageReferenceCount([
        block.summary,
        ...block.outputChunks.map((chunk) => chunk.content),
        block.result?.output ?? "",
      ].join("\n"));
      return 32 + imageCount * MARKDOWN_IMAGE_HEIGHT;
    }
    case "notice":
      return 58 + Math.min(72, (block.details?.length ?? 0) * 18);
    case "approval":
      return block.status === "pending" ? 180 : 54;
    case "attachment":
    case "skill":
    case "mention":
      return 38;
    case "steer":
      return 24 + estimatedMarkdownHeight(block.content, width);
    case "error":
      return 46 + Math.ceil(block.message.length / 90) * 18;
  }
}

export function estimateMessageHeight(message: Message, rawWidth = DEFAULT_TRANSCRIPT_WIDTH): number {
  const width = normalizedTranscriptWidth(rawWidth);
  const cachedByWidth = messageSizeEstimateCache.get(message);
  const cached = cachedByWidth?.get(width);
  if (cached) return cached;

  const blocks = message.blocks?.length
    ? message.blocks
    : message.content
      ? [{ type: "text" as const, content: message.content }]
      : [];
  const contentWidth = message.role === "user"
    ? Math.min(680, width * 0.78) - 28
    : width - 28;
  const blockHeight = blocks.reduce(
    (total, block) => total + estimatedBlockHeight(block, contentWidth),
    0,
  );
  const blockGaps = Math.max(0, blocks.length - 1) * 8;
  const rowChrome = message.role === "user" ? 46 : 58;
  const minimum = message.role === "user" ? 78 : 112;
  const estimate = Math.min(24_000, Math.max(minimum, Math.round(rowChrome + blockHeight + blockGaps)));
  const nextByWidth = cachedByWidth ?? new Map<number, number>();
  nextByWidth.set(width, estimate);
  if (!cachedByWidth) messageSizeEstimateCache.set(message, nextByWidth);
  return estimate;
}

export function cachedOrEstimatedMessageHeight(message: Message, rawWidth: number): number {
  const cached = measuredMessageHeights.get(message.id);
  const width = normalizedTranscriptWidth(rawWidth);
  if (
    cached &&
    cached.message === message &&
    Math.abs(cached.width - width) <= 32
  ) {
    measuredMessageHeights.delete(message.id);
    measuredMessageHeights.set(message.id, cached);
    return cached.height;
  }
  return estimateMessageHeight(message, width);
}

export function cacheMeasuredMessageHeight(
  message: Message,
  height: number,
  rawWidth: number,
): void {
  if (!Number.isFinite(height) || height <= 0) return;
  measuredMessageHeights.delete(message.id);
  measuredMessageHeights.set(message.id, {
    height,
    message,
    width: normalizedTranscriptWidth(rawWidth),
  });
  while (measuredMessageHeights.size > MAX_CACHED_MESSAGE_HEIGHTS) {
    const oldestKey = measuredMessageHeights.keys().next().value as string | undefined;
    if (!oldestKey) break;
    measuredMessageHeights.delete(oldestKey);
  }
}
