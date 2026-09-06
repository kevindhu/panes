# Codex questions during execution

Panes uses the existing `item/tool/requestUserInput` request and response route
for blocking and asynchronous questions. The server's `isBlocking: false`
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
