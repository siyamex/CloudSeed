-- Optional: send a user's notifications to one of their Telegram destinations (through their own bot).
ALTER TABLE user_settings ADD COLUMN telegram_notify_destination_id UUID REFERENCES telegram_destinations(id) ON DELETE SET NULL;

ALTER TABLE notifications ADD COLUMN tg_state TEXT CHECK (tg_state IN ('sent', 'failed', 'skipped'));
ALTER TABLE notifications ADD COLUMN tg_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN tg_next_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX notifications_tg_idx ON notifications (created_at) WHERE tg_state IS NULL;
