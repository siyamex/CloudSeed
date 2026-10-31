-- History of backups made by the worker (on a schedule, or when an administrator asks for one).
CREATE TABLE backup_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger       TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'running', 'succeeded', 'failed')),
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  worker_id     TEXT,
  file_name     TEXT,
  bytes         BIGINT,
  row_count     INT,
  object_count  INT,
  missing_count INT NOT NULL DEFAULT 0,
  corrupt_count INT NOT NULL DEFAULT 0,
  -- the finished file was read back and decrypted completely, with every checksum matching
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  -- set when the file was removed by the retention rule
  pruned_at     TIMESTAMPTZ,
  error         TEXT
);
CREATE INDEX backup_runs_recent_idx ON backup_runs (requested_at DESC);
CREATE INDEX backup_runs_open_idx ON backup_runs (status) WHERE status IN ('requested', 'running');
