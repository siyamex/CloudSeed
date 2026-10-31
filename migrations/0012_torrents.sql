-- BitTorrent downloads: magnet links and .torrent files. The worker fetches the metadata, the user picks files, the worker
-- downloads them into a scratch folder and then imports them into the user's storage like any other file.
CREATE TABLE torrent_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           TEXT NOT NULL CHECK (source IN ('magnet', 'file')),
  magnet           TEXT,
  -- the .torrent file: uploaded by the user, or rebuilt from a magnet link once its metadata has arrived
  metainfo         BYTEA,
  info_hash        TEXT NOT NULL,
  name             TEXT,
  state            TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                     ('pending', 'metadata', 'awaiting_selection', 'queued', 'downloading', 'paused', 'importing', 'completed', 'failed', 'cancelled')),
  control          TEXT CHECK (control IN ('pause', 'cancel')),
  -- where the results go (NULL = top level) and the folder that was created for them
  folder_id        UUID REFERENCES folders(id) ON DELETE SET NULL,
  result_folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
  -- [{ "i": 0, "path": "dir/file.mkv", "size": 123, "selected": true }]
  files            JSONB NOT NULL DEFAULT '[]',
  total_bytes      BIGINT,
  selected_bytes   BIGINT,
  bytes_done       BIGINT NOT NULL DEFAULT 0,
  peers            INT NOT NULL DEFAULT 0,
  down_bps         BIGINT NOT NULL DEFAULT 0,
  up_bps           BIGINT NOT NULL DEFAULT 0,
  -- start downloading everything as soon as the metadata is known (still subject to the size and quota checks)
  auto_start       BOOLEAN NOT NULL DEFAULT FALSE,
  attempt          INT NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  imported_files   INT NOT NULL DEFAULT 0,
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
-- one live job per torrent per user (re-adding a finished one is fine)
CREATE UNIQUE INDEX torrent_jobs_live_uq ON torrent_jobs (user_id, info_hash) WHERE state NOT IN ('completed', 'failed', 'cancelled');
CREATE INDEX torrent_jobs_user_idx ON torrent_jobs (user_id, created_at DESC);
CREATE INDEX torrent_jobs_claim_idx ON torrent_jobs (next_attempt_at) WHERE state IN ('pending', 'queued');
