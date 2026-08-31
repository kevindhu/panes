import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  buildToolInputResponseFromSelections,
  defaultToolInputSelections,
  findLatestPendingToolInputApproval,
  parseToolInputQuestions,
  toolInputQuestionAllowsCustomAnswer,
} from "./toolInputApproval";

const nativeDetails = {
  _serverMethod: "item/tool/requestUserInput",
  isBlocking: true,
  itemId: "item-1",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which scope should the plan cover?",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Small", description: "Change only the affected flow." },
        { label: "Complete (Recommended)", description: "Cover every regression." },
      ],
    },
    {
      id: "notes",
      header: "Notes",
      question: "Anything else?",
      isOther: false,
      isSecret: false,
      options: null,
    },
    {
      id: "token",
      header: "Token",
      question: "Enter the token",
      isOther: false,
      isSecret: true,
      options: null,
    },
  ],
};

function assistantMessage(
  id: string,
  details: Record<string, unknown> = nativeDetails,
  status: "pending" | "answered" = "pending",
): Message {
  return {
    id,
    threadId: "thread-1",
    role: "assistant",
    status: "completed",
    schemaVersion: 1,
    blocks: [{
      type: "approval",
      approvalId: `approval-${id}`,
      actionType: "other",
      summary: "Codex requested input",
      details,
      status,
    }],
    createdAt: new Date().toISOString(),
    hydration: "full",
    hasDeferredContent: false,
  };
}

describe("Codex request-user-input helpers", () => {
  it("parses the current app-server isOther and isSecret fields", () => {
    const questions = parseToolInputQuestions(nativeDetails);

    expect(questions).toHaveLength(3);
    expect(questions[0]).toMatchObject({ id: "scope", custom: false, secret: false });
    expect(questions[0]?.options[1]).toMatchObject({
      label: "Complete (Recommended)",
      recommended: true,
      description: "Cover every regression.",
    });
    expect(questions[2]).toMatchObject({ id: "token", custom: false, secret: true });
  });

  it("treats options:null as free-form even when isOther is false", () => {
    const questions = parseToolInputQuestions(nativeDetails);
    expect(toolInputQuestionAllowsCustomAnswer(questions[0]!)).toBe(false);
    expect(toolInputQuestionAllowsCustomAnswer(questions[1]!)).toBe(true);

    expect(buildToolInputResponseFromSelections(
      questions,
      { scope: ["Complete (Recommended)"] },
      { notes: "Keep the change small", token: "secret-value" },
    )).toEqual({
      answers: {
        scope: { answers: ["Complete (Recommended)"] },
        notes: { answers: ["Keep the change small"] },
        token: { answers: ["secret-value"] },
      },
    });
  });

  it("selects the recommended option by default", () => {
    const questions = parseToolInputQuestions(nativeDetails);
    expect(defaultToolInputSelections(questions)).toEqual({
      scope: ["Complete (Recommended)"],
    });
  });

  it("finds only the latest pending native questionnaire", () => {
    const answered = assistantMessage("answered", nativeDetails, "answered");
    const malformed = assistantMessage("malformed", {
      _serverMethod: "item/tool/requestUserInput",
      questions: [],
    });
    const pending = assistantMessage("pending");

    expect(findLatestPendingToolInputApproval([answered, malformed, pending])?.approvalId)
      .toBe("approval-pending");
    expect(findLatestPendingToolInputApproval([answered, malformed])).toBeNull();
  });

  it("recognizes the legacy tool/request_user_input app-server alias", () => {
    const alias = assistantMessage("alias", {
      ...nativeDetails,
      _serverMethod: "tool/request_user_input",
    });

    expect(findLatestPendingToolInputApproval([alias])?.approvalId)
      .toBe("approval-alias");
  });
});
