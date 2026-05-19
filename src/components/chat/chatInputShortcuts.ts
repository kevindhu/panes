interface ChatInputShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function shouldSubmitChatInput(event: ChatInputShortcutEvent): boolean {
  if (event.isComposing || event.key !== "Enter") {
    return false;
  }

  if (event.shiftKey) {
    return false;
  }

  return true;
}
