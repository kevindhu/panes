export const MESSAGE_MIN_ROW_HEIGHT = 56;
export const MESSAGE_ROW_GAP = 12;
export const MESSAGE_OVERSCAN_PX = 700;
export const MESSAGE_VIRTUALIZATION_THRESHOLD = 120;

export interface MessageVirtualizationOptions {
  messageCount: number;
  streaming: boolean;
  allRowsMeasured: boolean;
  editing: boolean;
  loadingOlderMessages: boolean;
}
export interface VirtualizedMessageLayout {
  offsets: number[];
  rowCount: number;
  totalHeight: number;
}

export interface VirtualMessageWindow {
  startIndex: number;
  endIndexExclusive: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

export interface RetainedMessageRange {
  startMessageId: string;
  endMessageId: string;
}

interface MessageIdentity {
  id: string;
}

interface MessageIndexRange {
  startIndex: number;
  endIndexExclusive: number;
}

export function shouldVirtualizeMessages({
  messageCount,
  streaming,
  allRowsMeasured,
  editing,
  loadingOlderMessages,
}: MessageVirtualizationOptions): boolean {
  return (
    messageCount >= MESSAGE_VIRTUALIZATION_THRESHOLD &&
    !streaming &&
    allRowsMeasured &&
    !editing &&
    !loadingOlderMessages
  );
}

export function areMessageRowsMeasured(
  messages: readonly MessageIdentity[],
  measuredHeights: ReadonlyMap<string, number>,
): boolean {
  if (messages.length === 0) {
    return false;
  }

  return messages.every((message) => {
    const height = measuredHeights.get(message.id);
    return height !== undefined && Number.isFinite(height) && height > 0;
  });
}

export function buildVirtualizedMessageLayout(
  messages: readonly MessageIdentity[],
  measuredHeights: ReadonlyMap<string, number>,
): VirtualizedMessageLayout | null {
  if (!areMessageRowsMeasured(messages, measuredHeights)) {
    return null;
  }

  const rowCount = messages.length;
  const offsets = new Array<number>(rowCount + 1);
  offsets[0] = 0;

  for (let index = 0; index < rowCount; index += 1) {
    const measuredHeight = measuredHeights.get(messages[index].id);
    if (measuredHeight === undefined) {
      return null;
    }

    const rowHeight = Math.max(MESSAGE_MIN_ROW_HEIGHT, Math.ceil(measuredHeight));
    offsets[index + 1] =
      offsets[index] + rowHeight + (index < rowCount - 1 ? MESSAGE_ROW_GAP : 0);
  }

  return {
    offsets,
    rowCount,
    totalHeight: offsets[rowCount],
  };
}

export function createVirtualMessageWindow(
  layout: VirtualizedMessageLayout,
  startIndex: number,
  endIndexExclusive: number,
): VirtualMessageWindow {
  const normalizedStart = Math.max(0, Math.min(startIndex, layout.rowCount));
  const normalizedEnd = Math.max(
    normalizedStart,
    Math.min(endIndexExclusive, layout.rowCount),
  );
  const hiddenRowsBelow = normalizedEnd < layout.rowCount;
  const gapAfterLastVisibleRow = hiddenRowsBelow ? MESSAGE_ROW_GAP : 0;

  return {
    startIndex: normalizedStart,
    endIndexExclusive: normalizedEnd,
    topSpacerHeight: layout.offsets[normalizedStart],
    bottomSpacerHeight: Math.max(
      0,
      layout.totalHeight - layout.offsets[normalizedEnd] + gapAfterLastVisibleRow,
    ),
  };
}

export function computeVirtualMessageWindow(
  layout: VirtualizedMessageLayout,
  viewportScrollTop: number,
  viewportHeight: number,
  overscanPx = MESSAGE_OVERSCAN_PX,
): VirtualMessageWindow {
  const { offsets, rowCount } = layout;
  const visibleStart = Math.max(0, viewportScrollTop - overscanPx);
  const visibleEnd =
    Math.max(0, viewportScrollTop) + Math.max(0, viewportHeight) + overscanPx;

  let lo = 0;
  let hi = rowCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid + 1] < visibleStart) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const startIndex = lo;

  lo = startIndex;
  hi = rowCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] <= visibleEnd) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  let endIndexExclusive = lo;

  if (endIndexExclusive <= startIndex) {
    endIndexExclusive = Math.min(rowCount, startIndex + 1);
  }

  return createVirtualMessageWindow(layout, startIndex, endIndexExclusive);
}

export function retainedMessageRangeForIndexes(
  messages: readonly MessageIdentity[],
  startIndex: number,
  endIndexExclusive: number,
): RetainedMessageRange | null {
  if (
    startIndex < 0 ||
    endIndexExclusive <= startIndex ||
    endIndexExclusive > messages.length
  ) {
    return null;
  }

  return {
    startMessageId: messages[startIndex].id,
    endMessageId: messages[endIndexExclusive - 1].id,
  };
}

export function resolveRetainedMessageIndexes(
  messages: readonly MessageIdentity[],
  range: RetainedMessageRange | null,
): MessageIndexRange | null {
  if (!range) {
    return null;
  }

  const startIndex = messages.findIndex((message) => message.id === range.startMessageId);
  const endIndex = messages.findIndex((message) => message.id === range.endMessageId);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }

  return {
    startIndex: Math.min(startIndex, endIndex),
    endIndexExclusive: Math.max(startIndex, endIndex) + 1,
  };
}

export function mergeRetainedMessageRanges(
  messages: readonly MessageIdentity[],
  current: RetainedMessageRange | null,
  incoming: RetainedMessageRange | null,
): RetainedMessageRange | null {
  if (!current) {
    return incoming;
  }
  if (!incoming) {
    return current;
  }

  const currentIndexes = resolveRetainedMessageIndexes(messages, current);
  const incomingIndexes = resolveRetainedMessageIndexes(messages, incoming);
  if (!currentIndexes) {
    return incomingIndexes ? incoming : null;
  }
  if (!incomingIndexes) {
    return current;
  }

  return retainedMessageRangeForIndexes(
    messages,
    Math.min(currentIndexes.startIndex, incomingIndexes.startIndex),
    Math.max(currentIndexes.endIndexExclusive, incomingIndexes.endIndexExclusive),
  );
}

export function resolveVirtualMessageWindow({
  virtualizationEnabled,
  layout,
  messages,
  retainedRange,
  viewportScrollTop,
  viewportHeight,
  overscanPx = MESSAGE_OVERSCAN_PX,
}: {
  virtualizationEnabled: boolean;
  layout: VirtualizedMessageLayout | null;
  messages: readonly MessageIdentity[];
  retainedRange: RetainedMessageRange | null;
  viewportScrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
}): VirtualMessageWindow | null {
  if (!virtualizationEnabled || !layout) {
    return null;
  }

  const viewportWindow = computeVirtualMessageWindow(
    layout,
    viewportScrollTop,
    viewportHeight,
    overscanPx,
  );
  const retainedIndexes = resolveRetainedMessageIndexes(messages, retainedRange);
  if (!retainedIndexes) {
    return viewportWindow;
  }

  return createVirtualMessageWindow(
    layout,
    Math.min(viewportWindow.startIndex, retainedIndexes.startIndex),
    Math.max(viewportWindow.endIndexExclusive, retainedIndexes.endIndexExclusive),
  );
}
