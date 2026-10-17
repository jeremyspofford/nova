# 06 — Domain Data Model

Storage: **SQLite (WAL)** via Drizzle ORM. All timestamps are UTC ISO-8601 strings. IDs are
UUIDv7 (sortable). Soft-delete uses `deleted_at`. Every table has `created_at`, `updated_at`.
Large blobs (attachments, images, snapshots) live on disk under the app data dir and are
referenced by relative path + SHA-256.

The Hub holds the one canonical database (ADR-069 keeps `memory_item` canonical; a second
store per subsystem was rejected, `docs/external/RECONCILIATION.md` APP-3 row 25). Columns
that hold a JSON document named after a schema in `contracts/schemas/` are validated against
that schema on write.

## 1. Entity overview

```
Account ──1:N── ProviderAccount ──1:N── ModelPref
   │
   ├──1:N── Project ──1:N── Thread ──1:N── Turn ──1:N── Message ──1:N── MessagePart (items)
   │                         │              │              ├──1:N── ToolCall ──0:1── Approval
   │                         │              │              └──1:N── Citation
   │                         │              └──1:N── ServerRequest ──0:1── Approval
   │                         ├──1:N── Artifact
   │                         └──0:1── SessionHandoff
   │
   ├──1:N── Run (Work) ──1:N── RunStep ──1:N── SubAgent
   │            ├──0:1── Goal (open)
   │            ├──1:N── Schedule
   │            └──1:N── Trigger ──0:1── McpEventSubscription ──1:N── McpEventDelivery
   │
   ├──1:N── CodeSession ──1:N── CodeChange ──1:N── DiffComment
   │            ├──N:1── Environment
   │            ├──0:1── Worktree (lease)
   │            └──1:N── SessionHandoff
   │
   ├──1:N── Agent ──1:N── AgentResponsibility
   │            ├──1:N── AgentRule
   │            ├──1:N── AgentMemory
   │            ├──0:1── Goal (open)
   │            ├──1:N── ChannelBinding ──1:1── Thread (per channel, ADR-070)
   │            └──1:1── Computer ──1:N── ComputerSnapshot
   │
   ├──1:N── MemoryItem ──N:1── MemoryConsolidationRun
   ├──1:N── PolicyRule ──1:N── PermissionGrant
   ├──1:N── CommandRule ──1:N── PermissionGrant
   ├──1:N── PermissionProfile / Hook
   ├──1:N── AuditEvent / Event
   ├──1:N── Skill / PluginInstall / McpServer / Connector
   ├──1:N── AppAuthorization / ImportRecord
   ├──1:N── UsageEvent
   ├──1:N── Notification
   ├──1:N── Setting / FeatureFlag            (themes and keybindings are files, §3)
   ├──1:N── Device (§7) ──1:N── SyncState / TransportEndpoint / StagedWrite / Worktree
   └──1:N── Automation / SmartEntity (§8)
            AmbientRecord / AmbientCoverage / AmbientGrant / Meeting / Speaker (§8)
```

## 2. Core tables

### account & providers

```sql
CREATE TABLE account (
  id TEXT PRIMARY KEY,            -- uuidv7
  kind TEXT NOT NULL,             -- 'local' | 'oidc'
  display_name TEXT,
  username TEXT,
  avatar_path TEXT,
  email TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE provider_account (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  provider TEXT NOT NULL,         -- 'anthropic'|'openai'|'google'|'openrouter'|'local'|...
  label TEXT NOT NULL,
  auth_kind TEXT NOT NULL,        -- 'oauth'|'api_key'|'none'
  secret_ref TEXT,                -- keychain reference ONLY; never the secret
  base_url TEXT,
  scopes TEXT,                    -- JSON array
  entitlements TEXT,              -- JSON {limit, used, resetAt, plan}
  status TEXT NOT NULL DEFAULT 'active', -- active|expired|revoked|error
  last_check_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE model_pref (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,         -- provider-native id
  alias TEXT,                     -- user-facing virtual model / preset name (FR-221)
  enabled INTEGER NOT NULL DEFAULT 1,
  default_params TEXT,            -- JSON {temperature, reasoningLevel, maxTokens, speed, ...}
  cost_in REAL, cost_out REAL,    -- per 1M tokens, informational
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

### projects, threads, turns, messages

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'code' | 'work'
  instructions TEXT,
  memory_scope TEXT NOT NULL DEFAULT 'shared', -- shared|project_only; set at creation (FR-205);
                                      -- multi-user shared projects are always project_only
  upstream_project_ref TEXT,          -- optional external id (e.g., remote sync)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE project_folder (       -- local projects (FR-035)
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  path TEXT NOT NULL,
  include_globs TEXT, exclude_globs TEXT,
  index_status TEXT NOT NULL DEFAULT 'pending', -- pending|indexing|ready|error
  last_indexed_at TEXT
);

CREATE TABLE thread (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id),
  mode TEXT NOT NULL,              -- 'chat' | 'work' | 'code' | 'agent'
  title TEXT,
  parent_thread_id TEXT REFERENCES thread(id),  -- branching / side chat / sub-agent child
  branch_from_message_id TEXT,
  temporary INTEGER NOT NULL DEFAULT 0,
  side INTEGER NOT NULL DEFAULT 0,  -- side chat: reads the parent's path, adds no turns to it (FR-026)
  memory_opt_out INTEGER NOT NULL DEFAULT 0, -- excluded from memory extraction (FR-032)
  active_leaf_id TEXT,              -- the active path runs from this message to the root (FR-020)
  model_id TEXT, reasoning_level TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle', -- idle|streaming|waiting_approval|waiting_input|error
  input_mode TEXT NOT NULL DEFAULT 'steer', -- unused since M2: the general.followUp setting decides (ADR-089)
  metadata TEXT,                   -- JSON (env, cwd, session opts, agent id, ...)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_thread_account_mode ON thread(account_id, mode, updated_at DESC);
CREATE INDEX idx_thread_project ON thread(project_id);
CREATE INDEX idx_thread_parent ON thread(parent_thread_id);

CREATE TABLE turn (                -- one trigger and everything the runtime did for it (docs/09 §2)
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  idx INTEGER NOT NULL,            -- order within the thread, from 0
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress|completed|interrupted|failed
  trigger TEXT NOT NULL DEFAULT 'user',       -- user|schedule|goal|hook|event|channel
  trigger_ref TEXT,                -- schedule, goal, hook, trigger or channel_binding id
  run_id TEXT REFERENCES run(id),
  goal_id TEXT REFERENCES goal(id),
  execution_location TEXT NOT NULL, -- 'hub' | 'device:<id>' | 'environment:<id>'; fixed for the turn (FR-127)
  model_id TEXT, reasoning_level TEXT,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count <= 200), -- model steps; backstop (FR-182)
  stop_reason TEXT,                -- end|budget|backstop|cancelled|approval_timeout|location_lost|error
  usage_json TEXT,                 -- {inputTokens, outputTokens, cachedTokens, costUsd, timeSeconds}
  started_at TEXT NOT NULL, ended_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (thread_id, idx),
  CHECK (status = 'in_progress' OR ended_at IS NOT NULL)
);
CREATE INDEX idx_turn_open ON turn(thread_id) WHERE status = 'in_progress';

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  turn_id TEXT REFERENCES turn(id), -- NULL only for messages imported without turns (FR-200)
  role TEXT NOT NULL,              -- system|user|assistant|tool|summary
  author_kind TEXT,                -- user|agent|subagent|system
  provenance TEXT NOT NULL DEFAULT 'typed', -- typed|pasted|tool|channel|capture|import (FR-189)
  delivery TEXT,                   -- NULL|steer|queued: how a follow-up entered its turn (FR-019)
  parent_id TEXT,                  -- the message this one follows; siblings are versions (FR-020)
  status TEXT NOT NULL DEFAULT 'complete', -- streaming|complete|incomplete|error
  model_id TEXT, provider TEXT, usage_json TEXT, cost_usd REAL, -- model_id: the model that answered
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_message_thread ON message(thread_id, created_at);
CREATE INDEX idx_message_turn ON message(turn_id);
CREATE INDEX idx_message_parent ON message(parent_id);

CREATE TABLE queued_input (         -- follow-ups sent in queue mode; survive a restart (FR-019)
  id TEXT PRIMARY KEY,             -- becomes the id of the user message it creates
  thread_id TEXT NOT NULL REFERENCES thread(id), account_id TEXT NOT NULL,
  text TEXT NOT NULL, attachments TEXT, -- JSON list of stored blobs
  model TEXT, reasoning_level TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|started|cancelled
  turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE message_part (        -- the "items" of a turn
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,              -- text|reasoning|tool_call|tool_result|image|file|artifact_ref|error|
                                   -- plan|command_execution|file_change|mcp_tool_call|subagent_activity|
                                   -- web_search|compaction|review_marker|hook_prompt
  content TEXT,                    -- text or JSON (shape per type, below)
  ref_id TEXT,                     -- tool_call, code_change, subagent, hook or approval id
  mime TEXT, blob_path TEXT,
  created_at TEXT NOT NULL
);
```

