CREATE TABLE IF NOT EXISTS codex_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  native_thread_id TEXT NOT NULL,
  native_turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  first_event_at_ms INTEGER,
  last_event_at_ms INTEGER,
  last_source_sequence INTEGER NOT NULL DEFAULT 0,
  started_json TEXT,
  completed_json TEXT,
  plan_json TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS codex_turn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  source_sequence INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  method TEXT NOT NULL,
  request_id TEXT,
  native_thread_id TEXT NOT NULL,
  native_turn_id TEXT,
  params_json TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(turn_id, source_sequence)
);

CREATE TABLE IF NOT EXISTS codex_turn_items (
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  phase TEXT,
  first_source_sequence INTEGER NOT NULL,
  last_source_sequence INTEGER NOT NULL,
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  started_json TEXT,
  completed_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(turn_id, item_id)
);

CREATE TABLE IF NOT EXISTS codex_item_stream_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES codex_turns(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES codex_turn_events(id) ON DELETE CASCADE,
  item_id TEXT,
  source_sequence INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  stream_kind TEXT NOT NULL,
  summary_index INTEGER,
  content TEXT NOT NULL,
  metadata_json TEXT,
  observed_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_codex_turns_thread
  ON codex_turns(thread_id, started_at_ms ASC);
CREATE INDEX IF NOT EXISTS idx_codex_turns_native
  ON codex_turns(native_thread_id, native_turn_id);
CREATE INDEX IF NOT EXISTS idx_codex_turn_events_order
  ON codex_turn_events(turn_id, source_sequence ASC);
CREATE INDEX IF NOT EXISTS idx_codex_turn_items_order
  ON codex_turn_items(turn_id, first_source_sequence ASC, item_id ASC);
CREATE INDEX IF NOT EXISTS idx_codex_item_chunks_order
  ON codex_item_stream_chunks(turn_id, source_sequence ASC, chunk_index ASC);
CREATE INDEX IF NOT EXISTS idx_codex_item_chunks_item
  ON codex_item_stream_chunks(turn_id, item_id, source_sequence ASC, chunk_index ASC);

