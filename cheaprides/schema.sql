-- 406CheapRides D1 schema.
-- Apply locally: wrangler d1 execute cheaprides-db --local --file=schema.sql
-- Apply remote:  wrangler d1 execute cheaprides-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_confirmed INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'monthly', 'yearly', 'sms')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  paid_until TEXT,
  trial_end TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  sms_phone TEXT,
  categories TEXT NOT NULL DEFAULT '[]',
  confirm_token_hash TEXT,
  confirm_token_expires_at TEXT,
  unsubscribe_token_hash TEXT,
  alert_opt_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_subscribers_customer ON subscribers (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscribers_subscription ON subscribers (stripe_subscription_id);

-- Idempotency for Stripe webhooks. event_id is the Stripe event id.
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions (email);

CREATE TABLE IF NOT EXISTS listings (
  listing_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  make TEXT,
  model TEXT,
  price INTEGER,
  previous_price INTEGER,
  drop_flag INTEGER NOT NULL DEFAULT 0,
  categories TEXT NOT NULL DEFAULT '[]',
  deal_score_text TEXT,
  deal_delta_usd INTEGER,
  city TEXT,
  state TEXT,
  mileage INTEGER,
  hero_photo_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_listings_feed ON listings (active, seen_at);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  previous_price INTEGER,
  seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (listing_id) REFERENCES listings (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history (listing_id, seen_at);
