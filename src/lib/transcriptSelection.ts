import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

export const TRANSCRIPT_SELECTION_SCOPE_ATTR = "data-transcript-selection-scope";
export const TRANSCRIPT_SELECTION_IGNORE_ATTR = "data-transcript-selection-ignore";

const ENDPOINT_CONTEXT_CHARS = 24;
const TRANSCRIPT_SELECTION_IGNORED_SELECTOR = [
  `[${TRANSCRIPT_SELECTION_IGNORE_ATTR}]`,
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "summary",
  "[role='button']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
].join(", ");

export interface TranscriptSelectionEndpoint {
  scopeId: string;
  messageId: string | null;
  offset: number;
  before: string;
  after: string;
}

export interface TranscriptSelectionBookmark {
  anchor: TranscriptSelectionEndpoint;
  focus: TranscriptSelectionEndpoint;
  backward: boolean;
  selectedText: string;
}

interface ResolvedSelectionPoint {
  node: Text;
  offset: number;
}

interface TranscriptLinkActivationEvent {
  button: number;
  detail: number;
}

interface TranscriptLinkPointerEvent {
  button: number;
}

const linksSelectedAtPointerDown = new WeakSet<HTMLAnchorElement>();

interface UseTranscriptSelectionOptions {
  rootRef: RefObject<HTMLElement | null>;
  resetKey?: string | null;
  onActiveChange?: (active: boolean) => void;
}

interface TranscriptSelectionController {
  active: boolean;
  clearSelection: () => void;
  selectedMessageRange: TranscriptSelectionMessageRange | null;
}

export interface TranscriptSelectionMessageRange {
  anchorMessageId: string;
  focusMessageId: string;
}

function eventElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function selectionIgnoredElement(target: EventTarget | null): Element | null {
  return eventElement(target)?.closest(TRANSCRIPT_SELECTION_IGNORED_SELECTOR) ?? null;
}

function selectionScopeForNode(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const scope = element?.closest<HTMLElement>(`[${TRANSCRIPT_SELECTION_SCOPE_ATTR}]`) ?? null;
  return scope && root.contains(scope) ? scope : null;
}

function scopeTextOffset(scope: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = scope.ownerDocument.createRange();
    range.selectNodeContents(scope);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function endpointForSelectionPoint(
  root: HTMLElement,
  node: Node | null,
  offset: number,
): TranscriptSelectionEndpoint | null {
  if (!node || !root.contains(node)) return null;
  const scope = selectionScopeForNode(root, node);
  const scopeId = scope?.getAttribute(TRANSCRIPT_SELECTION_SCOPE_ATTR)?.trim();
  if (!scope || !scopeId) return null;

  const textOffset = scopeTextOffset(scope, node, offset);
  if (textOffset === null) return null;
  const scopeText = scope.textContent ?? "";
  const message = scope.closest<HTMLElement>("[data-message-id]");
  return {
    scopeId,
    messageId: message?.dataset.messageId ?? null,
    offset: textOffset,
    before: scopeText.slice(Math.max(0, textOffset - ENDPOINT_CONTEXT_CHARS), textOffset),
    after: scopeText.slice(textOffset, textOffset + ENDPOINT_CONTEXT_CHARS),
  };
}

function selectionIsBackward(selection: Selection, range: Range): boolean {
  return !(
    selection.anchorNode === range.startContainer &&
    selection.anchorOffset === range.startOffset
  );
}

export function captureTranscriptSelection(
  root: HTMLElement,
  selection: Selection | null = root.ownerDocument.getSelection(),
): TranscriptSelectionBookmark | null {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  ) {
    return null;
  }

  if (selectionIgnoredElement(selection.anchorNode) || selectionIgnoredElement(selection.focusNode)) {
    return null;
  }

  const selectedText = selection.toString();
  if (!selectedText) return null;
  const anchor = endpointForSelectionPoint(root, selection.anchorNode, selection.anchorOffset);
  const focus = endpointForSelectionPoint(root, selection.focusNode, selection.focusOffset);
  if (!anchor || !focus) return null;

  return {
    anchor,
    focus,
    backward: selectionIsBackward(selection, selection.getRangeAt(0)),
    selectedText,
  };
}

