-- Media library: probe results (also the probe/thumbnail work queue), derived objects, playback progress, subtitle links.
CREATE TABLE media_metadata (
  file_id          UUID PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('video','audio')),
  -- pending -> processing -> ready | failed ; 'unsupported' = indexed but ffprobe could not read it
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed','unsupported')),
  duration_ms      BIGINT,
  width            INT,
  height           INT,
  container        TEXT,
  video_codec      TEXT,
  audio_codec      TEXT,
  bitrate          BIGINT,
  -- audio/subtitle/video streams as reported by ffprobe (index, codec, language, title, channels, default)
  streams          JSONB NOT NULL DEFAULT '[]',
  -- extra tags such as title/artist/album
  tags             JSONB NOT NULL DEFAULT '{}',
  title            TEXT,
  attempt          INT NOT NULL DEFAULT 0,
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_message    TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  probed_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_metadata_user_idx ON media_metadata (user_id, kind, created_at DESC);
CREATE INDEX media_metadata_claim_idx ON media_metadata (next_attempt_at) WHERE status = 'pending';
CREATE INDEX media_metadata_lease_idx ON media_metadata (lease_expires_at) WHERE status = 'processing';

-- Objects derived from a media file (thumbnail, extracted subtitles, transcoded renditions). They live in the same
-- storage backend, are charged to the owner's quota, and are removed with the source file.
CREATE TABLE media_assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('thumbnail','subtitle','rendition')),
  -- thumbnail: ''  subtitle: stream index  rendition: profile name
  variant          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('queued','processing','ready','failed')),
  storage_provider_kind TEXT,
  storage_key      TEXT,
  size_bytes       BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  mime_type        TEXT,
  progress         REAL NOT NULL DEFAULT 0,
  worker_id        TEXT,
  lease_expires_at TIMESTAMPTZ,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, kind, variant)
);
CREATE INDEX media_assets_user_idx ON media_assets (user_id);
CREATE INDEX media_assets_claim_idx ON media_assets (created_at) WHERE status = 'queued';

CREATE TABLE media_playback_progress (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id      UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position_ms  BIGINT NOT NULL CHECK (position_ms >= 0),
  duration_ms  BIGINT,
  completed    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, file_id)
);
CREATE INDEX media_progress_recent_idx ON media_playback_progress (user_id, updated_at DESC);

-- A subtitle file explicitly attached to a media file (same-folder files named like the video are found automatically).
CREATE TABLE media_subtitle_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_file_id    UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  subtitle_file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  label            TEXT,
  language         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (media_file_id, subtitle_file_id)
);
