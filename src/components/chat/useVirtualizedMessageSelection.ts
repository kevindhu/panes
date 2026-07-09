import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import {
  mergeRetainedMessageRanges,
  resolveRetainedMessageIndexes,
  type RetainedMessageRange,
} from "./messageVirtualization";

export type VirtualizedMessageSelectionPhase = "idle" | "dragging" | "pinned";

interface MessageIdentity {
  id: string;
}
export interface VirtualizedMessageSelectionState {
  phase: VirtualizedMessageSelectionPhase;
  retainedRange: RetainedMessageRange | null;
}

interface UseVirtualizedMessageSelectionOptions {
  viewportRef: RefObject<HTMLElement | null>;
  threadId: string | null;
  messages: readonly MessageIdentity[];
  renderedRangeRef: RefObject<RetainedMessageRange | null>;
  onSelectionCleared: () => void;
}

const IDLE_SELECTION_STATE: VirtualizedMessageSelectionState = {
  phase: "idle",
  retainedRange: null,
};

const NON_SELECTABLE_TARGET_SELECTOR =
  "button, input, textarea, select, option, [role='button'], [data-no-text-selection]";

function selectionEndpointInsideElement(
  element: HTMLElement,
  node: Node | null,
): boolean {
  if (!node) {
    return false;
  }
  const endpoint = node instanceof Element ? node : node.parentElement;
  return endpoint ? element.contains(endpoint) : false;
}

export function hasActiveTextSelectionInsideElement(
  element: HTMLElement | null,
): boolean {
  if (!element) {
    return false;
  }

  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    try {
      if (range.intersectsNode(element)) {
        return true;
      }
    } catch {
      // Fall back to endpoint checks if the WebView rejects intersectsNode.
    }
  }

  return (
    selectionEndpointInsideElement(element, selection.anchorNode) ||
    selectionEndpointInsideElement(element, selection.focusNode)
  );
}

function retainedRangesEqual(
  left: RetainedMessageRange | null,
  right: RetainedMessageRange | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.startMessageId === right.startMessageId &&
      left.endMessageId === right.endMessageId)
  );
}

function selectionStatesEqual(
  left: VirtualizedMessageSelectionState,
  right: VirtualizedMessageSelectionState,
): boolean {
  return left.phase === right.phase && retainedRangesEqual(left.retainedRange, right.retainedRange);
}

export function useVirtualizedMessageSelection({
  viewportRef,
  threadId,
  messages,
  renderedRangeRef,
  onSelectionCleared,
}: UseVirtualizedMessageSelectionOptions): RefObject<VirtualizedMessageSelectionState> {
  const selectionStateRef = useRef<VirtualizedMessageSelectionState>(IDLE_SELECTION_STATE);
  const messagesRef = useRef(messages);
  const onSelectionClearedRef = useRef(onSelectionCleared);
  const finishGestureRafRef = useRef<number | null>(null);
  const previousThreadIdRef = useRef(threadId);

  messagesRef.current = messages;
  onSelectionClearedRef.current = onSelectionCleared;

  const updateSelectionState = useCallback(
    (
      update: (
        current: VirtualizedMessageSelectionState,
      ) => VirtualizedMessageSelectionState,
    ) => {
      const nextState = update(selectionStateRef.current);
      if (selectionStatesEqual(selectionStateRef.current, nextState)) {
        return;
      }
      selectionStateRef.current = nextState;
    },
    [],
  );

  const clearSelectionRetention = useCallback((notify = true) => {
    const selectionWasRetained = selectionStateRef.current.phase !== "idle";
    updateSelectionState(() => IDLE_SELECTION_STATE);
    if (selectionWasRetained && notify) {
      onSelectionClearedRef.current();
    }
  }, [updateSelectionState]);

  const pinCurrentRenderedRange = useCallback(
    (phase: Exclude<VirtualizedMessageSelectionPhase, "idle">) => {
      updateSelectionState((current) => {
        const retainedRange = mergeRetainedMessageRanges(
          messagesRef.current,
          current.retainedRange,
          renderedRangeRef.current,
        );
        if (!retainedRange) {
          return current;
        }
        return { phase, retainedRange };
      });
    },
    [renderedRangeRef, updateSelectionState],
  );

  const finalizeSelectionGesture = useCallback(() => {
    if (selectionStateRef.current.phase !== "dragging") {
      return;
    }
    if (finishGestureRafRef.current !== null) {
      window.cancelAnimationFrame(finishGestureRafRef.current);
    }

    finishGestureRafRef.current = window.requestAnimationFrame(() => {
      finishGestureRafRef.current = null;
      if (hasActiveTextSelectionInsideElement(viewportRef.current)) {
        pinCurrentRenderedRange("pinned");
      } else {
        clearSelectionRetention();
      }
    });
  }, [clearSelectionRetention, pinCurrentRenderedRange, viewportRef]);

  useLayoutEffect(() => {
    if (selectionStateRef.current.phase !== "dragging") {
      return;
    }
    pinCurrentRenderedRange("dragging");
  });

  useLayoutEffect(() => {
    if (previousThreadIdRef.current === threadId) {
      return;
    }

    previousThreadIdRef.current = threadId;
    if (hasActiveTextSelectionInsideElement(viewportRef.current)) {
      window.getSelection?.()?.removeAllRanges();
    }
    clearSelectionRetention(false);
  }, [clearSelectionRetention, threadId, viewportRef]);

  useLayoutEffect(() => {
    const retainedRange = selectionStateRef.current.retainedRange;
    if (
      retainedRange &&
      resolveRetainedMessageIndexes(messages, retainedRange) === null
    ) {
      clearSelectionRetention(false);
    }
  }, [clearSelectionRetention, messages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (
        !target?.closest("[data-message-id]") ||
        target.closest(NON_SELECTABLE_TARGET_SELECTOR)
      ) {
        return;
      }

      pinCurrentRenderedRange("dragging");
    };
    const onSelectionChange = () => {
      const selectionActive = hasActiveTextSelectionInsideElement(viewport);
      if (selectionActive) {
        if (selectionStateRef.current.phase === "idle") {
          pinCurrentRenderedRange("pinned");
        }
        return;
      }

      if (selectionStateRef.current.phase !== "dragging") {
        clearSelectionRetention();
      }
    };

    viewport.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("pointerup", finalizeSelectionGesture, true);
    window.addEventListener("pointercancel", finalizeSelectionGesture, true);
    window.addEventListener("blur", finalizeSelectionGesture);
    document.addEventListener("selectionchange", onSelectionChange);

    return () => {
      viewport.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("pointerup", finalizeSelectionGesture, true);
      window.removeEventListener("pointercancel", finalizeSelectionGesture, true);
      window.removeEventListener("blur", finalizeSelectionGesture);
      document.removeEventListener("selectionchange", onSelectionChange);
      if (finishGestureRafRef.current !== null) {
        window.cancelAnimationFrame(finishGestureRafRef.current);
        finishGestureRafRef.current = null;
      }
    };
  }, [
    clearSelectionRetention,
    finalizeSelectionGesture,
    pinCurrentRenderedRange,
    viewportRef,
  ]);

  return selectionStateRef;
}
