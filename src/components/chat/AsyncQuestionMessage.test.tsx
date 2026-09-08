// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import captured from "../../lib/__fixtures__/codex-async-question.json";
import savedReply from "../../lib/__fixtures__/codex-async-question-reply.json";
import { AsyncQuestionMessage } from "./AsyncQuestionMessage";
import { useChatStore } from "../../stores/chatStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { resetLiveQuestionnaireDraftsForTests } from "./ToolInputQuestionnaire";
import { asyncQuestionReply, parseAsyncQuestionReply } from "../../lib/asyncQuestionMessages";
import type { Message } from "../../types";

function replyMessage(content: string, threadId = "thread"): Message {
  return { id: "reply", threadId, role: "user", content, status: "completed", schemaVersion: 1, createdAt: "2026-09-06" };
}

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const history = vi.hoisted(() => vi.fn());
vi.mock("../../lib/codexIpc", () => ({ ipc: { getThreadMessagesWindow: history }, listenThreadEvents: vi.fn(async () => () => {}) }));
const roots: ReturnType<typeof createRoot>[] = [];

it("keeps the recorded fork answer resolved through real history normalization and thread navigation", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const reply = savedReply as Message;
  const owner: Message = { id: "9a71efd6-d2da-4241-a3f6-3c921225af40", threadId: reply.threadId,
    role: "assistant", status: "completed", schemaVersion: 1, createdAt: "2026-09-07 00:19:12.001" };
  history.mockImplementation(async (threadId: string) => ({ messages: threadId === reply.threadId ? [owner, reply] : [], nextCursor: null }));
  useChatStore.setState({ threadId: reply.threadId, streaming: false, status: "completed", messages: [owner, reply] });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  const render = () => root.render(<AsyncQuestionMessage threadId={reply.threadId} itemId={captured.id} messageId={owner.id} questions={captured.questions} />);
  await act(async () => render());
  expect(container.querySelector("summary")?.textContent).toContain("I’m not sure");
  await act(async () => { root.render(null); await useChatStore.getState().setActiveThread("other-thread"); });
  await act(async () => { await useChatStore.getState().setActiveThread(reply.threadId); render(); });
  expect(useChatStore.getState().messages.find((m) => m.id === reply.id)?.content).toBeUndefined();
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.querySelector("summary")?.textContent).toContain("I’m not sure");
  await act(async () => { root.render(null); await useChatStore.getState().setActiveThread(reply.threadId, { forceReload: true }); render(); });
  expect(container.querySelector('[role="radio"]')).toBeNull();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  resetLiveQuestionnaireDraftsForTests();
  useChatStore.setState({ messages: [] });
});

it.each([true, false])("renders the captured question and sends user input (running=%s)", async (streaming) => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const accept = async (text: string) => {
    useChatStore.setState({ messages: [replyMessage(text)] });
    return true;
  };
  const steer = vi.fn(accept);
  const send = vi.fn(accept);
  const approval = vi.fn();
  useChatStore.setState({ threadId: "thread", streaming, steer, send, respondApproval: approval });
  useThreadPlanModeStore.setState({ threadModes: { thread: "plan" } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<AsyncQuestionMessage threadId="thread" itemId={captured.id} questions={captured.questions} />));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(container.querySelector('.codex-questionnaire-answer')).not.toBeNull();
  expect(steer).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')][1]!;
  await act(async () => option.click());
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === "Send answers")!;
  await act(async () => button.click());
  expect(streaming ? steer : send).toHaveBeenCalledWith(
    expect.stringContaining('"answer":"On a mini-treadmill"'),
    expect.objectContaining({ threadIdOverride: "thread", planMode: true }),
  );
  expect(approval).not.toHaveBeenCalled();
  expect(container.textContent).toContain("asyncQuestions.sent");
  expect(container.querySelector('[role="radio"]')).toBeNull();
  const text = (streaming ? steer : send).mock.calls[0]![0];
  expect(parseAsyncQuestionReply(text)?.[0]?.questionItemId).toBe(JSON.stringify(["request_user_input_async", captured.id, 0]));
  // A fresh component must reconstruct the state from the persisted message.
  await act(async () => root.render(<AsyncQuestionMessage key="reload" threadId="thread" itemId={captured.id} questions={captured.questions} />));
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.textContent).toContain("On a mini-treadmill");
});

it("recognizes the already saved answer in the reported session, but not the copied prompt", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  const title = captured.questions[0]!.title;
  useChatStore.setState({ threadId: "thread", messages: [replyMessage(`>${title}\n\n${captured.questions[0]!.options.join("\n")}\nWere you trying to do a prompt here?`)] });
  await act(async () => root.render(<AsyncQuestionMessage threadId="thread" itemId={captured.id} questions={captured.questions} />));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  await act(async () => useChatStore.setState({ messages: [replyMessage(`> ${title}\n\nIn the safe room near its starting point`)] }));
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(container.querySelector("summary")?.textContent).toContain("In the safe room near its starting point");
});

it("isolates identities and threads and reconstructs only accepted steers", async () => {
  const content = asyncQuestionReply(captured.id, captured.questions, { answers: { "0": { answers: ["Custom answer"] } } })!;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  useChatStore.setState({ messages: [replyMessage(content, "other-thread")] });
  await act(async () => root.render(<AsyncQuestionMessage threadId="thread" itemId={captured.id} questions={captured.questions} />));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  await act(async () => useChatStore.setState({ messages: [{ ...replyMessage(content), pendingDelivery: true }] }));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  const message: Message = { ...replyMessage(""), role: "assistant", blocks: [{ type: "steer", steerId: "steer", content, status: "pending" }] };
  await act(async () => useChatStore.setState({ messages: [message] }));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  await act(async () => useChatStore.setState({ messages: [{ ...message, blocks: [{ type: "steer", steerId: "steer", content, status: "accepted" }] }] }));
  expect(container.querySelector('[role="radio"]')).toBeNull();
  await act(async () => root.render(<AsyncQuestionMessage threadId="thread" itemId="another-item" questions={captured.questions} />));
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  // Rollback removes the durable reply, so the question becomes answerable.
  await act(async () => { useChatStore.setState({ messages: [] }); root.render(<AsyncQuestionMessage threadId="thread" itemId={captured.id} questions={captured.questions} />); });
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
});

it("uses current execution state and preserves the form on rejected delivery", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const send = vi.fn(async () => false);
  const steer = vi.fn();
  useChatStore.setState({ threadId: "thread", streaming: true, send, steer });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<AsyncQuestionMessage threadId="thread" itemId={captured.id} questions={captured.questions} />));
  useChatStore.setState({ streaming: false });
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === "Send answers")!;
  await act(async () => button.click());
  expect(steer).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
