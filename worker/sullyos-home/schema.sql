-- worker/sullyos-home/schema.sql
CREATE TABLE IF NOT EXISTS home_messages (
  id TEXT PRIMARY KEY, char_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_messages_char_time ON home_messages(char_id, created_at);
CREATE TABLE IF NOT EXISTS home_memories (
  id TEXT PRIMARY KEY, char_id TEXT NOT NULL, room TEXT NOT NULL,
  summary TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS home_events (
  id TEXT PRIMARY KEY, char_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, disclosed_to_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS home_worlds (
  char_id TEXT PRIMARY KEY, facts TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS home_config (
  char_id TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
