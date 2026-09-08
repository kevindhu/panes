# Codex questions during execution

Codex has two distinct question delivery paths. Panes uses the existing
`item/tool/requestUserInput` request and response route for server requests.
The server's `isBlocking: false`
marks a nonblocking question. Missing flags and other approval methods remain
blocking, even if an unrelated method includes `isBlocking: false`.

Pending questions remain approval records for wire compatibility and transcript
recovery, but only blocking records contribute to `awaiting_approval`. Both the
frontend and Rust recovery logic apply this distinction. Answering one request
must preserve any other blocking request. Persisted approval state is authoritative
because answers can arrive independently of the streaming loop's block snapshot.

Blocking questions use the composer questionnaire. Nonblocking questions appear
in collapsible cards above the regular composer, with ongoing steering and Stop
controls available. All pending nonblocking requests are shown; selecting a
default option does not submit an answer. Plan selection and the local
"Implement this plan?" handoff remain separate from server questions.

Drafts use thread and request identity in either mode. The existing bounded
in-memory questionnaire cache preserves them during navigation and remounts;
it does not persist answer drafts across application restarts. Pending request
metadata remains in the database, and the existing runtime response route
rejects stale requests after a transport reset.

Server resolution, turn completion, and cancellation clear pending questions
through the existing lifecycle. A failed answer restores only that question,
preserving concurrent output and other answers. A late failure must not reopen
a request that has already resolved or a turn that has completed.

## Delivered asynchronous messages

`request_user_input_async` can emit an `agentMessage` item with `delivery: "async"`
and a `questions` array containing `title` and optional string `options`.
This is an ordinary item notification, not a server request. It creates no
approval record and has no JSON-RPC response ID. The native projector retains
its structured questions from the authoritative item, and the transcript renders
the shared questionnaire inline while leaving the composer available.

An explicit answer uses Codex desktop's text envelope:
`<send_user_message_question_reply>` containing a JSON array of
`{questionItemId, question, answer}`, followed by its closing tag.
For structured questions, `questionItemId` is the JSON encoding of
`["request_user_input_async", nativeItemId, questionIndex]`. It goes through the
existing user-input route: `turn/steer` while running, or a new user turn after
completion. Execution state is checked at submission time. There is no new RPC.

Answered state is reconstructed from saved user messages and accepted steers,
matched by question identity, and displayed as a collapsed answer summary.
The thread message window includes newer replies when the older question is
loaded; accepted steers in its native snapshot also supply answers. This works
after remount/reload and follows the retained history in forks and rollbacks.
There is no separately persisted answered flag. Reply envelopes are rendered
as readable question/answer text; their original stored text is preserved.
History normalization removes the duplicate user-message `content` when text
blocks exist. Answer reconstruction reads those canonical text blocks, falling
back to `content` only for records without text blocks. The navigation regression
uses the actual saved reply and `setActiveThread` to exercise this boundary.
No response is manufactured for `respond_to_approval`. A failed submission
retains the draft. A compatibility reader recognizes the exact single-option
quoted reply produced by the first Panes implementation, without interpreting
general follow-up messages or pasted prompts as answers.

Compatibility evidence: inspected the locally installed OpenAI Codex
26.901.6511.0 desktop app on 2026-09-06. Its async-question identity builder,
reply encoder/parser, and history reducer use this envelope and reconstruct
answers from user messages and accepted steering messages. This is observed
desktop behavior, not a claimed public app-server API guarantee. Keep the
format isolated in `src/lib/asyncQuestionMessages.ts` for future changes.

The regression fixture `src/lib/__fixtures__/codex-async-question.json` comes from
the reported "Fix Safe Room Win Teleport Race" session and exercises the actual
delivered-message shape rather than a synthetic server-request shape.
