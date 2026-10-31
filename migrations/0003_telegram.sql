-- Telegram integration: bots (token encrypted at rest), destinations, and the transfer queue/history.
CREATE TABLE telegram_bots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_bot_id       BIGINT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT,
  -- AES-256-GCM blob; NULL once disconnected. Never returned by the API.
  token_enc       BYTEA,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invalid','disconnected')),
  blocked_until   TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tg_bot_id)
);

CREATE TABLE telegram_destinations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id        UUID NOT NULL REFERENCES telegram_bots(id) ON DELETE CASCADE,
  chat_id       BIGINT NOT NULL,
  username      TEXT,
  title         TEXT NOT NULL,
  chat_type     TEXT NOT NULL CHECK (chat_type IN ('group','supergroup','channel')),
  can_send      BOOLEAN NOT NULL DEFAULT FALSE,
  permissions   JSONB NOT NULL DEFAULT '{}',
  problem       TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  -- earliest time the next message may go to this chat (flood-limit pacing and 429 back-off)
  next_send_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, chat_id)
);
CREATE UNIQUE INDEX telegram_destinations_default_uq ON telegram_destinations (user_id) WHERE is_default;
CREATE INDEX telegram_destinations_user_idx ON telegram_destinations (user_id);

CREATE TABLE telegram_transfers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id                UUID REFERENCES telegram_bots(id) ON DELETE SET NULL,
  destination_id        UUID REFERENCES telegram_destinations(id) ON DELETE SET NULL,
  -- snapshots, so history stays meaningful after a destination or bot is removed
  bot_username          TEXT,
  destination_title     TEXT NOT NULL,
  destination_chat_id   BIGINT NOT NULL,
  destination_username  TEXT,
  destination_type      TEXT NOT NULL,
  caption               TEXT,
  method                TEXT NOT NULL DEFAULT 'auto' CHECK (method IN ('auto','document')),
  album                 BOOLEAN NOT NULL DEFAULT FALSE,
  state                 TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','uploading','sent','partial','failed','cancelled')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ
);
CREATE INDEX telegram_transfers_user_idx ON telegram_transfers (user_id, created_at DESC);

CREATE TABLE telegram_transfer_files (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id      UUID NOT NULL REFERENCES telegram_transfers(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position         INT NOT NULL,
  file_id          UUID REFERENCES files(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type        TEXT NOT NULL,
  -- a byte range of the source file; used when an oversized file is split into numbered parts
  part_offset      BIGINT NOT NULL DEFAULT 0,
  part_index       INT,
  part_count       INT,
  send_as          TEXT NOT NULL CHECK (send_as IN ('document','photo','video','audio')),
  album_key        UUID,
  caption          TEXT,
  state            TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','uploading','sent','failed','cancelled')),
  attempt          INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  bytes_sent       BIGINT NOT NULL DEFAULT 0,
  message_id       BIGINT,
  -- true when the outcome is unknown (the request may have been delivered); never retried without confirmation
  ambiguous        BOOLEAN NOT NULL DEFAULT FALSE,
  error_code       TEXT,
  error_message    TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX telegram_files_transfer_idx ON telegram_transfer_files (transfer_id, position);
CREATE INDEX telegram_files_claim_idx ON telegram_transfer_files (next_attempt_at) WHERE state = 'queued';
CREATE INDEX telegram_files_lease_idx ON telegram_transfer_files (lease_expires_at) WHERE state = 'uploading';
