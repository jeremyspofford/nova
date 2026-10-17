-- 0010 — M3 memory consolidation (FR-204, FR-205, ADR-069; docs/06 memory_consolidation_run,
-- docs/09 §5). All timestamps UTC ISO-8601, ids UUIDv7. memory_item.consolidation_run_id
-- (0004) stays a plain column: runs are history and items outlive them.

-- One phase of one consolidation job for one scope. The summary injected into context for a
-- scope is the latest completed 'consolidate' run's; a user correction, dismissal or deletion of
-- an item clears the summaries of its scope until the next run writes a fresh one.
CREATE TABLE memory_consolidation_run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'agent')),
  scope_ref TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('extract', 'consolidate')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  threads_scanned INTEGER,
  items_created INTEGER,
  items_updated INTEGER,
  items_aged INTEGER,
  summary TEXT,
  summary_tokens INTEGER CHECK (summary_tokens IS NULL OR summary_tokens <= 2500),
  model_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (status = 'running' OR ended_at IS NOT NULL)
);
CREATE INDEX idx_consolidation_run_scope
  ON memory_consolidation_run (account_id, scope_kind, scope_ref, phase, started_at);
CREATE INDEX idx_consolidation_run_account ON memory_consolidation_run (account_id, started_at);

-- "Remember more / less about this topic" (FR-204). One row per topic instead of the docs/06
-- `memory.topicPreferences` setting; a topic set back to default is deleted. `topic_key` is the
-- case-folded topic used for matching.
CREATE TABLE memory_topic (
  account_id TEXT NOT NULL REFERENCES account (id),
  topic_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  preference TEXT NOT NULL CHECK (preference IN ('more', 'less')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, topic_key)
);

-- How far consolidation has read each thread: the last message (UUIDv7, time-ordered) it
-- scanned. A thread is read again only after new messages and a new idle window.
CREATE TABLE memory_thread_mark (
  thread_id TEXT PRIMARY KEY REFERENCES thread (id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account (id),
  last_message_id TEXT NOT NULL,
  run_id TEXT,
  updated_at TEXT NOT NULL
);