Item kinds added for the turn model (`content` is JSON unless noted):

| `type` | Content | Source |
| --- | --- | --- |
| `plan` | `{steps:[{title,status}], amendedReason?}` | Run plan card, FR-186 inline Work |
| `command_execution` | `{cmd, cwd, execSessionId?, exitCode?, outputPreview}` | `exec.run` (FR-184) |
| `file_change` | `{changeId, path, kind, additions, deletions}` | Code changes, FR-210 staged writes |
| `mcp_tool_call` | `{serverId, tool, callId, status}` | MCP tools (FR-042) |
| `subagent_activity` | `{subagentId, threadId, role, status, summary?}` | `task.*` tools (`docs/09` §4) |
| `web_search` | `{query, resultCount, citationIds[]}` | FR-029 |
| `compaction` | `{trigger: pre_turn\|mid_turn\|post_turn\|manual, tokensBefore, tokensAfter, summary}` | FR-183 |
| `review_marker` | `{phase: entered\|exited, kind: code_review\|auto_review, verdict?}` | FR-085, code review |
| `hook_prompt` | `{hookId, event, addedContext}` (text spilled to `blob_path` when large) | FR-197 |

Thread status (FR-215: Running, Needs input, Ready, Blocked) is **derived** from `thread.state`,
open `turn` rows, pending `server_request` rows, `goal.status` and child runs (`docs/09` §9);
it is not stored.

```sql
CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES message(id),
  thread_id TEXT REFERENCES thread(id),
  name TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT,
  origin TEXT NOT NULL DEFAULT 'upload', -- upload|window_capture (FR-214)|dictation|import
  blob_path TEXT NOT NULL,
  extracted_text_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE citation (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id),
  idx INTEGER, url TEXT, source_id TEXT, -- source_id for project sources (FR-040)
  title TEXT, snippet TEXT, retrieved_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE source (               -- project sources (FR-040); content is a blob (§3)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES project(id),
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  sha256 TEXT NOT NULL, blob_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|indexing|ready|error
  error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0, indexed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE source_chunk (         -- retrieval units, indexed by the FTS5 table source_chunk_fts
  seq INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source(id),
  idx INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
);
```

### tools, approvals, permissions, hooks, requests

