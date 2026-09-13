-- SullyOS 透视窗 · D1 schema（用户自建实例）
-- Worker 启动时自动建表（加性）；也可手动：
--   wrangler d1 create sullyos-perspective
--   wrangler d1 execute sullyos-perspective --file schema.sql

CREATE TABLE IF NOT EXISTS pv_devices (
  device_id    TEXT PRIMARY KEY,
  device_name  TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pv_role_tokens (
  token_hash TEXT PRIMARY KEY,
  char_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pv_role_tokens_device ON pv_role_tokens(device_id);

CREATE TABLE IF NOT EXISTS pv_sessions (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  platform    TEXT NOT NULL,
  source      TEXT NOT NULL,
  app_key     TEXT NOT NULL,
  app_label   TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pv_sessions_device_started ON pv_sessions(device_id, started_at);

CREATE TABLE IF NOT EXISTS pv_summaries (
  id                TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  window_start      INTEGER NOT NULL,
  window_end        INTEGER NOT NULL,
  session_count     INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  summary           TEXT NOT NULL,
  model             TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pv_summaries_device_end ON pv_summaries(device_id, window_end);

CREATE TABLE IF NOT EXISTS pv_ratelimit (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
