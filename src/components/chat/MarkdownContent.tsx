import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  getCachedAttachmentImageAssetUrl,
  getCachedAttachmentImageFallbackUrl,
  loadAttachmentImageAssetUrl,
  loadAttachmentImageFallbackUrl,
} from "../../lib/attachmentImages";
import { recordPerfMetric } from "../../lib/perfTelemetry";
import {
  classifyLinkTarget,
  getWorkspacePaneLeafIdFromEventTarget,
  navigateLinkTarget,
} from "../../lib/fileLinkNavigation";
import {
  MARKDOWN_LOCAL_IMAGE_MIME_ATTR,
  MARKDOWN_LOCAL_IMAGE_PATH_ATTR,
  rewriteMarkdownImageSources,
} from "../../lib/markdownImageSources";
import { renderMarkdownToHtml } from "../../workers/markdownParserCore";
import type {
  MarkdownParseWorkerRequest,
  MarkdownParseWorkerResponse,
} from "../../workers/markdownParser.types";
import { ImageAttachmentViewer } from "./ImageAttachmentViewer";

const MARKDOWN_WORKER_THRESHOLD_CHARS = 1000;
const STREAMING_MARKDOWN_INLINE_LIMIT_CHARS = 6000;
const MARKDOWN_CACHE_LIMIT = 280;
const MARKDOWN_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const MARKDOWN_LOCAL_IMAGE_THUMBNAIL_MAX_WIDTH = 720;
const MARKDOWN_LOCAL_IMAGE_THUMBNAIL_MAX_HEIGHT = 440;
const MARKDOWN_LOCAL_IMAGE_INLINE_MAX_WIDTH = 360;
const MARKDOWN_LOCAL_IMAGE_INLINE_MAX_HEIGHT = 220;

const markdownHtmlCache = new Map<string, string>();
const markdownLocalImageFrameCache = new Map<string, MarkdownLocalImageFrame>();
let markdownHtmlCacheBytes = 0;
let markdownWorkerInstance: Worker | null = null;
let markdownWorkerRequestSeq = 0;
const markdownWorkerCallbacks = new Map<
  number,
  {
    resolve: (value: string) => void;
    reject: (reason?: unknown) => void;
  }
>();

function computeCacheKey(content: string): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function readCachedMarkdownHtml(cacheKey: string): string | null {
  const html = markdownHtmlCache.get(cacheKey);
  if (html === undefined) {
    return null;
  }

  markdownHtmlCache.delete(cacheKey);
  markdownHtmlCache.set(cacheKey, html);
  return html;
}

function peekCachedMarkdownHtml(cacheKey: string): string | null {
  return markdownHtmlCache.get(cacheKey) ?? null;
}

function writeCachedMarkdownHtml(cacheKey: string, html: string) {
  const nextEntryBytes = estimateCacheEntryBytes(cacheKey, html);
  const existing = markdownHtmlCache.get(cacheKey);
  if (markdownHtmlCache.has(cacheKey)) {
    if (existing !== undefined) {
      markdownHtmlCacheBytes -= estimateCacheEntryBytes(cacheKey, existing);
    }
    markdownHtmlCache.delete(cacheKey);
  }
  markdownHtmlCache.set(cacheKey, html);
  markdownHtmlCacheBytes += nextEntryBytes;
  while (
    markdownHtmlCache.size > MARKDOWN_CACHE_LIMIT ||
    markdownHtmlCacheBytes > MARKDOWN_CACHE_MAX_BYTES
  ) {
    const oldestKey = markdownHtmlCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const oldestHtml = markdownHtmlCache.get(oldestKey);
    if (oldestHtml !== undefined) {
      markdownHtmlCacheBytes -= estimateCacheEntryBytes(oldestKey, oldestHtml);
    }
    markdownHtmlCache.delete(oldestKey);
  }

  if (markdownHtmlCacheBytes < 0) {
    markdownHtmlCacheBytes = 0;
  }
}

function estimateCacheEntryBytes(cacheKey: string, html: string): number {
  return (cacheKey.length + html.length) * 2;
}

