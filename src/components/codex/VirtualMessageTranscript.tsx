import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
} from "@tanstack/react-virtual";
import {
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

const USER_MESSAGE_ESTIMATE = 120;
const ASSISTANT_MESSAGE_ESTIMATE = 360;
const RESTORE_SETTLE_MS = 2_500;

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
  renderMessage,
}, forwardedRef) {
  const sizeContainerRef = useRef<HTMLDivElement | null>(null);
  const restoreCleanupRef = useRef<(() => void) | null>(null);
  const restoredRef = useRef(false);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [virtualizationEnabled, setVirtualizationEnabled] = useState(false);
  const pinnedInterval = useMemo(
    () => selectedIndexInterval(messages, selectedMessageRange),
    [messages, selectedMessageRange],
  );
  const estimatedTotalSize = useMemo(
    () => messages.reduce(
      (total, message) => total + (message.role === "user" ? USER_MESSAGE_ESTIMATE : ASSISTANT_MESSAGE_ESTIMATE),
      0,
    ),
    [messages],
  );
  const rangeExtractor = useCallback(
    (range: Range) => virtualRangeWithPinnedInterval(range, pinnedInterval),
    [pinnedInterval],
  );

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: messages.length,
    getScrollElement: () => viewportRef.current,
    getItemKey: (index) => messages[index]?.id ?? index,
    estimateSize: (index) => messages[index]?.role === "user"
      ? USER_MESSAGE_ESTIMATE
      : ASSISTANT_MESSAGE_ESTIMATE,
    overscan: 4,
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
    enabled: virtualizationEnabled,
  });

  const cancelRestore = useCallback(() => {
    restoreCleanupRef.current?.();
    restoreCleanupRef.current = null;
  }, []);

  const scrollToEnd = useCallback(() => {
    cancelRestore();
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (virtualizationEnabled) {
      virtualizer.scrollToEnd({ behavior: "auto" });
      window.requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [cancelRestore, viewportRef, virtualizationEnabled, virtualizer]);

  useImperativeHandle(forwardedRef, () => ({ cancelRestore, scrollToEnd }), [cancelRestore, scrollToEnd]);

  const setSizeContainer = useCallback((node: HTMLDivElement | null) => {
    sizeContainerRef.current = node;
    virtualizer.containerRef(node);
  }, [virtualizer]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const container = sizeContainerRef.current;
    if (!viewport || !container) return;
    const nextMargin = container.getBoundingClientRect().top
      - viewport.getBoundingClientRect().top
      + viewport.scrollTop;
    setScrollMargin((current) => Math.abs(current - nextMargin) > 0.5 ? nextMargin : current);
  }, [layoutRevision, viewportRef, virtualizationEnabled]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const enableWhenVisible = () => {
      if (viewport.clientHeight > 0) setVirtualizationEnabled(true);
    };
    enableWhenVisible();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(enableWhenVisible);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewportRef]);

  useLayoutEffect(() => {
    if (restoredRef.current) return;
    cancelRestore();
    const viewport = viewportRef.current;
    if (!viewport || messages.length === 0) return;
    if (!virtualizationEnabled) {
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
  }, [cancelRestore, messages, restorePosition, viewportRef, virtualizationEnabled, virtualizer]);

  useLayoutEffect(() => cancelRestore, [cancelRestore]);

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
