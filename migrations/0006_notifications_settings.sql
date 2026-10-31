-- Email delivery state for notifications, and per-user settings.
ALTER TABLE notifications ADD COLUMN email_state TEXT CHECK (email_state IN ('sent','failed','skipped'));
ALTER TABLE notifications ADD COLUMN email_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN email_next_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX notifications_email_idx ON notifications (created_at) WHERE email_state IS NULL;

CREATE TABLE user_settings (
  user_id                    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_download_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  -- personal limits can only lower the server-wide limits, never raise them
  download_concurrency       INT CHECK (download_concurrency BETWEEN 1 AND 20),
  download_bandwidth_bps     BIGINT CHECK (download_bandwidth_bps >= 0),
  email_notifications        BOOLEAN NOT NULL DEFAULT FALSE,
  muted_kinds                TEXT[] NOT NULL DEFAULT '{}',
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