```sql
CREATE TABLE tool_call (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES message(id),
  thread_id TEXT REFERENCES thread(id),
  turn_id TEXT REFERENCES turn(id),
  run_step_id TEXT REFERENCES run_step(id),
  parent_call_id TEXT REFERENCES tool_call(id), -- nested calls from script.run (FR-202)
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL,            -- builtin|mcp|plugin|computer|browser|page|device
  server_id TEXT, plugin_id TEXT,
  args_json TEXT NOT NULL,
  result_json TEXT, error TEXT,
  status TEXT NOT NULL,            -- pending|running|ok|error|denied|timeout
  tags_json TEXT,                  -- trace tags, e.g. ["ambient.verbatim_copy"] (FR-232)
  started_at TEXT, ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE approval (            -- ids of threads, turns, runs, calls and rules are plain columns
  id TEXT PRIMARY KEY,              -- (no FKs), so purges and run deletion never block on it
  account_id TEXT NOT NULL REFERENCES account(id),
  tool_call_id TEXT REFERENCES tool_call(id),
  thread_id TEXT REFERENCES thread(id),
  turn_id TEXT REFERENCES turn(id),
  run_id TEXT REFERENCES run(id),
  agent_id TEXT REFERENCES agent(id),
  tool_name TEXT,
  requested_action TEXT NOT NULL,
  args_preview TEXT, args_hash TEXT, -- redacted preview for the card; hash for repeat denials
  reason TEXT, scope TEXT, risk TEXT,
  user_asked INTEGER NOT NULL DEFAULT 0, -- intent provenance shown on the card (FR-189)
  options_json TEXT NOT NULL,      -- the decisions this card offers (tier, managed policy)
  always_scopes_json TEXT NOT NULL DEFAULT '[]', -- suggested "Always allow" scopes
  status TEXT NOT NULL DEFAULT 'pending', -- pending|decided|expired|cancelled; a hand-off stays
                                   -- pending (decision = 'handoff') until it is marked done
  tier TEXT,                       -- handoff_required|confirm_at_action|pre_approvable (FR-189)
  review_json TEXT,                -- auto-review verdict, schema auto-review-verdict.json (FR-085)
  decision TEXT,                   -- allow_once|allow_session|allow_always|deny_continue|deny_stop|
                                   -- handoff|timeout (FR-100, ADR-060); schema approval-decision.json
  always_scope TEXT,               -- tool|prefix_rule|host; required for allow_always
  always_ref TEXT,                 -- tool name, command_rule id or host
  deny_reason TEXT,                -- returned to the agent on deny_continue
  override INTEGER NOT NULL DEFAULT 0, -- the user overrode a reviewer deny with allow_once (audited)
  decided_by TEXT,                 -- user|hook:<id>|system ('system' only for timeout)
  decided_device_id TEXT, decided_at TEXT,
  expires_at TEXT,                 -- reaching it records decision = 'timeout'
  rule_id TEXT, rule_label TEXT,
  always_allow_managed INTEGER NOT NULL DEFAULT 0, -- "Always allow" shown disabled (managed)
  handoff_note TEXT, handoff_done_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (decision IS NULL OR decision <> 'allow_always' OR always_scope IS NOT NULL),
  CHECK (override = 0 OR decision = 'allow_once'),
  CHECK (tier IS NULL OR tier <> 'confirm_at_action'
         OR decision IS NULL OR decision NOT IN ('allow_session','allow_always')),
  CHECK (tier IS NULL OR tier <> 'handoff_required'
         OR decision IS NULL OR decision IN ('handoff','deny_continue','deny_stop','timeout'))
);
CREATE INDEX idx_approval_open ON approval(expires_at) WHERE decision IS NULL;

CREATE TABLE policy_rule (          -- tool/resource rules; schema policy-rule.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  scope_kind TEXT NOT NULL,        -- global|project|thread|run|session|agent|tool|plugin|site
  scope_ref TEXT,
  action_match TEXT NOT NULL,      -- JSON matcher (tool, resource pattern, effect)
  effect TEXT NOT NULL,            -- allow|ask|handoff|deny
  label TEXT, priority INTEGER NOT NULL DEFAULT 100,
  source TEXT NOT NULL DEFAULT 'user', -- user|managed|plugin
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE command_rule (         -- command prefix rules (FR-191); schema command-rule.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  scope_kind TEXT NOT NULL,        -- global|project|thread|session|agent
  scope_ref TEXT,
  pattern_json TEXT NOT NULL,      -- token prefix; each element a literal or a list of alternatives
  tools_json TEXT NOT NULL DEFAULT '["exec.run"]', -- exec tools the rule applies to
  decision TEXT NOT NULL,          -- allow|ask|deny (allow never removes the sandbox)
  priority INTEGER NOT NULL DEFAULT 100,
  host_executables_json TEXT,      -- absolute paths a bare command name may resolve to
  justification TEXT,              -- shown in prompts and denials; a deny names an alternative
  match_examples_json TEXT NOT NULL,     -- ≥ 1 command that must match; checked at load
  not_match_examples_json TEXT NOT NULL, -- ≥ 1 command that must not match; checked at load
  source TEXT NOT NULL,            -- user|managed|plugin
  plugin_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE permission_profile (   -- what the sandbox allows (FR-190, ADR-059); schema permission-profile.json
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES account(id),  -- NULL for built-ins
  name TEXT NOT NULL,              -- built-ins: read-only|workspace|full
  builtin INTEGER NOT NULL DEFAULT 0,
  extends TEXT REFERENCES permission_profile(id),
  fs_rules_json TEXT NOT NULL,     -- [{path, access: read|write|deny}]; path tokens :project|:tmp|:minimal|:home
  network_json TEXT NOT NULL,      -- {mode: off|allowlist|limited, allow[], deny[], socks5, allowLocalBinding}
  requires_substrate TEXT,         -- NULL | 'vm_or_container' (always set for 'full')
  source TEXT NOT NULL DEFAULT 'user', -- builtin|user|managed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE permission_grant (     -- remembered approvals (allow_session, allow_always)
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  approval_id TEXT REFERENCES approval(id),
  rule_id TEXT REFERENCES policy_rule(id) ON DELETE SET NULL,
  command_rule_id TEXT REFERENCES command_rule(id) ON DELETE SET NULL, -- "Always allow" on a
                                   -- command appends a rule; revoking the grant deletes it
  label TEXT NOT NULL,             -- what it allows, as listed in Settings → Permissions
  duration TEXT NOT NULL DEFAULT 'always', -- session|always
  scope_kind TEXT, scope_ref TEXT,  -- session grants: scope_kind = 'session'
  action_match TEXT, host TEXT,
  expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE tool_default (         -- per-tool defaults set by the user (FR-048)
  account_id TEXT NOT NULL REFERENCES account(id),
  tool TEXT NOT NULL,              -- canonical name, e.g. fs.write or mcp:files.search
  effect TEXT NOT NULL,            -- allow|ask|deny
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tool)
);

CREATE TABLE hook (                 -- lifecycle hooks (FR-197, ADR-068); schema hook-config.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  hook_key TEXT NOT NULL,          -- hook id from its file, unique per source
  event TEXT NOT NULL,             -- session.start|session.end|prompt.submit|tool.pre|tool.post|
                                   -- permission.request|compact.pre|compact.post|subagent.start|
                                   -- subagent.stop|stop|interrupt (docs/08 §4.1)
  matcher_json TEXT,               -- glob list; NULL = every occurrence
  handler_kind TEXT NOT NULL,      -- command|mcp_tool
  handler_json TEXT NOT NULL,      -- hook-config.json#/$defs/handler
  fail_closed INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,            -- managed|user|project|plugin|extension
  plugin_id TEXT, project_id TEXT REFERENCES project(id),
  content_hash TEXT NOT NULL,      -- SHA-256 over the canonical definition and any script it runs
  trusted_hash TEXT,               -- hash the user trusted; NULL or different = needs_trust
  trust_state TEXT NOT NULL DEFAULT 'needs_trust', -- needs_trust|trusted|revoked
                                   -- (hook-config.json#/$defs/trustRecord)
  trusted_by TEXT, trusted_at TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, source, plugin_id, project_id, hook_key)
);

CREATE TABLE server_request (       -- Hub-to-client requests (FR-188); schema server-request.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- approval|user_input|elicitation|client_tool|credential_refresh
  thread_id TEXT, turn_id TEXT, run_id TEXT, agent_id TEXT, call_id TEXT, -- correlation ids
  approval_id TEXT REFERENCES approval(id), -- kind = 'approval'
  target_device_id TEXT,           -- NULL = any authorized client; client_tool may name one
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|resolved|expired
  resolved_by TEXT,                -- user|hook:<id>
  resolved_by_device TEXT,
  resolution_json TEXT,
  notified_at TEXT,                -- fallback notification sent (FR-060)
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT,
  CHECK (status <> 'resolved' OR (resolution_json IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX idx_server_request_pending ON server_request(account_id, expires_at)
  WHERE status = 'pending';
```

### audit & events

```sql
CREATE TABLE audit_event (          -- append-only: triggers refuse UPDATE and DELETE
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,     -- chain order; the hash covers every column except hash
  account_id TEXT NOT NULL REFERENCES account(id),
  actor TEXT NOT NULL,             -- user|agent:<id>|system (run and sub-agent ids go in run_id/detail)
  kind TEXT NOT NULL,              -- tool_call|approval|review|hook|fs|network|egress|auth|update|
                                   -- policy|import|ambient
  thread_id TEXT, turn_id TEXT, run_id TEXT, agent_id TEXT, session_id TEXT,
  action TEXT NOT NULL, resource TEXT,
  input_hash TEXT, decision TEXT, result TEXT,
  detail_json TEXT,
  prev_hash TEXT, hash TEXT NOT NULL,  -- hash chain for tamper evidence
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_event(created_at DESC);

CREATE TABLE event (                -- persisted events for replay (contracts/events.md)
  id TEXT PRIMARY KEY,             -- uuidv7, monotonic; consumers dedupe by id
  account_id TEXT NOT NULL,
  name TEXT NOT NULL, schema_version INTEGER NOT NULL,
  actor TEXT NOT NULL,             -- user|agent:<id>|system
  thread_id TEXT, turn_id TEXT, run_id TEXT, agent_id TEXT, session_id TEXT, -- from correlation
  correlation_json TEXT, payload_json TEXT NOT NULL,
  syncable INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL
);
CREATE INDEX idx_event_thread ON event(thread_id, id);
CREATE INDEX idx_event_run ON event(run_id, id);
```

### work runs, goals, schedules, triggers

