import type { Message, ThreadStatus } from "../../types";

export const PLAN_IMPLEMENTATION_CODING_MESSAGE = "Implement the plan.";

export type PlanImplementationDecision = "implement" | "stay";

export function resolvePlanImplementationDecision(
  selectedAnswer: string | null | undefined,
  implementChoice: string,
  stayChoice: string,
): PlanImplementationDecision | null {
  const selected = selectedAnswer?.trim();
  const implement = implementChoice.trim();
  const stay = stayChoice.trim();

  if (!selected || !implement || !stay || implement === stay) return null;
  if (selected === implement) return "implement";
  if (selected === stay) return "stay";
  return null;
}

const STRUCTURED_PLAN_LINE_PATTERN =
  /(^|\n)- \[(?:pending|in_progress|inProgress|completed)\] /;
const GENERIC_PLAN_LIST_PATTERN = /(^|\n)(?:[-*]|\d+\.)\s+\S+/g;
const PROPOSED_PLAN_PATTERN = /<proposed_plan>[\s\S]*<\/proposed_plan>/i;

export function textHasStructuredPlan(content: string | null | undefined): boolean {
  if (!content?.trim()) return false;
  if (PROPOSED_PLAN_PATTERN.test(content) || STRUCTURED_PLAN_LINE_PATTERN.test(content)) {
    return true;
  }
  return (content.match(GENERIC_PLAN_LIST_PATTERN) ?? []).length >= 2;
}

export function messageHasStructuredPlan(message: Message | null | undefined): boolean {
  if (!message || message.role !== "assistant") return false;

  const content = (message.blocks ?? []).reduce((combined, block) => {
    if (block.type !== "text" && block.type !== "thinking") return combined;
    return combined ? `${combined}\n${block.content}` : block.content;
  }, "");

  return textHasStructuredPlan(content);
}

function trailingAssistantMessages(messages: Message[]): Message[] {
  const trailing: Message[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") break;
    trailing.unshift(message);
  }
  return trailing;
}

export function shouldClearPendingPlanImplementationPrompt(status: ThreadStatus): boolean {
  return status === "error" || status === "idle";
}

export function shouldPromptToImplementPlan({
  streaming,
  status,
  activeThreadId,
  armedThreadId,
  messages,
  nativePlanText,
}: {
  streaming: boolean;
  status: ThreadStatus;
  activeThreadId: string | null;
  armedThreadId: string | null;
  messages: Message[];
  nativePlanText?: string | null;
}): boolean {
  if (streaming || status !== "completed") return false;
  if (!activeThreadId || armedThreadId !== activeThreadId) return false;
  if (nativePlanText?.trim()) return true;

  const assistantMessages = trailingAssistantMessages(messages);
  return assistantMessages.some(messageHasStructuredPlan);
}
