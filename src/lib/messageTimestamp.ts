const SQLITE_MESSAGE_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function parseMessageCreatedAtTimestamp(createdAt: string): number | null {
  // SQLite's timezone-less timestamps are UTC, just like the ISO message dates.
  const normalized = SQLITE_MESSAGE_TIMESTAMP_PATTERN.test(createdAt)
    ? `${createdAt.replace(" ", "T")}Z`
    : createdAt;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
