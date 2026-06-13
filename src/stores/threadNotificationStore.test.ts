// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countWorkspaceThreadNotifications,
  readStoredThreadNotifications,
  useThreadNotificationStore,
} from "./threadNotificationStore";
import type { ChatTurnFinishedEvent } from "../lib/ipc";

const completedEvent: ChatTurnFinishedEvent = {
  threadId: "thread-1",
  workspaceId: "ws-1",
  repoId: "repo-1",
  engineId: "codex",
  threadTitle: "Implement feature",
  status: "completed",
  preview: "Done",
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

    const hydrated = readStoredThreadNotifications();
    expect(hydrated["thread-1"]).toMatchObject({
      threadId: "thread-1",
      workspaceId: "ws-1",
      repoId: "repo-1",
      status: "completed",
    });
  });
});
