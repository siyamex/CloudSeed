-- Operations: worker heartbeats (shown on the admin pages).
CREATE TABLE worker_heartbeats (
  id           TEXT PRIMARY KEY,
  role         TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pid          INT,
  host         TEXT,
  info         JSONB NOT NULL DEFAULT '{}'
);
