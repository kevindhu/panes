import { expect, it } from "vitest";
import { answersFromReply, asyncQuestionReply, displayAsyncQuestionReply, parseAsyncQuestionReply } from "./asyncQuestionMessages";

it("round-trips the Codex desktop envelope, including multiple and free-text answers", () => {
  const questions = [{ title: "Where?" }, { title: "Why?" }];
  const text = asyncQuestionReply("call_123", questions, { answers: {
    "0": { answers: ["Lobby"] }, "1": { answers: ['A \"race\"\nwith a callback'] },
  } })!;
  expect(text).toBe('<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_123\\",0]","question":"Where?","answer":"Lobby"},{"questionItemId":"[\\"request_user_input_async\\",\\"call_123\\",1]","question":"Why?","answer":"A \\"race\\"\\nwith a callback"}]\n</send_user_message_question_reply>');
  expect(answersFromReply("call_123", questions, text)).toEqual(["Lobby", 'A "race"\nwith a callback']);
  expect(answersFromReply("call_other", questions, text)).toEqual([null, null]);
  expect(displayAsyncQuestionReply(text)).toBe('> Where?\n\nLobby\n\n> Why?\n\nA "race"\nwith a callback');
});

it("accepts Codex's single-object reply and preserves malformed/ordinary text", () => {
  const text = '<send_user_message_question_reply>\n{"questionItemId":"id","question":"Q","answer":"A"}\n</send_user_message_question_reply>';
  expect(parseAsyncQuestionReply(text)).toEqual([{ questionItemId: "id", question: "Q", answer: "A" }]);
  for (const malformed of ["ordinary text", "<send_user_message_question_reply>[]</send_user_message_question_reply>", "<send_user_message_question_reply>{}</send_user_message_question_reply>", "<send_user_message_question_reply>oops</send_user_message_question_reply>"]) {
    expect(parseAsyncQuestionReply(malformed)).toBeNull();
    expect(displayAsyncQuestionReply(malformed)).toBe(malformed);
  }
});
