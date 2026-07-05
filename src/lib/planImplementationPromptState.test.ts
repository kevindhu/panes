// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  armPlanImplementationPrompt,
  disarmPlanImplementationPrompt,
  isPlanImplementationPromptArmed,
  listPendingPlanImplementationPromptThreadIds,
  planImplementationPromptLogOperationId,
  readPendingPlanImplementationPromptRecords,
} from "./planImplementationPromptState";

describe("planImplementationPromptState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists armed plan implementation prompts by thread", () => {
    armPlanImplementationPrompt("thread-1");

    expect(isPlanImplementationPromptArmed("thread-1")).toBe(true);
    expect(listPendingPlanImplementationPromptThreadIds()).toEqual(["thread-1"]);
    expect(readPendingPlanImplementationPromptRecords()["thread-1"]).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("disarms a persisted prompt", () => {
    armPlanImplementationPrompt("thread-1");
    armPlanImplementationPrompt("thread-2");

    disarmPlanImplementationPrompt("thread-1");

    expect(isPlanImplementationPromptArmed("thread-1")).toBe(false);
    expect(isPlanImplementationPromptArmed("thread-2")).toBe(true);
    expect(listPendingPlanImplementationPromptThreadIds()).toEqual(["thread-2"]);
  });

  it("ignores missing and blank thread ids", () => {
    armPlanImplementationPrompt("");
    armPlanImplementationPrompt(null);
    disarmPlanImplementationPrompt(undefined);

    expect(listPendingPlanImplementationPromptThreadIds()).toEqual([]);
  });

  it("uses a stable log operation id", () => {
    expect(planImplementationPromptLogOperationId("thread-1")).toBe("plan-prompt:thread-1");
  });
});
