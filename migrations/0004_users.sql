-- Multi-user foundation. Everything that exists today becomes user 1 (the owner, an admin).
-- Until registration exists (a later release) user 1 is the only user, so this changes nothing visible.
--
-- user_id columns default to 1 so code that has not been converted yet keeps working unchanged.
-- (No REFERENCES clause: SQLite requires a NULL default for that, and the app enforces the link.)
--
-- Columns that are UNIQUE across the whole table (categories.slug, merchants.key, raw_messages.body_hash,
-- notifications_sent.key) cannot be changed in place without dropping parent tables, which would cascade-delete
-- budgets and categories' dependants. The owner keeps the existing values; other users get a per-user suffix
-- or salt added by the app (see worker/lib/userkeys.ts).

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,              -- NULL for the owner until they add one
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  approved_at TEXT
);

INSERT INTO users (id, email, name, role, status, created_at, approved_at)
VALUES (1, NULL, 'Owner', 'admin', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE accounts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE categories ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE merchants ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rules ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE transactions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE raw_messages ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE budgets ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE range_budgets ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dashboards ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notes ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE insights ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_usage ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE api_tokens ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications_sent ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

-- Per-user settings (the old global `settings` table keeps only truly global keys after the next step).
CREATE TABLE user_settings (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Lookups are always "this user's rows".
CREATE INDEX tx_user_date ON transactions(user_id, local_date);
CREATE INDEX accounts_user ON accounts(user_id);
CREATE INDEX categories_user ON categories(user_id);
CREATE INDEX merchants_user ON merchants(user_id);
CREATE INDEX rules_user ON rules(user_id);
CREATE INDEX raw_messages_user ON raw_messages(user_id, status);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
