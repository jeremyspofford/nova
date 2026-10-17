# 06 — Domain Data Model

Storage: **SQLite (WAL)** via Drizzle ORM. All timestamps are UTC ISO-8601 strings. IDs are
UUIDv7 (sortable). Soft-delete uses `deleted_at`. Every table has `created_at`, `updated_at`.
Large blobs (attachments, images, snapshots) live on disk under the app data dir and are
referenced by relative path + SHA-256.

## 1. Entity overview

```
Account ──1:N── ProviderAccount ──1:N── ModelPref
   │
   ├──1:N── Project ──1:N── Thread ──1:N── Message ──1:N── MessagePart
   │                              │            │
   │                              │            ├──1:N── ToolCall ──1:1── Approval
   │                              │            └──1:N── Citation
   │                              └──1:N── Artifact
   │
   ├──1:N── Run (Work) ──1:N── RunStep ──1:N── SubAgent
   │            └──1:N── Schedule ──1:1── Trigger
   │
   ├──1:N── CodeSession ──1:N── CodeChange ──1:N── DiffHunk
   │            └──1:1── Environment
   │
   ├──1:N── Agent ──1:N── AgentResponsibility
   │            ├──1:N── AgentRule
   │            ├──1:N── AgentMemory
   │            ├──1:N── ChannelBinding
   │            └──1:1── Computer ──1:N── ComputerSnapshot
   │
   ├──1:N── MemoryItem
   ├──1:N── PolicyRule ──1:N── PermissionGrant
   ├──1:N── AuditEvent
   ├──1:N── Skill / PluginInstall / McpServer / Connector
   ├──1:N── UsageEvent
   ├──1:N── Notification
   └──1:N── Setting / Theme / Keybinding
Device ──1:N── SyncState
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
  alias TEXT,                     -- user-facing virtual model name
  enabled INTEGER NOT NULL DEFAULT 1,
  default_params TEXT,            -- JSON {temperature, reasoningLevel, maxTokens, ...}
  cost_in REAL, cost_out REAL,    -- per 1M tokens, informational
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

### projects, threads, messages

```sql
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'code' | 'work'
  instructions TEXT,
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
  parent_thread_id TEXT REFERENCES thread(id),  -- branching / side chat
  branch_from_message_id TEXT,
  temporary INTEGER NOT NULL DEFAULT 0,
  model_id TEXT, reasoning_level TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle', -- idle|streaming|waiting_approval|error
  metadata TEXT,                   -- JSON (env, cwd, session opts, agent id, ...)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_thread_account_mode ON thread(account_id, mode, updated_at DESC);
CREATE INDEX idx_thread_project ON thread(project_id);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  role TEXT NOT NULL,              -- system|user|assistant|tool|summary
  author_kind TEXT,                -- user|agent|subagent|system
  status TEXT NOT NULL DEFAULT 'complete', -- streaming|complete|incomplete|error
  model_id TEXT, provider TEXT, usage_json TEXT, cost_usd REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX idx_message_thread ON message(thread_id, created_at);

CREATE TABLE message_part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES message(id),
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,              -- text|reasoning|tool_call|tool_result|image|file|artifact_ref|error
  content TEXT,                    -- text or JSON
  mime TEXT, blob_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE attachment (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES message(id),
  thread_id TEXT REFERENCES thread(id),
  name TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT,
  blob_path TEXT NOT NULL,
  extracted_text_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE citation (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id),
  idx INTEGER, url TEXT, title TEXT, snippet TEXT, retrieved_at TEXT
);
```

### tools, approvals, audit

```sql
CREATE TABLE tool_call (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES message(id),
  thread_id TEXT REFERENCES thread(id),
  run_step_id TEXT REFERENCES run_step(id),
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL,            -- builtin|mcp|plugin|computer|browser
  server_id TEXT, plugin_id TEXT,
  args_json TEXT NOT NULL,
  result_json TEXT, error TEXT,
  status TEXT NOT NULL,            -- pending|running|ok|error|denied|timeout
  started_at TEXT, ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT REFERENCES tool_call(id),
  run_id TEXT REFERENCES run(id),
  agent_id TEXT REFERENCES agent(id),
  requested_action TEXT NOT NULL,
  reason TEXT, scope TEXT, risk TEXT,
  decision TEXT,                   -- allow_once|allow_always|deny|handoff
  decided_by TEXT, decided_at TEXT,
  rule_id TEXT REFERENCES policy_rule(id),
  created_at TEXT NOT NULL
);

