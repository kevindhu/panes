import { describe, expect, it } from "vitest";
import { getWorkspaceDropIndex, moveWorkspaceId } from "./workspaceDragSort";

describe("workspaceDragSort", () => {
  it("moves a dragged workspace id to the requested drop index", () => {
    expect(moveWorkspaceId(["a", "b", "c", "d"], "c", 1)).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("clamps drop indexes to the available workspace range", () => {
    expect(moveWorkspaceId(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveWorkspaceId(["a", "b", "c"], "c", -1)).toEqual(["c", "a", "b"]);
  });

  it("calculates drop index from non-dragged row centers", () => {
    const rows = [
      { id: "a", top: 0, bottom: 30 },
      { id: "b", top: 30, bottom: 60 },
      { id: "c", top: 60, bottom: 90 },
    ];

    expect(getWorkspaceDropIndex(10, rows, "b")).toBe(0);
    expect(getWorkspaceDropIndex(76, rows, "b")).toBe(2);
  });
});
