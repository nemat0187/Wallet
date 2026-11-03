-- Where each exchange rate came from ('cbar' = Central Bank of Azerbaijan, 'er-api' = open.er-api.com fallback,
-- 'carried' = the nearest earlier rate copied to a day without a published one) and when it was stored.
ALTER TABLE fx_rates ADD COLUMN source TEXT NOT NULL DEFAULT 'cbar';
ALTER TABLE fx_rates ADD COLUMN fetched_at TEXT;
