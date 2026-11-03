-- Savings goals: a name, a target amount, how much is saved so far (minor units) and an optional deadline.
CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  target INTEGER NOT NULL CHECK (target > 0),
  saved INTEGER NOT NULL DEFAULT 0 CHECK (saved >= 0),
  deadline TEXT,                  -- YYYY-MM-DD, optional
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_goals_user ON goals (user_id);