function ensureMarkdownWorker(): Worker | null {
  if (typeof Worker === "undefined") {
    return null;
  }
  if (!markdownWorkerInstance) {
    markdownWorkerInstance = new Worker(
      new URL("../../workers/markdownParser.worker.ts", import.meta.url),
      { type: "module" },
    );
    markdownWorkerInstance.onmessage = (
      event: MessageEvent<MarkdownParseWorkerResponse>,
    ) => {
      const payload = event.data;
      const callback = markdownWorkerCallbacks.get(payload.id);
      if (!callback) {
        return;
      }
      markdownWorkerCallbacks.delete(payload.id);
      if (payload.ok) {
        callback.resolve(payload.html);
      } else {
        callback.reject(new Error(payload.error));
      }
    };
    markdownWorkerInstance.onerror = (error) => {
      for (const callback of markdownWorkerCallbacks.values()) {
        callback.reject(error);
      }
      markdownWorkerCallbacks.clear();
      markdownWorkerInstance?.terminate();
      markdownWorkerInstance = null;
    };
  }
  return markdownWorkerInstance;
}

function parseMarkdownInWorker(markdown: string): Promise<string> {
  const worker = ensureMarkdownWorker();
  if (!worker) {
    return Promise.reject(new Error("worker-unavailable"));
  }

  return new Promise((resolve, reject) => {
    markdownWorkerRequestSeq += 1;
    const requestId = markdownWorkerRequestSeq;
    markdownWorkerCallbacks.set(requestId, { resolve, reject });
    const payload: MarkdownParseWorkerRequest = {
      id: requestId,
      markdown,
    };
    worker.postMessage(payload);
  });
}

interface MarkdownContentProps {
  content: string;
  className?: string;
  style?: CSSProperties;
  streaming?: boolean;
  workspaceRootPath?: string | null;
}

interface MarkdownWorkerPlaceholderOptions {
  hasStreamed: boolean;
  streaming: boolean;
  workerEligible: boolean;
  workerError: boolean;
  workerHtml: string | null;
}

function getEventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }

  if (target instanceof Node) {
    return target.parentElement;
  }

  return null;
}

export function shouldRenderMarkdownWorkerPlaceholder({
  hasStreamed,
  streaming,
  workerEligible,
  workerError,
  workerHtml,
}: MarkdownWorkerPlaceholderOptions): boolean {
  return (
    workerEligible &&
    !streaming &&
    !hasStreamed &&
    !workerError &&
    workerHtml === null
  );
}

function handleMarkdownLinkClick(event: ReactMouseEvent<HTMLDivElement>): void {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }

  const element = getEventElement(event.target);
  if (!element) {
    return;
  }

  const anchor = element.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }

  const rawHref = anchor.getAttribute("href");
  if (!rawHref) {
    return;
  }

  const selection = globalThis.getSelection?.();
  if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
    event.preventDefault();
    return;
  }

  const targetKind = classifyLinkTarget(rawHref);
  if (targetKind === "other") {
    return;
  }

  event.preventDefault();
  if (targetKind === "local") {
    event.stopPropagation();
  }
  void navigateLinkTarget(rawHref, {
    shiftKey: event.shiftKey,
    sourceLeafId: getWorkspacePaneLeafIdFromEventTarget(event.currentTarget),
  });
}

function getFileNameFromPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return normalizedPath.split("/").filter(Boolean).pop() ?? "image";
}

interface MarkdownLocalImageProps {
  filePath: string;
  mimeType?: string;
  alt?: string;
}

interface MarkdownLocalImageFrame {
  width: number;
  height: number;
  aspectRatio: string;
}

function getThumbnailPreviewOptions() {
  return {
    maxWidth: MARKDOWN_LOCAL_IMAGE_THUMBNAIL_MAX_WIDTH,
    maxHeight: MARKDOWN_LOCAL_IMAGE_THUMBNAIL_MAX_HEIGHT,
  };
}

function getMarkdownLocalImageFrameCacheKey(filePath: string, mimeType?: string): string {
  return `${filePath}\u0000${mimeType ?? ""}`;
}

