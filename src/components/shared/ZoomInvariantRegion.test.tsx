import { Children, isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { ZoomInvariantFlowRegion } from "./ZoomInvariantRegion";

describe("ZoomInvariantFlowRegion", () => {
  it("keeps the original element shape when compensation is disabled", () => {
    const tree = ZoomInvariantFlowRegion({
      enabled: false,
      regionHeight: "22px",
      className: "toolbar",
      children: "content",
    });

    expect(isValidElement(tree)).toBe(true);
    expect(tree.props).toMatchObject({
      className: "toolbar",
      children: "content",
    });
  });

  it("creates a flow slot and a counter-scaled visual surface", () => {
    const tree = ZoomInvariantFlowRegion({
      enabled: true,
      regionHeight: "var(--toolbar-height)",
      className: "toolbar",
      children: "content",
    });

    expect(tree.props.className).toBe("zoom-invariant-flow-slot");
    expect(tree.props.style).toEqual({
      "--zoom-invariant-region-height": "var(--toolbar-height)",
    });

    const surface = Children.only(tree.props.children);
    expect(isValidElement(surface)).toBe(true);
    if (!isValidElement(surface)) return;
    expect(surface.props).toMatchObject({
      className: "toolbar zoom-invariant-flow-content",
      children: "content",
    });
  });
});
