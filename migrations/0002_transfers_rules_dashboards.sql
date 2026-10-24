-- 1. Transfers: every card is tracked on its own. Pairs that look like a transfer between the
--    owner's cards are only *suggested* (pair_id); they count as spending/income until the owner
--    tags them as "between my accounts". pair_id = id of the suggested counterpart; 0 = the owner
--    answered "not a transfer", so it is never suggested again.
ALTER TABLE transactions ADD COLUMN pair_id INTEGER;
ALTER TABLE transactions ADD COLUMN tx_type TEXT;
CREATE INDEX tx_pair ON transactions(pair_id) WHERE pair_id IS NOT NULL;

UPDATE transactions SET tx_type = CASE description
  WHEN 'Card payment' THEN 'purchase'
  WHEN 'Cash withdrawal' THEN 'cash_withdrawal'
  WHEN 'Transfer received' THEN 'transfer_in'
  WHEN 'Transfer sent' THEN 'transfer_out'
  WHEN 'Incoming payment' THEN 'income'
  WHEN 'Refund' THEN 'refund'
  WHEN 'Bank fee' THEN 'fee'
  ELSE NULL END;

-- Earlier versions tagged own-card transfers automatically. Keep the pairing as a suggestion…
UPDATE transactions SET pair_id = (
    SELECT o.id FROM transactions o
     WHERE o.id <> transactions.id AND o.kind = 'transfer' AND o.category_source = 'default'
       AND o.account_id IS NOT NULL AND o.account_id <> transactions.account_id
       AND o.amount_base = -transactions.amount_base
       AND ABS(julianday(o.occurred_at) - julianday(transactions.occurred_at)) <= 15.0 / 1440
     ORDER BY ABS(julianday(o.occurred_at) - julianday(transactions.occurred_at))
     LIMIT 1)
 WHERE kind = 'transfer' AND category_source = 'default'
   AND (tx_type IS NULL OR tx_type <> 'cash_withdrawal')
   AND category_id = (SELECT id FROM categories WHERE slug = 'transfer.own');

-- …and undo the automatic tagging: money out is an expense, money in is income.
UPDATE transactions
   SET kind = CASE WHEN amount_base > 0 THEN 'income' ELSE 'expense' END,
       category_id = (SELECT id FROM categories WHERE slug = CASE WHEN transactions.amount_base > 0 THEN 'income.transfer' ELSE 'people' END),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE kind = 'transfer' AND category_source = 'default'
   AND (tx_type IS NULL OR tx_type <> 'cash_withdrawal')
   AND category_id = (SELECT id FROM categories WHERE slug = 'transfer.own');

-- Clearer names for card-to-card transfers (only if the owner hasn't renamed them).
UPDATE categories SET name = 'Transfers sent' WHERE slug = 'people' AND name = 'Payments to people';
UPDATE categories SET name = 'Transfers received' WHERE slug = 'income.transfer' AND name = 'Money received';

-- 2. Rules with several conditions and more actions.
ALTER TABLE rules ADD COLUMN conditions TEXT;
ALTER TABLE rules ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE rules ADD COLUMN set_tags TEXT;
ALTER TABLE rules ADD COLUMN set_note TEXT;
ALTER TABLE rules ADD COLUMN continue_after INTEGER NOT NULL DEFAULT 0;

-- 3. Custom dashboards (widgets stored as JSON).
CREATE TABLE dashboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  widgets TEXT NOT NULL DEFAULT '[]',
  show_on_home INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
