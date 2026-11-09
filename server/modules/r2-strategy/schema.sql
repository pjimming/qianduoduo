-- Explicit migration only. Application startup must never execute this file.
CREATE TABLE r2_strategy_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  ledger_identity TEXT NOT NULL UNIQUE,
  activation_seq INTEGER NOT NULL CHECK (activation_seq >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('legacy','shadow','v9','suspended')),
  contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE r2_strategy_transitions (
  operation_key TEXT PRIMARY KEY,
  activation_seq INTEGER NOT NULL UNIQUE CHECK (activation_seq > 0),
  from_mode TEXT NOT NULL CHECK (from_mode IN ('legacy','shadow','v9','suspended')),
  to_mode TEXT NOT NULL CHECK (to_mode IN ('legacy','shadow','v9','suspended')),
  contract_hash TEXT NOT NULL CHECK (length(contract_hash) = 64),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE r2_fund_reservations (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES decision_proposals(id),
  decision_id INTEGER NOT NULL REFERENCES decision_log(id),
  leg_key TEXT NOT NULL CHECK (length(leg_key) > 0),
  activation_seq INTEGER NOT NULL CHECK (activation_seq > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  executed_cents INTEGER NOT NULL DEFAULT 0 CHECK (executed_cents >= 0),
  released_cents INTEGER NOT NULL DEFAULT 0 CHECK (released_cents >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','settled','released')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (executed_cents + released_cents <= amount_cents),
  CHECK ((state = 'active' AND executed_cents + released_cents < amount_cents)
    OR (state != 'active' AND executed_cents + released_cents = amount_cents)),
  UNIQUE(proposal_id, leg_key), UNIQUE(decision_id, leg_key)
) STRICT;
CREATE INDEX r2_reservations_active ON r2_fund_reservations(state, proposal_id);
CREATE TABLE r2_derivation_jobs (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  activation_seq INTEGER NOT NULL CHECK (activation_seq >= 0),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 65536),
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token TEXT UNIQUE, lease_until TEXT, retry_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((status = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status != 'running' AND lease_token IS NULL AND lease_until IS NULL)),
  UNIQUE(event_type, activation_seq, input_hash)
) STRICT;
CREATE INDEX r2_jobs_dispatch ON r2_derivation_jobs(status, retry_at, id);
CREATE TABLE r2_derivation_watermarks (
  event_type TEXT PRIMARY KEY,
  activation_seq INTEGER NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  job_id INTEGER NOT NULL REFERENCES r2_derivation_jobs(id),
  completed_at TEXT NOT NULL
) STRICT;
