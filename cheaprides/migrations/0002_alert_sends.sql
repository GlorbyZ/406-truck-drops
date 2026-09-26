-- Apply on an existing cheaprides-db that already has schema.sql from the first release.
-- Fresh databases can use schema.sql, which includes this table.
-- wrangler d1 execute cheaprides-db --remote --file=migrations/0002_alert_sends.sql

CREATE TABLE IF NOT EXISTS alert_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL,
  listing_id TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (subscriber_id, listing_id, event),
  FOREIGN KEY (subscriber_id) REFERENCES subscribers (id)
);

CREATE INDEX IF NOT EXISTS idx_alert_sends_listing ON alert_sends (listing_id, event);
