export interface WorkspaceDragRowRect {
  id: string;
  top: number;
  bottom: number;
}

export function moveWorkspaceId(
  orderedIds: string[],
  draggedId: string,
  dropIndex: number,
): string[] {
  const remaining = orderedIds.filter((id) => id !== draggedId);
  if (remaining.length === orderedIds.length) {
    return orderedIds;
  }

  const targetIndex = Math.max(0, Math.min(dropIndex, remaining.length));
  return [
    ...remaining.slice(0, targetIndex),
    draggedId,
    ...remaining.slice(targetIndex),
  ];
}

export function getWorkspaceDropIndex(
  clientY: number,
  rowRects: WorkspaceDragRowRect[],
  draggedId: string,
): number {
  let index = 0;

  for (const rect of rowRects) {
    if (rect.id === draggedId) {
      continue;
    }

    const centerY = rect.top + ((rect.bottom - rect.top) / 2);
    if (clientY > centerY) {
      index += 1;
    }
  }

  return index;
}

