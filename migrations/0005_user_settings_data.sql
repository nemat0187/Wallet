-- Settings now belong to a user. The owner's existing settings (including TOTP and Telegram link, seed version)
-- move to user 1; only the Telegram bot's webhook secret stays installation-wide.
INSERT OR IGNORE INTO user_settings (user_id, key, value)
  SELECT 1, key, value FROM settings WHERE key <> 'telegram_webhook_secret';
DELETE FROM settings WHERE key <> 'telegram_webhook_secret';
