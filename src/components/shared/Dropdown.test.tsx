// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "./Dropdown";
import { ZoomInvariantScaleProvider } from "./ZoomInvariantRegion";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("Dropdown zoom-invariant portals", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.querySelectorAll(".dropdown-menu-portal").forEach((node) => node.remove());
    container.remove();
    vi.restoreAllMocks();
  });

  it("carries the containing chrome scale across the body portal", () => {
    act(() => {
      root.render(
        <ZoomInvariantScaleProvider scale={0.8}>
          <Dropdown
            options={[{ value: "one", label: "One" }]}
            value="none"
            onChange={vi.fn()}
          />
        </ZoomInvariantScaleProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(".dropdown-trigger");
    expect(trigger).not.toBeNull();
    act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const portal = document.querySelector<HTMLElement>(".dropdown-menu-portal");
    expect(portal).not.toBeNull();
    expect(portal?.style.transform).toBe("scale(0.8)");
    expect(portal?.style.transformOrigin).toBe("top left");
    expect(portal?.querySelector(".dropdown-menu")).not.toBeNull();
  });

  it("defaults ordinary dropdowns to the normal visual scale", () => {
    act(() => {
      root.render(
        <Dropdown
          options={[{ value: "one", label: "One" }]}
          value="none"
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(".dropdown-trigger");
    act(() => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(
      document.querySelector<HTMLElement>(".dropdown-menu-portal")?.style.transform,
    ).toBe("scale(1)");
  });
});