function findScope(root: HTMLElement, scopeId: string): HTMLElement | null {
  if (root.getAttribute(TRANSCRIPT_SELECTION_SCOPE_ATTR) === scopeId) return root;
  for (const scope of root.querySelectorAll<HTMLElement>(`[${TRANSCRIPT_SELECTION_SCOPE_ATTR}]`)) {
    if (scope.getAttribute(TRANSCRIPT_SELECTION_SCOPE_ATTR) === scopeId) return scope;
  }
  return null;
}

function resolveTextOffset(scope: HTMLElement, requestedOffset: number): ResolvedSelectionPoint | null {
  const showText = scope.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = scope.ownerDocument.createTreeWalker(scope, showText);
  const targetOffset = Math.max(0, requestedOffset);
  let traversed = 0;
  let lastText: Text | null = null;
  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const length = textNode.data.length;
    lastText = textNode;
    if (targetOffset <= traversed + length) {
      return { node: textNode, offset: targetOffset - traversed };
    }
    traversed += length;
  }
  return lastText ? { node: lastText, offset: lastText.data.length } : null;
}

function contextMatchLength(left: string, right: string, fromEnd: boolean): number {
  const limit = Math.min(left.length, right.length);
  let matched = 0;
  while (matched < limit) {
    const leftIndex = fromEnd ? left.length - matched - 1 : matched;
    const rightIndex = fromEnd ? right.length - matched - 1 : matched;
    if (left[leftIndex] !== right[rightIndex]) break;
    matched += 1;
  }
  return matched;
}

function endpointContextScore(
  scopeText: string,
  offset: number,
  endpoint: TranscriptSelectionEndpoint,
): number {
  const before = scopeText.slice(Math.max(0, offset - endpoint.before.length), offset);
  const after = scopeText.slice(offset, offset + endpoint.after.length);
  return (
    contextMatchLength(before, endpoint.before, true) +
    contextMatchLength(after, endpoint.after, false)
  );
}

function relocateWithinSingleScope(
  scope: HTMLElement,
  bookmark: TranscriptSelectionBookmark,
): { anchorOffset: number; focusOffset: number } | null {
  if (bookmark.anchor.scopeId !== bookmark.focus.scopeId || !bookmark.selectedText) return null;
  const scopeText = scope.textContent ?? "";
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= scopeText.length) {
    const start = scopeText.indexOf(bookmark.selectedText, searchFrom);
    if (start < 0) break;
    const end = start + bookmark.selectedText.length;
    const anchorOffset = bookmark.backward ? end : start;
    const focusOffset = bookmark.backward ? start : end;
    candidates.push({
      start,
      end,
      score:
        endpointContextScore(scopeText, anchorOffset, bookmark.anchor) +
        endpointContextScore(scopeText, focusOffset, bookmark.focus),
    });
    searchFrom = start + Math.max(1, bookmark.selectedText.length);
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return null;
  const candidate = candidates[0];
  return bookmark.backward
    ? { anchorOffset: candidate.end, focusOffset: candidate.start }
    : { anchorOffset: candidate.start, focusOffset: candidate.end };
}