```sql
CREATE TABLE run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id),
  thread_id TEXT REFERENCES thread(id),
  agent_id TEXT REFERENCES agent(id),
  parent_run_id TEXT REFERENCES run(id), -- delegation (FR-059); child consumption counts upward
  origin TEXT NOT NULL DEFAULT 'user',   -- user|schedule|trigger|chat_escalation|delegation|goal
  title TEXT NOT NULL, objective TEXT NOT NULL,
  plan_json TEXT,
  status TEXT NOT NULL,            -- planning|running|waiting_approval|paused|done|output_missing|
                                   -- failed|cancelled
  pause_reason TEXT,               -- set while paused: user|budget_time|budget_tokens|budget_cost|
                                   -- backstop|usage_limit|approval_timeout|review_breaker|safety|
                                   -- error (model or tool failure, docs/09 §12)
  autonomy TEXT NOT NULL DEFAULT 'standard',
  -- budgets (FR-182, ADR-058); cost_budget_usd NULL = the provider spend cap (FR-116)
  time_budget_s INTEGER NOT NULL DEFAULT 3600,
  token_budget INTEGER NOT NULL DEFAULT 2000000,
  cost_budget_usd REAL,
  time_used_s INTEGER NOT NULL DEFAULT 0,  -- wall clock while a turn runs; waits excluded
  tokens_used INTEGER NOT NULL DEFAULT 0,  -- includes child runs
  cost_used_usd REAL NOT NULL DEFAULT 0,
  expected_output_json TEXT,       -- declared output to verify (FR-187)
  output_verified_at TEXT,
  result_summary TEXT, result_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  CHECK (status <> 'paused' OR pause_reason IS NOT NULL),
  CHECK (status <> 'done' OR expected_output_json IS NULL OR output_verified_at IS NOT NULL)
);
CREATE INDEX idx_run_status ON run(account_id, status, updated_at DESC);

CREATE TABLE goal (                 -- FR-181, docs/09 §2.1; schema goal.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  run_id TEXT REFERENCES run(id),
  agent_id TEXT REFERENCES agent(id),
  thread_id TEXT REFERENCES thread(id),  -- where continuation turns (trigger 'goal') run
  objective TEXT NOT NULL CHECK (length(objective) <= 4000),
  status TEXT NOT NULL DEFAULT 'active', -- active|paused|blocked|usage_limited|budget_limited|complete
  status_set_by TEXT NOT NULL DEFAULT 'user', -- user|agent|system
  status_reason TEXT, progress_note TEXT, completion_summary TEXT,
  token_budget INTEGER, time_budget_s INTEGER, cost_budget_usd REAL, -- NULL = run/agent budgets
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_s INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  blocker_key TEXT,                -- normalized key of the last reported blocker
  blocker_description TEXT,        -- the agent's description of it (goal.json blocker.description)
  blocker_count INTEGER NOT NULL DEFAULT 0, -- consecutive goal turns with that key; reset on resume
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  CHECK ((run_id IS NULL) <> (agent_id IS NULL)),
  CHECK (status NOT IN ('usage_limited','budget_limited') OR status_set_by = 'system'),
  CHECK (status <> 'blocked' OR status_set_by <> 'agent' OR blocker_count >= 3)
);
CREATE UNIQUE INDEX uq_goal_open_run ON goal(run_id)
  WHERE run_id IS NOT NULL AND status <> 'complete';
CREATE UNIQUE INDEX uq_goal_open_agent ON goal(agent_id)
  WHERE agent_id IS NOT NULL AND status <> 'complete';

CREATE TABLE run_step (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id),
  idx INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  detail_json TEXT, started_at TEXT, ended_at TEXT
);

CREATE TABLE subagent (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id),
  thread_id TEXT REFERENCES thread(id),
  role TEXT, status TEXT NOT NULL, result_json TEXT,
  created_at TEXT NOT NULL, ended_at TEXT
);

CREATE TABLE schedule (             -- FR-055, FR-206, ADR-079; schema schedule.json
  id TEXT PRIMARY KEY, run_id TEXT REFERENCES run(id), agent_id TEXT REFERENCES agent(id),
  cron TEXT, rrule TEXT, interval_seconds INTEGER,
  once_at TEXT,                    -- one-shot fire (self-set wakes, FR-206)
  timezone TEXT NOT NULL,          -- IANA; required by schedule.json
  starts_at TEXT, ends_at TEXT,    -- starts_at is the RRULE DTSTART
  instructions TEXT NOT NULL, notify_condition TEXT,
  delivery_targets_json TEXT NOT NULL, -- JSON array of {kind: inapp|os|slack|teams|email|webhook, ref}
  expected_output_json TEXT,       -- declared output (FR-187)
  catch_up_policy TEXT NOT NULL DEFAULT 'once',      -- once|skip
  catch_up_lookback_s INTEGER NOT NULL DEFAULT 604800, -- 7 days
  origin TEXT NOT NULL DEFAULT 'user', -- user|agent (schedule.create, FR-059)|agent_self (wake)
  wake_reason TEXT,                -- agent_self only
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, next_run_at TEXT,
  last_outcome TEXT,               -- done|output_missing|failed|cancelled (run.completed status)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((cron IS NOT NULL) + (rrule IS NOT NULL) + (interval_seconds IS NOT NULL)
         + (once_at IS NOT NULL) = 1),
  CHECK (origin <> 'agent_self'
         OR (agent_id IS NOT NULL AND once_at IS NOT NULL AND wake_reason IS NOT NULL))
);
CREATE INDEX idx_schedule_next ON schedule(next_run_at) WHERE enabled = 1;

CREATE TABLE trigger (
  id TEXT PRIMARY KEY, schedule_id TEXT REFERENCES schedule(id), run_id TEXT REFERENCES run(id),
  agent_id TEXT REFERENCES agent(id),
  kind TEXT NOT NULL,              -- webhook|connector_event|mcp_event|fs_change|email (event
                                   -- sources, docs/09 §7; chat-workspace events are
                                   -- connector_event) | schedule (a schedule's fire, schedule_id)
  source_ref TEXT,                 -- connector id, device id (fs_change) or mcp_event_subscription id
  config_json TEXT, dedupe_key TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE mcp_event_subscription ( -- FR-201
  id TEXT PRIMARY KEY,             -- also the webhook path segment (contracts/hub-api.md §1)
  account_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL REFERENCES mcp_server(id),
  trigger_id TEXT NOT NULL REFERENCES trigger(id),
  event_name TEXT NOT NULL,
  remote_ref TEXT,                 -- the server's subscription id
  webhook_secret_ref TEXT NOT NULL, -- keychain reference of the signing secret
  filter_json TEXT,
  expires_at TEXT,
  refresh_before TEXT,             -- refresh is attempted from this time on
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|refreshing|lapsed|failed|removed
  last_delivery_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE mcp_event_delivery (   -- dedupe by delivery id; only signed deliveries ≤ 256 KiB
  subscription_id TEXT NOT NULL REFERENCES mcp_event_subscription(id),
  delivery_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes <= 262144),
  run_id TEXT REFERENCES run(id),  -- run started or agent turn's run, if any
  received_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, delivery_id)
);
```

### code sessions

