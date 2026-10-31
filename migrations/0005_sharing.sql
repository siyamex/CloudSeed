-- Sharing links, per-file sharing switch, abuse reports, and "link" messages for Telegram transfers.
ALTER TABLE files ADD COLUMN sharing_disabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE shared_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id           UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  -- Only a SHA-256 of the token is stored; the link itself is shown once, when it is created.
  token_hash        BYTEA NOT NULL UNIQUE,
  label             TEXT,
  -- public: anyone with the link. private: only people signed in to this CloudSeed instance.
  mode              TEXT NOT NULL DEFAULT 'public' CHECK (mode IN ('public','private')),
  expires_at        TIMESTAMPTZ NOT NULL,
  max_downloads     INT CHECK (max_downloads IS NULL OR max_downloads > 0),
  download_count    INT NOT NULL DEFAULT 0,
  access_count      INT NOT NULL DEFAULT 0,
  password_hash     TEXT,
  revoked_at        TIMESTAMPTZ,
  -- set by an administrator after an abuse report; the owner cannot undo it
  disabled_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_notified   BOOLEAN NOT NULL DEFAULT FALSE,
  last_accessed_at  TIMESTAMPTZ,
  last_download_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX shared_links_user_idx ON shared_links (user_id, created_at DESC);
CREATE INDEX shared_links_file_idx ON shared_links (file_id);
CREATE INDEX shared_links_expiry_idx ON shared_links (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE abuse_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id    UUID REFERENCES shared_links(id) ON DELETE SET NULL,
  file_name   TEXT,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('illegal','malware','copyright','privacy','other')),
  details     TEXT,
  -- one-way hash of the reporter's address, enough to spot floods without storing the address
  reporter_hash TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX abuse_reports_status_idx ON abuse_reports (status, created_at DESC);

-- A Telegram transfer item can be a message containing a download link instead of an uploaded file.
ALTER TABLE telegram_transfer_files DROP CONSTRAINT telegram_transfer_files_send_as_check;
ALTER TABLE telegram_transfer_files ADD CONSTRAINT telegram_transfer_files_send_as_check CHECK (send_as IN ('document','photo','video','audio','link'));
ALTER TABLE telegram_transfer_files ADD COLUMN share_id UUID REFERENCES shared_links(id) ON DELETE SET NULL;
