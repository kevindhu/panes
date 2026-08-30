import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Check, Copy } from "lucide-react";
import { createChatImageDescriptor } from "../../lib/chatImageSources";
import { recordPerfMetric } from "../../lib/perfTelemetry";
import {
  classifyLinkTarget,
  getWorkspacePaneLeafIdFromEventTarget,
  navigateLinkTarget,
} from "../../lib/fileLinkNavigation";
import {
  recordTranscriptLinkPointerDown,
  transcriptLinkShouldNavigate,
} from "../../lib/transcriptSelection";
import {
  MARKDOWN_CHAT_IMAGE_SOURCE_ATTR,
  MARKDOWN_LOCAL_IMAGE_MIME_ATTR,
  MARKDOWN_LOCAL_IMAGE_PATH_ATTR,
  rewriteMarkdownImageSources,
} from "../../lib/markdownImageSources";
import { renderMarkdownToHtml } from "../../workers/markdownParserCore";
import type {
  MarkdownParseWorkerRequest,
  MarkdownParseWorkerResponse,
} from "../../workers/markdownParser.types";
import { ChatImagePreview } from "./ChatImage";

const MARKDOWN_WORKER_THRESHOLD_CHARS = 1000;
const STREAMING_MARKDOWN_INLINE_LIMIT_CHARS = 6000;
const MARKDOWN_CACHE_LIMIT = 280;
const MARKDOWN_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const markdownHtmlCache = new Map<string, string>();
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
  selectionScopeId?: string;
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

function getLinkAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const element = getEventElement(target);
  const anchor = element?.closest("a");
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}

function handleMarkdownLinkClick(event: ReactMouseEvent<HTMLDivElement>): void {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }

  const anchor = getLinkAnchor(event.target);
  if (!anchor) {
    return;
  }

  const rawHref = anchor.getAttribute("href");
  if (!rawHref) {
    return;
  }

  if (!transcriptLinkShouldNavigate(event, anchor)) {
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

function handleMarkdownLinkMouseDown(event: ReactMouseEvent<HTMLDivElement>): void {
  const anchor = getLinkAnchor(event.target);
  if (anchor) recordTranscriptLinkPointerDown(event, anchor);
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

interface MarkdownCodeBlockProps {
  content: string;
  preProps: Record<string, unknown>;
  children: ReactNode[];
}

function MarkdownCodeBlock({ content, preProps, children }: MarkdownCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
    }
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1500);
    } catch {
      setCopied(false);
    }
  }, [content]);

  const copyLabel = copied ? "Code copied" : "Copy code";

  return (
    <div className="markdown-code-block">
      {createElement("pre", preProps, ...children)}
      <button
        type="button"
        className={`markdown-code-copy${copied ? " copied" : ""}`}
        onClick={() => void handleCopy()}
        aria-label={copyLabel}
        title={copyLabel}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

interface StableStreamingTextState {
  content: string;
  chunks: string[];
  version: number;
}

function StableStreamingText({ text }: { text: string }) {
  // Native selections are anchored to Text nodes. Keep committed stream
  // chunks immutable and represent later output with newly appended nodes.
  const committedRef = useRef<StableStreamingTextState>({
    content: "",
    chunks: [],
    version: 0,
  });
  const committed = committedRef.current;
  const candidate = text === committed.content
    ? committed
    : text.startsWith(committed.content)
      ? {
          content: text,
          chunks: [...committed.chunks, text.slice(committed.content.length)],
          version: committed.version,
        }
      : { content: text, chunks: [text], version: committed.version + 1 };

  useLayoutEffect(() => {
    committedRef.current = candidate;
  }, [candidate]);

  return candidate.chunks.map((chunk, index) => (
    <Fragment key={`${candidate.version}:${index}`}>{chunk}</Fragment>
  ));
}

function convertHtmlNodeToReact(
  node: ChildNode,
  key: string,
  preserveStreamingText: boolean,
): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    return preserveStreamingText
      ? <StableStreamingText key={`${key}:streaming-text`} text={text} />
      : text;
  }

  if (!(node instanceof Element)) {
    return null;
  }

  const tagName = node.tagName.toLowerCase();
  if (tagName === "img") {
    const filePath = node.getAttribute(MARKDOWN_LOCAL_IMAGE_PATH_ATTR)?.trim();
    const source = node.getAttribute(MARKDOWN_CHAT_IMAGE_SOURCE_ATTR)?.trim();
    const image = createChatImageDescriptor({
      id: `markdown:${key}`,
      origin: "markdown",
      source,
      filePath,
      mimeType: node.getAttribute(MARKDOWN_LOCAL_IMAGE_MIME_ATTR)?.trim(),
      alt: node.getAttribute("alt")?.trim(),
    });
    if (image) {
      return (
        <ChatImagePreview
          key={key}
          image={image}
          variant="markdown"
        />
      );
    }
  }

  const props: Record<string, unknown> = {};
  for (const attribute of Array.from(node.attributes)) {
    if (attribute.name === "style") {
      continue;
    }
    const reactName = getReactAttributeName(attribute.name);
    props[reactName] = getReactAttributeValue(attribute.name, attribute.value);
  }

  if (isVoidElement(tagName)) {
    return createElement(tagName, { ...props, key });
  }

  const children = Array.from(node.childNodes).map((childNode, childIndex) =>
    convertHtmlNodeToReact(childNode, `${key}.${childIndex}`, preserveStreamingText),
  );

  if (
    tagName === "pre" &&
    node.childElementCount === 1 &&
    node.firstElementChild?.tagName.toLowerCase() === "code"
  ) {
    return (
      <MarkdownCodeBlock
        key={key}
        content={node.textContent ?? ""}
        preProps={props}
        children={children}
      />
    );
  }

  return createElement(tagName, { ...props, key }, ...children);
}

