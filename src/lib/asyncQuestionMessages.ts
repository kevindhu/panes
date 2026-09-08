export interface AsyncQuestion {
  title: string;
  options?: string[];
}

// These are delivered messages, not JSON-RPC requests. There is no request ID
// to answer through respond_to_approval; replies are ordinary user input.
export function parseAsyncQuestions(payload: Record<string, unknown>): AsyncQuestion[] {
  if (payload.delivery !== "async" || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const question = value as Record<string, unknown>;
    if (typeof question.title !== "string" || !question.title.trim()) return [];
    const options = Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === "string" && Boolean(option.trim()))
      : undefined;
    return [{ title: question.title, options }];
  });
}

export function asyncQuestionDetails(questions: AsyncQuestion[]): Record<string, unknown> {
  return {
    questions: questions.map((question, index) => ({
      id: String(index),
      question: question.title,
      options: question.options,
      isOther: true,
    })),
  };
}

export interface AsyncQuestionAnswer {
  questionItemId: string;
  question: string;
  answer: string;
}

const replyStart = "<send_user_message_question_reply>";
const replyEnd = "</send_user_message_question_reply>";

// Codex desktop's delivered-question identity and user-input envelope. These
// travel as text, not as a tool result or an app-server approval response.
export function asyncQuestionId(itemId: string, index: number): string {
  return JSON.stringify(["request_user_input_async", itemId, index]);
}

export function parseAsyncQuestionReply(text: string): AsyncQuestionAnswer[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(replyStart) || !trimmed.endsWith(replyEnd)) return null;
  try {
    const decoded: unknown = JSON.parse(trimmed.slice(replyStart.length, -replyEnd.length));
    const answers = Array.isArray(decoded) ? decoded : [decoded];
    if (!answers.length || !answers.every((value) => value &&
      typeof value.questionItemId === "string" && typeof value.question === "string" &&
      typeof value.answer === "string")) return null;
    return answers;
  } catch {
    return null;
  }
}

export function displayAsyncQuestionReply(text: string): string {
  return parseAsyncQuestionReply(text)?.map(({ question, answer }) =>
    `${question.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${answer}`,
  ).join("\n\n") ?? text;
}

export function asyncQuestionReply(itemId: string, questions: AsyncQuestion[], response: unknown): string | null {
  const answers = (response as { answers?: Record<string, { answers?: unknown }> } | null)?.answers;
  const replies: AsyncQuestionAnswer[] = [];
  for (const [index, question] of questions.entries()) {
    const values = answers?.[String(index)]?.answers;
    if (!Array.isArray(values)) return null;
    const text = values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join("\n");
    if (!text) return null;
    replies.push({ questionItemId: asyncQuestionId(itemId, index), question: question.title, answer: text });
  }
  return replies.length ? `${replyStart}\n${JSON.stringify(replies)}\n${replyEnd}` : null;
}

export function answersFromReply(itemId: string, questions: AsyncQuestion[], text: string): (string | null)[] {
  const replies = parseAsyncQuestionReply(text);
  return questions.map((question, index) => {
    const id = asyncQuestionId(itemId, index);
    const answer = replies?.filter((reply) => reply.questionItemId === id).at(-1)?.answer;
    if (answer !== undefined) return answer;
    // Compatibility with Panes' first implementation. Only an exact single
    // suggested answer is unambiguous; pasted prompts and general steering are
    // not evidence that the question was answered. Never rewrite the ledger.
    if (questions.length === 1) {
      const prefix = `${question.title.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      if (text.startsWith(prefix)) {
        const legacyAnswer = text.slice(prefix.length);
        if (question.options?.includes(legacyAnswer)) return legacyAnswer;
      }
    }
    return null;
  });
}
