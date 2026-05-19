import { describe, expect, it } from "vitest";
import {
  hasMeaningfulTextSelection,
  shouldFocusLeafFromMouseGesture,
} from "./WorkspacePaneShell";

function createSelection({
  isCollapsed,
  text,
}: {
  isCollapsed: boolean;
  text: string;
}): Selection {
  return {
    isCollapsed,
    toString: () => text,
  } as Selection;
}

describe("WorkspacePaneShell selection safeguards", () => {
  it("treats only non-collapsed text selections as meaningful", () => {
    expect(hasMeaningfulTextSelection(null)).toBe(false);
    expect(hasMeaningfulTextSelection(createSelection({ isCollapsed: true, text: "hello" }))).toBe(false);
    expect(hasMeaningfulTextSelection(createSelection({ isCollapsed: false, text: "   " }))).toBe(false);
    expect(hasMeaningfulTextSelection(createSelection({ isCollapsed: false, text: "hello" }))).toBe(true);
  });

  it("focuses the pane for a completed click without selection", () => {
    expect(shouldFocusLeafFromMouseGesture({
      startX: 120,
      startY: 40,
      endX: 122,
      endY: 41,
      selection: null,
    })).toBe(true);
  });

  it("does not focus the pane after a drag-sized gesture", () => {
    expect(shouldFocusLeafFromMouseGesture({
      startX: 120,
      startY: 40,
      endX: 132,
      endY: 41,
      selection: null,
    })).toBe(false);
  });

  it("does not focus the pane while text is selected", () => {
    expect(shouldFocusLeafFromMouseGesture({
      startX: 120,
      startY: 40,
      endX: 121,
      endY: 41,
      selection: createSelection({ isCollapsed: false, text: "selected text" }),
    })).toBe(false);
  });
});
