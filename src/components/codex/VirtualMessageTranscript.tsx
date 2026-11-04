import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { forwardRef, useCallback, useImperativeHandle, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatScrollPosition } from "../../lib/chatScrollPosition";
import type { TranscriptSelectionMessageRange } from "../../lib/transcriptSelection";
import type { Message } from "../../types";
import type { TranscriptRow } from "./transcriptRows";
import { estimateMessageHeight } from "./virtualMessageSizing";

export const CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED: boolean = true;
export interface VirtualMessageTranscriptHandle {
  cancelRestore: () => void;
  scrollToEnd: () => void;
}
interface Props {
  messages: Message[];
  rows?: TranscriptRow[];
  viewportRef: RefObject<HTMLDivElement | null>;
  restorePosition: ChatScrollPosition | null;
  selectedMessageRange: TranscriptSelectionMessageRange | null;
  layoutRevision: string;
  historyPending?: boolean;
  virtualizationEnabled?: boolean;
  renderMessage: (message: Message) => ReactNode;
  onFollowChange?: (following: boolean) => void;
  onPositionChange?: (position: ChatScrollPosition) => void;
}
interface Anchor { key: string; messageId: string; offset: number }
const heights = new Map<string, number>();
const MAX_HEIGHTS = 8_000;
const BOTTOM_TOLERANCE_PX = 8;
const measurementKey = (width: number, row: TranscriptRow) => `${width}:${row.key}:${row.revision ?? ""}`;
export function virtualRangeWithPinnedInterval(range: Range, interval: readonly [number, number] | null) {
  const selected = new Set(defaultRangeExtractor(range));
  if (interval) for (let i = interval[0]; i <= interval[1]; i++) selected.add(i);
  return [...selected].sort((a, b) => a - b);
}

