# Codex transcript v2: lossless capture and replay contract

Status: accepted for implementation on `feature/codex-transcript-v2`.

## Purpose

Panes must be able to reconstruct a Codex turn after a restart without depending on the
lossy legacy `ContentBlock` projection. The native app-server stream is the durable source;
the existing message blocks remain a compatibility projection until the v2 renderer ships.

The current Codex app-server contract defines `item/*` notifications as the source of truth
for turn items. `item/started` carries the initial item and `item/completed` carries the
authoritative final item. Deltas are ordered additions to an item, not replacements for the
completed item.

## Non-negotiable invariants

1. **Capture before projection.** A matching native notification or server request is sent to
   the transcript recorder before its derived `EngineEvent` is produced for the legacy UI.
2. **No storage truncation.** Native params, started/completed items, deltas, diffs, command
   output, errors, and structured tool results have no character cap in the v2 tables.
3. **Stable identity.** A local assistant message owns exactly one `codex_turns` row. Native
   `threadId`, `turnId`, and `itemId` values are retained independently.
4. **Stable order.** Each capture has a monotonically increasing source sequence. Events and
   chunks replay in `(source_sequence, chunk_index)` order.
5. **Idempotent replay.** Re-applying the same `(turn, source_sequence)` event is a no-op when
   its bytes match and an error when they conflict.
6. **Authoritative completion.** `item/completed` may differ from streamed deltas and always
   becomes the final item snapshot. The deltas remain available as the historical stream.
7. **Delta-before-start is valid.** A placeholder item may be created by a delta and enriched
   later by `item/started` or `item/completed`.
8. **Unknown means retained.** Unknown methods and unknown `ThreadItem.type` values are stored
   in `codex_turn_events`; unknown items also receive a normal `codex_turn_items` row.
9. **UI limits are not storage limits.** Paging, virtualization, and preview caps may be used
   by renderers. They never mutate or replace the native ledger.
10. **One projector.** Live rendering, history reload, recovery, and deterministic fixture
    replay will consume the same ordered snapshot API.

## Durability boundary

The lossless guarantee begins when a conversation-scoped JSON-RPC line is successfully read
from the Codex app-server stdout pipe. Panes does not promise to reconstruct data that an older
Panes version already truncated or data that Codex never emitted.

The recorder uses a bounded, backpressured channel and batched SQLite transactions. Normal turn
completion closes and joins the recorder so all accepted events are committed before the turn
is considered fully drained. Process or hardware failure can still lose the currently executing
SQLite transaction; WAL and SQLite durability govern that failure window.

## Native-to-local flow

```text
Codex JSONL stdout
  -> exact RawValue params
  -> lossless turn-scoped router
  -> CodexNativeEvent (ordered)
  -> batched SQLite recorder
  -> codex_turns / codex_turn_events / codex_turn_items / codex_item_stream_chunks
  -> legacy EngineEvent mapper (temporary dual-write)
  -> current ContentBlock renderer (temporary)
```

The legacy mapper may continue to trim data for an in-memory preview. It must never be the only
copy of native data.

## Tables

### `codex_turns`

One row per local assistant message and native Codex turn. It owns lifecycle state, native IDs,
the latest plan and usage snapshots, exact turn-start/turn-complete params, and the last accepted
source sequence.

### `codex_turn_events`

Append-only ordered native envelopes. It stores event kind, method, optional request ID, exact
params JSON, observed time, and source sequence. The uniqueness constraint on turn and sequence
is the replay idempotency boundary.

### `codex_turn_items`

One row per native `itemId`. It stores type, phase, status, first/last sequence, and complete
started/completed item JSON. Completed JSON is authoritative.

### `codex_item_stream_chunks`

Ordered decoded content chunks associated with their native event. It covers agent text, plans,
reasoning summaries/content, command/file output, terminal input, MCP progress, and realtime
transcript text. Raw event JSON remains available for fields not yet projected.

## Schema drift policy

`scripts/codex-app-server-contract.json` is the reviewed inventory of the installed app-server
surface. `pnpm check:codex-schema` generates the current CLI schema and fails when:

- a known item disappears;
- an unreviewed item appears;
- a required conversation notification disappears; or
- the raw fallback/storage hooks are removed.

A new Codex item is never dropped at runtime: the raw fallback stores it. Updating the reviewed
inventory is nevertheless required so schema changes are visible during development.

## Rollout

Phase 1 is additive and dual-write. It does not delete legacy blocks, rewrite existing messages,
or switch the renderer. Later phases may read v2 snapshots behind a feature flag. The legacy
reader remains for pre-v2 history even after the renderer switches.

## Phase 1 acceptance gates

- Exact preservation of an output payload larger than all legacy caps.
- Exact event and chunk order after database close/reopen.
- Duplicate replay is idempotent; conflicting duplicate sequence fails loudly.
- Completion without start and delta before start both produce valid item snapshots.
- Completed item JSON replaces started state without deleting streamed chunks.
- Every reviewed `ThreadItem` type and an unknown future type survive replay.
- Existing-database migration is idempotent.
- Windows schema generation and parity checks pass against the installed Codex CLI.

