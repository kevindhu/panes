import type { ApprovalBlock, Message } from "../types";

export function isUserInputRequest(details?: Record<string, unknown>): boolean {
  const method = String(details?._serverMethod ?? "")
    .replace(/[._\-/]/g, "")
    .toLowerCase();
  return method === "itemtoolrequestuserinput" || method === "toolrequestuserinput";
}

// Unknown requests and older runtimes remain blocking. Only an explicit
// nonblocking user-input request can bypass the approval waiting state.
export function isBlockingApproval(details?: Record<string, unknown>): boolean {
  return !(isUserInputRequest(details) && details?.isBlocking === false);
}

export function pendingQuestions(messages: Message[]): ApprovalBlock[] {
  return messages
    .filter((message) => message.role === "assistant" && message.status === "streaming")
    .flatMap((message) => (message.blocks ?? []).filter(
      (block): block is ApprovalBlock => block.type === "approval" &&
        block.status === "pending" && isUserInputRequest(block.details),
    ));
}