```sql
CREATE TABLE environment (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- local|cloud|ssh|wsl|container|vm|device
  device_id TEXT REFERENCES device(id), -- kind 'device' / 'ssh' with the novad helper (FR-062)
  label TEXT NOT NULL, config_json TEXT,
  repo_urls TEXT, setup_script TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', last_check_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE code_session (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),  -- 1:1 with a code thread
  environment_id TEXT REFERENCES environment(id),
  project_folder_id TEXT REFERENCES project_folder(id),
  worktree_id TEXT REFERENCES worktree(id),
  branch TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'manual', -- manual|accept_edits|plan|auto|bypass (presets, FR-063)
  permission_profile_id TEXT REFERENCES permission_profile(id), -- FR-190
  status TEXT NOT NULL DEFAULT 'idle',
  pull_request_url TEXT, ci_status TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE worktree (             -- worktree registry (FR-073); at most 15 active per repo
  id TEXT PRIMARY KEY,
  device_id TEXT REFERENCES device(id), -- where the repo lives
  name TEXT NOT NULL,               -- <id> shown in the worktree list
  repo_path TEXT NOT NULL,         -- main checkout
  path TEXT NOT NULL,              -- <repo>/.nova/worktrees/<id>
  branch TEXT NOT NULL,            -- nova/<slug>
  source_branch TEXT NOT NULL,
  lease_session_id TEXT REFERENCES code_session(id),
  lease_expires_at TEXT,           -- NULL = until the session is archived or handed off
  status TEXT NOT NULL DEFAULT 'active', -- active|released|removed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (device_id, path)
);
CREATE INDEX idx_worktree_repo ON worktree(device_id, repo_path, status);

CREATE TABLE session_handoff (      -- FR-213; recorded in the session history
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  code_session_id TEXT REFERENCES code_session(id), -- NULL for a chat handoff
  from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, -- 'device:<id>' | 'environment:<id>'
  git_state_json TEXT,             -- {branch, baseSha, worktreeId?, patchBlobPath?, patchSha256?}
  status TEXT NOT NULL DEFAULT 'pending', -- pending|completed|failed
  error TEXT, created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE code_change (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES code_session(id),
  path TEXT NOT NULL, change_kind TEXT NOT NULL,  -- add|modify|delete|rename
  old_path TEXT, additions INTEGER, deletions INTEGER,
  patch_blob_path TEXT, applied INTEGER NOT NULL DEFAULT 0,
  reviewed_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE diff_comment (
  id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES code_change(id),
  path TEXT, line INTEGER, side TEXT, body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
```

### agents & computers

```sql
CREATE TABLE agent (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL, avatar_path TEXT, persona TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active|paused|provisioning|error
  computer_id TEXT REFERENCES computer(id),
  connected_computer_id TEXT REFERENCES computer(id), -- one active connection (FR-081)
  primary_thread_id TEXT REFERENCES thread(id),       -- in-app thread; private bindings may share it
  time_budget_s INTEGER, token_budget INTEGER, cost_budget_usd REAL, -- defaults for its runs (FR-182)
  metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_responsibility (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id),
  title TEXT NOT NULL, instructions TEXT, status TEXT NOT NULL DEFAULT 'active',
  goal_id TEXT REFERENCES goal(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_rule (                 -- FR-084
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id),
  description TEXT NOT NULL,
  matcher_json TEXT NOT NULL,           -- action/resource matcher
  effect TEXT NOT NULL,                 -- act|act_on_request|ask|handoff
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_memory (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id),
  kind TEXT NOT NULL,                   -- note|fact|preference|observation
  content TEXT NOT NULL, source_thread_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  origin_audience TEXT NOT NULL DEFAULT 'private', -- private|shared: audience of the source thread
                                        -- (channel_binding.audience; docs/13 §4, ADR-070)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE channel_binding (
  id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agent(id), account_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- inapp|slack|teams|telegram|email|webhook|voice
  external_ref TEXT NOT NULL,           -- channel/user id
  audience TEXT NOT NULL DEFAULT 'shared', -- private (owner only) | shared
  thread_id TEXT REFERENCES thread(id), -- this binding's own thread (ADR-070)
  share_primary_thread INTEGER NOT NULL DEFAULT 0, -- private bindings only: use agent.primary_thread_id
  config_json TEXT, secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK (share_primary_thread = 0 OR audience = 'private')
);

CREATE TABLE computer (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- cloud|local_container|local_host
  provider TEXT, base_image TEXT, state TEXT NOT NULL DEFAULT 'stopped',
  device_id TEXT REFERENCES device(id), -- local_host: the connected device
  snapshot_blob_path TEXT, spec_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);

CREATE TABLE computer_snapshot (
  id TEXT PRIMARY KEY, computer_id TEXT NOT NULL REFERENCES computer(id),
  label TEXT, blob_path TEXT NOT NULL, size_bytes INTEGER, created_at TEXT NOT NULL
);
```

### memory, artifacts, library, usage, notifications

```sql
CREATE TABLE memory_item (          -- canonical, reviewable memory (FR-032, FR-204, ADR-069)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,             -- global|project|thread|agent
  scope_ref TEXT,
  content TEXT NOT NULL, kind TEXT,
  content_key TEXT NOT NULL,            -- normalized content; duplicates in a scope are skipped
  category TEXT,                        -- Memory page grouping (FR-204)
  confidence REAL,
  as_of TEXT,                           -- when the fact was observed or true
  valid_until TEXT,                     -- after this, consolidation ages the item
  source_kind TEXT NOT NULL DEFAULT 'chat', -- chat|consolidation|import|ambient|manual
  source_thread_id TEXT, source_message_id TEXT,
  origin_audience TEXT NOT NULL DEFAULT 'private', -- private|shared: audience of the thread or channel
                                        -- binding it came from; a consolidated item is private if any
                                        -- source is (docs/13 §4, ADR-070)
  consolidation_run_id TEXT REFERENCES memory_consolidation_run(id),
  supersedes_id TEXT REFERENCES memory_item(id), -- history kept when a fact is retired
  status TEXT NOT NULL DEFAULT 'active',    -- active|dismissed
  user_edited INTEGER NOT NULL DEFAULT 0,   -- pinned or edited items are flagged, never rewritten
  pinned INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_scope ON memory_item(account_id, scope_kind, scope_ref, status);

CREATE TABLE memory_consolidation_run ( -- FR-204 background job (docs/09 §5)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL, scope_ref TEXT, -- global|project|agent
  phase TEXT NOT NULL,                  -- extract|consolidate
  status TEXT NOT NULL,                 -- running|completed|failed
  threads_scanned INTEGER, items_created INTEGER, items_updated INTEGER, items_aged INTEGER,
  summary TEXT,                         -- consolidate phase: the injected memory summary
  summary_tokens INTEGER CHECK (summary_tokens IS NULL OR summary_tokens <= 2500),
  model_id TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);

CREATE TABLE memory_topic (         -- "Remember more / less about this topic" (FR-204)
  account_id TEXT NOT NULL REFERENCES account(id),
  topic_key TEXT NOT NULL, topic TEXT NOT NULL,
  preference TEXT NOT NULL,        -- more|less ('default' deletes the row)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, topic_key)
);

CREATE TABLE memory_thread_mark (   -- how far consolidation has read each thread
  thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  last_message_id TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL
);
-- The current memory summary for a scope is the latest completed 'consolidate' run.
-- Settings key (no table): memory.referencePastChats (bool, FR-205); topic preferences live in
-- memory_topic (FR-204).

CREATE TABLE artifact (
  id TEXT PRIMARY KEY, thread_id TEXT REFERENCES thread(id),
  message_id TEXT REFERENCES message(id), run_id TEXT REFERENCES run(id),
  kind TEXT NOT NULL,                   -- markdown|code|html|image|chart|pdf|docx|pptx|xlsx|site|canvas|file
  title TEXT, blob_path TEXT, mime TEXT, sha256 TEXT, version INTEGER NOT NULL DEFAULT 1,
  live INTEGER NOT NULL DEFAULT 0, meta_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE usage_event (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  provider TEXT, model TEXT, thread_id TEXT, turn_id TEXT, run_id TEXT, goal_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE notification (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- approval|completion|error|attention|system (FR-013)
  title TEXT NOT NULL, body TEXT,
  href TEXT,                       -- a same-origin app path
  refs_json TEXT,
  dedupe_key TEXT,                 -- an unread notification with the same key is updated in place
  read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
```

