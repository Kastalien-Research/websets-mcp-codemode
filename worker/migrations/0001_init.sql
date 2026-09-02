-- Buffered Exa webhook deliveries. `seq` is the pull cursor: AUTOINCREMENT
-- keeps it monotonic even after `DELETE FROM events WHERE seq <= ?` (ack)
-- empties the table, so a stale cursor from the puller can never collide
-- with a freshly inserted row.
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  signature TEXT,
  body TEXT NOT NULL
);

-- Supports the retention sweep: DELETE FROM events WHERE received_at < ?
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
