-- 0048 — M8 data controls (FR-105, FR-116; ADR-097 D5): spend caps per provider and the alerts
-- they fired, the retention sweeps, and the anchor that keeps a pruned audit chain verifiable.

-- A spend cap per account and provider kind (FR-116). Spend is the sum of `usage_event.cost_usd`
-- in the current period (UTC day or month) plus what "clear usage data" carried over for it.
CREATE TABLE spend_cap (
  account_id TEXT NOT NULL REFERENCES account (id),
  provider TEXT NOT NULL,
  limit_usd REAL NOT NULL CHECK (limit_usd > 0),
  period TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'month')),
  warn_at REAL NOT NULL DEFAULT 0.8 CHECK (warn_at > 0 AND warn_at < 1),
  hard_stop INTEGER NOT NULL DEFAULT 1,
  -- Spend of the period `carried_period_start` that "clear usage data" removed from usage_event.
  carried_usd REAL NOT NULL DEFAULT 0,
  carried_period_start TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- One row per cap, period and level: the warning and the "cap reached" notice fire once.
CREATE TABLE spend_alert (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  period_start TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('warning', 'reached')),
  spent_usd REAL NOT NULL,
  limit_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider, period_start, level)
);

-- The daily retention sweep (and sweeps the owner runs): what each item removed.
CREATE TABLE retention_sweep (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_json TEXT,
  error TEXT
);
CREATE INDEX idx_retention_sweep_started ON retention_sweep (started_at);

-- Where a pruned audit chain starts: the seq and hash of the last pruned entry. Verification walks
-- from here; only the retention sweep writes it, and its own audit entry records each prune.
CREATE TABLE audit_anchor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  pruned_at TEXT NOT NULL
);
