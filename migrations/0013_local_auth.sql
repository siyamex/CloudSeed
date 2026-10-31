-- Password sign-in for the administrator account(s) created during first-run setup. Google remains the way everyone else signs in.
CREATE TABLE local_credentials (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- scrypt, never the password
  password_hash   TEXT NOT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