CREATE TABLE policy_rule (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  scope_kind TEXT NOT NULL,        -- global|project|thread|run|agent|tool|plugin|site
  scope_ref TEXT,
  action_match TEXT NOT NULL,      -- JSON matcher (tool, resource pattern, effect)
  effect TEXT NOT NULL,            -- allow|ask|handoff|deny
  label TEXT, priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE permission_grant (     -- remembered approvals
  id TEXT PRIMARY KEY, rule_id TEXT, scope_kind TEXT, scope_ref TEXT,
  action_match TEXT, expires_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  actor TEXT NOT NULL,             -- user|agent:<id>|agent:<id>|system
  kind TEXT NOT NULL,              -- tool_call|approval|fs|network|auth|update|policy
  thread_id TEXT, run_id TEXT, agent_id TEXT, session_id TEXT,
  action TEXT NOT NULL, resource TEXT,
  input_hash TEXT, decision TEXT, result TEXT,
  detail_json TEXT,
  prev_hash TEXT, hash TEXT NOT NULL,  -- hash chain for tamper evidence
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_event(created_at DESC);
```

### work runs, schedules, triggers

```sql
CREATE TABLE run (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id),
  thread_id TEXT REFERENCES thread(id),
  agent_id TEXT REFERENCES agent(id),
  title TEXT NOT NULL, objective TEXT NOT NULL,
  plan_json TEXT, status TEXT NOT NULL,  -- planning|running|waiting_approval|paused|done|failed|cancelled
  autonomy TEXT NOT NULL DEFAULT 'standard',
  result_summary TEXT, result_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_run_status ON run(account_id, status, updated_at DESC);

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

CREATE TABLE schedule (
  id TEXT PRIMARY KEY, run_id TEXT REFERENCES run(id), agent_id TEXT REFERENCES agent(id),
  cron TEXT, interval_seconds INTEGER, timezone TEXT NOT NULL DEFAULT 'UTC',
  starts_at TEXT, ends_at TEXT,
  instructions TEXT, notify_condition TEXT, delivery_target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, next_run_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE trigger (
  id TEXT PRIMARY KEY, schedule_id TEXT REFERENCES schedule(id), run_id TEXT REFERENCES run(id),
  kind TEXT NOT NULL,              -- webhook|slack|email|fs_change|schedule
  config_json TEXT, dedupe_key TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT, created_at TEXT NOT NULL
);
```

### code sessions

```sql
CREATE TABLE environment (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- local|cloud|ssh|wsl|container
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
  worktree_path TEXT, branch TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'manual', -- manual|accept_edits|plan|auto|bypass
  status TEXT NOT NULL DEFAULT 'idle',
  pull_request_url TEXT, ci_status TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
  connected_computer_id TEXT REFERENCES computer(id),
  metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_responsibility (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id),
  title TEXT NOT NULL, instructions TEXT, status TEXT NOT NULL DEFAULT 'active',
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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE channel_binding (
  id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agent(id), account_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- slack|teams|telegram|email|webhook
  external_ref TEXT NOT NULL,           -- channel/user id
  config_json TEXT, secret_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE computer (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- cloud|local_container|local_host
  provider TEXT, base_image TEXT, state TEXT NOT NULL DEFAULT 'stopped',
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
CREATE TABLE memory_item (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,             -- global|project|thread|agent
  scope_ref TEXT,
  content TEXT NOT NULL, kind TEXT, confidence REAL,
  source_message_id TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY, thread_id TEXT REFERENCES thread(id),
  message_id TEXT REFERENCES message(id), run_id TEXT REFERENCES run(id),
  kind TEXT NOT NULL,                   -- markdown|code|html|image|chart|pdf|site|canvas|file
  title TEXT, blob_path TEXT, mime TEXT, version INTEGER NOT NULL DEFAULT 1,
  live INTEGER NOT NULL DEFAULT 0, meta_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE usage_event (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  provider TEXT, model TEXT, thread_id TEXT, run_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE notification (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT, body TEXT, refs_json TEXT,
  read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
```

### extensions, settings, sync

```sql
CREATE TABLE mcp_server (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT NOT NULL, transport TEXT NOT NULL, -- stdio|sse|http
  command TEXT, args_json TEXT, url TEXT, env_ref_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, last_status TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE plugin_install (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL, version TEXT NOT NULL, source TEXT,
  manifest_json TEXT, signature TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT, updated_at TEXT
);

CREATE TABLE skill (
  id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, description TEXT,
  instructions TEXT NOT NULL, triggers_json TEXT, files_json TEXT,
  builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE connector (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL,
  label TEXT, secret_ref TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE setting (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, scope_kind TEXT NOT NULL DEFAULT 'global',
  scope_ref TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE device (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT, platform TEXT,
  public_key TEXT, last_seen_at TEXT, created_at TEXT NOT NULL
);

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
│   ├── patches/<sha256>
│   ├── snapshots/<computer-id>/<snapshot-id>.tar.zst
│   └── screenshots/<yyyymmdd>/<id>.png
├── plugins/<plugin-id>/<version>/
├── skills/<skill-id>/
├── themes/<theme-id>.json
├── logs/
└── backups/                # pre-migration backups
```

## 4. Indexing & search

- **FTS5** virtual table over `message_part.content` (text) for chat search.
- **Vector index** (`sqlite-vec`) over chunked `message`, `attachment.extracted_text`, and
  project files for semantic retrieval; embeddings via a configurable provider (local
  default: `all-MiniLM`-class ONNX model; remote optional).
- **Code index**: tree-sitter parse → symbols/references tables in a separate `code_cache.db`
  per project (rebuildable, git-ignored, safe to delete).

## 5. Migration & retention policy

- Forward-only migrations, one per schema version, run in a transaction with a backup first.
- Retention defaults: messages forever; tool results 90 days unless pinned; screenshots 30
  days; logs 14 days; snapshots until deleted or 30 days. All configurable; user can disable
  pruning.
- Export: a single `.nova` archive (SQLite + blobs + manifest) plus a JSONL audit export.
- Delete: cascading soft-delete then hard-delete job with a 30-day recovery window.

## 6. Invariants

1. A `tool_call` in `run_step` context always has an audit event.
2. A `permission_grant` always references a `policy_rule` or an explicit scope.
3. Secrets never appear in any table; only `secret_ref` pointers.
4. `audit_event.hash` chains to `prev_hash`; verification tool included.
5. Deleting a `thread` cascades to messages/parts/attachments/artifacts but preserves
   `audit_event` (tombstoned via `thread_id`).
6. An `agent` always has exactly one cloud `computer`.

## 7. Hub, devices & transports (added)

The Hub holds the canonical database. Clients and compute nodes are registrations in it.

```sql
CREATE TABLE device (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL,        -- hub|compute|client|wake-helper
  cert_fingerprint TEXT NOT NULL, public_key TEXT NOT NULL,
  roles TEXT NOT NULL, scopes TEXT,              -- JSON
  status TEXT NOT NULL DEFAULT 'pending',        -- pending|active|revoked|unreachable
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
  net TEXT NOT NULL,                             -- lan|lattice|relay|direct
  url TEXT NOT NULL, healthy INTEGER NOT NULL DEFAULT 1,
  latency_ms INTEGER, last_checked_at TEXT, created_at TEXT NOT NULL
);

CREATE TABLE add_device_request (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  role TEXT NOT NULL, code_hash TEXT NOT NULL, scopes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending|approved|expired|denied
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
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
requires an active `wake-helper` device on the same LAN.
