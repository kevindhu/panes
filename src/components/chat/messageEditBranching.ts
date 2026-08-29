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

export function computeDroppedTurnsForEditedMessage(
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

export function messagesBeforeEditableUserTurn(
  messages: Message[],
  messageId: string,
): Message[] | null {
  const selectedIndex = messages.findIndex((message) => message.id === messageId);
  if (selectedIndex < 0 || !isEditableUserTurn(messages[selectedIndex])) {
    return null;
  }

  return messages.slice(0, selectedIndex);
}

export function computeTurnsAfterAssistantMessage(
  messages: Message[],
  messageId: string,
): number | null {
  const selectedIndex = messages.findIndex((message) => message.id === messageId);
  if (
    selectedIndex < 0 ||
    messages[selectedIndex].role !== "assistant" ||
    messages[selectedIndex].status === "streaming"
  ) {
    return null;
  }

  return messages
    .slice(selectedIndex + 1)
    .filter((message) => message.role === "user" && !messageHasSteerMarker(message))
    .length;
}

export function canForkFromAssistantMessage(
  message: Message,
  sourceTurnActive: boolean,
): boolean {
  if (message.role !== "assistant" || message.status === "streaming") {
    return false;
  }

  // A native turn id gives Codex an immutable boundary even if a newer turn is
  // only optimistically visible in the frontend and has not reached app-server yet.
  return !sourceTurnActive || Boolean(message.nativeTurnId?.trim());
}

export interface EditableMessageContext {
  text: string;
  attachments: ChatAttachment[];
  planMode: boolean;
}

export function mergeUniqueChatAttachments(
  current: ChatAttachment[],
  incoming: ChatAttachment[],
): ChatAttachment[] {
  if (incoming.length === 0) {
    return current;
  }

  const knownPaths = new Set(current.map((attachment) => attachment.filePath));
  const merged = [...current];
  for (const attachment of incoming) {
    if (knownPaths.has(attachment.filePath)) {
      continue;
    }
    knownPaths.add(attachment.filePath);
    merged.push(attachment);
  }
  return merged;
}

export function removeChatAttachmentById(
  attachments: ChatAttachment[],
  attachmentId: string,
): ChatAttachment[] {
  return attachments.filter((attachment) => attachment.id !== attachmentId);
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