### extensions, settings, sync

```sql
CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT NOT NULL, transport TEXT NOT NULL, -- stdio|sse|http
  command TEXT, args_json TEXT, url TEXT, env_ref_json TEXT,
  config_json TEXT,                -- mcp-config.json#/$defs/server (timeouts, tool lists, oauth, ...)
  source TEXT NOT NULL DEFAULT 'user', -- user|plugin|bundle|import|managed|device
  plugin_id TEXT,
  device_id TEXT REFERENCES device(id), -- device-local stdio server exposed through novad (FR-210)
  bundle_manifest_json TEXT,       -- mcp-bundle-manifest.json (FR-199)
  signature_status TEXT,           -- verified|unverified (sideload confirmed)
  bundle_sha256 TEXT,              -- install record (docs/08 §2.5)
  install_record_json TEXT,        -- mcp-bundle-manifest.json#/$defs/installRecord: source
                                   -- catalog|registry|file, confirmed permissions, userConfig
  enabled INTEGER NOT NULL DEFAULT 1, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE plugin_install (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL, version TEXT NOT NULL, source TEXT, -- catalog|git|path|import
  manifest_json TEXT, signature TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT, updated_at TEXT
);

CREATE TABLE skill (                -- folder format (ADR-067); the body stays in SKILL.md on disk
  id TEXT PRIMARY KEY, account_id TEXT,
  name TEXT NOT NULL, description TEXT NOT NULL,
  folder_path TEXT NOT NULL,       -- skills/<skill-id>/ containing SKILL.md
  frontmatter_json TEXT NOT NULL,  -- schema skill-frontmatter.json
  source TEXT NOT NULL,            -- managed|project|user|plugin|builtin (collision order, FR-046)
  plugin_id TEXT, project_id TEXT REFERENCES project(id),
  content_hash TEXT NOT NULL,      -- SHA-256 over the folder
  provenance_json TEXT,            -- L1 proposal, demonstration (FR-226) or import record
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE connector (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL,
  label TEXT, secret_ref TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE app_authorization (    -- per-client tokens: Nova's MCP server (FR-192), third-party apps (FR-222)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- mcp_client|api_app
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,            -- JSON array, e.g. ["memory.read","ambient.search"]
  token_hash TEXT UNIQUE,          -- SHA-256 of the bearer token; the token is shown once
  ambient_grant_id TEXT REFERENCES ambient_grant(id), -- required for any ambient scope (FR-233)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|revoked
  created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT, revoked_at TEXT,
  CHECK (status <> 'active' OR token_hash IS NOT NULL)
);

CREATE TABLE import_record (        -- FR-200 preview, provenance and SHA-256 dedupe
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,       -- instruction_file|skill_folder|plugin|mcp_config|project|
                                   -- memory_export|chat_export
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,            -- of the normalized item
  item_kind TEXT NOT NULL,         -- what it became: instruction|skill|plugin|mcp_server|project|memory|thread
  target_ref TEXT,                 -- id of the created row
  status TEXT NOT NULL,            -- imported|disabled_pending_permissions|failed
  secrets_migrated INTEGER NOT NULL DEFAULT 0, -- secrets moved to the keychain as secret:// refs
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_import_dedupe ON import_record(account_id, item_kind, sha256)
  WHERE status <> 'failed';

CREATE TABLE feature_flag (         -- ADR-082; schema feature-flag.json
  key TEXT PRIMARY KEY,            -- e.g. 'sandbox.microVm'
  stage TEXT NOT NULL,             -- experimental|beta|stable|deprecated|removed
  enabled INTEGER NOT NULL DEFAULT 0,
  description TEXT,                -- ≤ 500 characters
  requirement TEXT,                -- FR-NNN the flag gates
  source TEXT NOT NULL DEFAULT 'default', -- default|user|managed
  updated_at TEXT NOT NULL,
  CHECK (stage <> 'removed' OR enabled = 0)
);

CREATE TABLE setting (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'global',
  scope_ref TEXT, updated_at TEXT NOT NULL
);

-- `device` is defined once, in §7.

CREATE TABLE sync_state (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL, vector_json TEXT,  -- opaque version vector
  synced_at TEXT
);
```

## 3. Blob storage layout

```
<appData>/nova/
├── nova.db               # SQLite
├── nova.db-wal
├── blobs/
│   ├── attachments/<sha256>
│   ├── artifacts/<artifact-id>/v<N>/<file>
│   ├── patches/<sha256>             # code changes and handoff patches (FR-213)
│   ├── staged/<staged-write-id>     # two-phase device writes (FR-210)
│   ├── snapshots/<computer-id>/<snapshot-id>.tar.zst
│   ├── screenshots/<yyyymmdd>/<id>.png
│   ├── ambient/<yyyy>/<mm>/<dd>/<record-id>.jpg.age # pixels when the target is the Hub (FR-228)
│   └── voiceprints/<speaker-id>.enc  # FR-231, never leaves the Hub
├── plugins/<plugin-id>/<version>/
├── skills/<skill-id>/SKILL.md (+ scripts, templates)
├── themes/<theme-id>.json
├── logs/
└── backups/                # pre-migration backups
```

## 4. Indexing & search

- **FTS5** virtual table over `message_part.content` (text) for chat search.
- **Vector index** (`sqlite-vec`) over chunked `message`, `attachment.extracted_text`, and
  project files for semantic retrieval; embeddings via a configurable provider (local
  default: `all-MiniLM`-class ONNX model; remote optional). History embeddings are dropped
  when "reference past chats" is off (FR-205).
- **Ambient**: an FTS5 **external-content** table over certified `ambient_record` text (§8);
  rows enter the index only when certified and leave it when certification is revoked. A
  vector index over ambient text is optional (FR-153).
- **Code index**: tree-sitter parse → symbols/references tables in a separate `code_cache.db`
  per project (rebuildable, git-ignored, safe to delete).

## 5. Migration & retention policy

- Forward-only migrations, one per schema version, run in a transaction with a backup first.
- Retention defaults: messages forever; tool results 90 days unless pinned; screenshots 30
  days; logs 14 days; snapshots until deleted or 30 days; resolved or expired
  `server_request` rows 30 days; `mcp_event_delivery` rows 7 days; ambient text 30 days and
  pixels 48 h (FR-154). All configurable; user can disable pruning.
- Export: a single `.nova` archive (SQLite + blobs + manifest) plus a JSONL audit export.
  Uncertified ambient rows are never exported (FR-227).
- Delete: cascading soft-delete then hard-delete job with a 30-day recovery window.

## 6. Invariants

1. A `tool_call` in `run_step` context always has an audit event.
2. A `permission_grant` always references a `policy_rule`, a `command_rule` or an explicit
   scope.
3. Secrets never appear in any table; only `secret_ref` pointers (token hashes are not
   secrets).
