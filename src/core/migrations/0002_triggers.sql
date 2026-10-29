-- M2: decision templates (System 1, CONTRACTS §3) and the trigger engine (NOVA-SPEC §4,
-- CONTRACTS §6). Times are ISO-8601 UTC strings.

-- A versioned, cached schema for a recurring decision. At most one version of a template is
-- active; a draft is never served.
CREATE TABLE decision_template (
  template_id        TEXT NOT NULL,
  version            INTEGER NOT NULL CHECK (version >= 1),
  situation          TEXT NOT NULL,
  inputs             TEXT NOT NULL,      -- JSON {name: 'string'|'number'|'boolean'}
  questions          TEXT NOT NULL,      -- JSON [{id, type: 'choice', options} | {id, type: 'score', min, max}]
  escalation         TEXT NOT NULL,      -- JSON {confidence_floor}
  uses               INTEGER NOT NULL DEFAULT 0,
  agreed             INTEGER NOT NULL DEFAULT 0,
  disagreed          INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL CHECK (state IN ('draft','active','retired')),
  dry_runs           TEXT NOT NULL DEFAULT '[]', -- JSON [{inputs, expect?}], re-run by the verifier
  activation_task_id TEXT REFERENCES task(id),
  created_by         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE UNIQUE INDEX decision_template_active ON decision_template(template_id) WHERE state = 'active';

CREATE TABLE decision_template_event (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id TEXT NOT NULL,
  version     INTEGER NOT NULL,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT                       -- JSON
);
CREATE INDEX decision_template_event_template ON decision_template_event(template_id, seq);

-- The visible registry: every automation Nova runs is a row here, and can be paused or removed.
CREATE TABLE trigger_rule (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  class           TEXT NOT NULL CHECK (class IN ('proactive','event','heartbeat')),
  source          TEXT NOT NULL,         -- webhook:<name> | cron | nova
  cron            TEXT,
  action          TEXT NOT NULL,         -- JSON {kind: 'task', task} | {kind: 'message', text}
  dedup_window_s  INTEGER NOT NULL CHECK (dedup_window_s >= 0),
  cooldown_s      INTEGER NOT NULL CHECK (cooldown_s >= 0),
  paused          INTEGER NOT NULL DEFAULT 0,
  hook_token_hash TEXT,                  -- sha256 of the webhook token; the token itself is never stored
  last_due_at     TEXT,                  -- heartbeat: the last due time handled
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX trigger_rule_source ON trigger_rule(source) WHERE class = 'event';

-- Changes to the registry, appended. Kept after a rule is deleted.
CREATE TABLE trigger_rule_event (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT                           -- JSON
);
CREATE INDEX trigger_rule_event_rule ON trigger_rule_event(rule_id, seq);

-- One record per firing. The payload is not stored, only its hash. rule_id has no foreign key
-- so the history outlives a deleted rule.
CREATE TABLE trigger (
  trigger_id     TEXT PRIMARY KEY,
  rule_id        TEXT,
  class          TEXT NOT NULL CHECK (class IN ('reactive','proactive','event','heartbeat')),
  source         TEXT NOT NULL,
  payload_ref    TEXT,
  triage         TEXT,                   -- JSON {decision, reason, model}
  dedup_key      TEXT,
  claim_key      TEXT UNIQUE,            -- heartbeat: rule:<id>@<due>, so a due time runs once
  cooldown_until TEXT,
  ledger_task_id TEXT REFERENCES task(id),
  message_id     TEXT,
  at             TEXT NOT NULL
);
CREATE INDEX trigger_rule_at ON trigger(rule_id, at);

-- Proactive contact. Every message traces to the trigger that caused it.
CREATE TABLE message (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  text         TEXT NOT NULL,
  trigger_id   TEXT NOT NULL REFERENCES trigger(trigger_id),
  delivered_at TEXT,                     -- null while held for quiet hours
  read_at      TEXT
);
