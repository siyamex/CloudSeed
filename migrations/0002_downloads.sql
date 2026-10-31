-- Download engine: durable job queue (Postgres-backed, claimed with FOR UPDATE SKIP LOCKED) and audit trail.
CREATE TABLE download_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  folder_id       UUID REFERENCES folders(id) ON DELETE SET NULL,
  filename        TEXT,
  on_conflict     TEXT NOT NULL DEFAULT 'rename' CHECK (on_conflict IN ('reject','rename','replace')),
  state           TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
                    ('pending','queued','resolving','downloading','paused','verifying','completed','failed','cancelled')),
  priority        SMALLINT NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 2),
  -- requested by the API for a job a worker is currently running; the worker acts on it within ~1s
  control         TEXT CHECK (control IN ('pause','cancel')),
  bytes_received  BIGINT NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  total_bytes     BIGINT CHECK (total_bytes >= 0),
  speed_bps       BIGINT NOT NULL DEFAULT 0,
  expected_sha256 TEXT CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  etag            TEXT,
  last_modified   TEXT,
  accepts_ranges  BOOLEAN,
  attempt         INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id       TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_code      TEXT,
  error_message   TEXT,
  file_id         UUID REFERENCES files(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX download_jobs_claim_idx ON download_jobs (priority DESC, created_at) WHERE state IN ('queued','pending');
CREATE INDEX download_jobs_user_idx ON download_jobs (user_id, created_at DESC);
CREATE INDEX download_jobs_user_updated_idx ON download_jobs (user_id, updated_at);
CREATE INDEX download_jobs_lease_idx ON download_jobs (lease_expires_at) WHERE state IN ('resolving','downloading','verifying');

CREATE TABLE download_job_events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  message    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX download_job_events_job_idx ON download_job_events (job_id, id);
