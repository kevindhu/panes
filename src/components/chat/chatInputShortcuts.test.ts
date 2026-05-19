import { describe, expect, it } from "vitest";
import { shouldSubmitChatInput } from "./chatInputShortcuts";

describe("shouldSubmitChatInput", () => {
  it("submits on plain Enter", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("submits on Ctrl/Cmd+Enter", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);

    expect(
      shouldSubmitChatInput({
        key: "Enter",
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(true);
  });

  it("keeps Shift+Enter as newline", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it("does not submit while composing with an IME", () => {
    expect(
      shouldSubmitChatInput({
        key: "Enter",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});
