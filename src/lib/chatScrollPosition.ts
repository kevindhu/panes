export const CHAT_NEAR_BOTTOM_PX = 160;

export interface ChatScrollPosition {
  scrollTop: number;
  distanceFromBottom: number;
  nearBottom: boolean;
  anchorMessageId: string | null;
  anchorOffset: number;
}

const MAX_SAVED_CHAT_SCROLL_POSITIONS = 40;
const savedChatScrollPositions = new Map<string, ChatScrollPosition>();

function messageElements(viewport: HTMLElement): HTMLElement[] {
  return [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")];
}

function messageAtViewportTop(
  viewport: HTMLElement,
  viewportTop: number,
): HTMLElement | null {
  if (typeof document.elementFromPoint === "function") {
    const viewportRect = viewport.getBoundingClientRect();
    const pointed = document.elementFromPoint(
      Math.min(viewportRect.right - 1, viewportRect.left + 12),
      viewportTop + 1,
    );
    const message = pointed?.closest<HTMLElement>("[data-message-id]") ?? null;
    if (message && viewport.contains(message)) return message;
  }

  const messages = messageElements(viewport);
  return messages.find((message) => message.getBoundingClientRect().bottom > viewportTop) ??
    messages.at(-1) ??
    null;
}

export function captureChatScrollPosition(viewport: HTMLElement): ChatScrollPosition {
  const viewportTop = viewport.getBoundingClientRect().top;
  const anchor = messageAtViewportTop(viewport, viewportTop);
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const distanceFromBottom = Math.max(0, maxScrollTop - viewport.scrollTop);
  return {
    scrollTop: viewport.scrollTop,
    distanceFromBottom,
    nearBottom: distanceFromBottom < CHAT_NEAR_BOTTOM_PX,
    anchorMessageId: anchor?.dataset.messageId ?? null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
  };
}

export function restoreChatScrollPosition(
  viewport: HTMLElement,
  position: ChatScrollPosition,
): boolean {
  if (position.nearBottom) {
    viewport.scrollTop = viewport.scrollHeight;
    return true;
  }

  const anchor = messageElements(viewport).find(
    (message) => message.dataset.messageId === position.anchorMessageId,
  );
  if (anchor) {
    const viewportTop = viewport.getBoundingClientRect().top;
    const currentAnchorOffset = anchor.getBoundingClientRect().top - viewportTop;
    viewport.scrollTop += currentAnchorOffset - position.anchorOffset;
    return true;
  }

  viewport.scrollTop = Math.min(
    position.scrollTop,
    Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  );
  return false;
}

export function saveChatScrollPosition(
  threadId: string,
  position: ChatScrollPosition,
): void {
  savedChatScrollPositions.delete(threadId);
  savedChatScrollPositions.set(threadId, position);
  while (savedChatScrollPositions.size > MAX_SAVED_CHAT_SCROLL_POSITIONS) {
    const oldestThreadId = savedChatScrollPositions.keys().next().value as string | undefined;
    if (!oldestThreadId) break;
    savedChatScrollPositions.delete(oldestThreadId);
  }
}

export function readChatScrollPosition(threadId: string): ChatScrollPosition | null {
  const saved = savedChatScrollPositions.get(threadId);
  if (!saved) return null;
  savedChatScrollPositions.delete(threadId);
  savedChatScrollPositions.set(threadId, saved);
  return saved;
}

export function resetChatScrollPositionsForTests(): void {
  savedChatScrollPositions.clear();
}
