// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineInfo, EngineModel } from "../../types";

const mockEnsureHealth = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        "modelPicker.selectModel": "Select model",
        "modelPicker.engine": "Engine",
        "modelPicker.models": "Models",
        "modelPicker.providers": "Providers",
        "modelPicker.searchModels": "Search models",
        "modelPicker.noModels": "No matching models",
        "modelPicker.thinking": "Thinking",
        "modelPicker.default": "default",
        "modelPicker.metadata.files": "Files",
        "modelPicker.effort.none": "None",
        "modelPicker.effort.minimal": "Minimal",
        "modelPicker.effort.low": "Low",
        "modelPicker.effort.medium": "Medium",
        "modelPicker.effort.high": "High",
        "modelPicker.effort.xhigh": "XHigh",
        "modelPicker.effort.max": "Max",
        "modelPicker.effort.ultra": "Ultra",
        "modelPicker.effort.noneShort": "None",
        "modelPicker.effort.minimalShort": "Min",
        "modelPicker.effort.lowShort": "Lo",
        "modelPicker.effort.mediumShort": "Med",
        "modelPicker.effort.highShort": "Hi",
        "modelPicker.effort.xhighShort": "XHi",
        "modelPicker.effort.maxShort": "Max",
        "modelPicker.effort.ultraShort": "Ultra",
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock("../../stores/engineStore", () => ({
  useEngineStore: (
    selector: (state: { ensureHealth: typeof mockEnsureHealth }) => unknown,
  ) => selector({ ensureHealth: mockEnsureHealth }),
}));

vi.mock("../shared/HarnessLogos", () => ({
  getHarnessIcon: (engineId: string) => <span data-engine-icon={engineId} />,
}));

import { ModelPicker } from "./ModelPicker";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalInnerWidth = window.innerWidth;

function makeModel(
  id: string,
  overrides: Partial<EngineModel> = {},
): EngineModel {
  return {
    id,
    displayName: id,
    description: `${id} description`,
    hidden: false,
    isDefault: false,
    inputModalities: ["text"],
    attachmentModalities: ["text"],
    supportsPersonality: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    ...overrides,
  };
}

const solModel = makeModel("gpt-5.6-sol", {
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast responses" },
    { reasoningEffort: "medium", description: "Balanced reasoning" },
    { reasoningEffort: "high", description: "Greater reasoning depth" },
    { reasoningEffort: "xhigh", description: "Extra high reasoning depth" },
    { reasoningEffort: "max", description: "Maximum reasoning depth" },
    { reasoningEffort: "ultra", description: "Automatic task delegation" },
  ],
});

const customModel = makeModel("custom-reasoner", {
  displayName: "Custom Reasoner",
  defaultReasoningEffort: "thorough",
  supportedReasoningEfforts: [
    { reasoningEffort: "quick", description: "Short pass" },
    { reasoningEffort: "thorough", description: "Detailed pass" },
  ],
});

const plainModel = makeModel("plain-model", {
  displayName: "Plain Model",
  defaultReasoningEffort: "",
});

const engine: EngineInfo = {
  id: "codex",
  name: "Codex",
  models: [solModel, customModel, plainModel],
  capabilities: {
    permissionModes: [],
    sandboxModes: [],
    approvalDecisions: [],
  },
};

