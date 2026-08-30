import {
  defaultRangeExtractor,
  measureElement as measureVirtualElement,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  Fragment,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { ChatScrollPosition } from "../../lib/chatScrollPosition";
import type { TranscriptSelectionMessageRange } from "../../lib/transcriptSelection";
import type { Message } from "../../types";
import {
  cacheMeasuredMessageHeight,
  cachedOrEstimatedMessageHeight,
  DEFAULT_TRANSCRIPT_WIDTH,
  normalizedTranscriptWidth,
} from "./virtualMessageSizing";

const RESTORE_SETTLE_MS = 2_500;

export const CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED: boolean = false;

export interface VirtualMessageTranscriptHandle {
  cancelRestore: () => void;
  scrollToEnd: () => void;
}

interface VirtualMessageTranscriptProps {
  messages: Message[];
  viewportRef: RefObject<HTMLDivElement | null>;
  restorePosition: ChatScrollPosition | null;
  selectedMessageRange: TranscriptSelectionMessageRange | null;
  layoutRevision: string;
  virtualizationEnabled?: boolean;
  renderMessage: (message: Message) => ReactNode;
}

function selectedIndexInterval(
  messages: Message[],
  selected: TranscriptSelectionMessageRange | null,
): readonly [number, number] | null {
  if (!selected) return null;
  const anchor = messages.findIndex((message) => message.id === selected.anchorMessageId);
  const focus = messages.findIndex((message) => message.id === selected.focusMessageId);
  if (anchor < 0 || focus < 0) return null;
  return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

export function virtualRangeWithPinnedInterval(
  range: Range,
  pinnedInterval: readonly [number, number] | null,
): number[] {
  const indexes = defaultRangeExtractor(range);
  if (!pinnedInterval) return indexes;
  const selected = new Set(indexes);
  for (let index = pinnedInterval[0]; index <= pinnedInterval[1]; index += 1) {
    selected.add(index);
  }
  return [...selected].sort((left, right) => left - right);
}

export const VirtualMessageTranscript = forwardRef<
  VirtualMessageTranscriptHandle,
  VirtualMessageTranscriptProps
>(function VirtualMessageTranscript({
  messages,
  viewportRef,
  restorePosition,
  selectedMessageRange,
  layoutRevision,
  virtualizationEnabled = CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED,
  renderMessage,
}, forwardedRef) {
  const sizeContainerRef = useRef<HTMLDivElement | null>(null);
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  const restoredRef = useRef(false);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [transcriptWidth, setTranscriptWidth] = useState(DEFAULT_TRANSCRIPT_WIDTH);
  const [viewportReady, setViewportReady] = useState(false);
  const virtualizationActive = virtualizationEnabled && viewportReady;
  const messagesRef = useRef(messages);
  const sizeEstimatesRef = useRef<number[]>([]);
  messagesRef.current = messages;
  const pinnedInterval = useMemo(
    () => selectedIndexInterval(messages, selectedMessageRange),
    [messages, selectedMessageRange],
  );
  const sizeEstimates = useMemo(
    () => virtualizationEnabled
      ? messages.map((message) => cachedOrEstimatedMessageHeight(message, transcriptWidth))
      : [],
    [messages, transcriptWidth, virtualizationEnabled],
  );
  sizeEstimatesRef.current = sizeEstimates;
  const estimatedTotalSize = useMemo(
    () => sizeEstimates.reduce((total, size) => total + size, 0),
    [sizeEstimates],
  );
  const rangeExtractor = useCallback(
    (range: Range) => virtualRangeWithPinnedInterval(range, pinnedInterval),
    [pinnedInterval],
  );
  const getItemKey = useCallback(
    (index: number) => messagesRef.current[index]?.id ?? index,
    [],
  );
  const estimateSize = useCallback((index: number) => {
    return sizeEstimatesRef.current[index] ?? 112;
  }, []);
  const measureElement = useCallback((
    element: HTMLDivElement,
    entry: ResizeObserverEntry | undefined,
    instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  ) => {
    const size = measureVirtualElement(element, entry, instance);
    const index = instance.indexFromElement(element);
    const message = messagesRef.current[index];
    const borderBox = entry?.borderBoxSize?.[0];
    const width = borderBox?.inlineSize ?? element.offsetWidth;
    if (message) cacheMeasuredMessageHeight(message, size, width);
    return size;
  }, []);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => viewportRef.current,
    getItemKey,
    estimateSize,
    measureElement,
    overscan: 6,
    scrollMargin,
    rangeExtractor,
    anchorTo: "end",
    followOnAppend: false,
    scrollEndThreshold: 160,
    initialRect: { width: 820, height: 800 },
    initialOffset: (restorePosition?.nearBottom ?? true)
      ? Math.max(0, estimatedTotalSize - 800)
      : restorePosition?.scrollTop ?? 0,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    useFlushSync: false,
    useAnimationFrameWithResizeObserver: true,
    enabled: virtualizationActive,
  });

  const cancelRestore = useCallback(() => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
  }, []);

  const scrollToEnd = useCallback(() => {
    cancelRestore();
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (virtualizationActive) {
      virtualizer.scrollToEnd({ behavior: "auto" });
      window.requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [cancelRestore, viewportRef, virtualizationActive, virtualizer]);

  useImperativeHandle(forwardedRef, () => ({ cancelRestore, scrollToEnd }), [cancelRestore, scrollToEnd]);

  const setSizeContainer = useCallback((node: HTMLDivElement | null) => {
    sizeContainerRef.current = node;
    virtualizer.containerRef(node);
  }, [virtualizer]);

  useLayoutEffect(() => {
    if (!virtualizationActive) return;
    const viewport = viewportRef.current;
    const container = sizeContainerRef.current;
    if (!viewport || !container) return;
    const nextMargin = container.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top
      + viewport.scrollTop;
    setScrollMargin((current) => Math.abs(current - nextMargin) > 0.5 ? nextMargin : current);
  }, [layoutRevision, viewportRef, virtualizationActive]);

  useLayoutEffect(() => {
    if (!virtualizationEnabled) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const enableWhenVisible = () => {
      if (viewport.clientHeight > 0) {
        const width = sizeContainerRef.current?.clientWidth || viewport.clientWidth;
        if (width > 0) {
          const normalizedWidth = normalizedTranscriptWidth(width);
          setTranscriptWidth((current) => current === normalizedWidth ? current : normalizedWidth);
        }
        setViewportReady(true);
      }
    };
    enableWhenVisible();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(enableWhenVisible);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef, virtualizationEnabled]);

  useLayoutEffect(() => {
    if (restoredRef.current) return;
    cancelRestore();
    const viewport = viewportRef.current;
    if (!viewport || messages.length === 0) return;
    if (!virtualizationEnabled) {
      restoredRef.current = true;
      viewport.scrollTop = restorePosition && !restorePosition.nearBottom
        ? restorePosition.scrollTop
        : viewport.scrollHeight;
      return;
    }
    if (!virtualizationActive) {
      if (viewport.clientHeight > 0) return;
      restoredRef.current = true;
      viewport.scrollTop = restorePosition && !restorePosition.nearBottom
        ? restorePosition.scrollTop
        : viewport.scrollHeight;
      return;
    }
    restoredRef.current = true;

    let frame = 0;
    let settleFrame = 0;
    let settleTimer = 0;
    let observer: ResizeObserver | null = null;
    let cancelled = false;
    const cleanup = () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
      window.clearTimeout(settleTimer);
      observer?.disconnect();
    };
    restoreCleanupRef.current = cleanup;

    if (!restorePosition || restorePosition.nearBottom) {
      virtualizer.scrollToEnd({ behavior: "auto" });
      frame = window.requestAnimationFrame(() => {
        if (!cancelled) viewport.scrollTop = viewport.scrollHeight;
      });
      return cleanup;
    }

    const anchorIndex = restorePosition.anchorMessageId
      ? messages.findIndex((message) => message.id === restorePosition.anchorMessageId)
      : -1;
    if (anchorIndex < 0) {
      virtualizer.scrollToOffset(restorePosition.scrollTop, { behavior: "auto" });
      return cleanup;
    }

    virtualizer.scrollToIndex(anchorIndex, { align: "start", behavior: "auto" });
    const correctAnchor = () => {
      if (cancelled || !restorePosition.anchorMessageId) return;
      const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((element) => element.dataset.messageId === restorePosition.anchorMessageId);
      if (!anchor) return;
      const offset = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.scrollTop += offset - restorePosition.anchorOffset;
      if (!observer && typeof ResizeObserver === "function") {
        observer = new ResizeObserver(correctAnchor);
        observer.observe(anchor);
      }
    };
    frame = window.requestAnimationFrame(() => {
      correctAnchor();
      settleFrame = window.requestAnimationFrame(correctAnchor);
    });
    settleTimer = window.setTimeout(() => {
      if (restoreCleanupRef.current === cleanup) restoreCleanupRef.current = null;
      cleanup();
    }, RESTORE_SETTLE_MS);
    return cleanup;
  }, [cancelRestore, messages, restorePosition, viewportRef, virtualizationActive, virtualizationEnabled, virtualizer]);

  useLayoutEffect(() => cancelRestore, [cancelRestore]);

  if (!virtualizationEnabled) {
    return (
      <>
        {messages.map((message) => (
          <Fragment key={message.id}>{renderMessage(message)}</Fragment>
        ))}
      </>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const coldStartIndexes = virtualItems.length === 0 && messages.length > 0
    ? messages.slice(-30).map((_, offset) => Math.max(0, messages.length - 30) + offset)
    : [];

  return (
    <div ref={setSizeContainer} className="codex-virtual-transcript">
      {coldStartIndexes.map((index) => (
        <div
          key={messages[index]!.id}
          className="codex-virtual-message-row is-cold-start"
          data-index={index}
        >
          {renderMessage(messages[index]!)}
        </div>
      ))}
      {virtualItems.map((item) => {
        const message = messages[item.index];
        if (!message) return null;
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            className="codex-virtual-message-row"
            data-index={item.index}
          >
            {renderMessage(message)}
          </div>
        );
      })}
    </div>
  );
});