4. `audit_event.hash` chains to `prev_hash`; verification tool included.
5. Deleting a `thread` cascades to turns/messages/parts/attachments/artifacts but preserves
   `audit_event` (tombstoned via `thread_id`).
6. An `agent` always has exactly one cloud `computer`.
7. **Every turn is bounded**: `turn.step_count` never exceeds 200, and a turn ends when a run
   or goal budget is reached; the run then pauses with a `pause_reason` (FR-182, ADR-058).
   Nothing continues silently.
8. A turn's `execution_location` never changes after the turn starts (FR-127).
9. **Goal budget states are system-owned**: only the system writes `usage_limited` or
   `budget_limited`; the agent may write `blocked` only when `blocker_count` ≥ 3 (CHECKs on
   `goal`). At most one open goal per run or agent.
10. **Approvals always end**: an unanswered approval reaching `expires_at` records
    `decision = 'timeout'`; it is never dropped. `allow_always` always carries an
    `always_scope`; `confirm_at_action` actions are never stored as session or always
    grants; `handoff_required` actions end only as handoff, deny or timeout (FR-100, FR-189).
11. A `server_request` has exactly one resolution: it moves once from `pending` to `resolved`
    or `expired`; later answers are rejected (FR-188).
12. **Protected paths** (FR-190) are applied after every permission profile, command rule,
    grant and hook; none of them makes `.git`, `.nova`, `.agents`, the data directory,
    credential locations or shell startup files writable. No allow rule or grant removes the sandbox (ADR-059).
13. A `hook` runs only while `trust_state = 'trusted'` and `trusted_hash = content_hash`; a
    hook never loosens built-in safety, managed policy, a `handoff` or a `deny` (ADR-068).
14. A `command_rule` is stored only after all its examples pass at load; one failing example
    rejects the whole rule file (FR-191).
15. Memory in a `project_only` project is never read outside that project (FR-205).
    Consolidation never writes `skill` rows (ADR-069).
16. A `feature_flag` at stage `removed` is never enabled and is rejected at load (ADR-082).
17. An `mcp_event_delivery` row exists only for a delivery with a valid signature; replays of
    a known `delivery_id` start nothing (FR-201).
18. A `memory_item` or `agent_memory` row with `origin_audience = 'private'` reaches a reply in
    a `shared` channel binding only after the policy check (default `ask` the owner; FR-088,
    ADR-070).

## 7. Hub, devices & transports (added)

The Hub holds the canonical database. Clients and compute nodes are registrations in it.

```sql
CREATE TABLE device (               -- the only device table
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL,        -- hub|compute|client|wake-helper
  platform TEXT,                                 -- OS family + form factor (desktop|mobile|web)
  cert_fingerprint TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  roles TEXT NOT NULL, scopes TEXT,              -- JSON; scopes include granted folders (FR-210)
  status TEXT NOT NULL DEFAULT 'pending',        -- pending|active|revoked|unreachable
  novad_version TEXT,                            -- below the capability minimum → refused (FR-081)
  relay_client_id TEXT UNIQUE,                   -- client id in relay envelopes (FR-137, ADR-071)
  relay_route_id TEXT UNIQUE,                    -- its routing id at the Relay (envelope to/from;
                                                 -- DELETE /v1/relay/routes/:routeId on revoke)
  offline_replica INTEGER NOT NULL DEFAULT 0,    -- capability gate
  local_runtime INTEGER NOT NULL DEFAULT 0,      -- capability gate
  last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE device_capability (
  device_id TEXT PRIMARY KEY REFERENCES device(id),
  document TEXT NOT NULL,                        -- JSON, schema device-capability.json
  updated_at TEXT NOT NULL
);

CREATE TABLE transport_endpoint (
  id TEXT PRIMARY KEY, device_id TEXT REFERENCES device(id),
  net TEXT NOT NULL,                             -- lan|mesh|relay|direct
  url TEXT NOT NULL, healthy INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER, last_checked_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE add_device_request (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  role TEXT NOT NULL, code_hash TEXT NOT NULL, scopes TEXT,
  via TEXT NOT NULL DEFAULT 'direct',            -- direct|relay (pairing by QR or code, FR-137)
  status TEXT NOT NULL DEFAULT 'pending',        -- pending|approved|expired|denied
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE staged_write (         -- two-phase device writes (FR-210)
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  session_ref TEXT NOT NULL,                     -- thread, run or code session that staged it
  path TEXT NOT NULL,                            -- canonical path inside a granted scope
  base_sha256 TEXT,                              -- file hash at staging (NULL = new file)
  new_sha256 TEXT NOT NULL, blob_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged',         -- staged|committed|discarded|conflict
  approval_id TEXT REFERENCES approval(id),
  created_at TEXT NOT NULL, committed_at TEXT
);

CREATE TABLE wake_request (
  id TEXT PRIMARY KEY, target_device_id TEXT NOT NULL,
  helper_device_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE firmware_change (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES device(id),
  setting TEXT NOT NULL, old_value TEXT, new_value TEXT,
  method TEXT NOT NULL, snapshot_ref TEXT,
  status TEXT NOT NULL,                          -- planned|approved|applied|rolled_back|failed
  approval_id TEXT REFERENCES approval(id),
  created_at TEXT NOT NULL, applied_at TEXT
);
```

Invariants: a `device` certificate is unique; a `device_capability` exists for every active
compute node; `firmware_change` requires an `approval` before `applied`; `wake_request`
requires an active `wake-helper` device on the same LAN; a `staged_write` commits only when the
file's current hash still equals `base_sha256` and policy allows (otherwise `conflict`);
revoking a device also stops relay routing for its `relay_client_id`.

## 8. Automations, smart home & ambient (added)

```sql
CREATE TABLE automation (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  current_version INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,            -- JSON: triggers/conditions/actions
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE automation_version (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automation(id),
  version INTEGER NOT NULL, definition TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE automation_run (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automation(id),
  trigger_kind TEXT NOT NULL, status TEXT NOT NULL,
  steps TEXT,                          -- JSON step results
  started_at TEXT NOT NULL, ended_at TEXT, error TEXT
);

CREATE TABLE smart_area (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT
);

CREATE TABLE smart_entity (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  integration TEXT NOT NULL,           -- ha|mqtt|matter|vendor
  external_id TEXT NOT NULL, type TEXT NOT NULL,   -- light|switch|sensor|climate|lock|...
  area_id TEXT REFERENCES smart_area(id), name TEXT,
  state TEXT, attributes TEXT,         -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE smart_scene (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, actions TEXT NOT NULL
);
```

### ambient capture (ADR-073, `docs/24`)

Records arrive from `novad` in signed batches, already redacted and stamped on the device
(FR-227, FR-228); the transported shape is `contracts/schemas/ambient-record.json`. The Hub
verifies the batch signature, checks each stamp against the current redaction policy and
stores the record. Hub-only state (received time, pin, readable flag) lives in these columns,
not in the transported record (`docs/24` §6.1). One repository module owns these tables and
every reader goes through its certified view.

