CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  tz TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  calc_method INTEGER NOT NULL DEFAULT 5,
  madhab INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS sleep_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL DEFAULT 0,
  is_nap INTEGER NOT NULL DEFAULT 0,
  efficiency_pct REAL,
  source TEXT NOT NULL,
  raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS sleep_stages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sleep_sessions(id),
  stage TEXT NOT NULL CHECK (stage IN ('awake','light','deep','rem')),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heart_rate_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ts_utc TEXT NOT NULL,
  bpm REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS hrv_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ts_utc TEXT NOT NULL,
  rmssd_ms REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS spo2_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  ts_utc TEXT NOT NULL,
  pct REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS prayer_timetable (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date_local TEXT NOT NULL,
  prayer TEXT NOT NULL,
  time_utc TEXT NOT NULL,
  method INTEGER NOT NULL,
  source_json TEXT,
  UNIQUE (user_id, date_local, prayer, method)
);

CREATE TABLE IF NOT EXISTS alarm_policies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  prayer TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  window_min INTEGER NOT NULL DEFAULT 45,
  deadline_offset_min INTEGER NOT NULL DEFAULT 20,
  preferred_stages_json TEXT NOT NULL DEFAULT '["light","awake"]',
  snooze_min INTEGER NOT NULL DEFAULT 5,
  max_snoozes INTEGER NOT NULL DEFAULT 2,
  UNIQUE (user_id, prayer)
);

CREATE TABLE IF NOT EXISTS alarm_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  policy_id TEXT NOT NULL REFERENCES alarm_policies(id),
  type TEXT NOT NULL CHECK (type IN ('scheduled','fired','snoozed','dismissed')),
  reason TEXT,
  ts_utc TEXT NOT NULL,
  detail_json TEXT
);

-- Append-only substrate for future AI-agent optimization (see docs/SPEC.md §5)
CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  ts_utc TEXT NOT NULL,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_stages_session ON sleep_stages(session_id);
CREATE INDEX IF NOT EXISTS idx_hr_user_ts ON heart_rate_samples(user_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_timetable_user_date ON prayer_timetable(user_id, date_local);
CREATE INDEX IF NOT EXISTS idx_alarm_events_user ON alarm_events(user_id, ts_utc);
CREATE INDEX IF NOT EXISTS idx_event_log_user ON event_log(user_id, ts_utc);
