-- 0007 — M3 policy and approvals (docs/06 §2 "tools, approvals, permissions"; docs/12 §2-§4,
-- §7.1; FR-048, FR-099, FR-100, FR-189, FR-190, FR-191). All timestamps UTC ISO-8601, ids UUIDv7.
-- Thread, turn, run, agent and tool-call ids are plain columns (no FK): approvals outlive purged
-- threads (audit), may precede their tool_call row, and runs and agents arrive in M4-M5.

-- Tool and resource rules (contracts/schemas/policy-rule.json). `action_match` is the schema's
-- `match` object. Managed rules (source 'managed') are read-only in the API.
CREATE TABLE policy_rule (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL CHECK (
    scope_kind IN ('global', 'project', 'thread', 'run', 'session', 'agent', 'tool', 'plugin', 'site')
  ),
  scope_ref TEXT,
  action_match TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'handoff', 'deny')),
  label TEXT,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'managed', 'plugin')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_policy_rule_account ON policy_rule (account_id, enabled);

-- Command prefix rules (FR-191, contracts/schemas/command-rule.json). A row is stored only after
-- every example passed (docs/06 §6 invariant 14).
CREATE TABLE command_rule (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'thread', 'session', 'agent')),
  scope_ref TEXT,
  pattern_json TEXT NOT NULL,
  tools_json TEXT NOT NULL DEFAULT '["exec.run"]',
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  host_executables_json TEXT,
  justification TEXT CHECK (justification IS NULL OR length(justification) <= 500),
  match_examples_json TEXT NOT NULL,
  not_match_examples_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'managed', 'plugin')),
  plugin_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_command_rule_account ON command_rule (account_id, enabled);

-- User and managed permission profiles (FR-190, contracts/schemas/permission-profile.json). The
-- built-ins (read-only, workspace, full) are data in packages/policy, so `extends` may name one
-- and is a plain column.
CREATE TABLE permission_profile (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES account (id),
  name TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  extends TEXT,
  fs_rules_json TEXT NOT NULL,
  network_json TEXT NOT NULL,
  requires_substrate TEXT CHECK (requires_substrate IS NULL OR requires_substrate = 'vm_or_container'),
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('builtin', 'user', 'managed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, name)
);

-- One `ask` waiting for (or answered by) the user (FR-100, ADR-060). `status` is the card's
-- lifecycle; `decision` the answer (schema approval-decision.json). A handed-off approval stays
-- `pending` with decision 'handoff' until the user marks the step done. Arguments are stored
-- only as a redacted preview and a hash.
CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  tool_call_id TEXT,
  thread_id TEXT,
  turn_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  tool_name TEXT,
  requested_action TEXT NOT NULL,
  args_preview TEXT,
  args_hash TEXT,
  reason TEXT,
  scope TEXT,
  risk TEXT CHECK (risk IS NULL OR risk IN ('low', 'medium', 'high')),
  tier TEXT CHECK (tier IS NULL OR tier IN ('handoff_required', 'confirm_at_action', 'pre_approvable')),
  user_asked INTEGER NOT NULL DEFAULT 0,
  options_json TEXT NOT NULL,
  always_scopes_json TEXT NOT NULL DEFAULT '[]',
  review_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided', 'expired', 'cancelled')),
  decision TEXT CHECK (
    decision IS NULL OR decision IN
      ('allow_once', 'allow_session', 'allow_always', 'deny_continue', 'deny_stop', 'handoff', 'timeout')
  ),
  always_scope TEXT CHECK (always_scope IS NULL OR always_scope IN ('tool', 'prefix_rule', 'host')),
  always_ref TEXT,
  deny_reason TEXT,
  override INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_device_id TEXT,
  decided_at TEXT,
  handoff_note TEXT,
  handoff_done_at TEXT,
  expires_at TEXT,
  rule_id TEXT,
  rule_label TEXT,
  -- Persistent grants were off when the card was made; the card shows "Always allow" disabled.
  always_allow_managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (decision IS NULL OR decision <> 'allow_always' OR always_scope IS NOT NULL),
  CHECK (override = 0 OR decision = 'allow_once'),
  CHECK (tier IS NULL OR tier <> 'confirm_at_action'
         OR decision IS NULL OR decision NOT IN ('allow_session', 'allow_always')),
  CHECK (tier IS NULL OR tier <> 'handoff_required'
         OR decision IS NULL OR decision IN ('handoff', 'deny_continue', 'deny_stop', 'timeout'))
);
CREATE INDEX idx_approval_open ON approval (expires_at) WHERE decision IS NULL;
CREATE INDEX idx_approval_account ON approval (account_id, created_at);
CREATE INDEX idx_approval_thread ON approval (thread_id, created_at);
-- "Deny and continue" makes an identical call in the same thread deny without asking (docs/12 §4.1).
CREATE INDEX idx_approval_denied ON approval (thread_id, tool_name, args_hash)
  WHERE decision = 'deny_continue';

-- Remembered approvals (docs/12 §4.2). A session grant is scoped to its chat (scope_kind
-- 'session', scope_ref = thread id); an "always" grant points at the rule it wrote.
-- `action_match` holds {tool, command?, argsHash?}.
CREATE TABLE permission_grant (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  approval_id TEXT REFERENCES approval (id),
  rule_id TEXT REFERENCES policy_rule (id) ON DELETE SET NULL,
  command_rule_id TEXT REFERENCES command_rule (id) ON DELETE SET NULL,
  duration TEXT NOT NULL DEFAULT 'always' CHECK (duration IN ('session', 'always')),
  scope_kind TEXT,
  scope_ref TEXT,
  action_match TEXT,
  host TEXT,
  label TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (rule_id IS NOT NULL OR command_rule_id IS NOT NULL OR scope_kind IS NOT NULL
         OR revoked_at IS NOT NULL)
);
CREATE INDEX idx_permission_grant_active ON permission_grant (account_id, scope_kind, scope_ref)
  WHERE revoked_at IS NULL;

-- Per-tool defaults the user set (FR-048): allow, ask or deny, keyed by tool name or glob.
CREATE TABLE tool_default (
  account_id TEXT NOT NULL REFERENCES account (id),
  tool TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tool)
);
