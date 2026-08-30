import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  messageHasStructuredPlan,
  resolvePlanImplementationDecision,
  shouldClearPendingPlanImplementationPrompt,
  shouldPromptToImplementPlan,
  textHasStructuredPlan,
} from "./planModePrompt";

function message(id: string, role: "user" | "assistant", content: string): Message {
  return {
    id,
    threadId: "thread-1",
    role,
    status: "completed",
    schemaVersion: 1,
    blocks: [{ type: role === "assistant" ? "thinking" : "text", content }],
    createdAt: new Date().toISOString(),
    hydration: "full",
    hasDeferredContent: false,
  };
}

const base = {
  streaming: false,
  status: "completed" as const,
  activeThreadId: "thread-1",
  armedThreadId: "thread-1",
};

describe("plan implementation handoff", () => {
  it("recognizes structured updates and proposed-plan envelopes", () => {
    expect(textHasStructuredPlan("- [completed] Inspect\n- [pending] Implement")).toBe(true);
    expect(textHasStructuredPlan("<proposed_plan>\nDo the focused change.\n</proposed_plan>")).toBe(true);
    expect(messageHasStructuredPlan(message(
      "assistant-1",
      "assistant",
      "Plan:\n1. Inspect the flow\n2. Restore the UI",
    ))).toBe(true);
  });

  it("uses the authoritative native plan item even when legacy blocks are empty", () => {
    expect(shouldPromptToImplementPlan({
      ...base,
      messages: [message("assistant-1", "assistant", "Plan is ready.")],
      nativePlanText: "A complete native Codex plan",
    })).toBe(true);
  });

  it("does not hand off on a clarification or an older plan before a newer user turn", () => {
    expect(shouldPromptToImplementPlan({
      ...base,
      messages: [message("assistant-1", "assistant", "Which scope should I use?")],
    })).toBe(false);

    expect(shouldPromptToImplementPlan({
      ...base,
      messages: [
        message("assistant-1", "assistant", "1. Inspect\n2. Implement"),
        message("user-1", "user", "Use the focused scope"),
        message("assistant-2", "assistant", "One more clarification"),
      ],
    })).toBe(false);
  });

  it("keeps a completed plan eligible across trailing assistant-only transcript entries", () => {
    expect(shouldPromptToImplementPlan({
      ...base,
      messages: [
        message("assistant-plan", "assistant", "1. Inspect\n2. Implement"),
        message("assistant-status", "assistant", "Plan is ready."),
      ],
    })).toBe(true);
  });

  it("requires the active armed thread and a completed turn", () => {
    const messages = [message("assistant-1", "assistant", "1. Inspect\n2. Implement")];
    expect(shouldPromptToImplementPlan({ ...base, streaming: true, messages })).toBe(false);
    expect(shouldPromptToImplementPlan({ ...base, status: "awaiting_approval", messages })).toBe(false);
    expect(shouldPromptToImplementPlan({ ...base, armedThreadId: "thread-2", messages })).toBe(false);
  });

  it("fails closed unless the implementation choice is exact", () => {
    expect(resolvePlanImplementationDecision(
      "Implement the plan",
      "Implement the plan",
      "Stay in plan mode",
    )).toBe("implement");
    expect(resolvePlanImplementationDecision(
      "Stay in plan mode",
      "Implement the plan",
      "Stay in plan mode",
    )).toBe("stay");
    expect(resolvePlanImplementationDecision(
      "implement the plan",
      "Implement the plan",
      "Stay in plan mode",
    )).toBeNull();
  });

  it("clears interrupted/error handoffs without clearing approval pauses", () => {
    expect(shouldClearPendingPlanImplementationPrompt("error")).toBe(true);
    expect(shouldClearPendingPlanImplementationPrompt("idle")).toBe(true);
    expect(shouldClearPendingPlanImplementationPrompt("awaiting_approval")).toBe(false);
    expect(shouldClearPendingPlanImplementationPrompt("completed")).toBe(false);
  });
});
