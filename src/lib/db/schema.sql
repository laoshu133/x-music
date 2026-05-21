CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  songmid TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  album_name TEXT,
  album_id TEXT,
  interval TEXT,
  image_url TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, songmid)
);

CREATE TABLE IF NOT EXISTS track_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  quality TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_path TEXT,
  final_path TEXT,
  lyrics_path TEXT,
  cover_path TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  tagged_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track_id, quality)
);

CREATE INDEX IF NOT EXISTS idx_track_files_status ON track_files(status);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_type ON jobs(status, type);

CREATE TABLE IF NOT EXISTS play_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  quality TEXT NOT NULL,
  played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_play_events_played_at ON play_events(played_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS favorite_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  desired_state TEXT NOT NULL,
  sync_state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track_id)
);

CREATE TABLE IF NOT EXISTS qq_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cookie TEXT NOT NULL,
  uin TEXT NOT NULL,
  encrypted_uin TEXT,
  qqmusic_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  qq_uin TEXT PRIMARY KEY,
  qq_cookie TEXT NOT NULL,
  encrypted_uin TEXT,
  qqmusic_key TEXT,
  emby_user_id TEXT,
  emby_username TEXT NOT NULL,
  emby_password TEXT NOT NULL,
  emby_access_token TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_favorite_sync_state ON favorite_sync(sync_state, updated_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS remote_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_type TEXT NOT NULL,
  local_key TEXT NOT NULL,
  remote TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(local_type, local_key, remote)
);

CREATE INDEX IF NOT EXISTS idx_remote_mappings_remote ON remote_mappings(remote, remote_id);

CREATE TABLE IF NOT EXISTS sync_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_events_status_type ON sync_events(status, type, updated_at);