function fitMarkdownLocalImageFrame(naturalWidth: number, naturalHeight: number): MarkdownLocalImageFrame | null {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }

  const aspect = naturalWidth / naturalHeight;
  let width = MARKDOWN_LOCAL_IMAGE_INLINE_MAX_WIDTH;
  let height = width / aspect;

  if (height > MARKDOWN_LOCAL_IMAGE_INLINE_MAX_HEIGHT) {
    height = MARKDOWN_LOCAL_IMAGE_INLINE_MAX_HEIGHT;
    width = height * aspect;
  }

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    aspectRatio: `${naturalWidth} / ${naturalHeight}`,
  };
}

function MarkdownLocalImage({ filePath, mimeType, alt }: MarkdownLocalImageProps) {
  const fileName = getFileNameFromPath(filePath);
  const thumbnailOptions = getThumbnailPreviewOptions();
  const frameCacheKey = getMarkdownLocalImageFrameCacheKey(filePath, mimeType);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() => (
    getCachedAttachmentImageAssetUrl(filePath, mimeType, thumbnailOptions)
      ?? getCachedAttachmentImageFallbackUrl(filePath, mimeType)
      ?? null
  ));
  const [fullSrc, setFullSrc] = useState<string | null>(() => (
    getCachedAttachmentImageAssetUrl(filePath, mimeType) ?? null
  ));
  const [thumbnailFrame, setThumbnailFrame] = useState<MarkdownLocalImageFrame | null>(() => (
    markdownLocalImageFrameCache.get(frameCacheKey) ?? null
  ));
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    setThumbnailFailed(false);
    setThumbnailFrame(markdownLocalImageFrameCache.get(frameCacheKey) ?? null);

    const cachedThumbnail = getCachedAttachmentImageAssetUrl(filePath, mimeType, thumbnailOptions);
    if (cachedThumbnail !== undefined) {
      setThumbnailSrc(cachedThumbnail);
      setThumbnailFailed(!cachedThumbnail);
      return () => {
        disposed = true;
      };
    }

    setThumbnailSrc(null);
    void loadAttachmentImageAssetUrl(filePath, mimeType, thumbnailOptions)
      .then((nextThumbnailSrc) => {
        if (disposed) {
          return;
        }
        setThumbnailSrc(nextThumbnailSrc);
        setThumbnailFailed(!nextThumbnailSrc);
      })
      .catch(() => {
        if (!disposed) {
          setThumbnailSrc(null);
          const cachedFallback = getCachedAttachmentImageFallbackUrl(filePath, mimeType);
          if (cachedFallback) {
            setThumbnailSrc(cachedFallback);
            setFullSrc(null);
            return;
          }
          void loadAttachmentImageFallbackUrl(filePath, mimeType)
            .then((fallbackSrc) => {
              if (!disposed) {
                setThumbnailSrc(fallbackSrc);
                setFullSrc(null);
                setThumbnailFailed(!fallbackSrc);
              }
            })
            .catch(() => {
              if (!disposed) {
                setThumbnailFailed(true);
              }
            });
        }
      });

    return () => {
      disposed = true;
    };
  }, [filePath, frameCacheKey, mimeType]);

  useEffect(() => {
    let disposed = false;
    const cachedFullSrc = getCachedAttachmentImageAssetUrl(filePath, mimeType);
    setFullSrc(cachedFullSrc ?? null);
    if (cachedFullSrc === undefined) {
      void loadAttachmentImageAssetUrl(filePath, mimeType)
        .then((nextFullSrc) => {
          if (!disposed) {
            setFullSrc(nextFullSrc);
          }
        })
        .catch(() => {
          if (!disposed) {
            setFullSrc(null);
          }
        });
    }
    return () => {
      disposed = true;
    };
  }, [filePath, mimeType]);

  const requestViewerFallback = useCallback(async (): Promise<string | null> => {
    const cachedFallback = getCachedAttachmentImageFallbackUrl(filePath, mimeType);
    if (cachedFallback !== undefined) {
      if (cachedFallback) {
        setThumbnailSrc(cachedFallback);
        setFullSrc(null);
      }
      return cachedFallback;
    }
    const fallbackSrc = await loadAttachmentImageFallbackUrl(filePath, mimeType);
    if (fallbackSrc) {
      setThumbnailSrc(fallbackSrc);
      setFullSrc(null);
    }
    return fallbackSrc;
  }, [filePath, mimeType]);

  function openViewer() {
    setViewerOpen(true);
  }

  function handleThumbnailError() {
    setFullSrc(null);
    void requestViewerFallback()
      .then((fallbackSrc) => setThumbnailFailed(!fallbackSrc))
      .catch(() => setThumbnailFailed(true));
  }

  function handleThumbnailLoad(event: SyntheticEvent<HTMLImageElement>) {
    const nextFrame = fitMarkdownLocalImageFrame(
      event.currentTarget.naturalWidth,
      event.currentTarget.naturalHeight,
    );
    if (!nextFrame) {
      return;
    }

    markdownLocalImageFrameCache.set(frameCacheKey, nextFrame);
    setThumbnailFrame(nextFrame);
  }

  const thumbnailFrameStyle = thumbnailFrame
    ? ({
        "--markdown-local-image-frame-width": `${thumbnailFrame.width}px`,
        "--markdown-local-image-frame-height": "auto",
        "--markdown-local-image-aspect": thumbnailFrame.aspectRatio,
      } as CSSProperties)
    : undefined;

  return (
    <>
      <button
        type="button"
        className="markdown-local-image-button"
        style={thumbnailFrameStyle}
        data-panes-markdown-local-image-path={filePath}
        data-panes-markdown-local-image-mime={mimeType}
        aria-label="Open image"
        onClick={openViewer}
      >
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={alt ?? fileName}
            className="markdown-local-image-thumbnail"
            draggable={false}
            decoding="async"
            onLoad={handleThumbnailLoad}
            onError={handleThumbnailError}
          />
        ) : (
          <span className="markdown-local-image-placeholder">
            {thumbnailFailed ? "Image unavailable" : "Loading image"}
          </span>
        )}
      </button>
      {viewerOpen && (
        <ImageAttachmentViewer
          open
          filePath={filePath}
          fileName={fileName}
          mimeType={mimeType}
          originalSrc={fullSrc}
          previewSrc={thumbnailSrc}
          requestPreview={requestViewerFallback}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

function isVoidElement(tagName: string): boolean {
  return tagName === "br" || tagName === "hr" || tagName === "img";
}

function getReactAttributeName(attributeName: string): string {
  switch (attributeName) {
    case "class":
      return "className";
    case "for":
      return "htmlFor";
    case "tabindex":
      return "tabIndex";
    case "colspan":
      return "colSpan";
    case "rowspan":
      return "rowSpan";
    default:
      return attributeName;
  }
}

function getReactAttributeValue(attributeName: string, value: string): string | number {
  if (attributeName === "tabindex" || attributeName === "colspan" || attributeName === "rowspan") {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : value;
  }

  return value;
}

function convertHtmlNodeToReact(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent;
  }

  if (!(node instanceof Element)) {
    return null;
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === "img") {
    const filePath = node.getAttribute(MARKDOWN_LOCAL_IMAGE_PATH_ATTR)?.trim();
    if (filePath) {
      return (
        <MarkdownLocalImage
          key={key}
          filePath={filePath}
          mimeType={node.getAttribute(MARKDOWN_LOCAL_IMAGE_MIME_ATTR)?.trim() || undefined}
          alt={node.getAttribute("alt")?.trim() || undefined}
        />
      );
    }
  }

  const props: Record<string, unknown> = { key };
  for (const attribute of Array.from(node.attributes)) {
    if (attribute.name === "style") {
      continue;
    }
    const reactName = getReactAttributeName(attribute.name);
    props[reactName] = getReactAttributeValue(attribute.name, attribute.value);
  }

  if (isVoidElement(tagName)) {
    return createElement(tagName, props);
  }

  const children = Array.from(node.childNodes).map((childNode, childIndex) =>
    convertHtmlNodeToReact(childNode, `${key}.${childIndex}`),
  );
  return createElement(tagName, props, ...children);
}

function renderMarkdownHtmlAsReact(html: string): ReactNode[] | null {
  if (typeof document === "undefined") {
    return null;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  if (!template.content.querySelector(`img[${MARKDOWN_LOCAL_IMAGE_PATH_ATTR}]`)) {
    return null;
  }

  return Array.from(template.content.childNodes).map((node, index) =>
    convertHtmlNodeToReact(node, `${index}`),
  );
}

export default function MarkdownContent({
  content,
  className,
  style,
  streaming = false,
  workspaceRootPath,
}: MarkdownContentProps) {
  const [workerHtml, setWorkerHtml] = useState<string | null>(null);
  const [workerError, setWorkerError] = useState(false);
  const parseStartedAtRef = useRef(0);
  const hasStreamedRef = useRef(streaming);

  const workerEligible = content.length >= MARKDOWN_WORKER_THRESHOLD_CHARS;
  const deferStreamingMarkdown =
    streaming && content.length >= STREAMING_MARKDOWN_INLINE_LIMIT_CHARS;
  const cacheKey = useMemo(() => computeCacheKey(content), [content]);
  const hasStreamed = hasStreamedRef.current || streaming;
  const cachedHtml = useMemo(() => peekCachedMarkdownHtml(cacheKey), [cacheKey]);
  const showWorkerPlaceholder = shouldRenderMarkdownWorkerPlaceholder({
    hasStreamed,
    streaming,
    workerEligible,
    workerError,
    workerHtml,
  }) && cachedHtml === null;

  const immediateHtml = useMemo(() => {
    if (cachedHtml !== null) {
      return cachedHtml;
    }
    if (deferStreamingMarkdown) {
      return null;
    }
    if (showWorkerPlaceholder) {
      return null;
    }
    return renderMarkdownToHtml(content);
  }, [cachedHtml, content, deferStreamingMarkdown, showWorkerPlaceholder]);

  useEffect(() => {
    if (!streaming) {
      return;
    }
    hasStreamedRef.current = true;
  }, [streaming]);

  useEffect(() => {
    if (immediateHtml === null) {
      return;
    }
    writeCachedMarkdownHtml(cacheKey, immediateHtml);
  }, [cacheKey, immediateHtml]);

  useEffect(() => {
    if (!workerEligible || streaming || hasStreamed) {
      setWorkerHtml(null);
      setWorkerError(false);
      return;
    }

    const cached = readCachedMarkdownHtml(cacheKey);
    if (cached !== null) {
      setWorkerHtml(cached);
      setWorkerError(false);
      return;
    }

    let disposed = false;
    setWorkerHtml(null);
    setWorkerError(false);
    parseStartedAtRef.current = performance.now();

    parseMarkdownInWorker(content)
      .then((html) => {
        if (disposed) {
          return;
        }
        writeCachedMarkdownHtml(cacheKey, html);
        setWorkerHtml(html);
        recordPerfMetric("chat.markdown.worker.ms", performance.now() - parseStartedAtRef.current, {
          chars: content.length,
          cached: false,
        });
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setWorkerError(true);
      });

    return () => {
      disposed = true;
    };
  }, [cacheKey, content, hasStreamed, streaming, workerEligible]);

  const html = workerEligible && !streaming && !hasStreamed && workerHtml !== null
    ? workerHtml
    : immediateHtml;
  const renderedHtml = useMemo(
    () => (html === null ? null : rewriteMarkdownImageSources(html, workspaceRootPath)),
    [html, workspaceRootPath],
  );
  const renderedReactNodes = useMemo(
    () => (renderedHtml === null ? null : renderMarkdownHtmlAsReact(renderedHtml)),
    [renderedHtml],
  );

  if (showWorkerPlaceholder) {
    return (
      <div className={className} style={style}>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
          }}
        >
          {content}
        </pre>
      </div>
    );
  }

  if (renderedHtml === null) {
    return (
      <div className={className} style={style}>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
          }}
        >
          {content}
        </pre>
      </div>
    );
  }

  if (renderedReactNodes !== null) {
    return (
      <div
        className={className}
        style={style}
        onClickCapture={handleMarkdownLinkClick}
      >
        {renderedReactNodes}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={style}
      onClickCapture={handleMarkdownLinkClick}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
