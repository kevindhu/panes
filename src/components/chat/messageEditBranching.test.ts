import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  computeRollbackTurnsForEditedMessage,
  extractEditableMessageContext,
  isEditableUserTurn,
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

function createAssistantMessage(id: string, content: string): Message {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    content,
    blocks: [{ type: "text", content }],
    status: "completed",
    schemaVersion: 1,
    createdAt: "2026-05-19T12:00:00.000Z",
  };
}

describe("messageEditBranching", () => {
  it("computes a rollback depth of one for the latest user turn", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
    ];

    expect(computeRollbackTurnsForEditedMessage(messages, "user-2")).toBe(1);
  });

  it("computes rollback depth from a middle user turn through the tail", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-2", "Reply"),
      createUserMessage("user-3", "Third"),
      createAssistantMessage("assistant-3", "Reply"),
    ];

    expect(computeRollbackTurnsForEditedMessage(messages, "user-2")).toBe(2);
  });

  it("ignores steer messages when computing rollback depth", () => {
    const messages = [
      createUserMessage("user-1", "First"),
      createAssistantMessage("assistant-1", "Reply"),
      createUserMessage("steer-1", "Follow this instead", { isSteer: true }),
      createAssistantMessage("assistant-2", "Reply"),
      createUserMessage("user-2", "Second"),
      createAssistantMessage("assistant-3", "Reply"),
    ];

    expect(isEditableUserTurn(messages[2])).toBe(false);
    expect(computeRollbackTurnsForEditedMessage(messages, "user-1")).toBe(2);
    expect(computeRollbackTurnsForEditedMessage(messages, "steer-1")).toBeNull();
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
});