/** One owner for scroll writes. Geometry changes never imply user follow intent. */
export const VirtualMessageTranscript = forwardRef<VirtualMessageTranscriptHandle, Props>(function VirtualMessageTranscript({
  messages, rows: suppliedRows, viewportRef, restorePosition, selectedMessageRange,
  layoutRevision, historyPending = false, virtualizationEnabled = CHAT_TRANSCRIPT_VIRTUALIZATION_ENABLED,
  renderMessage, onFollowChange, onPositionChange,
}, forwardedRef) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Child layout effects run before the enclosing viewport's ref is attached.
  // The container is a direct child of that viewport and is already in the DOM.
  const getViewport = useCallback(() => viewportRef.current ?? containerRef.current?.parentElement as HTMLDivElement | null, [viewportRef]);
  const [width, setWidth] = useState(820);
  const [margin, setMargin] = useState(0);
  const [ready, setReady] = useState(false);
  const [presented, setPresented] = useState(!virtualizationEnabled);
  const [, redraw] = useState(0);
  const following = useRef(restorePosition?.nearBottom ?? true);
  const anchor = useRef<Anchor | null>(restorePosition?.anchorMessageId ? {
    key: restorePosition.anchorRowId ?? restorePosition.anchorMessageId,
    messageId: restorePosition.anchorMessageId, offset: restorePosition.anchorOffset,
  } : null);
  const restoring = useRef(Boolean(restorePosition?.anchorMessageId));
  const writtenOffset = useRef<number | null>(null);
  const userScrolling = useRef(false);
  const pointerActive = useRef(false);
  const previousScrollTop = useRef(0);
  const callbacks = useRef({ onFollowChange, onPositionChange });
  callbacks.current = { onFollowChange, onPositionChange };
  const rows = useMemo<TranscriptRow[]>(() => suppliedRows ?? messages.map(message => ({
    key: message.id, messageId: message.id, content: renderMessage(message),
    estimatedHeight: estimateMessageHeight(message, width),
  })), [suppliedRows, messages, renderMessage, width]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const keySignature = rows.map(row => row.key).join("\n");
  const indexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [keySignature]);
  const anchorIndex = anchor.current ? indexByKey.get(anchor.current.key) ?? rows.findIndex(row => row.messageId === anchor.current!.messageId) : undefined;
  const selectedInterval = useMemo<readonly [number, number] | null>(() => {
    if (!selectedMessageRange) return null;
    if (selectedMessageRange.anchorRowId && selectedMessageRange.focusRowId) {
      const a = indexByKey.get(selectedMessageRange.anchorRowId);
      const b = indexByKey.get(selectedMessageRange.focusRowId);
      if (a !== undefined && b !== undefined) return [Math.min(a, b), Math.max(a, b)];
    }
    const a = rows.findIndex(row => row.messageId === selectedMessageRange.anchorMessageId);
    const c = rows.findIndex(row => row.messageId === selectedMessageRange.focusMessageId);
    let b = -1, d = -1;
    rows.forEach((row, i) => {
      if (row.messageId === selectedMessageRange.focusMessageId) b = i;
      if (row.messageId === selectedMessageRange.anchorMessageId) d = i;
    });
    return a < 0 || b < 0 ? null : [Math.min(a, c), Math.max(b, d)];
  }, [keySignature, selectedMessageRange]);
  const getItemKey = useCallback((index: number) => rowsRef.current[index]!.key, [keySignature]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length, getScrollElement: getViewport, getItemKey,
    estimateSize: index => heights.get(measurementKey(width, rows[index]!)) ?? rows[index]!.estimatedHeight,
    overscan: 8, scrollMargin: margin, enabled: virtualizationEnabled && ready,
    initialRect: { width: 820, height: 800 },
    initialOffset: following.current ? Math.max(0, rows.reduce((n, row) => n + row.estimatedHeight, 0) - 800) : restorePosition?.scrollTop ?? 0,
    rangeExtractor: range => {
      const indexes = virtualRangeWithPinnedInterval(range, selectedInterval);
      // Measure the actual destination on the first commit, even when estimated
      // heights put the virtualizer's initial offset in a different range.
      if (following.current && !presented) {
        for (let i = Math.max(0, rows.length - 12); i < rows.length; i++) if (!indexes.includes(i)) indexes.push(i);
      }
      if (anchorIndex !== undefined && anchorIndex >= 0 && !indexes.includes(anchorIndex)) indexes.push(anchorIndex);
      const focusedKey = document.activeElement?.closest<HTMLElement>("[data-transcript-row]")?.dataset.transcriptRow;
      const focusedIndex = focusedKey ? indexByKey.get(focusedKey) : undefined;
      if (focusedIndex !== undefined && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
      return indexes.sort((a, b) => a - b);
    },
  });
  // This controller compensates against a stable row, including prepends and late
  // hydration. Never also run the virtualizer's independent compensation.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;

  const setFollowing = useCallback((value: boolean) => {
    if (following.current === value) return;
    following.current = value;
    callbacks.current.onFollowChange?.(value);
  }, []);
  const publishPosition = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const distance = Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
    callbacks.current.onPositionChange?.({
      scrollTop: viewport.scrollTop, distanceFromBottom: distance, nearBottom: following.current,
      anchorMessageId: anchor.current?.messageId ?? null,
      anchorRowId: anchor.current?.key, anchorOffset: anchor.current?.offset ?? 0,
    });
  }, [getViewport]);
  const capture = useCallback(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top;
    const nodes = [...viewport.querySelectorAll<HTMLElement>("[data-transcript-row]")];
    const node = nodes.find(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > top + 1 && rect.top <= top + 1;
    });
    if (node) anchor.current = {
      key: node.dataset.transcriptRow!, messageId: node.dataset.messageId!,
      offset: node.getBoundingClientRect().top - top,
    };
    else {
      // A scrollbar drag can land beyond the mounted range. Resolve that offset
      // from measurements instead of mistaking an old overscan row for the anchor.
      const item = virtualizer.getVirtualItemForOffset(viewport.scrollTop);
      const row = item && rowsRef.current[item.index];
      if (item && row) anchor.current = { key: row.key, messageId: row.messageId, offset: item.start - viewport.scrollTop };
    }
    publishPosition();
  }, [getViewport, virtualizer, publishPosition]);
  const pause = useCallback(() => {
    restoring.current = false;
    setPresented(true);
    setFollowing(false);
    writtenOffset.current = null;
    capture();
  }, [capture, setFollowing]);
  useImperativeHandle(forwardedRef, () => ({
    cancelRestore: pause,
    scrollToEnd: () => {
      restoring.current = false;
      // An explicit jump ends the old gesture. Its later scroll/layout events
      // must not be interpreted as the reader moving away from the bottom.
      userScrolling.current = false;
      pointerActive.current = false;
      setFollowing(true); anchor.current = null; redraw(n => n + 1);
    },
  }), [pause, setFollowing]);

  useLayoutEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const size = () => {
      if (!viewport.clientHeight) return;
      setReady(true);
      const nextWidth = containerRef.current?.clientWidth ?? viewport.clientWidth;
      if (nextWidth > 0) setWidth(Math.round(nextWidth));
      const container = containerRef.current;
      if (container) setMargin(container.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop);
    };
    size();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(size) : null;
    observer?.observe(viewport);
    if (containerRef.current) observer?.observe(containerRef.current);
    return () => observer?.disconnect();
  }, [getViewport, layoutRevision]);

  useLayoutEffect(() => { virtualizer.measure(); }, [width, virtualizer]);

  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      userScrolling.current = true;
      if (event.deltaY < 0 || !presented) pause();
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true]")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        userScrolling.current = true;
        pause();
      }
    };
    const onPointer = () => { pointerActive.current = true; pause(); };
    const onPointerUp = () => { pointerActive.current = false; };
    const onTouch = () => { userScrolling.current = true; pause(); };
    const onScroll = () => {
      const offset = viewport.scrollTop;
      if (writtenOffset.current !== null && Math.abs(offset - writtenOffset.current) < 1) {
        writtenOffset.current = null;
        previousScrollTop.current = offset;
        return;
      }
      if ((!presented || restoring.current) && !pointerActive.current && !userScrolling.current) return;
      if (pointerActive.current || userScrolling.current) {
        const atEnd = viewport.scrollHeight - viewport.clientHeight - offset <= BOTTOM_TOLERANCE_PX;
        if (!atEnd && offset < previousScrollTop.current - 1) setFollowing(false);
        if (atEnd && offset > previousScrollTop.current + 1 && !window.getSelection()?.toString()) setFollowing(true);
      }
      previousScrollTop.current = offset;
      capture();
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("keydown", onKey);
    viewport.addEventListener("pointerdown", onPointer);
    window.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("touchstart", onTouch, { passive: true });
    viewport.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("keydown", onKey);
      viewport.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointerUp);
      viewport.removeEventListener("touchstart", onTouch);
      viewport.removeEventListener("scroll", onScroll, true);
    };
  }, [capture, pause, setFollowing, getViewport, presented]);

  // Layout effects and ResizeObserver settle before paint. No timed restoration
  // loop can pull the user back after they begin reading.
  useLayoutEffect(() => {
    const viewport = getViewport();
    if (!viewport || !viewport.clientHeight || !rows.length) return;
    let target: number | undefined;
    let anchorStart: number | undefined;
    if (following.current) target = viewport.scrollHeight - viewport.clientHeight;
    else if (anchor.current && !virtualizationEnabled) {
      const node = [...viewport.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(node => node.dataset.transcriptRow === anchor.current!.key);
      if (node) target = viewport.scrollTop + node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.current.offset;
    }
    else if (anchor.current && ready) {
      let index = indexByKey.get(anchor.current.key);
      if (index !== undefined && !rows[index]!.pending) restoring.current = false;
      if (index === undefined) {
        index = rows.findIndex(row => row.messageId === anchor.current!.messageId);
        if (index >= 0 && !rows[index]!.pending) {
          restoring.current = false;
          anchor.current = { ...anchor.current, key: rows[index]!.key };
        }
        // A removed row/turn must not leave the conversation hidden forever.
        if (index < 0 && !historyPending) {
          restoring.current = false;
          anchor.current = null;
          target = restorePosition?.scrollTop ?? 0;
        }
      }
      if (index !== undefined && index >= 0) {
        const item = virtualizer.getVirtualItems().find(item => item.index === index);
        if (item && anchor.current) {
          anchorStart = item.start;
          target = item.start - anchor.current.offset;
        }
      }
    }
    if (target !== undefined) {
      target = Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight));
      if (Math.abs(viewport.scrollTop - target) > 0.5) {
        writtenOffset.current = target;
        viewport.scrollTop = target;
        previousScrollTop.current = target;
      }
    }
    if (!presented && virtualizationEnabled) {
      if (!ready || historyPending || (restoring.current && !following.current)) return;
      const container = containerRef.current!;
      const viewportRect = viewport.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const top = Math.max(viewportRect.top, containerRect.top);
      const bottom = Math.min(viewportRect.top + viewport.clientHeight, containerRect.bottom);
      const pendingMessages = new Set(rows.filter(row => row.pending).map(row => row.messageId));
      const destination = following.current ? rows.at(-1)?.messageId : anchor.current?.messageId;
      if (destination && pendingMessages.has(destination)) return;
      const nodes = [...container.querySelectorAll<HTMLElement>("[data-transcript-row]")];
      if (anchor.current && !following.current) {
        const node = nodes.find(node => node.dataset.transcriptRow === anchor.current!.key);
        // Near an edge, a saved offset may no longer be reachable after reflow.
        const expectedOffset = anchorStart !== undefined && target !== undefined ? anchorStart - target : anchor.current.offset;
        if (!node || Math.abs(node.getBoundingClientRect().top - viewportRect.top - expectedOffset) > 2) return;
      }
      // A scroll write updates the virtual range on the next scroll event. Do
      // not reveal empty space or a partially measured range in the meantime.
      let covered = top;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom <= top || rect.top >= bottom) continue;
        if (pendingMessages.has(node.dataset.messageId!) || rect.top > covered + 2) return;
        covered = Math.max(covered, rect.bottom);
      }
      if (covered < bottom - 2 || (target !== undefined && Math.abs(viewport.scrollTop - target) > 2)) return;
      setPresented(true);
    }
    if (following.current || !anchor.current) capture();
    else publishPosition();
  });

  const items = virtualizer.getVirtualItems();
  const coldRows = !ready ? rows.slice(-12) : [];
  return <div ref={containerRef} className="codex-virtual-transcript" aria-busy={virtualizationEnabled && !presented}
    style={{ height: ready && virtualizationEnabled ? virtualizer.getTotalSize() : undefined, visibility: virtualizationEnabled && !presented ? "hidden" : undefined }}>
    {!virtualizationEnabled ? rows.map(row => <div key={row.key} data-transcript-row={row.key} data-message-id={row.messageId}>{row.content}</div>) : <>
      {coldRows.map(row => <div key={row.key} data-transcript-row={row.key} data-message-id={row.messageId}>{row.content}</div>)}
      {items.map(item => {
        const row = rows[item.index]!;
        return <div key={row.key} data-index={item.index} data-transcript-row={row.key} data-message-id={row.messageId}
          className="codex-virtual-message-row"
          ref={node => {
            virtualizer.measureElement(node);
            if (node && node.offsetHeight > 0) {
              heights.set(measurementKey(width, row), node.offsetHeight);
              if (heights.size > MAX_HEIGHTS) heights.delete(heights.keys().next().value!);
            }
          }} style={{ transform: "translateY(" + (item.start - margin) + "px)" }}>{row.content}</div>;
      })}
    </>}
  </div>;
});
