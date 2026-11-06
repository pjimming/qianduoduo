CREATE TABLE screening_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled','startup','manual')),
  business_date TEXT NOT NULL,
  scheduled_at TEXT,
  idempotency_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','degraded','failed','interrupted')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  retry_at TEXT,
  rule_version TEXT NOT NULL,
  refresh_calendar_version TEXT NOT NULL,
  valuation_calendar_version TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  counts TEXT CHECK (counts IS NULL OR json_valid(counts)),
  health TEXT CHECK (health IS NULL OR json_valid(health)),
  input TEXT CHECK (input IS NULL OR json_valid(input)),
  error_code TEXT,
  error_message TEXT
) STRICT;
CREATE UNIQUE INDEX screening_scheduled_day ON screening_runs (business_date)
  WHERE trigger IN ('scheduled','startup');

CREATE TABLE screening_attempts (
  run_id INTEGER NOT NULL REFERENCES screening_runs (id),
  attempt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','degraded','failed','interrupted')),
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (run_id, attempt)
) STRICT;
CREATE UNIQUE INDEX screening_active_worker ON screening_attempts (status) WHERE status = 'running';

CREATE TABLE screening_nav_series (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  code TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (source, channel, code, content_hash),
  UNIQUE (id, source, channel, code)
) STRICT;
CREATE TABLE screening_nav_points (
  series_id INTEGER NOT NULL REFERENCES screening_nav_series (id),
  date TEXT NOT NULL,
  unit TEXT NOT NULL,
  cumulative TEXT,
  PRIMARY KEY (series_id, date)
) STRICT, WITHOUT ROWID;
CREATE TABLE screening_results (
  run_id INTEGER NOT NULL REFERENCES screening_runs (id),
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  category TEXT NOT NULL,
  term_days INTEGER,
  status TEXT NOT NULL CHECK (status IN ('eligible','watch','pending','rejected')),
  shortlisted INTEGER NOT NULL CHECK (shortlisted IN (0,1)),
  rank INTEGER,
  yield_1m REAL,
  performance_date TEXT,
  nav_date TEXT,
  nav_series_id INTEGER,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  PRIMARY KEY (run_id, source, channel, code),
  FOREIGN KEY (nav_series_id, source, channel, code) REFERENCES screening_nav_series (id, source, channel, code)
) STRICT, WITHOUT ROWID;
CREATE INDEX screening_rank ON screening_results (run_id, shortlisted, status, term_days, category, yield_1m DESC, channel, code);
CREATE INDEX screening_lookup ON screening_results (run_id, code, channel);
CREATE TABLE screening_evidence (
  run_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  channel TEXT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  url TEXT NOT NULL,
  hash TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (json_valid(summary)),
  PRIMARY KEY (run_id, source, channel, code, kind),
  FOREIGN KEY (run_id, source, channel, code) REFERENCES screening_results (run_id, source, channel, code)
) STRICT, WITHOUT ROWID;
CREATE TABLE screening_current (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_id INTEGER NOT NULL REFERENCES screening_runs (id)
) STRICT;
