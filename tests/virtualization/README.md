# Transcript virtualization checks

Run `pnpm exec vite --config tests/virtualization/vite.config.ts`, then open
`http://localhost:1430/tests/virtualization/` and press **Run scroll checks**.
This uses the production virtualizer, disclosure store, and selection controller
in a real browser. It does not connect to an engine or modify a session.

The eleven checks cover the initial bottom position, upward intent within 160px of
the bottom, delayed height growth above the reader, prepending history, width
reflow, session remount, delayed native hydration, retained expansion, selection within a giant turn,
retained keyboard focus, and explicit return to following output. Anchor checks
allow at most 2 CSS pixels of drift. Mounted-row counts must remain bounded,
including when text is selected. The harness intentionally uses variable heights
and groups 200 rows under a single message ID.

## Local session replay

`http://localhost:1430/tests/virtualization/session.html` renders the production
native transcript components and CSS against a local fixture. Use **Load local
audit fixture**, then **Run session checks**. The fixture is intentionally absent
from Git. It reads `.agent-workspace/virtualization-session.json` from this
checkout. Native image assets and exact raw-event IPC require the desktop app;
the browser fixture tests the semantic timeline and layout.

To export another fixture, first make a disposable database copy with the desired
session and its native transcript tables. Do not point this helper at production:
`Database::open` applies normal migrations to the copy.

From `src-tauri`, set `PANES_SCROLL_AUDIT_DB` to the absolute copy path,
`PANES_SCROLL_AUDIT_THREAD` to the local thread ID, and
`PANES_SCROLL_AUDIT_OUTPUT` to the absolute
`.agent-workspace/virtualization-session.json` path. Then run:

```powershell
cargo test --locked --lib export_local_virtualization_fixture -- --ignored --nocapture
```

The exporter exercises the actual display readers and reports serialized payload
sizes. Its elapsed time includes reading/serializing the full snapshots for
comparison, so it is not an app startup benchmark.

## Recorded verification, 2026-09-29

The synthetic checks passed with less than 0.6px anchor drift; selection retained
22 mounted rows. A disposable copy of **Review Assignment Documents** contained
117 messages, 56 native turns, 1,442 native items, 49,806 events, and 45,801 stream
chunks. Its native renderer produced 1,765 logical rows. The browser mounted 11
at the bottom and at most 29 during the tested history jumps. Narrowing the pane
and remounting preserved the anchor within 0.4px. These are observed test results,
not a guarantee for every viewport, font, session, or device.

For this session the display message DTOs totaled 163,193 bytes. Serialized native
snapshots fell from 192,641,646 bytes to 28,160,933 bytes. All session data remains
local and the production database was opened read-only during diagnosis/copying.

Frontend validation uses `pnpm typecheck` and
`pnpm exec vitest run --exclude '**/.agent-workspace/**'`. The exclusion prevents
unrelated cached plugin test suites in this local checkout from being collected.
Rust checks are `cargo fmt -- --check`, `cargo check --locked`, and the library
tests filtered to `codex_transcript`, `db::messages`, and
`commands::transcript_display`. Run `pnpm check:codex-schema` for the installed
CLI contract. The final run passed 469 frontend tests across 49 files, 39
relevant Rust tests, and the 19-item-type schema contract. The local export test
also passed when explicitly invoked.

The Tauri development app was launched successfully. Automated Windows UI
inspection was unavailable because the Computer Use native connection was absent.
Before merging, inspect the real desktop session with live output, image loading,
raw-event paging, pane resizing, and switching sessions while reading history.
No packaged executable is needed; restart `pnpm tauri:dev` after this change.
