import { describe, expect, it } from "vitest";
import { isBlockingApproval } from "./pendingQuestions";

describe("question blocking policy", () => {
  it("only exempts explicitly nonblocking user-input requests", () => {
    for (const method of ["item/tool/requestUserInput", "tool/request_user_input"]) {
      expect(isBlockingApproval({ _serverMethod: method, isBlocking: false })).toBe(false);
      expect(isBlockingApproval({ _serverMethod: method, isBlocking: true })).toBe(true);
      expect(isBlockingApproval({ _serverMethod: method })).toBe(true);
    }
    expect(isBlockingApproval({ _serverMethod: "item/commandExecution/requestApproval", isBlocking: false })).toBe(true);
    expect(isBlockingApproval()).toBe(true);
  });
});
