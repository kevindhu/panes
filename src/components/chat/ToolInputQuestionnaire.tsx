import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ApprovalResponse } from "../../types";
import {
  buildToolInputResponseFromSelections,
  defaultToolInputSelections,
  parseToolInputQuestions,
  toolInputQuestionAllowsCustomAnswer,
  type ToolInputSelections,
} from "./toolInputApproval";

interface Props {
  details: Record<string, unknown>;
  onSubmit: (response: ApprovalResponse) => boolean | void | Promise<boolean | void>;
  onStop?: () => void | Promise<void>;
  submitLabel?: string;
  draftKey?: string;
}

interface QuestionnaireDraft {
  signature: string;
  selectedByQuestion: ToolInputSelections;
  customByQuestion: Record<string, string>;
  currentQuestionIndex: number;
}

const MAX_LIVE_QUESTIONNAIRE_DRAFTS = 64;
const liveQuestionnaireDrafts = new Map<string, QuestionnaireDraft>();

function readLiveQuestionnaireDraft(
  draftKey: string | undefined,
  signature: string,
): QuestionnaireDraft | null {
  if (!draftKey) return null;
  const draft = liveQuestionnaireDrafts.get(draftKey);
  return draft?.signature === signature ? draft : null;
}

function writeLiveQuestionnaireDraft(draftKey: string, draft: QuestionnaireDraft): void {
  liveQuestionnaireDrafts.delete(draftKey);
  liveQuestionnaireDrafts.set(draftKey, draft);
  while (liveQuestionnaireDrafts.size > MAX_LIVE_QUESTIONNAIRE_DRAFTS) {
    const oldestKey = liveQuestionnaireDrafts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    liveQuestionnaireDrafts.delete(oldestKey);
  }
}

export function resetLiveQuestionnaireDraftsForTests(): void {
  liveQuestionnaireDrafts.clear();
}

function questionSignature(questions: ReturnType<typeof parseToolInputQuestions>): string {
  return questions.map((question) => JSON.stringify({
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multiple: question.multiple,
    custom: question.custom,
    secret: question.secret,
  })).join("|");
}

function visibleOptionLabel(label: string): string {
  return label.replace(/\s*\(recommended\)\s*$/i, "").trim();
}