function relocateEndpointOffset(
  scope: HTMLElement,
  endpoint: TranscriptSelectionEndpoint,
): number | null {
  const scopeText = scope.textContent ?? "";
  const exactContext = `${endpoint.before}${endpoint.after}`;
  if (exactContext) {
    const exactStart = scopeText.indexOf(exactContext);
    if (
      exactStart >= 0 &&
      scopeText.indexOf(exactContext, exactStart + 1) < 0
    ) {
      return exactStart + endpoint.before.length;
    }
  }

  let bestOffset: number | null = null;
  let bestScore = 0;
  let tied = false;
  for (let offset = 0; offset <= scopeText.length; offset += 1) {
    const score = endpointContextScore(scopeText, offset, endpoint);
    if (score > bestScore) {
      bestOffset = offset;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  return !tied && bestScore > 0 ? bestOffset : null;
}

function rangeForResolvedPoints(
  document: Document,
  anchor: ResolvedSelectionPoint,
  focus: ResolvedSelectionPoint,
  backward: boolean,
): Range | null {
  try {
    const range = document.createRange();
    const start = backward ? focus : anchor;
    const end = backward ? anchor : focus;
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

function resolveBookmarkPoints(
  root: HTMLElement,
  bookmark: TranscriptSelectionBookmark,
): { anchor: ResolvedSelectionPoint; focus: ResolvedSelectionPoint; range: Range } | null {
  const anchorScope = findScope(root, bookmark.anchor.scopeId);
  const focusScope = findScope(root, bookmark.focus.scopeId);
  if (!anchorScope || !focusScope) return null;

  let anchor = resolveTextOffset(anchorScope, bookmark.anchor.offset);
  let focus = resolveTextOffset(focusScope, bookmark.focus.offset);
  let range = anchor && focus
    ? rangeForResolvedPoints(root.ownerDocument, anchor, focus, bookmark.backward)
    : null;
  if (anchor && focus && range?.toString() === bookmark.selectedText) {
    return { anchor, focus, range };
  }

  const relocated = anchorScope === focusScope
    ? relocateWithinSingleScope(anchorScope, bookmark)
    : null;
  const relocatedAnchorOffset = relocated?.anchorOffset ?? relocateEndpointOffset(
    anchorScope,
    bookmark.anchor,
  );
  const relocatedFocusOffset = relocated?.focusOffset ?? relocateEndpointOffset(
    focusScope,
    bookmark.focus,
  );
  if (relocatedAnchorOffset === null || relocatedFocusOffset === null) return null;
  anchor = resolveTextOffset(anchorScope, relocatedAnchorOffset);
  focus = resolveTextOffset(focusScope, relocatedFocusOffset);
  range = anchor && focus
    ? rangeForResolvedPoints(root.ownerDocument, anchor, focus, bookmark.backward)
    : null;
  return range?.toString() === bookmark.selectedText && anchor && focus
    ? { anchor, focus, range }
    : null;
}

export function restoreTranscriptSelection(
  root: HTMLElement,
  bookmark: TranscriptSelectionBookmark,
  selection: Selection | null = root.ownerDocument.getSelection(),
): boolean {
  if (!selection) return false;
  const resolved = resolveBookmarkPoints(root, bookmark);
  if (!resolved) return false;

  try {
    if (typeof selection.setBaseAndExtent === "function") {
      selection.setBaseAndExtent(
        resolved.anchor.node,
        resolved.anchor.offset,
        resolved.focus.node,
        resolved.focus.offset,
      );
    } else {
      selection.removeAllRanges();
      selection.addRange(resolved.range);
    }
    return selection.toString() === bookmark.selectedText;
  } catch {
    return false;
  }
}

export function selectionIntersectsNode(node: Node): boolean {
  const selection = node.ownerDocument?.getSelection();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    try {
      if (selection.getRangeAt(index).intersectsNode(node)) return true;
    } catch {
      // A stale native range should never make a link activate.
      return true;
    }
  }
  return false;
}

export function recordTranscriptLinkPointerDown(
  event: TranscriptLinkPointerEvent,
  anchor: HTMLAnchorElement,
): void {
  linksSelectedAtPointerDown.delete(anchor);
  if (event.button === 0 && selectionIntersectsNode(anchor)) {
    linksSelectedAtPointerDown.add(anchor);
  }
}

export function transcriptLinkShouldNavigate(
  event: TranscriptLinkActivationEvent,
  anchor: HTMLAnchorElement,
): boolean {
  const selectionIntersectedAtPointerDown = linksSelectedAtPointerDown.delete(anchor);
  if (event.detail === 0) return true;
  return (
    event.button === 0 &&
    !selectionIntersectedAtPointerDown &&
    !selectionIntersectsNode(anchor)
  );
}

function targetIsEditable(target: EventTarget | null): boolean {
  const element = eventElement(target);
  return Boolean(
    element?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']"),
  );
}

export function useTranscriptSelection({
  rootRef,
  resetKey,
  onActiveChange,
}: UseTranscriptSelectionOptions): TranscriptSelectionController {
  const [active, setActive] = useState(false);
  const [selectedMessageRange, setSelectedMessageRange] = useState<TranscriptSelectionMessageRange | null>(null);
  const activeRef = useRef(false);
  const bookmarkRef = useRef<TranscriptSelectionBookmark | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);
  const restorePendingRef = useRef(false);
  const pointerActiveRef = useRef(false);
  const mutationDuringPointerRef = useRef(false);
  const restoringRef = useRef(false);
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const stopObserving = useCallback(() => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    restorePendingRef.current = false;
  }, []);

  const setSelectionActive = useCallback((next: boolean) => {
    if (activeRef.current === next) return;
    activeRef.current = next;
    setActive(next);
    onActiveChangeRef.current?.(next);
  }, []);

  const deactivate = useCallback(() => {
    bookmarkRef.current = null;
    setSelectedMessageRange(null);
    stopObserving();
    setSelectionActive(false);
  }, [setSelectionActive, stopObserving]);

  const scheduleRestore = useCallback(() => {
    if (restorePendingRef.current) return;
    restorePendingRef.current = true;
    queueMicrotask(() => {
      restorePendingRef.current = false;
      const root = rootRef.current;
      const bookmark = bookmarkRef.current;
      if (!root || !bookmark) return;
      // Stable streaming text normally leaves the native range untouched.
      // This remains the fallback for genuine Markdown structure changes.
      const current = captureTranscriptSelection(root);
      if (current?.selectedText === bookmark.selectedText) {
        bookmarkRef.current = current;
        return;
      }
      restoringRef.current = true;
      const restored = restoreTranscriptSelection(root, bookmark);
      restoringRef.current = false;
      if (!restored) deactivate();
    });
  }, [deactivate, rootRef]);

  const startObserving = useCallback(() => {
    const root = rootRef.current;
    if (!root || observerRef.current || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (pointerActiveRef.current) mutationDuringPointerRef.current = true;
      scheduleRestore();
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    observerRef.current = observer;
  }, [rootRef, scheduleRestore]);

  const captureCurrent = useCallback(() => {
    const root = rootRef.current;
    if (!root) return false;
    const bookmark = captureTranscriptSelection(root);
    if (!bookmark) return false;
    bookmarkRef.current = bookmark;
    const nextRange = bookmark.anchor.messageId && bookmark.focus.messageId
      ? {
          anchorMessageId: bookmark.anchor.messageId,
          focusMessageId: bookmark.focus.messageId,
        }
      : null;
    setSelectedMessageRange((current) => (
      current?.anchorMessageId === nextRange?.anchorMessageId &&
      current?.focusMessageId === nextRange?.focusMessageId
        ? current
        : nextRange
    ));
    setSelectionActive(true);
    startObserving();
    return true;
  }, [rootRef, setSelectionActive, startObserving]);

  const clearSelection = useCallback(() => {
    const root = rootRef.current;
    const selection = root?.ownerDocument.getSelection();
    deactivate();
    if (
      root &&
      selection &&
      ((selection.anchorNode && root.contains(selection.anchorNode)) ||
        (selection.focusNode && root.contains(selection.focusNode)))
    ) {
      selection.removeAllRanges();
    }
  }, [deactivate, rootRef]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const document = root.ownerDocument;

    const onSelectionChange = () => {
      if (restoringRef.current) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) {
        captureCurrent();
        return;
      }
      if (pointerActiveRef.current) return;
      if (targetIsEditable(document.activeElement)) deactivate();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerActiveRef.current = true;
      mutationDuringPointerRef.current = false;
      const target = eventElement(event.target);
      if (!target || !root.contains(target) || selectionIgnoredElement(target)) {
        clearSelection();
      }
    };
    const finishPointer = () => {
      if (!pointerActiveRef.current) return;
      queueMicrotask(() => {
        if (!pointerActiveRef.current) return;
        pointerActiveRef.current = false;
        const shouldRestoreAfterMutation = mutationDuringPointerRef.current;
        mutationDuringPointerRef.current = false;
        if (captureCurrent()) return;
        const root = rootRef.current;
        const bookmark = bookmarkRef.current;
        if (
          shouldRestoreAfterMutation &&
          root &&
          bookmark &&
          restoreTranscriptSelection(root, bookmark)
        ) {
          captureCurrent();
          return;
        }
        deactivate();
      });
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = eventElement(event.target);
      if (target && !root.contains(target) && targetIsEditable(target)) clearSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!bookmarkRef.current) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") return;
      if (event.key === "Escape" || targetIsEditable(event.target)) clearSelection();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", finishPointer, true);
    document.addEventListener("pointercancel", finishPointer, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", finishPointer, true);
      document.removeEventListener("pointercancel", finishPointer, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
      stopObserving();
    };
  }, [captureCurrent, clearSelection, deactivate, rootRef, stopObserving]);

  useEffect(() => {
    clearSelection();
  }, [clearSelection, resetKey]);

  return { active, clearSelection, selectedMessageRange };
}
