// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countWorkspacePendingApprovalNotifications,
  countWorkspaceThreadNotifications,
  readStoredThreadNotifications,
  useThreadNotificationStore,
} from "./threadNotificationStore";
import type { ChatTurnFinishedEvent } from "../lib/ipc";
import type { Thread } from "../types";

const completedEvent: ChatTurnFinishedEvent = {
  threadId: "thread-1",
  workspaceId: "ws-1",
  repoId: "repo-1",
  engineId: "codex",
  threadTitle: "Implement feature",
  status: "completed",
  preview: "Done",
};

const attentionThread: Thread = {
  id: "thread-attention",
  workspaceId: "ws-1",
  repoId: "repo-1",
  engineId: "codex",
  modelId: "gpt-5.5",
  engineThreadId: "engine-thread-1",
  title: "Answer questions",
  status: "awaiting_approval",
  messageCount: 2,
  totalTokens: 0,
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
};

describe("threadNotificationStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useThreadNotificationStore.setState({ notificationsByThreadId: {} });
    vi.useRealTimers();
  });

  it("records completed and error turns by thread", () => {
    useThreadNotificationStore.getState().markThreadFinished(completedEvent);
    useThreadNotificationStore.getState().markThreadFinished({
      ...completedEvent,
      threadId: "thread-2",
      status: "error",
      preview: "Failed",
    });

    const notifications = useThreadNotificationStore.getState().notificationsByThreadId;
    expect(Object.keys(notifications)).toEqual(["thread-1", "thread-2"]);
    expect(notifications["thread-1"]).toMatchObject({
      threadId: "thread-1",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "completed",
      threadTitle: "Implement feature",
      preview: "Done",
    });
    expect(countWorkspaceThreadNotifications(notifications, "ws-1")).toBe(2);
  });

  it("ignores interrupted turns", () => {
    useThreadNotificationStore.getState().markThreadFinished({
      ...completedEvent,
      status: "interrupted",
    });

    expect(useThreadNotificationStore.getState().notificationsByThreadId).toEqual({});
  });

  it("records attention-needed threads", () => {
    useThreadNotificationStore
      .getState()
      .markThreadNeedsAttention(attentionThread, "Question waiting");

    const notifications = useThreadNotificationStore.getState().notificationsByThreadId;
    expect(notifications["thread-attention"]).toMatchObject({
      threadId: "thread-attention",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "attention",
      threadTitle: "Answer questions",
      preview: "Question waiting",
    });
    expect(countWorkspaceThreadNotifications(notifications, "ws-1")).toBe(1);
  });

  it("records pending approval threads separately from attention", () => {
    useThreadNotificationStore
      .getState()
      .markThreadPendingApproval(attentionThread, "Input needed");

    const notifications = useThreadNotificationStore.getState().notificationsByThreadId;
    expect(notifications["thread-attention"]).toMatchObject({
      threadId: "thread-attention",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "pending_approval",
      threadTitle: "Answer questions",
      preview: "Input needed",
    });
    expect(countWorkspaceThreadNotifications(notifications, "ws-1")).toBe(1);
    expect(countWorkspacePendingApprovalNotifications(notifications, "ws-1")).toBe(1);
  });

  it("clears and prunes stored notifications", () => {
    useThreadNotificationStore.getState().markThreadFinished(completedEvent);
    useThreadNotificationStore.getState().markThreadFinished({
      ...completedEvent,
      threadId: "thread-2",
    });

    useThreadNotificationStore.getState().clearThreadNotification("thread-1");
    expect(Object.keys(useThreadNotificationStore.getState().notificationsByThreadId)).toEqual([
      "thread-2",
    ]);

    useThreadNotificationStore.getState().pruneThreadNotifications(["thread-3"]);
    expect(useThreadNotificationStore.getState().notificationsByThreadId).toEqual({});
  });

  it("persists records to localStorage and hydrates valid records", () => {
    useThreadNotificationStore.getState().markThreadFinished(completedEvent);
    useThreadNotificationStore.getState().markThreadPendingApproval(attentionThread);

    const hydrated = readStoredThreadNotifications();
    expect(hydrated["thread-1"]).toMatchObject({
      threadId: "thread-1",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "completed",
    });
    expect(hydrated["thread-attention"]).toMatchObject({
      threadId: "thread-attention",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "pending_approval",
    });
  });
});
