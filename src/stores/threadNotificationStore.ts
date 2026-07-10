import { create } from "zustand";
import type { ChatTurnFinishedEvent } from "../lib/ipc";
import type { Thread } from "../types";

const THREAD_NOTIFICATION_STORAGE_KEY = "panes:threadNotifications:v1";

export type ThreadNotificationStatus =
  | "completed"
  | "interrupted"
  | "error"
  | "attention"
  | "pending_approval";

export interface ThreadNotificationRecord {
  threadId: string;
  workspaceId: string;
  repoId: string | null;
  status: ThreadNotificationStatus;
  threadTitle: string;
  preview: string | null;
  createdAt: string;
}

interface ThreadNotificationState {
  notificationsByThreadId: Record<string, ThreadNotificationRecord>;
  markThreadFinished: (event: ChatTurnFinishedEvent) => void;
  markThreadNeedsAttention: (thread: Thread, preview?: string | null) => void;
  markThreadPendingApproval: (thread: Thread, preview?: string | null) => void;
  clearThreadNotification: (threadId: string | null | undefined) => void;
  pruneThreadNotifications: (validThreadIds: Iterable<string>) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStoredNotification(value: unknown): ThreadNotificationRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : "";
  const status =
    value.status === "completed" ||
    value.status === "interrupted" ||
    value.status === "error" ||
    value.status === "attention" ||
    value.status === "pending_approval"
      ? value.status
      : null;
  if (!threadId || !workspaceId || !status) {
    return null;
  }

  return {
    threadId,
    workspaceId,
    repoId: typeof value.repoId === "string" ? value.repoId : null,
    status,
    threadTitle: typeof value.threadTitle === "string" ? value.threadTitle : "",
    preview: typeof value.preview === "string" ? value.preview : null,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt
        ? value.createdAt
        : new Date(0).toISOString(),
  };
}

export function readStoredThreadNotifications(): Record<string, ThreadNotificationRecord> {
  try {
    const raw = globalThis.localStorage?.getItem(THREAD_NOTIFICATION_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const next: Record<string, ThreadNotificationRecord> = {};
    for (const value of Object.values(parsed)) {
      const notification = normalizeStoredNotification(value);
      if (notification) {
        next[notification.threadId] = notification;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function persistThreadNotifications(
  notificationsByThreadId: Record<string, ThreadNotificationRecord>,
): void {
  try {
    globalThis.localStorage?.setItem(
      THREAD_NOTIFICATION_STORAGE_KEY,
      JSON.stringify(notificationsByThreadId),
    );
  } catch {
    // Ignore storage failures in non-browser/test environments.
  }
}

function createNotificationRecord(event: ChatTurnFinishedEvent): ThreadNotificationRecord | null {
  return {
    threadId: event.threadId,
    workspaceId: event.workspaceId,
    repoId: event.repoId ?? null,
    status: event.status,
    threadTitle: event.threadTitle,
    preview: event.preview?.trim() || null,
    createdAt: new Date().toISOString(),
  };
}

function createThreadNotificationRecord(
  thread: Thread,
  status: Extract<ThreadNotificationStatus, "attention" | "pending_approval">,
  preview?: string | null,
): ThreadNotificationRecord {
  return {
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    repoId: thread.repoId ?? null,
    status,
    threadTitle: thread.title,
    preview: preview?.trim() || null,
    createdAt: new Date().toISOString(),
  };
}

export function countWorkspaceThreadNotifications(
  notificationsByThreadId: Record<string, ThreadNotificationRecord>,
  workspaceId: string,
): number {
  return Object.values(notificationsByThreadId).filter(
    (notification) => notification.workspaceId === workspaceId,
  ).length;
}

export function countWorkspacePendingApprovalNotifications(
  notificationsByThreadId: Record<string, ThreadNotificationRecord>,
  workspaceId: string,
): number {
  return Object.values(notificationsByThreadId).filter(
    (notification) =>
      notification.workspaceId === workspaceId && notification.status === "pending_approval",
  ).length;
}

export const useThreadNotificationStore = create<ThreadNotificationState>((set) => ({
  notificationsByThreadId: readStoredThreadNotifications(),

  markThreadFinished: (event) => {
    const notification = createNotificationRecord(event);
    if (!notification) {
      return;
    }

    set((state) => {
      const notificationsByThreadId = {
        ...state.notificationsByThreadId,
        [notification.threadId]: notification,
      };
      persistThreadNotifications(notificationsByThreadId);
      return { notificationsByThreadId };
    });
  },

  markThreadNeedsAttention: (thread, preview) => {
    const notification = createThreadNotificationRecord(thread, "attention", preview);

    set((state) => {
      const notificationsByThreadId = {
        ...state.notificationsByThreadId,
        [notification.threadId]: notification,
      };
      persistThreadNotifications(notificationsByThreadId);
      return { notificationsByThreadId };
    });
  },

  markThreadPendingApproval: (thread, preview) => {
    const notification = createThreadNotificationRecord(thread, "pending_approval", preview);

    set((state) => {
      const notificationsByThreadId = {
        ...state.notificationsByThreadId,
        [notification.threadId]: notification,
      };
      persistThreadNotifications(notificationsByThreadId);
      return { notificationsByThreadId };
    });
  },

  clearThreadNotification: (threadId) => {
    if (!threadId) {
      return;
    }

    set((state) => {
      if (!(threadId in state.notificationsByThreadId)) {
        return state;
      }

      const { [threadId]: _removed, ...notificationsByThreadId } = state.notificationsByThreadId;
      persistThreadNotifications(notificationsByThreadId);
      return { notificationsByThreadId };
    });
  },

  pruneThreadNotifications: (validThreadIds) => {
    const valid = new Set(validThreadIds);
    set((state) => {
      const nextEntries = Object.entries(state.notificationsByThreadId).filter(([threadId]) =>
        valid.has(threadId),
      );
      if (nextEntries.length === Object.keys(state.notificationsByThreadId).length) {
        return state;
      }

      const notificationsByThreadId = Object.fromEntries(nextEntries);
      persistThreadNotifications(notificationsByThreadId);
      return { notificationsByThreadId };
    });
  },
}));