function renderMarkdownHtmlAsReact(html: string, forceReactTree = false): ReactNode[] | null {
  if (typeof document === "undefined") {
    return null;
  }

  const template = document.createElement("template");
  template.innerHTML = html;

  const containsInteractiveContent =
    template.content.querySelector(`img[${MARKDOWN_CHAT_IMAGE_SOURCE_ATTR}]`) !== null ||
    template.content.querySelector("pre > code") !== null;
  if (!forceReactTree && !containsInteractiveContent) {
    return null;
  }

  return Array.from(template.content.childNodes).map((node, index) =>
    convertHtmlNodeToReact(node, `${index}`, forceReactTree),
  );
}

export default function MarkdownContent({
  content,
  className,
  style,
  streaming = false,
  workspaceRootPath,
  selectionScopeId,
}: MarkdownContentProps) {
  const [workerHtml, setWorkerHtml] = useState<string | null>(null);
  const [workerError, setWorkerError] = useState(false);
  const parseStartedAtRef = useRef(0);
  const hasStreamedRef = useRef(streaming);
  const generatedSelectionScopeId = useId();
  const resolvedSelectionScopeId = selectionScopeId ?? `markdown:${generatedSelectionScopeId}`;
  const handleLinkClick = useCallback(handleMarkdownLinkClick, []);
  const handleLinkMouseDown = useCallback(handleMarkdownLinkMouseDown, []);

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
    () => (renderedHtml === null ? null : renderMarkdownHtmlAsReact(renderedHtml, hasStreamed)),
    [hasStreamed, renderedHtml],
  );

  if (showWorkerPlaceholder) {
    return (
      <div
        className={className}
        style={style}
        data-transcript-selection-scope={resolvedSelectionScopeId}
      >
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
      <div
        className={className}
        style={style}
        data-transcript-selection-scope={resolvedSelectionScopeId}
      >
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "inherit",
          }}
        >
          {hasStreamed ? <StableStreamingText text={content} /> : content}
        </pre>
      </div>
    );
  }

  if (renderedReactNodes !== null) {
    return (
      <div
        className={className}
        style={style}
        data-transcript-selection-scope={resolvedSelectionScopeId}
        onMouseDownCapture={handleLinkMouseDown}
        onClickCapture={handleLinkClick}
      >
        {renderedReactNodes}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={style}
      data-transcript-selection-scope={resolvedSelectionScopeId}
      onMouseDownCapture={handleLinkMouseDown}
      onClickCapture={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
}