```sql
CREATE TABLE ambient_record (       -- capture and status records; schema ambient-record.json
  id TEXT PRIMARY KEY,                 -- record id from the device (UUIDv7, docs/24 §7)
  account_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES device(id),
  kind TEXT NOT NULL,                  -- capture|status
  ts TEXT NOT NULL, duration_ms INTEGER,
  source TEXT NOT NULL,                -- screen|mic|system-audio
  trigger TEXT,                        -- screen captures: app_switch|window_focus|click|typing_pause|
                                       -- scroll_stop|visual_change|idle|manual
  text_source TEXT,                    -- screen captures: accessibility|ocr|hybrid
  focused INTEGER,                     -- screen captures: from the focused window
  app_id TEXT, app_name TEXT, window_title TEXT, url TEXT, document_path TEXT, monitor INTEGER,
  text TEXT,                           -- redacted text; raw values are overwritten, never kept
  elements_json TEXT,                  -- accessibility elements / OCR words with normalized bounds
  segments_json TEXT,                  -- audio: [{startMs, endMs, text, speakerId?, confidence?}]
  content_hash TEXT,                   -- sha256:<hex> of redacted, normalized text (store dedupe)
  meeting_id TEXT REFERENCES meeting(id),
  media_json TEXT,                     -- [{kind: image|thumbnail|audio, target, ref, sha256, bytes,
                                       -- encrypted: true, keyId, width?, height?}];
                                       -- NULL in text-only mode (FR-228)
  redaction_stamp_json TEXT,           -- {policyVersion, categories[], model, where, certifiedAt, spans}
  policy_version INTEGER,              -- copied from the stamp for indexed revocation
  coverage_json TEXT,                  -- {complete, limits[]}: why content may be partial
  status_json TEXT,                    -- status records: {state, reason?, profile?, heartbeatMs?}
  certified_at TEXT,                   -- when the Hub accepted the stamp under the current policy;
                                       -- NULL = hidden from every reader (FR-227)
  pinned INTEGER NOT NULL DEFAULT 0,
  ingest_batch_id TEXT NOT NULL,       -- signed batch it arrived in (signature verified at ingest)
  received_at TEXT NOT NULL,
  CHECK (kind <> 'capture' OR (content_hash IS NOT NULL AND redaction_stamp_json IS NOT NULL
                               AND coverage_json IS NOT NULL)),
  CHECK (kind <> 'status' OR (status_json IS NOT NULL AND text IS NULL))
);
CREATE INDEX idx_ambient_ts ON ambient_record(account_id, ts DESC);
CREATE INDEX idx_ambient_readable ON ambient_record(account_id, ts DESC)
  WHERE certified_at IS NOT NULL;
CREATE INDEX idx_ambient_dedupe ON ambient_record(device_id, source, content_hash);
CREATE INDEX idx_ambient_policy ON ambient_record(policy_version) WHERE kind = 'capture';

-- The certified view: the only way readers reach ambient content (FR-227).
CREATE VIEW ambient_record_readable AS
  SELECT * FROM ambient_record WHERE kind = 'capture' AND certified_at IS NOT NULL;

-- External-content FTS (unicode61, secure-delete) over the certified view: no second copy of
-- the text. Triggers insert a row when a record becomes readable and issue the FTS 'delete'
-- command when it is hidden, re-redacted, forgotten or expired, so the index never holds an
-- uncertified record. Audio transcripts are indexed through `text` (the joined segments).
CREATE VIEW ambient_fts_source AS
  SELECT r.rowid AS rid, r.text, r.window_title, r.url,
         (SELECT group_concat(json_extract(e.value, '$.text'), ' ')
            FROM json_each(r.elements_json) AS e) AS elements_text
  FROM ambient_record AS r
  WHERE r.kind = 'capture' AND r.certified_at IS NOT NULL;
CREATE VIRTUAL TABLE ambient_record_fts USING fts5(
  text, window_title, url, elements_text,
  content='ambient_fts_source', content_rowid='rid', tokenize='unicode61'
);

CREATE TABLE ambient_coverage (     -- materialized intervals for coverage in every result (FR-155)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device(id),
  source TEXT NOT NULL,                -- screen|mic|system-audio
  start_ts TEXT NOT NULL, end_ts TEXT, -- NULL end = the current interval
  state TEXT NOT NULL,                 -- captured|paused|excluded|gap
  reason TEXT,                         -- a status reason (docs/24 §7.2) or a Hub-derived gap reason:
                                       -- unreported|pending_upload|forgotten|not_enabled
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ambient_coverage ON ambient_coverage(account_id, device_id, source, start_ts);

CREATE TABLE ambient_forget_window ( -- "forget last N minutes" tombstones (FR-154, docs/24 §6.3)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  device_id TEXT REFERENCES device(id), -- NULL = every device
  sources_json TEXT,                   -- screen|mic|system-audio list; NULL = every source
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE ambient_grant (        -- Hub-enforced read scope (FR-233, docs/24 §8.5)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  grantee_kind TEXT NOT NULL,          -- schedule|automation|agent|app_authorization (agent: an
                                       -- always-on agent acting outside the owner's own chats)
  grantee_ref TEXT NOT NULL,
  apps_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[]}',   -- app patterns; empty allow denies all
  windows_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[]}', -- title patterns
  content_types_json TEXT NOT NULL DEFAULT '["activity_summary"]', -- screen_text|elements|pixels|
                                       -- transcripts|meetings|activity_summary
  time_window_json TEXT,               -- {lookbackSeconds} or {from, to}; NULL = since the last
                                       -- successful run, at most 24 h
  max_concurrent_queries INTEGER NOT NULL DEFAULT 3,   -- docs/24 §8.5 maxConcurrentQueries
  per_query_timeout_ms INTEGER NOT NULL DEFAULT 30000, -- docs/24 §8.5 perQueryTimeoutMs
  created_by TEXT NOT NULL,            -- always the user; agents never issue grants
  expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE meeting (              -- phase 2 (FR-230)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, device_id TEXT REFERENCES device(id),
  app_id TEXT, url TEXT,               -- meeting app or URL that held the microphone
  started_at TEXT NOT NULL, ended_at TEXT,
  state TEXT NOT NULL DEFAULT 'active', -- active|ended|discarded
  title TEXT, summary_artifact_id TEXT REFERENCES artifact(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE speaker (              -- phase 2 (FR-231); voiceprints never leave the Hub
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT,                           -- NULL until the user names it
  voiceprint_blob_path TEXT,           -- encrypted embedding; deletable
  merged_into_id TEXT REFERENCES speaker(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE meeting_speaker (
  meeting_id TEXT NOT NULL REFERENCES meeting(id),
  cluster_label TEXT NOT NULL,         -- speaker cluster within the meeting
  speaker_id TEXT REFERENCES speaker(id), -- NULL when below the match margin
  match_confidence REAL,
  PRIMARY KEY (meeting_id, cluster_label)
);
```

Invariants:

- An `automation_run` always references a version; smart entities mirror external state and
  are never the source of truth.
- **Readers see only certified rows** (FR-227): every read path (UI, tools, MCP, export,
  automations, FTS, embeddings) filters on `certified_at IS NOT NULL`. At ingest the Hub
  refuses a record whose stamp is stale, covers fewer categories than the policy enables, or
  names no accepted model (regex alone never certifies), and a record inside an
  `ambient_forget_window`. A policy change sets `certified_at` to NULL on every row whose stamp
  no longer satisfies the policy until it is re-redacted.
- Every ambient read by a schedule, automation or external client is checked against an
  unexpired, unrevoked `ambient_grant` (FR-233): deny, then allow, otherwise reject; denials
  are audited.
- Ambient results state the time covered and the gaps, taken from `ambient_coverage`
  (FR-155).
- Ambient records are encrypted at rest and pruned by retention; a device deletes its pixel
  copy only after the target's size and SHA-256 match `media_json` (FR-228).
