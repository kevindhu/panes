// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolInputQuestionnaire } from "./ToolInputQuestionnaire";

const details = {
  _serverMethod: "item/tool/requestUserInput",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Choose a scope",
      isOther: false,
      options: [
        { label: "Focused", description: "Only this flow." },
        { label: "Complete (Recommended)", description: "All affected flows." },
      ],
    },
    {
      id: "secret",
      header: "Secret",
      question: "Enter a secret",
      isOther: false,
      isSecret: true,
      options: null,
    },
  ],
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToolInputQuestionnaire", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("walks native questions and sends the exact app-server response shape", async () => {
    const onSubmit = vi.fn(async () => undefined);
    await act(async () => {
      root.render(<ToolInputQuestionnaire details={details} onSubmit={onSubmit} />);
    });

    expect(container.textContent).toContain("Question 1 of 2");
    expect(container.querySelector(".codex-questionnaire-options .selected")?.textContent)
      .toContain("Complete");
    expect(container.querySelector(".codex-questionnaire-answer")).toBeNull();

    const next = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Next");
    await act(async () => next?.click());

    const password = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(password).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(password, "secret-value");
      password?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const send = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Send answers");
    await act(async () => send?.click());

    expect(onSubmit).toHaveBeenCalledWith({
      answers: {
        scope: { answers: ["Complete (Recommended)"] },
        secret: { answers: ["secret-value"] },
      },
    });
  });

  it("exposes Stop turn without manufacturing an invalid questionnaire response", async () => {
    const onSubmit = vi.fn();
    const onStop = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <ToolInputQuestionnaire details={details} onSubmit={onSubmit} onStop={onStop} />,
      );
    });

    const stop = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Stop turn");
    await act(async () => stop?.click());

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
