-- Wallet database schema (Cloudflare D1 / SQLite).
-- Money is stored as integers in minor units (1 AZN = 100 qəpik).
-- Timestamps are ISO-8601 UTC strings; `local_date` is the calendar day in the owner's timezone.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  ip TEXT
);

CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'card' CHECK (type IN ('card', 'cash', 'savings', 'other')),
  institution TEXT,
  card_last4 TEXT,
  currency TEXT NOT NULL DEFAULT 'AZN',
  color TEXT,
  balance INTEGER,
  balance_at TEXT,
  include_in_totals INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX accounts_last4 ON accounts(card_last4);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  icon TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX categories_parent ON categories(parent_id);

-- "Merchant memory": every distinct merchant seen, with the category it maps to.
-- Filled by the user's corrections, built-in rules and AI; consulted before calling AI again.
CREATE TABLE merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT,
  ai_confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- User-defined rules (take priority over everything else).
CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  match_field TEXT NOT NULL DEFAULT 'merchant' CHECK (match_field IN ('merchant', 'description', 'any')),
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'equals', 'starts_with', 'regex')),
  pattern TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('in', 'out')),
  min_amount INTEGER,
  max_amount INTEGER,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  set_category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  set_kind TEXT CHECK (set_kind IN ('expense', 'income', 'transfer')),
  set_merchant_name TEXT,
  set_excluded INTEGER,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'AZN',
  amount_base INTEGER NOT NULL,
  orig_amount INTEGER,
  orig_currency TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  merchant_raw TEXT,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT,
  ai_confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  tags TEXT,
  excluded INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER,
  source TEXT NOT NULL,
  external_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tx_date ON transactions(local_date);
CREATE INDEX tx_category ON transactions(category_id, local_date);
CREATE INDEX tx_merchant ON transactions(merchant_id);
CREATE INDEX tx_account ON transactions(account_id, local_date);
CREATE INDEX tx_review ON transactions(needs_review) WHERE needs_review = 1;
CREATE UNIQUE INDEX tx_external_ref ON transactions(external_ref) WHERE external_ref IS NOT NULL;

-- Every notification received from the phone, kept for auditing and re-processing.
CREATE TABLE raw_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL UNIQUE,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'parsed', 'failed', 'ignored', 'duplicate')),
  parse_method TEXT,
  parse_result TEXT,
  error TEXT,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX raw_messages_status ON raw_messages(status, received_at);

-- Monthly budgets per category (the overall budget lives in settings).
CREATE TABLE budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL UNIQUE REFERENCES categories(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  alert_pct INTEGER NOT NULL DEFAULT 80,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- De-duplicates alerts (one per budget, period and threshold).
CREATE TABLE notifications_sent (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('weekly', 'monthly', 'manual')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  model TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX insights_created ON insights(created_at);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  month TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL
);
CREATE INDEX ai_usage_month ON ai_usage(month);

-- Official Central Bank of Azerbaijan (CBAR) exchange rates: 1 unit of `currency` = `rate` AZN.
CREATE TABLE fx_rates (
  date TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (date, currency)
);
