-- One-time codes that hand a Google sign-in from the system browser (Chrome Custom Tab) back to the Android app.
-- Only a hash of the code is stored. The code is bound to a PKCE challenge, expires in minutes and works once.
CREATE TABLE app_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
