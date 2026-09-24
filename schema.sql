CREATE TABLE IF NOT EXISTS drops (
  listing_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price INTEGER,
  location TEXT,
  listed_at TEXT,
  url TEXT,
  take TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
