# Codex session lifetime and transport retries

Panes connects to `codex app-server` over local JSONL stdio. Codex owns the
upstream Responses WebSocket, reconnect attempts, and HTTP streaming fallback.
Panes leaves that transport selection and retry policy unchanged.

## Why idle subscriptions matter

On September 25, 2026, local Codex 0.156.0 logs and Panes turn timestamps showed
23 session shutdowns approximately 60 seconds after completion. Panes had been
unsubscribing after every turn based on an outdated assumption that Codex would
retain an unsubscribed runtime for 30 minutes. Recreating the runtime discards
its reusable connection and its session-scoped HTTP fallback decision.

The same session could therefore exhaust five WebSocket retries, finish over
HTTP, be unloaded during a short pause, and repeat the WebSocket failures on a
later turn. Earlier successful HTTP completions establish that this repeated
delay also occurred independently of the later 401 outage. The logs show remote
WebSocket closes before `response.completed`; they do not establish the
server-side reason for those closes.

## Panes retention policy

- Keep at most four idle chat runtimes subscribed, ordered by last completion.
- Release each after 30 minutes of inactivity, checked every 30 seconds.
- Release older idle runtimes immediately when the working set exceeds four.
- Remove a runtime from idle cleanup when a follow-up is being prepared, before
  Codex sends `turn/started`.
- Serialize reuse/resume and unsubscribe for the same thread and recheck cleanup
  eligibility after acquiring that lock. Unrelated threads use separate locks.
- Clear idle tracking when the transport is reset or Codex closes the thread.
- Continue releasing temporary title/fork/review runtimes through explicit cleanup.

This preserves Codex's existing recovery state for normal follow-ups without
keeping every visited thread and its MCP processes alive indefinitely. It cannot
prevent upstream outages, remote socket closes, or a fresh retry sequence after
an app restart or deliberate runtime eviction. No credentials, global Codex
provider settings, transcript events, or retry warnings are modified.

Regression coverage lives in `src-tauri/src/engines/codex_idle.rs` and the
`idle_subscription_*` tests in `src-tauri/src/engines/codex.rs`.
An isolated check against the installed CLI also started two threads without
model requests, unsubscribed one, and inspected `thread/loaded/list` after 70
seconds: the unsubscribed runtime was gone and the subscribed runtime remained.
