-- Foundation: identity, sessions, RBAC, storage metadata, audit, notifications, settings.

CREATE TABLE roles (
  id   SMALLINT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT INTO roles (id, name) VALUES (1, 'user'), (2, 'admin');

CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email)) WHERE status <> 'deleted';

CREATE TABLE user_profiles (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url   TEXT,
  theme        TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- Identity is keyed on (provider, subject). Email is never used to link accounts.
CREATE TABLE oauth_accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);

-- Only a SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   BYTEA NOT NULL UNIQUE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Short-lived OAuth login attempts (state/nonce/PKCE verifier), single use.
CREATE TABLE oauth_login_states (
  state_hash    BYTEA PRIMARY KEY,
  nonce         TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to   TEXT NOT NULL DEFAULT '/',
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE storage_providers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       TEXT NOT NULL CHECK (kind IN ('local','s3')),
  name       TEXT NOT NULL UNIQUE,
  config     JSONB NOT NULL DEFAULT '{}',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX storage_providers_default_uq ON storage_providers (is_default) WHERE is_default;

CREATE TABLE storage_quotas (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quota_bytes BIGINT NOT NULL CHECK (quota_bytes >= 0),
  used_bytes  BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);

CREATE TABLE folders (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name NOT LIKE '%/%'),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unique sibling names among live folders (root parent coalesced to the nil UUID).
CREATE UNIQUE INDEX folders_sibling_name_uq
  ON folders (user_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX folders_parent_idx ON folders (user_id, parent_id);

CREATE TABLE files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id   UUID REFERENCES folders(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name NOT LIKE '%/%'),
  size_bytes  BIGINT NOT NULL CHECK (size_bytes >= 0),
  mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
  sha256      TEXT,
  storage_provider_kind TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('uploading','ready','failed')),
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX files_sibling_name_uq
  ON files (user_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'), lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX files_folder_idx ON files (user_id, folder_id, name);
CREATE INDEX files_created_idx ON files (user_id, created_at DESC);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  ip         TEXT,
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE TABLE application_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO application_settings (key, value) VALUES
  ('registration_policy', '"open"');