export function ToolInputQuestionnaire({
  details,
  onSubmit,
  onStop,
  submitLabel = "Send answers",
  draftKey,
}: Props) {
  const questions = useMemo(() => parseToolInputQuestions(details), [details]);
  const signature = useMemo(() => questionSignature(questions), [questions]);
  const initialDraft = readLiveQuestionnaireDraft(draftKey, signature);
  const [selectedByQuestion, setSelectedByQuestion] = useState<ToolInputSelections>(() =>
    initialDraft?.selectedByQuestion ?? defaultToolInputSelections(questions),
  );
  const [customByQuestion, setCustomByQuestion] = useState<Record<string, string>>(
    () => initialDraft?.customByQuestion ?? {},
  );
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(
    () => initialDraft?.currentQuestionIndex ?? 0,
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const draft = readLiveQuestionnaireDraft(draftKey, signature);
    setSelectedByQuestion(draft?.selectedByQuestion ?? defaultToolInputSelections(questions));
    setCustomByQuestion(draft?.customByQuestion ?? {});
    setCurrentQuestionIndex(draft?.currentQuestionIndex ?? 0);
    setSubmitting(false);
  }, [draftKey, signature]); // eslint-disable-line react-hooks/exhaustive-deps -- signature is the stable request identity

  useEffect(() => {
    if (!draftKey) return;
    writeLiveQuestionnaireDraft(draftKey, {
      signature,
      selectedByQuestion,
      customByQuestion,
      currentQuestionIndex,
    });
  }, [currentQuestionIndex, customByQuestion, draftKey, selectedByQuestion, signature]);

  if (questions.length === 0) return null;

  const safeQuestionIndex = Math.min(currentQuestionIndex, questions.length - 1);
  const question = questions[safeQuestionIndex];
  const selectedAnswers = selectedByQuestion[question.id] ?? [];
  const customAnswer = customByQuestion[question.id] ?? "";
  const allowsCustomAnswer = toolInputQuestionAllowsCustomAnswer(question);
  const isLastQuestion = safeQuestionIndex === questions.length - 1;
  const canAdvance = selectedAnswers.length > 0 || (allowsCustomAnswer && customAnswer.trim().length > 0);

  function selectOption(label: string) {
    setSelectedByQuestion((current) => {
      const currentAnswers = current[question.id] ?? [];
      const selected = currentAnswers.includes(label);
      const nextAnswers = question.multiple
        ? selected
          ? currentAnswers.filter((answer) => answer !== label)
          : [...currentAnswers, label]
        : [label];
      return { ...current, [question.id]: nextAnswers };
    });
  }

  async function advance() {
    if (!canAdvance || submitting) return;
    if (!isLastQuestion) {
      setCurrentQuestionIndex((current) => Math.min(current + 1, questions.length - 1));
      return;
    }

    setSubmitting(true);
    try {
      const accepted = await onSubmit(buildToolInputResponseFromSelections(
        questions,
        selectedByQuestion,
        customByQuestion,
      ));
      if (accepted !== false && draftKey) {
        liveQuestionnaireDrafts.delete(draftKey);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function stop() {
    try {
      await onStop?.();
    } finally {
      if (draftKey) liveQuestionnaireDrafts.delete(draftKey);
    }
  }

  function handleAnswerKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void advance();
    }
  }

  return (
    <div className="codex-questionnaire" data-question-id={question.id}>
      <div className="codex-questionnaire-step">
        <span>Question {safeQuestionIndex + 1} of {questions.length}</span>
        {question.header && <strong>{question.header}</strong>}
      </div>

      <div className="codex-questionnaire-question">{question.question}</div>

      {question.options.length > 0 && (
        <div className="codex-questionnaire-options" role={question.multiple ? "group" : "radiogroup"}>
          {question.options.map((option) => {
            const selected = selectedAnswers.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                className={selected ? "selected" : ""}
                role={question.multiple ? "checkbox" : "radio"}
                aria-checked={selected}
                onClick={() => selectOption(option.label)}
              >
                <span>{visibleOptionLabel(option.label)}</span>
                {option.recommended && <small className="badge">Recommended</small>}
                {option.description && <small className="description">{option.description}</small>}
              </button>
            );
          })}
        </div>
      )}

      {allowsCustomAnswer && (
        question.secret ? (
          <input
            key={question.id}
            className="codex-questionnaire-answer"
            type="password"
            value={customAnswer}
            autoFocus
            autoComplete="off"
            placeholder="Type your answer…"
            aria-label={`Answer: ${question.question}`}
            onChange={(event) => setCustomByQuestion((current) => ({
              ...current,
              [question.id]: event.target.value,
            }))}
            onKeyDown={handleAnswerKeyDown}
          />
        ) : (
          <textarea
            key={question.id}
            className="codex-questionnaire-answer"
            rows={2}
            value={customAnswer}
            autoFocus
            placeholder={question.options.length > 0 ? "Or type another answer…" : "Type your answer…"}
            aria-label={`Answer: ${question.question}`}
            onChange={(event) => setCustomByQuestion((current) => ({
              ...current,
              [question.id]: event.target.value,
            }))}
            onKeyDown={handleAnswerKeyDown}
          />
        )
      )}

      <div className="codex-questionnaire-actions">
        <div>
          {onStop && (
            <button type="button" className="secondary danger" disabled={submitting} onClick={() => void stop()}>
              Stop turn
            </button>
          )}
          {safeQuestionIndex > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={submitting}
              onClick={() => setCurrentQuestionIndex((current) => Math.max(0, current - 1))}
            >
              Previous
            </button>
          )}
        </div>
        <button type="button" className="primary" disabled={!canAdvance || submitting} onClick={() => void advance()}>
          {submitting ? "Sending…" : isLastQuestion ? submitLabel : "Next"}
        </button>
      </div>
    </div>
  );
}
