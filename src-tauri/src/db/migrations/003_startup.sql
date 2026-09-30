-- Recovery must inspect small metadata, not overflow pages containing complete
-- transcripts/images. This covering index serves both the global assistant
-- status scan and each thread's latest assistant lookup (including rowid ties).
CREATE INDEX IF NOT EXISTS idx_messages_runtime
  ON messages(role, thread_id, created_at DESC, status);

-- Status, usage, blocks and native turn ID updates do not change searchable text.
-- The old trigger re-tokenized the entire message for every such update.
DROP TRIGGER IF EXISTS messages_fts_update;
CREATE TRIGGER messages_fts_update
AFTER UPDATE OF content, thread_id, role ON messages
WHEN old.content IS NOT new.content
  OR old.thread_id IS NOT new.thread_id
  OR old.role IS NOT new.role
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, thread_id, role, searchable_text)
  VALUES ('delete', old.rowid, old.thread_id, old.role, COALESCE(old.content, ''));
  INSERT INTO messages_fts(rowid, thread_id, role, searchable_text)
  VALUES (new.rowid, new.thread_id, new.role, COALESCE(new.content, ''));
END;
