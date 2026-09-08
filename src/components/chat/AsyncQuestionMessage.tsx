import { useState } from "react";
import { useTranslation } from "react-i18next";
import { answersFromReply, asyncQuestionDetails, asyncQuestionReply, type AsyncQuestion } from "../../lib/asyncQuestionMessages";
import { useChatStore } from "../../stores/chatStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import type { ApprovalResponse } from "../../types";
import { ToolInputQuestionnaire } from "./ToolInputQuestionnaire";

export function AsyncQuestionMessage({ threadId, itemId, questions, messageId, acceptedReplies = [] }: {
  threadId: string;
  itemId: string;
  questions: AsyncQuestion[];
  messageId?: string;
  acceptedReplies?: string[];
}) {
  const { t } = useTranslation("chat");
  const messages = useChatStore((state) => state.messages);
  const [error, setError] = useState(false);
  // Message windows load newest-first, so loading the question's owner also
  // loads its later replies. Derive history from durable user input, including
  // accepted in-turn steers, rather than storing another answered flag.
  const ownerIndex = messages.findIndex((message) => message.id === messageId);
  const replies = [...acceptedReplies];
  for (const [index, message] of messages.entries()) {
    if (message.threadId !== threadId || index < ownerIndex) continue;
    if (message.role === "user" && message.status === "completed" && !message.pendingDelivery) {
      // normalizeMessages drops duplicate user `content` on history load.
      // Text blocks are the canonical representation after navigation; live
      // optimistic input and older records may still use content alone.
      const textBlocks = (message.blocks ?? []).filter((block) => block.type === "text");
      const text = textBlocks.length
        ? textBlocks.map((block) => block.content).join("\n")
        : message.content;
      if (text) replies.push(text);
    }
    for (const block of message.blocks ?? []) {
      if (block.type === "steer" && block.status === "accepted") replies.push(block.content);
    }
  }
  const answers: (string | null)[] = questions.map(() => null);
  for (const reply of replies) {
    answersFromReply(itemId, questions, reply).forEach((answer, index) => {
      if (answer !== null) answers[index] = answer;
    });
  }
  const sent = answers.every((answer) => answer !== null);

  async function submit(response: ApprovalResponse): Promise<boolean> {
    const text = asyncQuestionReply(itemId, questions, response);
    const state = useChatStore.getState();
    if (!text || state.threadId !== threadId) return false;
    setError(false);
    const options = {
      threadIdOverride: threadId,
      planMode: useThreadPlanModeStore.getState().threadModes[threadId] === "plan",
    };
    // Re-read execution state when submitting: the originating turn may have
    // completed while the user was choosing an answer.
    let accepted = false;
    try {
      accepted = state.streaming
        ? await state.steer(text, options)
        : await state.send(text, { ...options, engineId: "codex" });
    } catch {
      // Keep the draft and offer retry if the transport rejects unexpectedly.
    }
    setError(!accepted);
    return accepted;
  }

  return (
    <section className="codex-async-question-message" aria-label={t("asyncQuestions.label")} data-transcript-selection-ignore>
      <div className="codex-pending-questions-label">{t("asyncQuestions.label")}</div>
      {sent ? <details className="codex-async-question-sent">
        <summary><span role="status">{t("asyncQuestions.sent")}</span>{" · "}{answers.join("; ")}</summary>
        {questions.map((question, index) => <div key={index}><p>{question.title}</p><p>{answers[index]}</p></div>)}
      </details> : (
        <ToolInputQuestionnaire
          details={asyncQuestionDetails(questions)}
          draftKey={`${threadId}:${itemId}`}
          onSubmit={submit}
        />
      )}
      {error && <p role="alert">{t("asyncQuestions.failed")}</p>}
    </section>
  );
}
