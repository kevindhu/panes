import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  canForkFromAssistantMessage,
  computeDroppedTurnsForEditedMessage,
  computeTurnsAfterAssistantMessage,
  extractEditableMessageContext,
  isEditableUserTurn,
  messagesBeforeEditableUserTurn,
  mergeUniqueChatAttachments,
  removeChatAttachmentById,
} from "./messageEditBranching";

function createUserMessage(
  id: string,
  content: string,
  options?: {
    planMode?: boolean;
    isSteer?: boolean;
    attachments?: Array<{
      fileName: string;
      filePath: string;
      sizeBytes: number;
      mimeType?: string;
    }>;
  },
): Message {
  return {
    id,
    threadId: "thread-1",
    role: "user",
    content,
    blocks: [
      ...(options?.attachments ?? []).map((attachment) => ({
        type: "attachment" as const,
        ...attachment,
      })),
      {
        type: "text" as const,
        content,
        planMode: options?.planMode || undefined,
        isSteer: options?.isSteer || undefined,
      },
    ],
    status: "completed",
    schemaVersion: 1,
    createdAt: "2026-05-19T12:00:00.000Z",
  };
}

function createAssistantMessage(
  id: string,
  content: string,
  options?: { nativeTurnId?: string; status?: Message["status"] },
): Message {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    content,
    blocks: [{ type: "text", content }],
    nativeTurnId: options?.nativeTurnId,
    status: options?.status ?? "completed",
    schemaVersion: 1,
    createdAt: "2026-05-19T12:00:00.000Z",
  };
}

describe("messageEditBranching", () => {
  it("drops one turn when editing the latest user turn", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
    ];

    expect(computeDroppedTurnsForEditedMessage(messages, "user-2")).toBe(1);
  });

  it("computes dropped turns from a middle user turn through the tail", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
      createUserMessage("user-3", "Third"),
      createAssistantMessage("assistant-3", "Reply"),
    ];

    expect(computeDroppedTurnsForEditedMessage(messages, "user-2")).toBe(2);
  });

  it("ignores steer messages when computing dropped turns", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("steer-1", "Follow this instead", { isSteer: true }),
      createAssistantMessage("assistant-2", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-3", "Reply"),
    ];

    expect(isEditableUserTurn(messages[2])).toBe(false);
    expect(computeDroppedTurnsForEditedMessage(messages, "user-1")).toBe(2);
    expect(computeDroppedTurnsForEditedMessage(messages, "steer-1")).toBeNull();
  });

  it("projects the retained history immediately when editing an earlier turn", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
    ];

    expect(messagesBeforeEditableUserTurn(messages, "user-2")).toEqual(
      messages.slice(0, 2),
    );
    expect(messagesBeforeEditableUserTurn(messages, "assistant-1")).toBeNull();
  });

  it("counts only later native turns when forking from an assistant response", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("steer-1", "Follow this instead", { isSteer: true }),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
      createUserMessage("user-3", "Third"),
      createAssistantMessage("assistant-3", "Reply"),
    ];

    expect(computeTurnsAfterAssistantMessage(messages, "assistant-1")).toBe(2);
    expect(computeTurnsAfterAssistantMessage(messages, "assistant-3")).toBe(0);
    expect(computeTurnsAfterAssistantMessage(messages, "user-1")).toBeNull();
  });

  it("allows an active-source fork only from a terminal assistant with a native turn id", () => {
    const anchored = createAssistantMessage("assistant-1", "Reply", {
      nativeTurnId: "turn-native-1",
    });
    const legacy = createAssistantMessage("assistant-legacy", "Reply");
    const streaming = createAssistantMessage("assistant-active", "Working", {
      nativeTurnId: "turn-native-active",
      status: "streaming",
    });

    expect(canForkFromAssistantMessage(anchored, true)).toBe(true);
    expect(canForkFromAssistantMessage(legacy, true)).toBe(false);
    expect(canForkFromAssistantMessage(legacy, false)).toBe(true);
    expect(canForkFromAssistantMessage(streaming, true)).toBe(false);
  });

  it("extracts editable text, attachments, and plan mode from a user message", () => {
    const message = createUserMessage("user-1", "Review $browser output", {
      planMode: true,
      attachments: [
        {
          fileName: "notes.md",
          filePath: "/workspace/notes.md",
          sizeBytes: 128,
          mimeType: "text/markdown",
        },
      ],
    });

    expect(extractEditableMessageContext(message)).toEqual({
      text: "Review $browser output",
      attachments: [
        {
          id: "user-1:attachment:0",
          fileName: "notes.md",
          filePath: "/workspace/notes.md",
          sizeBytes: 128,
          mimeType: "text/markdown",
        },
      ],
      planMode: true,
    });
  });

  it("merges attachments by file path without duplicates", () => {
    const current = [
      {
        id: "existing",
        fileName: "before.png",
        filePath: "/workspace/before.png",
        sizeBytes: 10,
        mimeType: "image/png",
      },
    ];
    const incoming = [
      {
        id: "duplicate",
        fileName: "before.png",
        filePath: "/workspace/before.png",
        sizeBytes: 10,
        mimeType: "image/png",
      },
      {
        id: "new",
        fileName: "after.png",
        filePath: "/workspace/after.png",
        sizeBytes: 20,
        mimeType: "image/png",
      },
    ];

    expect(mergeUniqueChatAttachments(current, incoming)).toEqual([
      current[0],
      incoming[1],
    ]);
  });

  it("removes attachments by id", () => {
    const attachments = [
      {
        id: "keep",
        fileName: "keep.png",
        filePath: "/workspace/keep.png",
        sizeBytes: 10,
        mimeType: "image/png",
      },
      {
        id: "drop",
        fileName: "drop.png",
        filePath: "/workspace/drop.png",
        sizeBytes: 20,
        mimeType: "image/png",
      },
    ];

    expect(removeChatAttachmentById(attachments, "drop")).toEqual([attachments[0]]);
  });
});
