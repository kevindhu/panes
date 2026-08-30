// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureTranscriptSelection,
  restoreTranscriptSelection,
  useTranscriptSelection,
} from "./transcriptSelection";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function selectText(node: Text, start: number, end: number) {
  const selection = document.getSelection();
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function textNodeContaining(root: Node, text: string): Text {
  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(text)) return node;
  }
  throw new Error(`Could not find text node containing ${JSON.stringify(text)}`);
}

function SelectionHarness({
  live,
  resetKey,
  onActiveChange,
}: {
  live: boolean;
  resetKey: string;
  onActiveChange: (active: boolean) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useTranscriptSelection({ rootRef, resetKey, onActiveChange });
  return (
    <div ref={rootRef}>
      <div data-transcript-selection-scope="turn:stable">
        {live
          ? <><strong>Live: Keep </strong><span>persistent selection visible while output grows.</span></>
          : <span>Keep persistent selection visible.</span>}
      </div>
    </div>
  );
}

describe("transcript selection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.getSelection()?.removeAllRanges();
    container.remove();
  });

  it("restores selected text after its rendered markup is replaced and shifted", () => {
    container.innerHTML = [
      '<div id="transcript">',
      '<div data-transcript-selection-scope="message:1">Alpha beta gamma.</div>',
      "</div>",
    ].join("");
    const transcript = container.querySelector("#transcript") as HTMLDivElement;
    const scope = transcript.firstElementChild as HTMLDivElement;
    const originalText = scope.firstChild as Text;
    selectText(originalText, 6, 10);

    const bookmark = captureTranscriptSelection(transcript);
    expect(bookmark?.selectedText).toBe("beta");

    scope.innerHTML = "Intro. Alpha <em>beta</em> gamma and new output.";
    expect(bookmark && restoreTranscriptSelection(transcript, bookmark)).toBe(true);
    expect(document.getSelection()?.toString()).toBe("beta");
  });

  it("uses stable scopes to restore a selection spanning separate transcript entries", () => {
    container.innerHTML = [
      '<div id="transcript">',
      '<div data-transcript-selection-scope="message:1">First response</div>',
      '<div data-transcript-selection-scope="message:2">Second response</div>',
      "</div>",
    ].join("");
    const transcript = container.querySelector("#transcript") as HTMLDivElement;
    const first = transcript.children[0].firstChild as Text;
    const second = transcript.children[1].firstChild as Text;
    const range = document.createRange();
    range.setStart(first, 6);
    range.setEnd(second, 6);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    const selectedText = document.getSelection()?.toString() ?? "";

    const bookmark = captureTranscriptSelection(transcript);
    transcript.children[0].innerHTML = "Intro. First <strong>response</strong>";
    transcript.children[1].innerHTML = "Second <em>response</em> plus output";

    expect(bookmark && restoreTranscriptSelection(transcript, bookmark)).toBe(true);
    expect(document.getSelection()?.toString()).toBe(selectedText);
  });

  it("automatically restores an active selection across a live React rerender", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        <SelectionHarness live={false} resetKey="thread:1" onActiveChange={onActiveChange} />,
      );
    });

    const scope = container.querySelector('[data-transcript-selection-scope="turn:stable"]') as HTMLDivElement;
    const text = textNodeContaining(scope, "persistent selection");
    const start = text.data.indexOf("persistent selection");
    selectText(text, start, start + "persistent selection".length);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      await Promise.resolve();
    });
    expect(onActiveChange).toHaveBeenCalledWith(true);

    await act(async () => {
      root.render(
        <SelectionHarness live resetKey="thread:1" onActiveChange={onActiveChange} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.getSelection()?.toString()).toBe("persistent selection");
  });

  it("restores a structurally replaced selection before pointer release", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        <SelectionHarness live={false} resetKey="thread:1" onActiveChange={onActiveChange} />,
      );
    });

    const scope = container.querySelector('[data-transcript-selection-scope="turn:stable"]') as HTMLDivElement;
    const text = textNodeContaining(scope, "persistent selection");
    const start = text.data.indexOf("persistent selection");
    selectText(text, start, start + "persistent selection".length);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
      scope.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      root.render(
        <SelectionHarness live resetKey="thread:1" onActiveChange={onActiveChange} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.getSelection()?.toString()).toBe("persistent selection");
  });

  it("clears the logical and native selection when the transcript identity changes", async () => {
    const onActiveChange = vi.fn();
    await act(async () => {
      root.render(
        <SelectionHarness live={false} resetKey="thread:1" onActiveChange={onActiveChange} />,
      );
    });
    const scope = container.querySelector('[data-transcript-selection-scope="turn:stable"]') as HTMLDivElement;
    const text = textNodeContaining(scope, "persistent selection");
    selectText(text, 5, 25);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));

    await act(async () => {
      root.render(
        <SelectionHarness live={false} resetKey="thread:2" onActiveChange={onActiveChange} />,
      );
    });

    expect(document.getSelection()?.isCollapsed).toBe(true);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });
});
