-- 1. Budgets for a calendar range (overall or per category), next to the monthly ones.
--    scope 'days'  : the same days of every month, e.g. the 15th to the 30th (end before start wraps into the next month)
--    scope 'dates' : one exact range of dates
CREATE TABLE range_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE, -- NULL = all spending
  amount INTEGER NOT NULL,
  alert_pct INTEGER NOT NULL DEFAULT 80,
  scope TEXT NOT NULL CHECK (scope IN ('days', 'dates')),
  start_day INTEGER,
  end_day INTEGER,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. Free-form notes.
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX notes_order ON notes(pinned DESC, updated_at DESC);
