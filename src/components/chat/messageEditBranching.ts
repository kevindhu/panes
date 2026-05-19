import type { ChatAttachment, ContentBlock, Message } from "../../types";

function readUserMessageText(message: Message): string | null {
  if (message.role !== "user") {
    return null;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  const textBlocks = (message.blocks ?? []).filter(
    (block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text",
  );

  if (textBlocks.length === 0) {
    return null;
  }

  return textBlocks.map((block) => block.content).join("\n");
}

function messageHasSteerMarker(message: Message): boolean {
  return (message.blocks ?? []).some(
    (block) => block.type === "text" && block.isSteer === true,
  );
}

export function isEditableUserTurn(message: Message): boolean {
  const text = readUserMessageText(message);
  return message.role === "user" && !messageHasSteerMarker(message) && text !== null;
}

export function computeRollbackTurnsForEditedMessage(
  messages: Message[],
  messageId: string,
): number | null {
  const userTurnIds = messages
    .filter((message) => isEditableUserTurn(message))
    .map((message) => message.id);
  const selectedIndex = userTurnIds.findIndex((id) => id === messageId);
  if (selectedIndex < 0) {
    return null;
  }

  return userTurnIds.length - selectedIndex;
}

export interface EditableMessageContext {
  text: string;
  attachments: ChatAttachment[];
  planMode: boolean;
}

export function extractEditableMessageContext(
  message: Message,
): EditableMessageContext | null {
  if (!isEditableUserTurn(message)) {
    return null;
  }

  const text = readUserMessageText(message);
  if (text === null) {
    return null;
  }

  const attachments = (message.blocks ?? []).flatMap((block, index) =>
    block.type === "attachment"
      ? [
          {
            id: `${message.id}:attachment:${index}`,
            fileName: block.fileName,
            filePath: block.filePath,
            sizeBytes: block.sizeBytes,
            mimeType: block.mimeType,
          } satisfies ChatAttachment,
        ]
      : [],
  );
  const planMode = (message.blocks ?? []).some(
    (block) => block.type === "text" && block.planMode === true,
  );

  return {
    text,
    attachments,
    planMode,
  };
}