describe("ModelPicker reasoning effort dropdown", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
    document.body.innerHTML = "";
  });

  async function renderPicker({
    modelId,
    effort,
    onEffortChange = vi.fn(),
  }: {
    modelId: string;
    effort: string;
    onEffortChange?: (effort: string) => void;
  }) {
    await act(async () => {
      root.render(
        <ModelPicker
          engines={[engine]}
          health={{ codex: { id: "codex", available: true } }}
          selectedEngineId="codex"
          selectedModelId={modelId}
          selectedEffort={effort}
          onEngineModelChange={vi.fn()}
          onEffortChange={onEffortChange}
        />,
      );
    });
  }

  async function openModelPicker() {
    const trigger = container.querySelector(".mp-trigger") as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.click();
    });
    expect(document.body.querySelector(".mp-popover")).not.toBeNull();
  }

  async function openEffortMenu() {
    const trigger = document.body.querySelector(
      ".mp-effort-trigger",
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.click();
    });
    const menu = document.body.querySelector(
      ".mp-effort-menu",
    ) as HTMLDivElement | null;
    expect(menu).not.toBeNull();
    if (!menu) {
      throw new Error("Reasoning effort menu did not open");
    }
    return menu;
  }

  it("renders every advertised Sol effort in source order with descriptions and defaults", async () => {
    const onEffortChange = vi.fn();
    await renderPicker({ modelId: solModel.id, effort: "max", onEffortChange });
    await openModelPicker();

    const trigger = document.body.querySelector(
      ".mp-effort-trigger",
    ) as HTMLButtonElement | null;
    expect(trigger?.textContent).toContain("Max");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("listbox");

    const menu = await openEffortMenu();
    expect(menu.parentElement).toBe(document.body);
    expect(
      Array.from(menu.querySelectorAll(".mp-effort-option-name"), (node) => node.textContent),
    ).toEqual(["Low", "Medium", "High", "XHigh", "Max", "Ultra"]);
    expect(
      Array.from(
        menu.querySelectorAll(".mp-effort-option-description"),
        (node) => node.textContent,
      ),
    ).toEqual([
      "Fast responses",
      "Balanced reasoning",
      "Greater reasoning depth",
      "Extra high reasoning depth",
      "Maximum reasoning depth",
      "Automatic task delegation",
    ]);
    expect(menu.querySelectorAll(".mp-effort-option-default")).toHaveLength(1);
    expect(menu.querySelector(".mp-effort-option-default")?.parentElement?.textContent).toContain(
      "Low",
    );
    expect(menu.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      "Max",
    );

    const ultraOption = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(".mp-effort-option"),
    ).find((option) => option.textContent?.includes("Ultra"));
    expect(ultraOption).not.toBeUndefined();
    await act(async () => {
      ultraOption?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      ultraOption?.click();
    });

    expect(onEffortChange).toHaveBeenCalledWith("ultra");
    expect(document.body.querySelector(".mp-effort-menu")).toBeNull();
    expect(document.body.querySelector(".mp-popover")).not.toBeNull();
  });

  it("supports keyboard selection and lets Escape close only the effort menu", async () => {
    const onEffortChange = vi.fn();
    await renderPicker({ modelId: solModel.id, effort: "max", onEffortChange });
    await openModelPicker();
    let menu = await openEffortMenu();

    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onEffortChange).toHaveBeenCalledWith("ultra");
    expect(document.body.querySelector(".mp-popover")).not.toBeNull();

    menu = await openEffortMenu();
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector(".mp-effort-menu")).toBeNull();
    expect(document.body.querySelector(".mp-popover")).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(document.body.querySelector(".mp-popover")).toBeNull();
  });

  it("uses an unrelated model's custom effort catalog without slug-specific behavior", async () => {
    const onEffortChange = vi.fn();
    await renderPicker({
      modelId: customModel.id,
      effort: "thorough",
      onEffortChange,
    });
    await openModelPicker();
    const menu = await openEffortMenu();

    expect(
      Array.from(menu.querySelectorAll(".mp-effort-option-name"), (node) => node.textContent),
    ).toEqual(["Quick", "Thorough"]);
    expect(menu.querySelector(".mp-effort-option-default")?.parentElement?.textContent).toContain(
      "Thorough",
    );

    const quickOption = menu.querySelector(".mp-effort-option") as HTMLButtonElement | null;
    await act(async () => {
      quickOption?.click();
    });
    expect(onEffortChange).toHaveBeenCalledWith("quick");
  });

  it("constrains the portaled menu inside a narrow viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 220,
    });
    await renderPicker({ modelId: solModel.id, effort: "max" });
    await openModelPicker();

    const trigger = document.body.querySelector(
      ".mp-effort-trigger",
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    if (!trigger) {
      throw new Error("Reasoning effort trigger was not rendered");
    }
    trigger.getBoundingClientRect = () =>
      ({
        x: 120,
        y: 80,
        top: 80,
        right: 212,
        bottom: 104,
        left: 120,
        width: 92,
        height: 24,
        toJSON: () => ({}),
      }) as DOMRect;

    const menu = await openEffortMenu();
    expect(menu.style.width).toBe("204px");
    expect(menu.style.left).toBe("8px");
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBe(212);
  });

  it("omits the selector when the selected model advertises no efforts", async () => {
    await renderPicker({ modelId: plainModel.id, effort: "medium" });
    await openModelPicker();
    expect(document.body.querySelector(".mp-effort-trigger")).toBeNull();
    expect(document.body.querySelector(".mp-model-controls")).toBeNull();
  });
});
