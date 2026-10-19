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
   ├──1:N── ProviderActive                   (one active account per provider kind)
   │
   ├──1:N── Project ──1:N── Thread ──1:N── Turn ──1:N── Message ──1:N── MessagePart (items)
   │           │             │              │              ├──1:N── ToolCall ──0:1── Approval
   │           │             │              │              └──1:N── Citation
   │           │             │              └──1:N── ServerRequest ──0:1── Approval
   │           │             ├──1:N── Artifact
   │           │             ├──1:N── ThreadShare / SharedMessage (a shared thread, M7)
   │           │             ├──1:N── ScriptRun (script.run, M7)
   │           │             └──1:N── SessionHandoff
   │           ├──1:N── Source ──1:N── SourceChunk
   │           └──1:N── ProjectFolder ──1:N── ProjectFolderFile ──1:1── Source
   │
   ├──1:N── Run (Work) ──1:N── RunStep
   │            ├──1:N── SubAgent
   │            └──0:1── Goal (open)
   ├──1:N── Schedule ──1:N── ScheduleFire  (each fire starts a Run or an agent turn)
   ├──1:N── Trigger ──1:N── TriggerEvent    (each event starts a Run or wakes an agent)
   │            └──0:1── McpEventSubscription ──1:N── McpEventDelivery
   │
   ├──1:N── CodeSession ──1:N── CodeChange ──1:N── DiffComment
   │            ├──1:N── CodeReview ──1:N── DiffComment (findings)
   │            ├──N:1── Environment ──1:N── CloudRun / CloudSnapshot / CloudWorkBinding (cloud, M7)
   │            ├──0:1── Worktree (lease)
   │            ├──0:1── CodeSessionState (budgets, setup, task.spawn parent)
   │            ├──1:N── CodePullRequest ──N:1── GitHost
   │            ├──1:N── CodeVerifyRun
   │            ├──1:N── CodeAttemptSet ──1:N── CodeAttempt (each its own CodeSession, M7)
   │            ├──1:N── CodeMerge (M7)
   │            ├──0:1── CodeDelegation (an Agent started it, M7)
   │            ├──1:N── AgentDelegation (by its thread) ──N:1── AgentAdapter (M7)
   │            └──1:N── SessionHandoff
   │
   ├──1:N── Agent ──1:N── AgentThread (main, proactive, binding, background)
   │            ├──1:N── AgentResponsibility
   │            ├──1:N── AgentRule
   │            ├──1:N── AgentMemory ──1:N── AgentSuggestion
   │            ├──1:N── AgentWake
   │            ├──0:1── Goal (open)
   │            ├──1:N── ChannelBinding ──1:1── Thread (per channel, ADR-070)
   │            │            └──0:1── ChannelReadPosition, 1:N── ChannelApprovalLink (M7)
   │            ├──0:1── Computer (its own) ──1:N── ComputerSnapshot
   │            ├──0:1── AgentDeviceConnection (active) ──N:1── Device
   │            ├──0:1── AgentPluginScope (M7)
   │            └──0:1── TeamAgent (own identity Account) ──1:N── TeamAgentCredential / TeamTask (M7)
   ├──0:1── TeamMember / ProfileCard (M7)
   ├──1:N── MemberSetting (M7)
   ├──1:N── TeamInvitation / OidcProvider (created by the owner, M7)
   ├──1:N── OidcIdentity ──N:1── OidcProvider (M7)
   ├──1:N── ExternalAgent / ChannelIdentity / NotificationRule / NotificationDelivery
   ├──1:N── PushSubscription / PushDelivery (M7)
   ├──1:N── SyncField (change feed) / SyncMergeEntry / IdempotencyKey (M7)
   ├──0:1── QuietHours
   ├──1:N── Computer ──1:N── ScreenGrant / ScreenAction / ScreenTakeover / ScreenAppshot
   │            └──0:1── ScreenControl
   ├──1:N── EgressScope / EgressCredential
   ├──1:N── BrowserSite / BrowserAction / BrowserLogin
   ├──1:N── BrowserFallbackConsent / BrowserFallbackSession ──1:N── BrowserFallbackAction (M7.5)
   ├──1:N── OobEndpoint ──1:N── OobAction ──0:1── Approval (M7.5)
   ├──1:N── Space ──1:N── SpacePage ──1:N── SpacePageVersion / SpaceComment
   │            └──1:N── SpaceProposal
   ├──1:N── Site ──1:N── SiteVersion / SitePublish
   │
   ├──1:N── MemoryItem ──N:1── MemoryConsolidationRun
   ├──1:N── PolicyRule ──1:N── PermissionGrant
   ├──1:N── CommandRule ──1:N── PermissionGrant
   ├──1:N── PermissionProfile / Hook
   ├──1:N── AuditEvent / Event
   ├──1:N── SkillState / PluginInstall / AgentRole / Connector  (skills themselves are folders, §3)
   ├──1:N── McpServer ──0:1── McpOAuth
   ├──1:N── AppAuthorization / ImportRecord
   ├──1:N── UsageEvent
   ├──1:N── Notification
   ├──1:N── Setting / FeatureFlag            (themes and keybindings are files, §3)
   ├──1:N── Device (§7) ──1:N── TransportEndpoint / StagedWrite / Worktree
   │            ├──0:1── SyncReplica (M7)
   │            ├──0:1── DeviceManagement (novad devices)
   │            ├──1:N── FirmwareSnapshot / FirmwareChange ──0:1── Approval (M7.5)
   │            ├──1:N── BootProfile / BootRequest / BootAttempt / PxeToken (M7.5)
   │            ├──1:N── DeviceDecommission / BrowserBridgeGrant (M7.5)
   │            ├──0:1── NodePolicy (compute nodes, M7.5)
   │            └──1:N── DeviceGrant / DeviceUpdate / WakeRequest
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
  username TEXT,                  -- unique among live accounts (FR-113)
  avatar_path TEXT,               -- sealed blob (§3): PNG, JPEG or WebP ≤ 2 MB, metadata stripped
  email TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX uq_account_username ON account(username)
  WHERE username IS NOT NULL AND deleted_at IS NULL;

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

CREATE TABLE provider_active (      -- the active account of each provider kind (FR-115)
  account_id TEXT NOT NULL REFERENCES account(id),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL, -- without a row, or when it names a removed account, the
                                   -- oldest live account of the kind is active
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
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

CREATE TABLE project_folder (       -- local projects (FR-035): a folder on the Hub bound to a project
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  path TEXT NOT NULL,              -- canonical (real) path; at most 20 folders per project
  access TEXT NOT NULL DEFAULT 'read', -- read|write; a tool root for the project's chats, capped by
                                   -- the permission profile in force (FR-190)
  include_globs TEXT, exclude_globs TEXT, -- reserved for per-folder rules; unused in M4
  index_status TEXT NOT NULL DEFAULT 'pending', -- pending|indexing|ready|error
  file_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,                      -- the failure, or a note when a cap stopped indexing (still ready)
  last_indexed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, path)
);

CREATE TABLE project_folder_file (  -- the folder's file index: one row per indexed file
  folder_id TEXT NOT NULL REFERENCES project_folder(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id), -- the folder-backed source holding its chunks
  size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, -- an unchanged file is skipped on re-index
  sha256 TEXT NOT NULL,
  PRIMARY KEY (folder_id, rel_path)
);
CREATE INDEX idx_project_folder_file_source ON project_folder_file(source_id);

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
  trigger_ref TEXT,                -- schedule, goal, hook, trigger or channel_binding id; M5 run
                                   -- and sub-agent turns use trigger 'user' with the run id here
  run_id TEXT REFERENCES run(id),  -- set on turns a run starts (M5); a turn the user types into a
  goal_id TEXT REFERENCES goal(id), -- run thread has none yet
  execution_location TEXT NOT NULL, -- 'hub' | 'device:<id>' | 'environment:<id>'; fixed for the turn (FR-127)
  model_id TEXT, reasoning_level TEXT,
  step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count <= 200), -- model steps; backstop (FR-182)
  stop_reason TEXT,                -- end|budget|backstop|cancelled|approval_timeout|location_lost|error
  usage_json TEXT,                 -- {inputTokens, outputTokens, cachedTokens, costUsd, timeSeconds};
                                   -- since M5 timeSeconds is active time: waits for approvals and
                                   -- for the user's answers are left out
  started_at TEXT NOT NULL, ended_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (thread_id, idx),
  CHECK (status = 'in_progress' OR ended_at IS NOT NULL)
);
CREATE INDEX idx_turn_open ON turn(thread_id) WHERE status = 'in_progress';
CREATE INDEX idx_turn_started ON turn(started_at); -- usage insights: the longest turn (FR-114)

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  turn_id TEXT REFERENCES turn(id), -- NULL only for messages imported without turns (FR-200) and
                                   -- messages a device replica pushed (M7, FR-112)
  role TEXT NOT NULL,              -- system|user|assistant|tool|summary (summary: a compaction, below)
  author_kind TEXT,                -- who wrote it (table below)
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
                                   -- context (a resolved @-mention, FR-022)|
                                   -- plan|command_execution|file_change|mcp_tool_call|subagent_activity|
                                   -- web_search|compaction|review_marker|hook_prompt|notice
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
| `compaction` | `{trigger: pre_turn\|mid_turn\|post_turn\|manual, tokensBefore, tokensAfter, summary, note, turnId, covered, elided[], taint[], hooks[], method: model\|extractive}` | FR-183 |
| `review_marker` | `{phase: entered\|exited, kind: code_review\|auto_review, verdict?}` | FR-085, code review |
| `hook_prompt` | `{hookId, event, addedContext}` (text spilled to `blob_path` when large) | FR-197 |
| `notice` | `{code, message}`: something Nova tells the user about the turn, e.g. `instructions_truncated` | FR-185 |

M5 writes `compaction` and `notice`. It does not write `plan` (a run's plan lives in `run_step`),
`command_execution` (the tool card shows the command), `file_change`, `subagent_activity` or
`review_marker` yet.

**Compaction storage (FR-183).** A compaction needs no table of its own. It is a message with
role `summary`, `author_kind = 'system'`, `provenance = 'tool'` and one `compaction` part (idx 0).
It is inserted in the tree just above the turn's user message, and that message's versions are
reparented under it, so every later context of the path starts from the summary. `covered`
counts the messages it stands for. `elided` lists the earlier steps of the current turn whose
tool results it dropped (mid-turn and manual compactions keep only the latest step's).
The summary is plain text and keeps the `taint` of what it summarizes. The original messages
stay stored, visible and searchable.

`message.author_kind` says who wrote a message. Only text the signed-in user typed carries their
authority (FR-189); every other user-role message gets `provenance = 'tool'`:

| `author_kind` | Role | Written for |
| --- | --- | --- |
| `user` | user | the user's own message, typed in a Nova client |
| `agent` | assistant | every model reply |
| `hook` | user | a `stop` hook's continuation prompt (FR-197) |
| `run` | user | a Work run's objective or Nova's continuation of a run (typed only when the user wrote or started it) |
| `schedule` | user | a schedule's instructions on a scheduled run's first turn |
| `goal` | user | a goal continuation (FR-181); never the user's authority |
| `subagent` | user | a sub-agent's task, written by the parent model; never the user's authority |
| `system` | summary | a compaction summary |
| `offline` | assistant | an answer a device's local model wrote while the Hub was unreachable, pushed by its replica (M7, FR-128) |

*As built in M7 (ADR-095; `packages/core/src/sync`).* `message.provenance` is unchanged: its
CHECK (0002) still allows only the six values above. A message a device replica pushed is stored
with `provenance = 'typed'` and `turn_id` NULL. An offline user message keeps `author_kind =
'user'`, so memory extraction and intent checks treat it as the user's own words. The labels the
message view shows are derived when a thread is read: `offline` from `author_kind = 'offline'`,
and `sync` for a user message whose change-feed row (`sync_field`, field `body`) names the device
that wrote it.

Thread status (FR-215: Running, Needs input, Ready, Blocked) is **derived** from `thread.state`,
open `turn` rows, pending `server_request` rows, `goal.status` and child runs (`docs/09` §9);
it is not stored. M5 computes it in the Hub with precedence needs_input > blocked > running >
ready (child threads count for needs_input and running only). The last value per thread is kept
in memory only, to emit `thread.status.changed` when it changes.

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
  sha256 TEXT NOT NULL, blob_path TEXT NOT NULL, -- folder-backed sources (FR-035):
                                   -- folder:<folder id>/<rel path>; the bytes stay in the folder
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
  account_id TEXT NOT NULL REFERENCES account(id),
  message_id TEXT REFERENCES message(id),
  thread_id TEXT REFERENCES thread(id),
  turn_id TEXT REFERENCES turn(id),
  run_step_id TEXT REFERENCES run_step(id),
  parent_call_id TEXT REFERENCES tool_call(id), -- nested calls from script.run (FR-202)
  tool_name TEXT NOT NULL,
  source TEXT NOT NULL,            -- builtin|mcp|plugin|computer|browser|page|device
  server_id TEXT, plugin_id TEXT,
  origin TEXT NOT NULL DEFAULT 'model', -- model|ui|hook|mcp_client: who issued the call (audited)
  args_json TEXT NOT NULL,         -- redacted
  result_json TEXT, error TEXT,    -- redacted
  status TEXT NOT NULL,            -- pending|awaiting_approval|running|ok|error|denied|timeout|
                                   -- cancelled
  decision TEXT, approval_id TEXT, -- the gate's outcome and the approval it waited on
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
  review_json TEXT,                -- auto-review verdict, schema auto-review-verdict.json (FR-085):
                                   -- {outcome, risk, userAuthorization, rationale}, written when the
                                   -- reviewer's ask or handoff opens the card; rationale redacted,
                                   -- ≤ 1,000 characters (M5 does not show it in ApprovalView yet)
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
  answer_in TEXT CHECK (answer_in IS NULL OR answer_in = 'hub'), -- 0040 (M7.5): NULL anywhere its
                                   -- tier allows; hub = only the signed-in user in a Nova client
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
  id TEXT PRIMARY KEY,             -- shown and addressed as hook:<origin>.<hook_key>
                                   -- (hook:project:<projectId>.<hook_key> for project hooks)
  account_id TEXT NOT NULL REFERENCES account(id),
  hook_key TEXT NOT NULL,          -- hook id from its file, unique per source
  event TEXT NOT NULL,             -- session.start|session.end|prompt.submit|tool.pre|tool.post|
                                   -- permission.request|compact.pre|compact.post|subagent.start|
                                   -- subagent.stop|stop|interrupt (docs/08 §4.1)
  matcher_json TEXT,               -- glob list; NULL = every occurrence
  handler_kind TEXT NOT NULL,      -- command|mcp_tool
  handler_json TEXT NOT NULL,      -- hook-config.json#/$defs/handler
  fail_closed INTEGER NOT NULL DEFAULT 0, -- tool.pre and permission.request fail closed regardless
  source TEXT NOT NULL,            -- managed|user|project|plugin|extension: managed policy,
                                   -- <dataDir>/hooks.json, a project folder's .nova/hooks.json, a plugin
  plugin_id TEXT, project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  definition_json TEXT NOT NULL,   -- the definition as found in its file (what is hashed, minus enabled);
                                   -- the files stay authoritative and are re-read before each dispatch
  base_dir TEXT,                   -- folder a command hook runs in and may reference (plugin, project)
  limits_json TEXT,                -- plugin hooks: the plugin's limits {network, fsProject, answersAsks}
  content_hash TEXT NOT NULL,      -- SHA-256 over the canonical definition and any script it runs
                                   -- inside base_dir
  trusted_hash TEXT,               -- hash the user trusted; NULL or different = needs_trust
  trust_state TEXT NOT NULL DEFAULT 'needs_trust', -- needs_trust|trusted|revoked
                                   -- (hook-config.json#/$defs/trustRecord)
  trusted_by TEXT, trusted_at TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  enabled INTEGER NOT NULL DEFAULT 1, -- the user's switch (user hooks) or the plugin's (plugin hooks)
  last_run_at TEXT,
  last_effect TEXT,                -- none|context|decision|continue|blocked|error
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- NULLs are distinct in a plain UNIQUE constraint, so the per-source key uses COALESCE.
CREATE UNIQUE INDEX idx_hook_key
  ON hook(account_id, source, COALESCE(plugin_id, ''), COALESCE(project_id, ''), hook_key);
CREATE INDEX idx_hook_event ON hook(account_id, event);

CREATE TABLE server_request (       -- Hub-to-client requests (FR-188); schema server-request.json
  id TEXT PRIMARY KEY,             -- uuidv7
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- approval|user_input|elicitation|client_tool|credential_refresh
  thread_id TEXT, turn_id TEXT, run_id TEXT, agent_id TEXT, call_id TEXT, -- correlation ids
                                   -- (plain columns, no FKs: purges never block on a request)
  approval_id TEXT REFERENCES approval(id), -- kind = 'approval'
  target_device_id TEXT,           -- NULL = any authorized client; client_tool may name one
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|resolved|expired
  resolved_by TEXT,                -- user|hook:<id>
  resolved_by_device TEXT,
  resolution_json TEXT,            -- the answer, redacted
  expired_reason TEXT,             -- timeout|cancelled|restart: a cancelled request (its turn was
                                   -- cancelled) and one a restart left pending end `expired` too
  notified_at TEXT,                -- fallback notification sent (FR-060), once per request
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT, -- resolved_at is also
                                   -- set when a request expires
  CHECK (status <> 'resolved' OR (resolution_json IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX idx_server_request_pending ON server_request(account_id, expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_server_request_thread ON server_request(thread_id) -- derived status (FR-215)
  WHERE status = 'pending';
```

M5 writes no `approval` rows here: approvals keep their own table, and `GET /requests` lists
pending approvals as read-only `approval` items read from `approval`. M6 still writes NULL in
`agent_id`: a request's thread leads to its agent through `agent_thread`.

Migration 0040 (M7.5; FR-146, FR-189; ADR-096) adds `approval.answer_in`. Firmware, boot,
out-of-band and decommission cards set it to `hub`: risk high, tier `confirm_at_action`, options
`allow_once` and `deny_continue`. The gate refuses any decision on such a card not made by the
signed-in user (`decided_by` other than `user`) with `policy_denied` `{reason: hub_only}`; a
channel's button press or reply is refused the same way, a signed email link answers nothing, and
the channel prompt carries no buttons or link. Each of those areas also acts only on an
`allow_once` with `decided_by = 'user'`. Clients see the column as `ApprovalView.answerIn`.

### audit & events

```sql
CREATE TABLE audit_event (          -- append-only: triggers refuse UPDATE and DELETE
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,     -- chain order; the hash covers every column except hash
  account_id TEXT NOT NULL REFERENCES account(id),
  actor TEXT NOT NULL,             -- user|agent:<id>|system (run and sub-agent ids go in run_id/detail);
                                   -- also mcp_client:<authorization id> and a hook id (M4)
  kind TEXT NOT NULL,              -- tool_call|approval|review|hook|fs|network|egress|auth|update|
                                   -- policy|import|ambient|secret|settings|mcp|node|plugin|terminal|
                                   -- run|schedule|request|code (M5)|agent|channel|computer|browser|
                                   -- screen|device|space (M6)
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

Audit actions added in M4 (`kind` / `action`; inputs are stored as a hash only):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `auth` | `app_authorization.create`, `app_authorization.revoke` | `app_authorization:<id>` | adding or revoking a client of Nova's MCP server (FR-044) |
| `mcp` | `client.call` | `app_authorization:<id>` | every call from an MCP client; actor `mcp_client:<id>`, detail `{clientId, clientName, tool, callId}` |
| `mcp` | `bundle.install`, `bundle.update` | `mcp_server:<id>` | bundle installs (FR-199): version, SHA-256, signature, `sideloaded`, confirmed permissions |
| `mcp` | `oauth.start`, `oauth.connect`, `oauth.failed`, `oauth.revoke` | `mcp_server:<id>` | OAuth for a remote server (FR-047) |
| `settings` | `plugin.install`, `plugin.update`, `plugin.enable`, `plugin.disable`, `plugin.uninstall` | `plugin:<pluginId>` | the plugin installer (FR-045) |
| `settings` | `hook.trust`, `hook.untrust`, `hook.delete` | hook id | the hooks trust list (FR-197) |
| `policy` | `hook.<event>` | the tool, if any | every hook run; actor is the hook id, `decision` its effect, `result` `ok\|timeout\|error\|not_started` |
| `fs` | `fs.write` | file path | a save from the file editor (FR-039), `detail.origin: ui` |
| `tool_call` | `terminal.open`, `terminal.close` | the terminal's folder | terminals (FR-006) |
| `settings` | `import.applied` | `import:<importId>` | an import run (FR-200) |
| `secret` | `import.secret.moved` | the `secret://` reference | each secret an import moved to the vault |
| `mcp` | `add` | `mcp_server:<id>` | an imported MCP server (`source: import`, disabled) |

The `hook`, `plugin` and `terminal` kinds are reserved; M4 writes the kinds above.

Audit actions added in M5 (`kind` / `action`; inputs are stored as a hash only):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `run` | `run.create`, `run.start`, `run.pause`, `run.resume`, `run.redirect`, `run.cancel`, `run.budget.extend`, `run.plan.update` | `run:<id>` | Work run controls (FR-051, FR-182); `result` is the run status; `run.redirect` keeps only the input hash; `run.budget.extend` has `detail.by` |
| `run` | `goal.set`, `goal.update`, `goal.clear`, `goal.status` | `goal:<id>` | goals (FR-181); `goal.status` has `detail {from, to}` |
| `run`, `schedule` or `policy` | `turn.start` | `thread:<id>` | every turn a run, schedule, goal, sub-agent or hook starts: kind `run` when it belongs to a run, `schedule` for a schedule trigger, else `policy`; actor `user` or `system`; `decision` `user_instruction` or `no_authority`; detail `{trigger, triggerRef, runId, goalId, authorKind, messageId, source\|origin}` |
| `schedule` | `schedule.create`, `schedule.update`, `schedule.delete` | `schedule:<id>` | schedule edits (FR-055); `detail.changed` on update |
| `schedule` | `schedule.fire`, `schedule.run_now`, `schedule.skip` | `schedule:<id>` | a fire or catch-up (`result` is the run id), Run now, and missed fires recorded as skipped (ADR-079) |
| `network` | `schedule.webhook` | the webhook host | a webhook delivery; `decision` `delivered\|failed` |
| `code` | `code.session.created`, `code.mode.changed` | the session folder | Code sessions (FR-061, FR-063); `decision` is the mode |
| `code` | `code.change.rejected` | the file's path | rejecting hunks rewrites the user's file (FR-064) |
| `code` | `code.review` | the session folder | a `/review` run (FR-069): model, attempts and finding count |
| `code` | `code.commit` | the session folder | a commit (`docs/10` §8): sha, branch, files, `hooksRan` |
| `review` | `review.verdict`, `review.override`, `review.breaker` | the call's path or host (`review.override`: the tool) | the auto-reviewer (FR-085): each verdict with model, attempts, latency and `failedClosed`; an Allow once over its verdict; a breaker trip |
| `tool_call` | `exec.session.kill` | the session's folder | an exec session killed from the terminal pane (actor `user`), or ended with its run or a cancel (actor `system`) (FR-184); `result` `killed\|cancelled` |

The reviewer's entries use kind `review` (the M5 integration fixes moved them from `policy`). The
`request` kind is reserved: M5 writes no audit entry for server-to-client requests.

Audit actions added in M6 (ADR-093; `kind` / `action`; inputs are stored as a hash only):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `agent` | `agent.create`, `agent.update`, `agent.delete`, `agent.pause`, `agent.auto_pause`, `agent.resume`, `agent.stop` | `agent:<id>` | always-on agents (FR-079, FR-090); detail always carries `agentId`; `agent.auto_pause` (actor `system`, reason `safety`) has no caller in M6 |
| `agent` | `agent.responsibility.*`, `agent.rule.*` (`create`, `update`, `delete`), `agent.note.*`, `agent.memory.update`, `agent.memory.forget`, `agent.memory.purge`, `agent.suggestion.accept`, `agent.suggestion.dismiss` | `agent:<id>` | the user's edits (FR-084, FR-089); notes the agent writes and `agent.progress` are events only |
| `agent` | `agent.proactive.start`, `agent.proactive.end`, `agent.proactive.denied`, `agent.delegate`, `agent.session.message`, `agent.session.archive`, `agent.wake.set`, `agent.binding.thread` | `agent:<id>` | research (FR-082), delegation (FR-083), cross-session tools (FR-072), self-set wakes (FR-206) and a binding's thread; actor `agent:<id>` or `system` |
| `agent` | `goal.set`, `goal.clear`, `goal.status` | `agent:<id>` | an agent's goal (FR-181); the runs area keeps kind `run` for run goals |
| `agent` | `external_agent.mark`, `external_agent.unmark`, `external_agent.denied`, `external_agent.allowed` | `external_agent:<address>` | FR-194; a denial has `detail.cause: external_agent` and the action (`accept_task`, `delegate`, `send_data`) |
| `schedule` | `schedule.wake` | `schedule:<id>` | a self-set wake (actor `agent:<id>`); agent schedules also write the M5 schedule actions |
| `channel` | `channel.create`, `channel.update`, `channel.delete`, `channel.connect`, `channel.disconnect`, `channel.test`, `channel.identity.set`, `channel.identity.remove` | `channel_binding:<id>` (identities `<kind>:<externalId>`) | bindings and identity mapping (FR-088) |
| `channel` | `channel.message.dropped`, `channel.share.check`, `channel.approval.answered`, `channel.approval.refused` | `channel_binding:<id>`, `approval:<id>` | dropped inbound messages (`detail.reason`), the private-to-shared check, approvals answered from a channel (actor `channel:<bindingId>`) |
| `channel` | `trigger.create`, `trigger.update`, `trigger.delete`, `trigger.fired`, `trigger.skipped`, `trigger.failed`, `trigger.rejected` | `trigger:<id>` | event triggers (FR-056); `trigger.rejected` for a webhook that failed authentication |
| `mcp` | `mcp.subscription.create`, `mcp.subscription.remove`, `mcp.event.rejected` | `mcp_server:<id>` | MCP event subscriptions (FR-201); a refused delivery's reason is in `result` |
| `settings` | `notification.rule.set`, `notification.rule.reset`, `quiet_hours.set`, `egress.scope.set`, `egress.scope.delete` | the rule, `quiet_hours`, `<kind>:<id>` | notification routing (FR-060) and scope network policy (FR-193) |
| `secret` | `egress.credential.create`, `egress.credential.update`, `egress.credential.delete`, `code.githost.connected`, `code.githost.removed` | the `secret://` reference or the host's web URL | credentials the proxy injects (ADR-063) and Git host tokens (FR-070); never a value |
| `network` | `egress.request`, `egress.connect` | `host:port` | every egress proxy decision (FR-193): detail `{egressSession, scope, method, host, port, addressClass, mode, decision, cause, rule, status, inspected, bytesIn, bytesOut, credentials?, hooks?, error?}`; no bodies, paths or full URLs |
| `computer` | `computer.create`, `computer.delete`, `computer.snapshot`, `computer.snapshot.delete`, `computer.restore`, `computer.stop`, `computer.exec`, `computer.fs.write`, `computer.fs.delete`, `computer.fs.move` | `computer:<id>` | computers (FR-080); `computer.exec` only for commands through the `Computer` seam (exec tools are audited as tool calls) |
| `computer` | `computer.takeover.started`, `computer.takeover.ended` | `computer:<id>` | takeover (FR-087); `result` `returned\|restart` |
| `browser` | `browser.site.set`, `browser.site.removed`, `browser.domains.set`, `browser.devprotocol.enabled`, `browser.devprotocol.disabled`, `browser.session.closed` | the site or host | site permissions and lists (FR-094) |
| `browser` | `browser.devserver.granted`, `browser.devserver.revoked` | `127.0.0.1:<port>` | a Code session's dev server granted to (or taken from) a computer's browser (FR-097, FR-067); detail `{computerId}` |
| `browser` | `browser.navigation.blocked`, `browser.action.denied`, `browser.external_agent`, `browser.injection_suspected` | the host | refusals: `browser.action.denied` has `cause: password\|external_agent` |
| `browser` | `browser.signin.requested`, `.submitted`, `.cancelled`, `.expired`, `browser.login.saved`, `.used`, `.deleted`, `browser.fallback.started`, `browser.fallback.refused` | the host | private sign-in (FR-086); passwords are never audited; the fallback actions have no caller in M6 (M7.5 gave them one, below) |
| `review` | `review.verdict` | the host | the auto-reviewer on an `auto_review` site (`detail.source: browser`) |
| `screen` | `screen.control.enabled`, `screen.control.disabled`, `screen.kill`, `screen.resume`, `screen.grant.created`, `screen.grant.renewed`, `screen.grant.revoked`, `screen.click`, `screen.scroll`, `screen.type`, `screen.key`, `screen.drag`, `appshot.captured` | `computer:<id>` (`/app:<app>`) | computer use (FR-093, FR-207, FR-098, FR-075); one entry per recorded action, `decision: deny` for a refusal; typed text only as a hash |
| `code` | `environment.created`, `environment.updated`, `environment.removed`, `code.push`, `code.pr.opened`, `code.branch.created`, `code.budget.extended`, `code.worktree.created`, `code.worktree.released`, `code.worktree.removed`, `code.devserver.start`, `code.devserver.stop`, `code.session.messaged`, `code.session.archived`, `code.worker.spawned` | the session folder, environment id, worktree path or pull request URL | Code M6 (FR-062, FR-068, FR-070, FR-072, FR-073, FR-097); `code.push` is written for denied pushes too; `code.commit` records actor `agent` for the agent's commits |
| `device` | `device.register`, `device.revoke`, `device.update`, `device.module.start\|stop\|restart\|rollback\|crashed\|disabled`, `device.service.start\|stop\|restart`, `device.power.wol-enable\|sleep\|restart\|shutdown`, `device.wake` | the device id | `novad` devices (FR-141, FR-144, FR-145, FR-148, FR-150); `device.update` covers both a PATCH and a pushed bundle |
| `device` | `device.access.request`, `device.access.decide`, `device.grant.create`, `device.grant.revoke`, `device.write.stage`, `device.write.commit`, `device.write.discard`, `device.fs.delete`, `device.fs.move`, `device.exec`, `device.mcp.call`, `device.connection.create`, `device.connection.revoke` | the device id | device files, local MCP and agent connections (FR-210, FR-081); route actions are audited as `user` while their events carry actor `system` |
| `space` | `space.deleted`, `space.page.deleted`, `space.page.restored`, `space.page.edited`, `space.proposal.accepted`, `space.proposal.rejected`, `site.published`, `site.unpublished`, `site.deleted` | `space:<id>`, `page:<id>`, `site:<id>` or the published folder | spaces and sites (FR-036, FR-037); `space.page.edited` is an agent's direct version |

Creating spaces, saving pages, comments, building sites, checking environments, Git
hosts or verify runs, side questions and file reads on a device are not audited.

Audit actions added in M6.5 (ADR-094; `kind` / `action`; no new kind):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `device` | `device.add.start` | the pairing id | an owner starts Add Device (FR-132): role, scopes, transport, expiry; actor `user` |
| `device` | `device.add.complete` | the request id; for a refusal the pairing id (none for a typed code) | a device commits: `result` `committed`; a refusal `result: denied` with `detail.reason` (`wrong_code`, `burned`, `expired`, `unknown`, `code_only_locked`, `key_revoked`, `kind_not_allowed`, `key_in_use`), audited for the pairing or, for a typed code, for each account it was tried against; a Relay claim that becomes a request is `result: ok` |
| `device` | `device.add.reveal` | the request id | a good reveal (`result: ok`, the request is now pending) or a burned one (`result: denied`, `reason: bad_reveal`) |
| `device` | `device.add.approve`, `device.add.deny` | the request id | the owner's decision (`decision` `approved` or `denied`; actor `user`); a deny that lost to an approval writes nothing |
| `device` | `device.add.expire` | the pairing or request id | `detail.what`: `pairing` (an unused code), `commit` (never revealed), `request` (never decided) or `grant` (approved, never collected) |
| `device` | `device.scopes.update` | the device id | `PUT /devices/:id/scopes`: `{from, to}` |
| `device` | `device.revoke` | the device id | M6.5 also writes it for compute nodes, browsers and apps (`{name, kind, sessions, fingerprint}`); `device.wake` gains `via` (the helper's id, `hub`, or null for `no_wake_helper`) and `device.register` gains `addDevice: true` for a bound token |
| `network` | `network.change`, `network.rollback` | the change id | the network panel's settings (`{keys, values}`) and one-click rollback (`result: failed` with the error when the undo throws) (FR-135, FR-139) |
| `network` | `network.setup.consent`, `network.setup.apply`, `network.setup.rollback` | `network_setup_step:<id>` | the setup assistant (FR-136): consent `granted` or `revoked`; every apply, also when denied (`system_changes_disabled`, `would_lock_out`); every rollback (actor `system` when automatic), with `allowSystemChanges`, `failed` and `reason`, `result: rollback_failed` when an undo failed |
| `network` | `trust.change`, `trust.ca.create`, `trust.ca.rotate`, `trust.leaf.issue`, `trust.device.issue`, `trust.device.revoke`, `trust.mesh.store` | `trust`, or the CA, certificate or device id | trust (FR-134): a mode change with `{from, to, via: settings\|rollback}`; certificates by serial, never a key |
| `network` | `relay.change`, `relay.pair`, `relay.revoke` | `relay`, or the relay client id | the Relay (FR-137): settings changes; pairing outcomes with `decision` `approved`, `denied`, `expired` or `refused` and `detail.reason` (`expired`, `bad_claim`, `client_conflict`, `revoked_key`, `add_device_unavailable`, `add_device_refused`); revocations with whether the Relay was told |

No entry holds a code, nonce, token or key. Trust actions the Hub takes on its own are attributed
to the owner account and not written before setup.

Audit actions added in M7 (ADR-095; `kind` / `action`; no new kind: sync uses `device`, the cloud
runner `settings`, `code` and `run`):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `device` | `sync.restore` | `sync:<kind>:<entityId>` | restoring a merge-log entry (FR-109): detail `{entryId, kind, entityId, field, deviceId}` (the device of a device session, else null) |
| `device` | `sync.replica.reset` | `device:<id>` | the owner resets a device's replica; it must load a snapshot again |
| `settings` | `cloud.runner.change`, `cloud.runner.remove` | `cloud.runner` | the cloud runner's URL, token and switch (FR-108): `{url, urlChanged, token: replaced\|kept, enabled, test}`; never the token |
| `code` | `cloud.environment.rebuild`, `cloud.environment.remove`, `cloud.snapshot.create`, `cloud.snapshot.restore`, `cloud.snapshot.delete` | the environment or snapshot id | cloud environments (FR-071) and their snapshots; creating a cloud environment writes the M6 `environment.created` with `detail.kind: cloud` |
| `run` | `cloud.run.start`, `cloud.run.cancel`, `cloud.run.caps`, `cloud.run.capped`, `cloud.artifact.import`, `cloud.work.start` | the cloud run id (`cloud.work.start`: the Work run id) | leases on a cloud environment and their caps (FR-108, FR-116); `cloud.run.capped` (actor `system`) has `{resource, used, limit}`; an imported artifact has its size and SHA-256 |
| `settings` | `push.subscribe`, `push.unsubscribe`, `push.subscription.gone`, `push.test`, `push.vapid.create` | `push_subscription:<id>` (`push.test` without one: `push`; `push.vapid.create`: `push:vapid`) | Web Push (FR-111): the endpoint's origin, never its keys; `push.subscription.gone` (actor `system`, `detail: {reason, deviceId?}`) when the push service drops an endpoint (`reason`: the push service's answer) or its device is revoked (`reason: device_revoked`, which also deletes its keys from the vault); the VAPID key made on first use (actor `system`) |
| `settings` | `notification.test` | `notification_rule:<category>` | a test notification from Settings (FR-060) |
| `schedule` | `schedule.webhook_secret.rotate` | `schedule:<id>` | a webhook signing secret rotated (FR-055); the secret is shown once and never audited |
| `mcp` | `mcp.subscription.refresh` | `mcp_server:<id>` | refreshing an MCP event subscription by hand (FR-201) |
| `channel` | `channel.approval.answered`, `channel.approval.refused` | `approval:<id>` | M7 adds `detail.via: button\|link` (a button press or the signed email link; a text answer has none) and the refusal reasons `unknown`, `other_conversation`, `already_decided`, `link_required`, `unavailable`; `channel.message.dropped` gains the reason `unverified_sender`; `channel.email.sender_check_off` when an email binding's `senderCheck` is set to `none` (after the explicit confirmation) |
| `code` | `code.handoff.requested`, `code.handoff.completed`, `code.handoff.refused`, `code.handoff.failed`, `thread.handoff` | the target folder, else the target ref | handoffs (FR-213): `{handoffId, sessionId?, from, …}`; `thread.handoff` moves a chat |
| `code` | `code.merge`, `code.merge.resolved`, `code.merge.aborted` | the session folder | three-way merges (FR-073); `code.merge` has `result` `ok`, `conflict` or `denied` |
| `code` | `code.attempts.started`, `code.attempt.applied`, `code.attempts.discarded` | the parent session's folder | best-of-N (FR-212); `code.attempt.applied` has `result: conflict` when its merge conflicted |
| `code` | `code.delegate`, `code.delegation.held`, `code.delegation.cancelled` | the session folder (`held`, `cancelled`: the session id) | a session an agent started (actor `agent:<id>`); `held` when the agent pauses or stops, `cancelled` when it is deleted (actor `system`) |
| `code` | `environment.hostkey.pinned`, `environment.hostkey.mismatch`, `environment.hostkey.reset` | the environment id | SSH host keys (FR-062): pinned on first use (actor `system`) or by an update; a different key refused (`result: denied`, actor `system`); reset on purpose, or when the host changed (`reason: host_changed`) |
| `code` | `code.mode.changed` | the session folder | M7 also writes it (actor `system`, `detail.reason: handoff`) when a handoff target cannot offer the session's mode |
| `tool_call` | `script.call` | the nested tool's name | each call a `script.run` script made (FR-202), besides the call's own entry: `{scriptCallId, callId, tool, index}`, `decision` and `result` its status; actor `system` |
| `code` | `agent_adapter.create`, `agent_adapter.update`, `agent_adapter.delete`, `agent_adapter.check` | the adapter id | external agent adapters (FR-203); `check` records the handshake's `{ok, reason}` |
| `code` | `delegation.start`, `delegation.permission`, `delegation.cancel`, `delegation.finish` | the delegation id | a Code session's delegation to an adapter: the prompt's SHA-256 only; each permission request the agent made (actor `system`, `decision` the answer); a cancel (actor `user`), also when turning the flag off stopped it (actor `system`, `detail.reason`); the end with `{status, stopReason, permissionRequests, operations}` |
| `policy` | `acp.fetch`, `acp.think`, `acp.action` | the resource, if any | the gate's decisions on an external agent's own permission requests (the gate audits every decision under the tool's name) |
| `mcp` | `add` | `mcp_server:<id>` | M7 records `deviceId` (a server on a device), `auth: true` (a stored Authorization header, never its value) and the `oauth` settings (FR-042) |
| `mcp` | `client.call` | `app_authorization:<id>` | M7 also writes it for MCP clients' resource and prompt reads and listings (FR-044) |
| `auth` | `team.invite`, `team.invite.revoke` | `invitation:<id>` | the owner's invitation links for the people of the Hub (ADR-095) |
| `auth` | `team.join`, `team.member.remove` | `account:<id>` | a member joining (`detail.via` `local` or `oidc`) and the owner removing one |
| `auth` | `oidc.provider.create`, `oidc.provider.update`, `oidc.provider.delete`, `oidc.provider.test` | `oidc:<id>` | OIDC providers (FR-113) |
| `auth` | `oidc.link`, `oidc.sign_in`, `oidc.refused`, `oidc.unlink` | `oidc:<providerId>` (`oidc.unlink`: `oidc-identity:<id>`) | OIDC sign-in; `oidc.refused` (actor `system`) has `{reason, flow}` and goes to the account that started it, else the owner's |
| `auth` | `profile.card` | `account:<id>` | the public profile card's switch and handle (FR-113) |
| `auth` | `thread.share`, `thread.unshare` | `thread:<id>` | shared threads (FR-217) |
| `agent` | `team_agent.provision`, `team_agent.remove`, `team_agent.credential.add`, `team_agent.credential.remove` | `agent:<id>` | team agents (FR-091), written twice: in the owner's trail (actor `user`) and the identity account's (actor `owner:<accountId>`) |
| `agent` | `team_task.start`, `team_task.end` | `team-task:<id>` | a task given to a team agent, in its identity account's trail (actor `agent:<id>`) |
| `agent` | `goal.usage_retry`, `agent.plugins` | `agent:<id>` | a goal tried again after a usage limit (actor `system`); the plugins connected to an agent (FR-045) |
| `device` | `device.tls.refuse` | the device id | a `novad` device or compute node refused at mutual TLS (FR-126): `{kind, reason, serial}`, at most once an hour per device and reason; actor `system` |
| `network` | `relay.registrationToken.set`, `relay.registrationToken.clear` | `relay` | the Relay registration token; detail holds only its `secret://` reference |
| `browser` | `browser.session.crashed`, `browser.session.restarted`, `browser.session.restart_failed` | the host | a crashed page or browser and its restart (docs/11 §10); actor `system`; after 3 restarts in 10 minutes the session closes with `restart_failed` |
| `browser` | `browser.site.level.set`, `browser.site.level.removed` | the site pattern (none when a deletion removed them) | a site's level for one project or agent (FR-094): `{scopeKind, scopeRef, level}`; when deleting the project or agent removed its levels, actor `system` and `{scopeKind, scopeRef, count, reason: project_deleted\|agent_deleted}` |
| `browser` | `browser.injection_suspected` | the host | M7 also writes it for console and network capture (`detail.source` `console` or `network`), once per set of findings |

No entry holds a runner token, push key, invitation token, OIDC code or secret, adapter secret
value or script code. Sync pushes and their merges are not audited (the merge log keeps every
overwritten value), nor are push deliveries (`push_delivery` keeps how each ended) or idempotent
replays.

Audit actions added in M7.5 (ADR-096; `kind` / `action`; no new kind: firmware, boot, out-of-band,
decommission and compute-node policy use `device`):

| Kind | Action | Resource | Written for |
| --- | --- | --- | --- |
| `device` | `device.firmware.read`, `device.firmware.plan`, `device.firmware.approval`, `device.firmware.apply`, `device.firmware.rollback` | the device id | BIOS/firmware changes (FR-146): a read through the device (`{supported, method, vendor, settings}`, a count), then each step with the change id and the values `before` and `after`; `apply` also has the approval and authorization ids and `result` `ok`, `failed` or `error`; a planned rollback has `result: requested` |
| `device` | `device.firmware.watchdog` | the device id | the device's watchdog report (actor `system`): `result` `ok`, `reverted`, `revert_failed` (with `failed`, `notRestored`, `errorCode` and the values the machine now holds) or `missed` (the Hub's sweep: no report by the deadline plus 120 s) |
| `secret` | `device.firmware.password.set`, `device.firmware.password.clear` | the device id | the write-only BIOS admin password: `{ref}` only (`secret://devices/<id>/bios-admin`); cleared when the device is revoked or decommissioned (actor `system`, `reason: device_revoked`) |
| `device` | `device.boot.read`, `device.boot.profile.create`, `device.boot.profile.update`, `device.boot.profile.delete` | the device id | boot status read through the device (`result` `ok` or the error code) and profile edits with before and after (FR-143) |
| `device` | `device.boot.request`, `device.boot.denied`, `device.boot.expired`, `device.boot.set`, `device.boot.commit`, `device.boot.revert` | the device id | a try, commit or revert: its card filed, denied or expired, then sent to the device (`set` is a try) with the state before and after |
| `device` | `device.boot.watchdog` | the device id | a trial's end (actor `system`): `result` `ok`, `reverted` or `failed` (`no_heartbeat`, `no_watchdog_report`), from the device's report or the Hub's own watchdog |
| `device` | `device.boot.pxe.token`, `device.boot.pxe.script`, `device.boot.pxe.image` | the device id | a boot token created, rotated or revoked (its id and creation time, never the token); every iPXE menu and image fetch (actor `system`, `{from, …}`; images with name, size and byte range) |
| `device` | `device.oob.refuse` | none; a refusal about one endpoint: its id | out-of-band management (FR-147) refused (`decision: denied`, `{what, reason}`) for a member (`owner_only`), while it is off (`oob_disabled`), or for turning it on through the settings route (`consent_required`, `via: settings`); turning it on or off is the `setting.changed` entry of `devices.oob.enabled` |
| `device` | `device.oob.endpoint.create`, `device.oob.endpoint.update`, `device.oob.endpoint.delete` | the endpoint id | BMC registrations: name, kind, address, port, system, device, pin and whether it is confirmed; never a credential |
| `device` | `device.oob.pin`, `device.oob.pin_mismatch` | the endpoint id | a BMC certificate fingerprint read on first use without credentials (`decision: unconfirmed`), confirmed by the owner (`confirmed`), or a different certificate refused (expected and presented fingerprints) |
| `device` | `device.oob.<action>` | the endpoint id | each out-of-band action (`check`, `power.status`, `power.on`, `power.off`, `power.cycle`, `power.reset`, `sensors`, `bios.read`, `bios.plan`, `bios.apply`, `boot.next`): `decision` `requested`, `approved`, `denied`, `expired`, `done` or `failed`, the parameters, `inputHash` the approval's hash; changes also carry before and after |
| `device` | `device.decommission.request`, `device.decommission.decide`, `device.decommission` | the device id | decommissioning a `novad` device (ADR-096 D9): the request `{purge, approvalId, reachable}`; a card that ended without the owner's Allow once (`decision` `denied` or `expired`), or a request withdrawn because the device was revoked meanwhile (`decision: cancelled`); the run, `result` `wiped`, `unreachable`, `refused` or `not_told`, with the status before and after (revoked, certificate revoked) |
| `device` | `device.endpoint.change`, `device.endpoint.refuse` | the device id | a device moving its management endpoint to `https://` for mutual TLS (actor `system`, `{before, after, channel: mutual_tls}`); a refused endpoint (`endpoint_downgrade`, `https_needs_certificate`; `decision: deny`, at most once an hour per device and reason) |
| `device` | `device.config.push` | the device id | the owner's "push now" of a device's overrides (FR-142, FR-150): `{revision}` |
| `device` | `node.policy.update`, `node.service.start`, `node.service.stop`, `node.service.restart` | the compute node's device id | a compute node's policy (quiet hours, time zone, routing) with before and after, and its services (`{service, state}`); reading a service's status is not audited (FR-126) |
| `network` | `trust.hub_client.issue`, `trust.device.renew`, `trust.device.revoke` | the device id (`trust.hub_client.issue`: none) | the Hub's client certificate for the management channel (`{serial, notAfter, uri}`); a device certificate renewal (`{serial, role, notAfter}`); the older certificates revoked once the renewal is presented (actor `system`, `{certificates, reason: renewed, serials}`) |
| `settings` | `setting.changed` | the key | M7.5 adds `before`, `after` and `confirmed` (true when the change came with the owner's explicit confirmation) for every security setting written through the Hub's settings writer: `PATCH /api/v1/settings`, `PUT /api/v1/devices/firmware/policy` and `POST /api/v1/oob/enable\|disable` (enable's consent is `confirmed: true`). It is the change's only audit entry |
| `browser` | `browser.fallback.offered`, `browser.fallback.consent.granted`, `browser.fallback.consent.used`, `browser.fallback.consent.revoked`, `browser.fallback.started`, `browser.fallback.ended`, `browser.fallback.refused`, `browser.fallback.failed` | the site | the local browser fallback (FR-209): the offer, the per-site consent (before and after), a session on a device's browser and how it ended (with the egress filter's counts); a refusal has `decision: deny` and the reason |
| `browser` | `browser.fallback.orphan_closed` | the device id | a device browser session the Hub did not know, closed at start or by the 15-minute sweep (actor `system`) |
| `browser` | `browser.bridge.connected`, `browser.bridge.disconnected`, `browser.bridge.replaced`, `browser.bridge.events.refused` | the device id | the extension bridge (FR-096) as `novad` reports it: a connection, its end, a second connection replacing the first (before and after OS users), and relayed events that failed their check (a count) |
| `browser` | `browser.bridge.tab.shared`, `browser.bridge.tab.unshared`, `browser.bridge.tab.closed`, `browser.bridge.tab.opened`, `browser.bridge.tab.attach`, `browser.bridge.tab.detach` | the tab's host (`tab.opened`: the site; `unshared`, `closed`, `attach`, `detach`: none) | per-tab consent and the agent's own tabs: `{deviceId, tabId}` |
| `browser` | `browser.bridge.host.reported`, `browser.bridge.host.withdrawn`, `browser.bridge.grant.created`, `browser.bridge.grant.all_sites`, `browser.bridge.grant.revoked` | the host (`*` for all sites) | per-host grants: the browser's permission reported or withdrawn, the owner's grant or confirmation, the separate "all sites" grant, a revocation; before and after states |
| `browser` | `browser.bridge.refused`, `browser.bridge.history.search` | none; `device:<id>` for a history search | a bridge call refused (`decision: deny`, `{deviceId, method, reason}`); every history search, answered or not (`{deviceId, queryLength}`, never the query) |
| `channel` | `channel.approval.refused` | `approval:<id>` | M7.5 adds the reason `hub_only`: a button press or reply on a Hub-only card, or an answer through a signed link made before (`via: link`) |

No entry holds a BIOS password, a BMC credential or a boot token.

### work runs, goals, schedules, triggers

```sql
CREATE TABLE run (                 -- a `work` thread plus this row; its turns run in the one chat
  id TEXT PRIMARY KEY,             -- loop (ADR-076)
  account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id),
  thread_id TEXT NOT NULL REFERENCES thread(id), -- one run per thread
  agent_id TEXT,                   -- the agent that delegated it (M6, FR-083; a child run inherits
                                   -- it); plain TEXT: delegated runs outlive the agent as history
  parent_run_id TEXT REFERENCES run(id), -- delegation (FR-059); child consumption counts upward
  origin TEXT NOT NULL DEFAULT 'user',   -- user|schedule|trigger|chat_escalation|delegation|goal
  origin_ref TEXT,                 -- the chat it escalated from (FR-186), the schedule or trigger
  template TEXT,                   -- NULL|deep_research (FR-220)
  title TEXT NOT NULL, objective TEXT NOT NULL,
  authority TEXT NOT NULL DEFAULT 'none', -- user|none: whose words the objective carries (FR-189);
                                   -- `user` when the user typed it or started a proposed run
  authority_source TEXT,           -- e.g. run:<id>, for the audit trail
  model TEXT,
  status TEXT NOT NULL,            -- planning|running|waiting_approval|paused|done|output_missing|
                                   -- failed|cancelled
  pause_reason TEXT,               -- set while paused: user|budget_time|budget_tokens|budget_cost|
                                   -- backstop|usage_limit|approval_timeout|review_breaker|safety|
                                   -- error (model or tool failure, docs/09 §12)
  status_detail TEXT,              -- why it paused or failed, in a sentence
  autonomy TEXT NOT NULL DEFAULT 'standard', -- ask_first|standard|autonomous
  plan_approved INTEGER NOT NULL DEFAULT 0, -- the user started the plan or wrote it
  -- budgets (FR-182, ADR-058); cost_budget_usd NULL = the provider spend cap (FR-116)
  time_budget_s INTEGER NOT NULL DEFAULT 3600,
  token_budget INTEGER NOT NULL DEFAULT 2000000,
  cost_budget_usd REAL,
  time_used_ms INTEGER NOT NULL DEFAULT 0, -- active time while a turn runs, in ms; waits excluded
  tokens_used INTEGER NOT NULL DEFAULT 0,  -- includes child runs and sub-agents
  cost_used_usd REAL NOT NULL DEFAULT 0,
  progress_note TEXT,              -- the progress summary of the last pause or turn
  pending_json TEXT,               -- user redirects waiting for the running turn to end
  error_count INTEGER NOT NULL DEFAULT 0, -- consecutive failed turns; the third fails the run
  expected_output_json TEXT,       -- declared output to verify (FR-187)
  output_verified_at TEXT,
  result_summary TEXT, result_json TEXT, -- result_json: {summary, artifactIds, evidence}
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  CHECK (status <> 'paused' OR pause_reason IS NOT NULL),
  CHECK (status <> 'done' OR expected_output_json IS NULL OR output_verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_run_thread ON run(thread_id);
CREATE INDEX idx_run_status ON run(account_id, status, updated_at DESC);
CREATE INDEX idx_run_parent ON run(parent_run_id) WHERE parent_run_id IS NOT NULL;
-- The plan lives in run_step (no plan_json). Autonomy maps to an approval policy: ask_first →
-- ask_always, standard → defaults, autonomous → review.

CREATE TABLE goal (                 -- FR-181, docs/09 §2.1; schema goal.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  run_id TEXT REFERENCES run(id),
  agent_id TEXT,                   -- an agent's goal (M6); plain TEXT, no FK
  thread_id TEXT REFERENCES thread(id),  -- where continuation turns (trigger 'goal') run
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 4000),
  created_by TEXT NOT NULL DEFAULT 'user', -- user|agent (goal.set)
  status TEXT NOT NULL DEFAULT 'active', -- active|paused|blocked|usage_limited|budget_limited|complete
  status_set_by TEXT NOT NULL DEFAULT 'user', -- user|agent|system
  status_reason TEXT, progress_note TEXT, completion_summary TEXT,
  token_budget INTEGER, time_budget_s INTEGER, cost_budget_usd REAL, -- NULL = run/agent budgets
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_ms INTEGER NOT NULL DEFAULT 0, -- in ms, like run.time_used_ms
  cost_used_usd REAL NOT NULL DEFAULT 0,
  blocker_key TEXT,                -- normalized key of the last reported blocker
  blocker_description TEXT,        -- the agent's description of it (goal.json blocker.description)
  blocker_count INTEGER NOT NULL DEFAULT 0, -- consecutive goal turns with that key; reset on resume
  blocker_turn_id TEXT,            -- the last of those turns
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  CHECK ((run_id IS NULL) <> (agent_id IS NULL)),
  CHECK (status NOT IN ('usage_limited','budget_limited') OR status_set_by = 'system'),
  CHECK (status <> 'blocked' OR status_set_by <> 'agent' OR blocker_count >= 3)
);
CREATE UNIQUE INDEX uq_goal_open_run ON goal(run_id)
  WHERE run_id IS NOT NULL AND status <> 'complete';
CREATE UNIQUE INDEX uq_goal_open_agent ON goal(agent_id)
  WHERE agent_id IS NOT NULL AND status <> 'complete';
CREATE INDEX idx_goal_account ON goal(account_id, status, updated_at DESC);
-- Clearing a goal deletes its row.

CREATE TABLE run_step (             -- the plan: steps the model proposes (plan.set) or the user edits
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id),
  idx INTEGER NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending|running|done|failed|skipped
  detail_json TEXT, started_at TEXT, ended_at TEXT,
  UNIQUE (run_id, idx)
);

CREATE TABLE subagent (             -- FR-053, FR-054: a child `work` thread under the run's thread
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run(id),
  thread_id TEXT REFERENCES thread(id), -- NULL while queued behind the concurrency limit
  role TEXT NOT NULL, objective TEXT NOT NULL,
  tools_json TEXT,                 -- the allow-list the parent gave it, never wider than its own
  status TEXT NOT NULL,            -- queued|running|done|failed|cancelled
  inbox_json TEXT,                 -- task.message input waiting for the child's turn to end
  result_json TEXT,                -- {summary}
  created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_subagent_run ON subagent(run_id, created_at);
CREATE UNIQUE INDEX uq_subagent_thread ON subagent(thread_id) WHERE thread_id IS NOT NULL;
-- M5 enforces the allow-list only through the read-only profile (a child limited to reading
-- tools runs with `read-only`).

CREATE TABLE schedule (             -- FR-055, FR-206, ADR-079; schema schedule.json
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id), -- the project its runs belong to
  run_id TEXT,                     -- the Work run it was made from ("schedule it"), if any
  agent_id TEXT,                   -- set for an agent's schedules and wakes (M6): a fire starts a
                                   -- turn on the agent's main thread instead of a run; plain TEXT
  title TEXT NOT NULL,             -- defaults to the start of the instructions
  cron TEXT, rrule TEXT,
  interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
  once_at TEXT,                    -- one-shot fire (self-set wakes, FR-206)
  timezone TEXT NOT NULL,          -- IANA; required by schedule.json
  starts_at TEXT, ends_at TEXT,    -- starts_at is the RRULE DTSTART and the interval's anchor
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 8000),
  notify_condition TEXT CHECK (notify_condition IS NULL OR length(notify_condition) <= 1000),
  delivery_targets_json TEXT NOT NULL, -- JSON array of {kind: inapp|os|slack|teams|email|webhook, ref};
                                   -- a webhook's signing secret is secret://schedule/<id>/webhook
  expected_output_json TEXT,       -- declared output (FR-187)
  catch_up_policy TEXT NOT NULL DEFAULT 'once',      -- once|skip
  catch_up_lookback_s INTEGER NOT NULL DEFAULT 604800, -- 7 days
  autonomy TEXT NOT NULL DEFAULT 'standard', -- ask_first|standard|autonomous, for its runs
  origin TEXT NOT NULL DEFAULT 'user', -- user|agent (schedule.create, FR-059)|agent_self (wake)
  wake_reason TEXT,                -- agent_self only
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT, next_run_at TEXT, -- next_run_at: the next fire not yet handled
  last_outcome TEXT,               -- done|output_missing|failed|cancelled|no_news
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((cron IS NOT NULL) + (rrule IS NOT NULL) + (interval_seconds IS NOT NULL)
         + (once_at IS NOT NULL) = 1),
  CHECK (origin <> 'agent_self'
         OR (agent_id IS NOT NULL AND once_at IS NOT NULL AND wake_reason IS NOT NULL))
);
CREATE INDEX idx_schedule_next ON schedule(next_run_at) WHERE enabled = 1;
CREATE INDEX idx_schedule_account ON schedule(account_id, created_at);

CREATE TABLE schedule_fire (        -- a schedule's history (ADR-079): fires, catch-ups, skips
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- fire|catch_up|skipped
  due_at TEXT,                     -- the rule time it stands for (catch-up or skip: the last missed
                                   -- time); NULL for Run now
  window_first TEXT, window_last TEXT, window_count INTEGER, -- the missed window (catch_up, skipped)
  run_id TEXT, thread_id TEXT,     -- plain TEXT: the history outlives a deleted run
  notify INTEGER,                  -- the run's schedule.report: 1 deliver, 0 no news, NULL deliver
  report_message TEXT,
  receipts_json TEXT,              -- delivery results: [{kind, ref?, receipt, error?}]
  outcome TEXT,                    -- done|output_missing|failed|cancelled|no_news; NULL while open
  detail TEXT,                     -- why: no news, the delivery that failed, the error
  fired_at TEXT NOT NULL, ended_at TEXT,
  CHECK (kind = 'fire' OR (window_first IS NOT NULL AND window_last IS NOT NULL
         AND window_count IS NOT NULL))
);
-- Claiming a fire inserts its row in the transaction that moves next_run_at; the unique index
-- stops one rule time from firing twice, across restarts too.
CREATE UNIQUE INDEX uq_schedule_fire_due ON schedule_fire(schedule_id, kind, due_at)
  WHERE due_at IS NOT NULL;
CREATE INDEX idx_schedule_fire_schedule ON schedule_fire(schedule_id, fired_at DESC);
CREATE INDEX idx_schedule_fire_open ON schedule_fire(account_id, thread_id)
  WHERE outcome IS NULL AND kind <> 'skipped';

CREATE TABLE trigger (               -- event triggers (FR-056, docs/09 §7; M6)
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  schedule_id TEXT REFERENCES schedule(id) ON DELETE CASCADE,
  run_id TEXT, agent_id TEXT,      -- plain TEXT: deleting an agent is never blocked by its triggers
                                   -- (the agents area removes them first)
  project_id TEXT REFERENCES project(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,              -- webhook|connector_event|mcp_event|fs_change|email (event
                                   -- sources; chat-workspace events are connector_event) | schedule
                                   -- (a schedule's fire); the API creates the event kinds only
  title TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'run', -- run: a Work run (origin trigger) | wake: a turn on the
                                   -- agent's thread (trigger event)
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 8000), -- the user's text;
                                   -- the event payload is attached as untrusted data
  source_ref TEXT,                 -- channel binding (connector_event), device (fs_change) or
                                   -- mcp_event_subscription id (mcp_event)
  config_json TEXT,
  dedupe_key TEXT,                 -- the payload field whose value dedupes events (default `id`)
  secret_ref TEXT,                 -- secret://trigger/<id>: webhook token and signing secret
  autonomy TEXT NOT NULL DEFAULT 'standard', -- ask_first|standard (never autonomous)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_trigger_source ON trigger(kind, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE trigger_event (         -- each event a trigger saw, by dedupe key (M6)
  trigger_id TEXT NOT NULL REFERENCES trigger(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,        -- a repeated key starts nothing
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- started|failed|skipped
  run_id TEXT, thread_id TEXT, turn_id TEXT, -- plain TEXT: history outlives runs and threads
  detail TEXT, received_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, dedupe_key)
);

CREATE TABLE mcp_event_subscription ( -- FR-201 (M6)
  id TEXT PRIMARY KEY,             -- also the webhook path segment (/api/v1/mcp/events/<id>)
  account_id TEXT NOT NULL REFERENCES account(id),
  mcp_server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL REFERENCES trigger(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  remote_ref TEXT,                 -- the server's subscription id
  webhook_secret_ref TEXT NOT NULL, -- secret://mcp/<server id>/events/<id>: the signing secret
  filter_json TEXT,
  expires_at TEXT,
  refresh_before TEXT,             -- refresh is attempted from this time on
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|refreshing|lapsed|failed|removed
  last_delivery_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE mcp_event_delivery (   -- accepted deliveries only: signed and ≤ 256 KiB; kept 7 days
  subscription_id TEXT NOT NULL REFERENCES mcp_event_subscription(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes <= 262144),
  run_id TEXT,                     -- plain TEXT: the run it started, if any
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
  label TEXT NOT NULL, config_json TEXT, -- the connection (host, user, image, distro); never a
                                   -- secret: SSH keys and passwords are in the keychain at
                                   -- secret://code/environment/<id>/credential (M6)
  repo_urls TEXT, setup_script TEXT,
  status TEXT NOT NULL DEFAULT 'unknown', -- ok|degraded|down|unknown
  status_detail TEXT,              -- why it is degraded or down (no Git, no sandbox)
  last_check_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_environment_local ON environment(account_id) WHERE kind = 'local';
-- M5 has one built-in `local` environment per account (the Hub host); it is `ok` or `degraded`,
-- never `down`. M6 saves container, ssh, wsl and device environments (FR-062, FR-078). M7 adds
-- `cloud` (the cloud runner, below); `vm` is not offered. An SSH environment's host key, pinned on
-- first use, is `config_json.hostKey` (M7).

CREATE TABLE code_session (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  thread_id TEXT NOT NULL UNIQUE REFERENCES thread(id), -- 1:1 with a code thread (title, model)
  environment_id TEXT REFERENCES environment(id),
  folder_path TEXT NOT NULL,       -- canonical folder the user chose (the main checkout when the
                                   -- session works in a worktree)
  project_folder_id TEXT REFERENCES project_folder(id),
  worktree_id TEXT REFERENCES worktree(id),
  branch TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'manual', -- manual|accept_edits|plan|auto|bypass (presets, FR-063)
  permission_profile_id TEXT,      -- reserved for a custom profile; the mode sets the profile (FR-190)
  status TEXT NOT NULL DEFAULT 'active', -- active|archived (its thread was archived or deleted)
  pull_request_url TEXT, ci_status TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_session_account ON code_session(account_id, updated_at DESC);
-- The mode last used in a folder is the `code.folderModes` setting (Plan is never saved).

CREATE TABLE worktree (             -- worktree registry (FR-073); at most 15 active per repo
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT REFERENCES device(id), -- where the repo lives; NULL = the Hub
  name TEXT NOT NULL,               -- 8 hex characters, shown in the worktree list
  repo_path TEXT NOT NULL,         -- main checkout
  path TEXT NOT NULL,              -- <repo>/.nova/worktrees/<name>
  branch TEXT NOT NULL,            -- nova/<slug>
  source_branch TEXT NOT NULL,
  lease_session_id TEXT REFERENCES code_session(id),
  lease_expires_at TEXT,           -- NULL = until the session is archived or handed off; M6 leases
                                   -- from the registry routes expire, and an expired lease is
                                   -- released (`worktree.released` reason `expired`)
  status TEXT NOT NULL DEFAULT 'active', -- active|released|removed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (device_id, path)
);
CREATE INDEX idx_worktree_repo ON worktree(device_id, repo_path, status);
CREATE UNIQUE INDEX idx_worktree_hub_path ON worktree(path) WHERE device_id IS NULL;
-- An archived session releases its lease: a clean worktree is removed, a dirty one is kept.

CREATE TABLE session_handoff (      -- 0036 (M7): a move of a Code session, or of a chat, to another
  id TEXT PRIMARY KEY,             -- device, environment or worktree (FR-213); the session history
  account_id TEXT NOT NULL REFERENCES account(id),
  thread_id TEXT NOT NULL REFERENCES thread(id),
  code_session_id TEXT REFERENCES code_session(id), -- NULL for a chat handoff
  from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, -- 'environment:<id>' | 'worktree:<id>' |
                                   -- 'device:<id>' | 'hub'
  from_label TEXT NOT NULL, to_label TEXT NOT NULL,
  target_folder TEXT,              -- where the session lands
  source_action TEXT NOT NULL DEFAULT 'keep', -- keep|clean: what happens to the source
  git_state_json TEXT,             -- branch, HEAD, the working-state tree and the hashes of the patch
                                   -- and bundle; the files are under code/handoffs/<id>/ (§3)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|refused|failed
  reason TEXT,                     -- why it was refused or failed, e.g. target_dirty,
                                   -- branch_diverged, protected_folder
  error TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_session_handoff_thread ON session_handoff(thread_id, created_at DESC);
CREATE INDEX idx_session_handoff_session ON session_handoff(code_session_id, created_at DESC);

CREATE TABLE code_change (          -- one changed file (FR-064, FR-065), relative to the session folder
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES code_session(id),
  path TEXT NOT NULL, change_kind TEXT NOT NULL,  -- add|modify|delete|rename (M5 never detects
                                   -- renames: a delete plus an add)
  old_path TEXT,
  additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0, -- 1 while it has undecided hunks
  patch_blob_path TEXT,            -- the pending part (work tree against the accepted baseline),
  patch_sha256 TEXT,               -- a unified patch at code/<sessionId>/patches/<id>.patch (§3)
  decided_json TEXT NOT NULL DEFAULT '{"hunks":[],"file":null}', -- decided hunks of this round
  state TEXT NOT NULL DEFAULT 'pending', -- pending|accepted|rejected|partial
  call_id TEXT,                    -- the tool call that made it, when the agent did
  applied INTEGER NOT NULL DEFAULT 0, -- 1 once committed (committed rows are hidden)
  reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_code_change_path ON code_change(session_id, path);

CREATE TABLE code_review (          -- a /review of the session's uncommitted changes (FR-069)
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES code_session(id),
  status TEXT NOT NULL DEFAULT 'running', -- running|done|failed
  model_id TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]', -- [{id, path, line, severity, title, reasoning, fix}]
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_code_review_session ON code_review(session_id, created_at DESC);

CREATE TABLE diff_comment (         -- a comment on a diff line (FR-065), by the user or a review
  id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES code_change(id),
  session_id TEXT NOT NULL REFERENCES code_session(id),
  path TEXT, line INTEGER,
  side TEXT,                       -- old|new
  body TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user', -- user|review (a finding of review_id)
  review_id TEXT REFERENCES code_review(id),
  submitted_at TEXT,               -- when a user comment was sent to the agent as one turn
  resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX idx_diff_comment_session ON diff_comment(session_id, created_at);

CREATE TABLE git_host (             -- a Git host connected for pushes and pull requests (FR-070, M6)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- github
  label TEXT NOT NULL, api_url TEXT NOT NULL, web_url TEXT NOT NULL,
  login TEXT,                      -- the login the token signs in as
  token_ref TEXT NOT NULL,         -- secret://code/githost/<id>/token; never the token
  status TEXT NOT NULL DEFAULT 'unknown', -- ok|error|unknown
  status_detail TEXT, last_check_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_git_host_web ON git_host(account_id, web_url);

CREATE TABLE code_pull_request (    -- a pull request a session opened, with its CI state (FR-070, M6)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  session_id TEXT NOT NULL REFERENCES code_session(id),
  host_id TEXT NOT NULL REFERENCES git_host(id),
  repo TEXT NOT NULL,              -- owner/name on the host
  number INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
  head_branch TEXT NOT NULL, base_branch TEXT NOT NULL, head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'open', -- open|closed|merged
  ci_status TEXT NOT NULL DEFAULT 'none', -- none|queued|running|passed|failed
  checks_json TEXT NOT NULL DEFAULT '[]', -- as the host reported them; summaries are untrusted
  feedback_sha TEXT,               -- the head whose CI failure was already sent to the agent
  last_polled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE code_verify_run (      -- one auto-verify run (FR-068, M6)
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES code_session(id),
  trigger TEXT NOT NULL,           -- auto (a turn edited files) | manual
  turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running|passed|failed|error|skipped
  checks_json TEXT NOT NULL DEFAULT '[]', -- each command: status, exit code, redacted capped log
  created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE code_session_state (   -- per-session M6 state (docs/09 §2, docs/10 §2, §9)
  session_id TEXT PRIMARY KEY REFERENCES code_session(id),
  time_limit_s INTEGER, token_limit INTEGER, cost_limit_usd REAL, -- NULL = no bound
  time_used_ms INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0,
  budget_reached TEXT,             -- time|tokens|cost: the bound that stopped the last turn
  setup_status TEXT, setup_detail TEXT, -- running|ok|failed: a container environment's setup
                                   -- script, run once per session
  parent_session_id TEXT REFERENCES code_session(id), -- a task.spawn worker's parent (FR-073)
  role TEXT,
  updated_at TEXT NOT NULL
);
```

Each Code session also keeps a shadow repository at `<dataDir>/code/<sessionId>/shadow.git`
(§3) with two refs: `refs/nova/baseline` (the accepted state) and `refs/nova/start` (the last
committed state). The pending diff is the work tree against the baseline. The symbol index
(FR-074) lives in Hub memory per session; there is no symbols table in M5.

M6 mirrors the latest pull request's URL and CI status onto `code_session.pull_request_url` and
`ci_status` for the session view; the pull requests themselves live in `code_pull_request`. Dev
servers (FR-097) and the processes of an environment are not stored:
they are exec sessions in Hub memory, and `novad` buffers a remote environment's process output.

Migration 0036 (M7; FR-212, FR-213, FR-073; ADR-095) creates `session_handoff` as shown above
and adds best-of-N attempts, three-way merges and Code sessions an agent starts. Agent ids are
plain TEXT: removing an agent never waits on its delegations.

```sql
CREATE TABLE code_attempt_set (     -- a best-of-N task (FR-212): N attempts of one objective
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  session_id TEXT NOT NULL REFERENCES code_session(id),
  objective TEXT NOT NULL,
  base_sha TEXT NOT NULL,          -- the session's HEAD; every attempt starts there
  status TEXT NOT NULL DEFAULT 'running', -- running|ready|applied|discarded
  applied_attempt_id TEXT, merge_id TEXT, -- set when the user applied one (plain TEXT)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_code_attempt_set_session ON code_attempt_set(session_id, created_at DESC);

CREATE TABLE code_attempt (         -- one attempt (2 to 4 per set): its own Code session in its own
  id TEXT PRIMARY KEY,             -- worktree, with its budgets in code_session_state
  set_id TEXT NOT NULL REFERENCES code_attempt_set(id),
  idx INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES code_session(id),
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running|done|failed|applied|discarded
  reply TEXT,                      -- its last reply: the model's words, untrusted
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (set_id, idx)
);
CREATE INDEX idx_code_attempt_session ON code_attempt(session_id);

CREATE TABLE code_merge (           -- a three-way merge onto a session's folder (docs/10 §9, §14)
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES code_session(id),
  source_kind TEXT NOT NULL,       -- session (another session's work)|attempt|patch
  source_ref TEXT, base_sha TEXT,
  status TEXT NOT NULL,            -- applied|conflicted|resolved|refused|aborted
  files_json TEXT NOT NULL DEFAULT '[]',     -- MergeFileView[]
  conflicts_json TEXT NOT NULL DEFAULT '[]', -- MergeConflictView[], bounded and redacted
  backup_path TEXT,                -- code/<session-id>/merges/<id>.json: the files as they were,
                                   -- for an abort; NULL when nothing was written
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX idx_code_merge_session ON code_merge(session_id, created_at DESC);

CREATE TABLE code_delegation (      -- a Code session an agent started with code.delegate (docs/09 §4)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  agent_id TEXT NOT NULL, agent_thread_id TEXT NOT NULL, -- plain TEXT
  session_id TEXT NOT NULL REFERENCES code_session(id),
  thread_id TEXT NOT NULL,         -- the session's thread: the agent's rules apply there, and the
                                   -- result returns to the agent
  status TEXT NOT NULL DEFAULT 'running', -- running|done|failed
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE UNIQUE INDEX idx_code_delegation_thread ON code_delegation(thread_id);
CREATE INDEX idx_code_delegation_agent ON code_delegation(agent_id, created_at DESC);
```

By default a merge with conflicts is refused (`refused`, with each conflict's three sides). When
the user asks for markers it is written as `conflicted`, and the markers block commits until the
merge is resolved or aborted; binary conflicts are never merged. Handoff bundles are deleted when
the handoff completes, and the handoff folders expire after 7 days.

### cloud runner

Migration 0034 (M7; FR-108, FR-071, FR-116; ADR-095). A cloud environment is an `environment` row
of kind `cloud`. Its `config_json` holds the runner's environment id and the spec: repository URLs
without user information, setup script, base image, caches, network, disk cap. The Hub keeps the
agent loop, the model calls and the policy gate; the runner keeps the environments, runs their
commands and holds the snapshot files. The runner token is a vault entry
(`secret://cloud/runner/token`), never a row. Thread and Work run ids are plain TEXT: threads can
be purged, and runs belong to the runs area.

```sql
CREATE TABLE cloud_run (            -- a Code session's or Work run's lease on a cloud environment
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  environment_id TEXT NOT NULL REFERENCES environment(id),
  thread_id TEXT,
  kind TEXT NOT NULL,              -- code|work|system (a lease with no thread)
  work_run_id TEXT,
  runner_run_id TEXT NOT NULL,     -- the run on the runner
  status TEXT NOT NULL DEFAULT 'active', -- active|completed|cancelled|capped|failed|lost (the runner
                                   -- no longer knows it)
  reason TEXT,
  cpu_cap_s INTEGER NOT NULL, wall_cap_s INTEGER NOT NULL, -- from cloud.runner.caps: 3,600 s CPU and
                                   -- 14,400 s wall by default; raisable (FR-116)
  cpu_used_s REAL NOT NULL DEFAULT 0, wall_used_s REAL NOT NULL DEFAULT 0, -- metered by the runner;
                                   -- wall time counts only while a command runs
  commands INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]', -- resources past the warning point (0.8 of a cap)
  last_event_id INTEGER NOT NULL DEFAULT 0, -- where the Hub's event stream from the runner resumes
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_cloud_run_thread ON cloud_run(account_id, thread_id, status);
CREATE INDEX idx_cloud_run_environment ON cloud_run(environment_id, status);
CREATE UNIQUE INDEX idx_cloud_run_runner ON cloud_run(runner_run_id);

CREATE TABLE cloud_work_binding (   -- a Work run whose commands and files go to a cloud environment
  thread_id TEXT PRIMARY KEY,      -- the run's thread
  account_id TEXT NOT NULL REFERENCES account(id),
  environment_id TEXT NOT NULL REFERENCES environment(id),
  work_run_id TEXT NOT NULL,
  folder TEXT NOT NULL,            -- the run's working folder on the runner
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cloud_work_binding_environment ON cloud_work_binding(environment_id);

CREATE TABLE cloud_snapshot (       -- the Hub's index of a cloud environment's snapshots; the tar
  id TEXT PRIMARY KEY,             -- itself stays on the runner
  account_id TEXT NOT NULL REFERENCES account(id),
  environment_id TEXT NOT NULL REFERENCES environment(id),
  runner_snapshot_id TEXT NOT NULL,
  label TEXT,
  reason TEXT NOT NULL,            -- manual|run_start|before_restore
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, restored_at TEXT
);
CREATE INDEX idx_cloud_snapshot_environment ON cloud_snapshot(environment_id, created_at DESC);
```

Nova does not encrypt the snapshot tar files; encryption at rest on the runner is its operator's.
Agents' own `cloud` computers still use the M6 mock runner on the Hub, not these tables.

### scripts and external agents (flagged)

Migration 0038 (M7; FR-202, FR-203). Both features are off by default (`scripts.enabled`,
`externalAgents.enabled`); while a flag is off its routes answer 404.

```sql
CREATE TABLE script_run (           -- one script.run call (FR-202); its id is the tool call's
  id TEXT PRIMARY KEY,             -- (tool_call.id), and its nested calls are the tool calls whose
                                   -- parent_call_id names it
  account_id TEXT NOT NULL REFERENCES account(id),
  thread_id TEXT REFERENCES thread(id), turn_id TEXT,
  code_sha256 TEXT NOT NULL,       -- the code's hash only, never the code or its output (the
                                   -- tool_call row holds the redacted arguments and result)
  status TEXT NOT NULL,            -- running|ok|error|cancelled
  error_code TEXT,
  calls INTEGER NOT NULL DEFAULT 0, -- nested calls; scripts.limits.maxCalls is 20 by default
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_script_run_thread ON script_run(thread_id, created_at);

CREATE TABLE agent_adapter (        -- an external coding agent the owner registered (FR-203): a
  id TEXT PRIMARY KEY,             -- command that speaks an open agent protocol on stdio
  account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL, command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '{}', -- secret:// references only, under the adapter's own
                                   -- secret://agent-adapter/<id>/; any other is refused
  network_json TEXT NOT NULL DEFAULT '[]', -- hosts its process may reach through the egress proxy;
                                   -- none by default
  permission_routing TEXT NOT NULL CHECK (permission_routing IN ('client')), -- the only mode: every
                                   -- file read, write and command goes through Nova's gate
  enabled INTEGER NOT NULL DEFAULT 1,
  last_check_json TEXT,            -- the last handshake: agent name and version, protocol version,
                                   -- or why it was refused
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX idx_agent_adapter_name ON agent_adapter(account_id, name)
  WHERE deleted_at IS NULL;

CREATE TABLE agent_delegation (     -- one task a Code session delegated to an adapter
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  thread_id TEXT NOT NULL REFERENCES thread(id), -- the session's thread
  adapter_id TEXT NOT NULL REFERENCES agent_adapter(id),
  status TEXT NOT NULL,            -- starting|running|completed|failed|cancelled
  prompt TEXT NOT NULL,            -- the user's
  output TEXT,                     -- the agent's reply text, redacted and capped
  stop_reason TEXT, error TEXT,
  agent_json TEXT,                 -- the agent's name and version as it reported them, redacted
  permission_requests INTEGER NOT NULL DEFAULT 0, operations INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX idx_agent_delegation_thread ON agent_delegation(thread_id, created_at);
```

A delegation's file changes are the session's own diffs; the agent's progress is an event stream,
not stored.

### agents & computers

Migrations 0020 (agents) and 0022 (computers, egress). Ids of other areas' rows are plain TEXT
where an area must be deletable without the other (noted per column).

```sql
CREATE TABLE agent (                -- an always-on agent (FR-079, FR-090, docs/09 §8)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  avatar_path TEXT,                -- a sealed, metadata-stripped blob, like account.avatar_path
  instructions TEXT NOT NULL DEFAULT '' CHECK (length(instructions) <= 16000), -- the user's own
                                   -- text (the spec's `persona`)
  status TEXT NOT NULL DEFAULT 'active', -- active|paused|stopped
  pause_reason TEXT,               -- user|safety (auto-pause); required while paused
  status_detail TEXT,
  autonomy TEXT NOT NULL DEFAULT 'standard', -- ask_first|standard|autonomous
  model TEXT,
  computer_id TEXT,                -- its own computer (FR-080); plain TEXT (0022 comes later),
                                   -- written by the computers area, cleared when it is purged
  primary_thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL, -- its main `agent` thread
  proactive INTEGER NOT NULL DEFAULT 1, memory_enabled INTEGER NOT NULL DEFAULT 1,
  time_budget_s INTEGER NOT NULL CHECK (time_budget_s >= 60), -- per turn chain (a turn plus
  token_budget INTEGER NOT NULL CHECK (token_budget >= 1000), -- its hook continuations)
  cost_budget_usd REAL,            -- NULL = the provider spend cap
  time_used_ms INTEGER NOT NULL DEFAULT 0, tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used_usd REAL NOT NULL DEFAULT 0, -- lifetime totals
  last_proactive_at TEXT, last_active_at TEXT,
  metadata TEXT,                   -- JSON: the schedules and runs a pause stopped, restored on resume
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (status <> 'paused' OR pause_reason IS NOT NULL)
);

CREATE TABLE agent_thread (         -- every thread of an agent
  thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- main|proactive (research)|binding (one per channel binding,
                                   -- ADR-070)|background (a delegated Work run, FR-083)
  binding_ref TEXT,                -- the channel binding of a `binding` thread (plain TEXT)
  audience TEXT NOT NULL DEFAULT 'private', -- private|shared: where its content may go (docs/13 §4)
  run_id TEXT,                     -- a `background` thread's run; plain TEXT: runs outlive the agent
  created_at TEXT NOT NULL,
  CHECK (kind <> 'binding' OR binding_ref IS NOT NULL),
  CHECK (kind <> 'background' OR run_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_agent_thread_binding ON agent_thread(agent_id, binding_ref)
  WHERE binding_ref IS NOT NULL;

CREATE TABLE agent_responsibility (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 4000),
  status TEXT NOT NULL DEFAULT 'active', -- active|paused|done
  goal_id TEXT REFERENCES goal(id) ON DELETE SET NULL, -- the one that holds the agent's open goal
  progress_note TEXT,              -- the agent's last note (agent-written: untrusted)
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE agent_rule (           -- FR-084, docs/12 §3
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  matcher_json TEXT NOT NULL,      -- tools, hosts, action classes and channels
  command_json TEXT,               -- optional command prefix rule (FR-191): act or ask only
  effect TEXT NOT NULL,            -- act|act_on_request|ask|handoff
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (command_json IS NULL OR effect IN ('act', 'ask'))
);
-- Rules reach the engine as user-layer rules scoped to each of the agent's threads; policy_rule
-- cannot store act_on_request, so they keep their own table.

CREATE TABLE agent_memory (         -- notes and learned items (FR-089, ADR-080)
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- note|fact|preference|observation
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  author TEXT NOT NULL,            -- user|agent (agent notes are untrusted)
  source TEXT NOT NULL,            -- manual|tool|proactive|conversation
  source_thread_id TEXT,
  responsibility_id TEXT REFERENCES agent_responsibility(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  origin_audience TEXT NOT NULL DEFAULT 'private', -- private|shared: audience of the source thread
                                   -- (docs/13 §4, ADR-070)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Conversation memory of an agent is `memory_item` rows with scope_kind 'agent'; turning the
-- agent's memory off purges what it derived.

CREATE TABLE agent_suggestion (     -- proactive research suggestions (FR-082); never the user's intent
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES agent_memory(id) ON DELETE SET NULL, -- the observation note behind it
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|accepted|dismissed (accepting only records it)
  thread_id TEXT, turn_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE agent_wake (           -- every accepted schedule.wake (FR-206)
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  schedule_id TEXT,                -- plain TEXT: kept when the user cancels the schedule, so the
                                   -- per-day limit counts every wake the agent set
  at TEXT NOT NULL, requested_at TEXT NOT NULL, reason TEXT NOT NULL,
  moved_by_quiet_hours INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE external_agent (       -- identities marked as external AI agents (FR-194, docs/12 §6.2)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  address TEXT NOT NULL CHECK (length(address) BETWEEN 1 AND 300), -- a channel identity, an email
                                   -- address or a name such as "the billing agent"
  label TEXT, created_at TEXT NOT NULL,
  UNIQUE (account_id, address)
);

CREATE TABLE computer (             -- an agent's own computer or a connected device (FR-080, FR-081)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- cloud|local_container|local_host
  agent_id TEXT REFERENCES agent(id) ON DELETE CASCADE, -- set for an agent's own computer
  provider TEXT,                   -- who serves it: container|bwrap|micro_vm|mock_cloud|novad
  base_image TEXT,
  state TEXT NOT NULL DEFAULT 'stopped', -- starting|running|stopped|degraded|error
  device_id TEXT REFERENCES device(id), -- local_host: the connected device
  snapshot_blob_path TEXT,         -- the latest snapshot's folder
  spec_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT
);
CREATE UNIQUE INDEX uq_computer_agent ON computer(agent_id)
  WHERE agent_id IS NOT NULL AND kind <> 'local_host';
-- A computer is a folder, not a long-lived container: <dataDir>/computers/<id>/{home,browser}.
-- Each command runs in a fresh sandbox over it; software persists only when installed under home.

CREATE TABLE computer_snapshot (    -- a folder copy at blobs/snapshots/<computer-id>/<snapshot-id>/
  id TEXT PRIMARY KEY, computer_id TEXT NOT NULL REFERENCES computer(id) ON DELETE CASCADE,
  label TEXT, blob_path TEXT NOT NULL, size_bytes INTEGER, created_at TEXT NOT NULL
);

CREATE TABLE egress_scope (         -- a scope's network policy (docs/11 §7, docs/12 §8; FR-193)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  scope_kind TEXT NOT NULL,        -- run|session|agent|plugin|mcp_server
  scope_id TEXT NOT NULL,          -- plain TEXT: scopes of any area
  mode TEXT,                       -- off|allowlist|limited; NULL inherits the global mode
  allow_json TEXT NOT NULL DEFAULT '[]', deny_json TEXT NOT NULL DEFAULT '[]',
  hooks_json TEXT NOT NULL DEFAULT '[]', -- stripping hooks
  allow_local_binding INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, scope_kind, scope_id)
);

CREATE TABLE egress_credential (    -- a credential the proxy injects for its hosts (ADR-063)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL, hosts_json TEXT NOT NULL,
  scheme TEXT NOT NULL,            -- bearer|basic|header
  header_name TEXT,                -- required for `header`
  username TEXT,                   -- basic
  scope_kind TEXT, scope_id TEXT,  -- both NULL = account-wide; else one run, session, agent,
                                   -- plugin or MCP server
  secret_ref TEXT NOT NULL,        -- the value lives in the vault, never here
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (scheme <> 'header' OR header_name IS NOT NULL),
  CHECK ((scope_kind IS NULL) = (scope_id IS NULL))
);
```

Every egress decision is an audit entry (kind `network`), not a table row; `GET
/egress/decisions` reads them back.

### people, shared threads and team agents

Migration 0037 (M7; FR-217, FR-091, FR-113, FR-045; ADR-095). Several people can use one Hub.
Each member has their own `account` row (kind `local`), with their own memory, connectors and
sessions; a team agent works under an identity account of its own that nobody signs in to.
Removing a member sets `account.deleted_at` (the account is closed) and keeps their data. The
OIDC client secret and team agents' credentials are vault entries; rows hold only `secret://`
references.

```sql
CREATE TABLE team_member (          -- the people of the Hub; the owner's row is recorded at setup
  account_id TEXT PRIMARY KEY REFERENCES account(id), -- (or when an older Hub first starts M7)
  role TEXT NOT NULL,              -- owner|member; the owner row decides who the owner is
  invitation_id TEXT,
  invited_by TEXT REFERENCES account(id),
  joined_at TEXT NOT NULL,
  removed_at TEXT, removed_by TEXT -- a removed member's sessions end and their account is closed
);
CREATE UNIQUE INDEX uq_team_member_owner ON team_member(role) WHERE role = 'owner';

CREATE TABLE team_invitation (      -- one-use invitation links; only the token's SHA-256 is stored
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  label TEXT CHECK (label IS NULL OR length(label) <= 100),
  created_by TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,        -- team.invitationHours: 72 by default, at most 720
  redeemed_at TEXT, redeemed_by TEXT REFERENCES account(id), revoked_at TEXT
);
CREATE INDEX idx_team_invitation_created ON team_invitation(created_at);

CREATE TABLE oidc_provider (        -- an OIDC provider the owner configured (FR-113, docs/13 §7)
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  issuer TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_secret_ref TEXT,          -- secret://team/oidc/<id>; NULL for a public client (PKCE alone)
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE oidc_identity (        -- an account linked to an OIDC identity (issuer + subject)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  provider_id TEXT NOT NULL REFERENCES oidc_provider(id) ON DELETE CASCADE,
  subject TEXT NOT NULL, email TEXT,
  linked_at TEXT NOT NULL, last_sign_in_at TEXT,
  UNIQUE (provider_id, subject),
  UNIQUE (account_id, provider_id) -- one identity per provider per account
);

CREATE TABLE profile_card (         -- the opt-in public profile card (FR-113): read-only, the display
  account_id TEXT PRIMARY KEY REFERENCES account(id), -- name and, optionally, the avatar
  handle TEXT NOT NULL UNIQUE CHECK (length(handle) BETWEEN 3 AND 40),
  enabled INTEGER NOT NULL DEFAULT 0, -- served only while team.publicProfiles is on as well
  show_avatar INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE thread_share (         -- a participant of a shared thread other than its owner (FR-217)
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  owner_account_id TEXT NOT NULL REFERENCES account(id),
  shared_by TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, account_id)
);
CREATE INDEX idx_thread_share_account ON thread_share(account_id, created_at);

CREATE TABLE shared_message (       -- who wrote each user message of a shared thread
  message_id TEXT PRIMARY KEY,     -- plain TEXT: a queued message keeps its queue id
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_shared_message_thread ON shared_message(thread_id, created_at);

CREATE TABLE team_agent (           -- a specialist/team agent (FR-091): an always-on agent that lives
  agent_id TEXT PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE, -- in its own identity account
  identity_account_id TEXT NOT NULL UNIQUE REFERENCES account(id), -- its memory, connectors,
                                   -- credentials, policy and audit
  created_by TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE team_agent_credential ( -- bookkeeping for the admin's list: a provider_account or
  id TEXT PRIMARY KEY,             -- egress_credential row of the identity account
  agent_id TEXT NOT NULL REFERENCES team_agent(agent_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- provider|egress
  ref_id TEXT NOT NULL,            -- that row's id; its value is a vault entry
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  created_by TEXT NOT NULL REFERENCES account(id),
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, kind, ref_id)
);

CREATE TABLE team_task (            -- a task a person gave a team agent; it runs under the agent's
  id TEXT PRIMARY KEY,             -- identity, in a thread of its own
  agent_id TEXT NOT NULL REFERENCES team_agent(agent_id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL REFERENCES account(id),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 8000),
  thread_id TEXT, turn_id TEXT,
  status TEXT NOT NULL,            -- queued|running|done|failed|cancelled
  result TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE INDEX idx_team_task_agent ON team_task(agent_id, created_at);
CREATE INDEX idx_team_task_requester ON team_task(requested_by, created_at);

CREATE TABLE agent_plugin_scope (   -- the plugins connected to an agent (FR-045): its threads may use
  agent_id TEXT PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE, -- only their tools; no row:
  plugin_ids_json TEXT NOT NULL,   -- every plugin the account enabled
  updated_at TEXT NOT NULL
);

CREATE TABLE member_setting (       -- a member's own preferences (appearance, keyboard, onboarding);
  account_id TEXT NOT NULL REFERENCES account(id), -- Hub settings stay the owner's
  key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
```

A shared thread stays in its owner's account and is memory opt-out: nobody's memory joins its
turns, and each turn runs under whoever wrote it.

### channels & notification routing

Migration 0021 (FR-088, FR-056, FR-201, FR-060). Bot tokens, signing secrets and webhook tokens
live in the vault; rows hold only `secret://` references. `agent_id` and history run and thread
ids are plain TEXT, so deleting an agent is not blocked by its bindings and history outlives a
run or a purged thread.

```sql
CREATE TABLE channel_binding (      -- one external conversation bound to an agent thread (ADR-070)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  agent_id TEXT,
  kind TEXT NOT NULL,              -- inapp|slack|teams|telegram|email|webhook|voice
  label TEXT NOT NULL,
  external_ref TEXT NOT NULL,      -- Slack channel or DM id, Teams conversation id, email
                                   -- address, webhook name; inbound events route by it
  audience TEXT NOT NULL DEFAULT 'shared', -- private (the owner only) | shared
  thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL, -- its own thread; NULL until the first
                                   -- message
  share_primary_thread INTEGER NOT NULL DEFAULT 0, -- private only: use the agent's primary thread
  allow_unknown INTEGER NOT NULL DEFAULT 0, -- unknown senders are ignored unless set
  config_json TEXT,                -- adapter settings without secrets (bot user and team, app id
                                   -- and service URL, callback URL)
  secret_ref TEXT,                 -- secret://channel/<owner binding id>: bindings of one Slack or
                                   -- Teams app share it
  rate_per_minute INTEGER NOT NULL DEFAULT 10 CHECK (rate_per_minute BETWEEN 1 AND 600),
  rate_per_hour INTEGER NOT NULL DEFAULT 120 CHECK (rate_per_hour BETWEEN 1 AND 10000),
  enabled INTEGER NOT NULL DEFAULT 1, -- 0: disconnected; inbound ignored, nothing sent
  status_detail TEXT, last_message_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (share_primary_thread = 0 OR audience = 'private')
);

CREATE TABLE channel_identity (     -- external users mapped to a role, per account and kind
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL, external_id TEXT NOT NULL, display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member', -- owner (may answer pre-approvable approvals) | member
  created_at TEXT NOT NULL,
  UNIQUE (account_id, kind, external_id)
);

CREATE TABLE channel_message (      -- dedupe, loop prevention and rate caps; the text is in the
  id TEXT PRIMARY KEY,             -- thread, only its hash here
  binding_id TEXT NOT NULL REFERENCES channel_binding(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL,         -- in|out
  external_id TEXT,                -- the adapter's message id, or the delivery receipt
  conversation TEXT, thread_ref TEXT, sender TEXT,
  thread_id TEXT, turn_id TEXT,
  status TEXT NOT NULL,            -- in: started|answered|ignored|dropped; out: sent|failed|withheld
  reason TEXT, text_hash TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_channel_message_external ON channel_message(binding_id, direction,
  external_id) WHERE external_id IS NOT NULL;

CREATE TABLE notification_rule (    -- per category, where a notification goes (FR-060); no row:
  account_id TEXT NOT NULL REFERENCES account(id), -- in-app and OS, no channel
  category TEXT NOT NULL,          -- approval|completion|error|attention|system
  inapp INTEGER NOT NULL DEFAULT 1, os INTEGER NOT NULL DEFAULT 1,
  channels_json TEXT NOT NULL DEFAULT '[]', -- channel binding ids
  bypass_quiet INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, category)
);

CREATE TABLE quiet_hours (          -- a daily window that defers non-urgent notifications (FR-060)
  account_id TEXT PRIMARY KEY REFERENCES account(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL, end_time TEXT NOT NULL, -- HH:MM local; an end before the start
                                   -- crosses midnight
  timezone TEXT NOT NULL,
  days_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]', -- weekdays a window starts on (0 = Sunday)
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_delivery ( -- channel copies of notifications; deferred ones wait here
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  notification_id TEXT,
  binding_id TEXT NOT NULL REFERENCES channel_binding(id) ON DELETE CASCADE,
  category TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  due_at TEXT NOT NULL,            -- the end of quiet hours for a deferred copy
  status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
  receipt TEXT, error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
```

Quiet hours are a table, not a setting, because areas cannot write settings.

Migration 0035 (M7; FR-110, FR-111, FR-060) adds what Telegram and email bindings, signed approval
links and push need. Bot tokens, mailbox passwords, the approval-link key
(`secret://channels/approval-link-key`), the VAPID key (`secret://push/vapid`) and Web Push auth
secrets are vault entries. Device, notification and approval ids are plain TEXT, so history rows
outlive what they name.

```sql
CREATE TABLE channel_cursor (       -- where a poller left off for one credential group, keyed by the
  binding_id TEXT PRIMARY KEY REFERENCES channel_binding(id) ON DELETE CASCADE, -- group's first
  cursor TEXT NOT NULL,            -- binding: a Telegram update offset, or an email folder's
  updated_at TEXT NOT NULL         -- UIDVALIDITY and last UID
);

CREATE TABLE channel_approval_link ( -- a signed one-use approval link sent by email (docs/13 §4);
  id TEXT PRIMARY KEY,             -- the link carries it with an HMAC under the link key
  account_id TEXT NOT NULL REFERENCES account(id),
  binding_id TEXT NOT NULL REFERENCES channel_binding(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,        -- the approval's expiry or channels.approvalLinkMinutes (60),
                                   -- whichever comes first
  used_at TEXT, decision TEXT,     -- set when the link answered, or was spent by a refused answer
  created_at TEXT NOT NULL
);
CREATE INDEX idx_channel_approval_link_approval ON channel_approval_link(approval_id);

CREATE TABLE push_subscription (    -- a browser's Web Push subscription (FR-111, RFC 8030/8291)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT,
  endpoint TEXT NOT NULL,          -- https, on a host push.webPushHosts lists
  p256dh TEXT NOT NULL,            -- the browser's public key
  auth_ref TEXT NOT NULL,          -- secret://push/<id>/auth: the auth secret
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|failing|gone
  failures INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, last_success_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, endpoint)
);

CREATE TABLE push_delivery (        -- each push sent: where it went and how it ended, never what it
  id TEXT PRIMARY KEY,             -- said; kept 7 days
  account_id TEXT NOT NULL REFERENCES account(id),
  notification_id TEXT,
  target_kind TEXT NOT NULL,       -- webpush (a push_subscription) | relay (the account's native
                                   -- clients through the Relay)
  target_ref TEXT,
  status TEXT NOT NULL,            -- sent|failed|gone|skipped
  detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_push_delivery_created ON push_delivery(account_id, created_at);
```

Plain email text never answers an approval; only the signed link does. Telegram and email messages
use the M6 `channel_message` rows (a Telegram receipt is `tg:<chat>:<id>`).

### browser & screen

Migrations 0023 (browser) and 0027 (screen). Computer, thread, turn and call ids are plain
TEXT: the computer table belongs to another area, and purges never block on a trace row.

```sql
CREATE TABLE browser_site (         -- the allow and block lists with per-site levels (FR-094)
  account_id TEXT NOT NULL REFERENCES account(id),
  pattern TEXT NOT NULL,           -- M7: a level for one project or agent is its own allow row keyed
                                   -- <pattern>|project:<id> or <pattern>|agent:<id>, with its own
                                   -- rule (no migration)
  access TEXT NOT NULL,            -- allow|block
  level TEXT,                      -- always_ask|auto_review|always_allow (allow only)
  dev_protocol INTEGER NOT NULL DEFAULT 0, -- developer-protocol mode (allow only)
  rule_id TEXT,                    -- the site-scoped policy_rule the level is enforced with
                                   -- (plain TEXT: the user may delete it in Settings)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, pattern),
  CHECK (access = 'allow' OR (level IS NULL AND dev_protocol = 0)),
  CHECK (access = 'block' OR level IS NOT NULL)
);

CREATE TABLE browser_action (       -- every browser action, for the Activity trace (FR-098)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL, thread_id TEXT, turn_id TEXT, call_id TEXT,
  tool TEXT NOT NULL, action TEXT NOT NULL, target TEXT, url TEXT, host TEXT,
  result TEXT NOT NULL,            -- ok|error|blocked|denied|handoff
  error TEXT, classification_json TEXT, -- the page-action classifier's effect classes (FR-095)
  before_path TEXT, after_path TEXT, -- blobs/screenshots/<yyyymmdd>/<id>-<before|after>.png,
                                   -- sealed; cleared when retention removes the files
  approval_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE browser_login (        -- saved logins (FR-086); reuse needs the user's pick
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  host TEXT NOT NULL, username TEXT NOT NULL,
  secret_ref TEXT NOT NULL CHECK (secret_ref LIKE 'secret://%'), -- secret://browser/login/<id>
  created_at TEXT NOT NULL, last_used_at TEXT,
  UNIQUE (account_id, host, username)
);

CREATE TABLE screen_control (       -- computer use per computer (FR-093)
  computer_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  enabled INTEGER NOT NULL DEFAULT 0, -- off until the user enables it
  stopped_at TEXT, stopped_by TEXT, -- the kill key's stop (user|key|system), held until the
                                   -- user resumes control
  updated_at TEXT NOT NULL
);

CREATE TABLE screen_grant (         -- per-app grants, made only by the user (FR-207, docs/12 §4.2)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL, app TEXT NOT NULL,
  tier TEXT NOT NULL,              -- view|click|full: the app's tier when granted
  granted_by TEXT NOT NULL, thread_id TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, -- 30 minutes by default, renewable
  renewed_at TEXT, revoked_at TEXT
);

CREATE TABLE screen_action (        -- every input action on a controlled desktop, refusals included
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL,
  actor TEXT NOT NULL,             -- user|system|agent:<id>
  origin TEXT NOT NULL,            -- tool|takeover
  kind TEXT NOT NULL,              -- click|scroll|type|key|drag
  args_json TEXT NOT NULL,         -- typed text is stored as its length only
  app TEXT, window_title TEXT,
  tier TEXT,                       -- none|view|click|full
  status TEXT NOT NULL,            -- ok|refused|failed|stopped
  error_code TEXT, error_message TEXT,
  thread_id TEXT, turn_id TEXT, call_id TEXT, takeover_id TEXT,
  before_blob TEXT, after_blob TEXT, -- content-addressed attachment blobs, encrypted at rest
  created_at TEXT NOT NULL, completed_at TEXT
);

CREATE TABLE screen_takeover (      -- the user's takeovers of an agent's computer (FR-087)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL,
  surface TEXT NOT NULL,           -- desktop|browser
  started_by TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT,  -- returned|restart
  input_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_screen_takeover_open ON screen_takeover(computer_id)
  WHERE ended_at IS NULL;          -- at most one open per computer

CREATE TABLE screen_appshot (       -- an image artifact of a window, the screen or a page (FR-075)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  source TEXT NOT NULL,            -- window|screen|browser
  app TEXT, window_title TEXT, url TEXT, width INTEGER, height INTEGER,
  thread_id TEXT, captured_by TEXT NOT NULL, captured_at TEXT NOT NULL
);
```

Migration 0043 (M7.5; FR-209, FR-096; ADR-096 D7, D8) adds the local browser fallback and the
extension bridge's grants. Device, computer and thread ids are plain TEXT: devices are revoked, not
deleted, and a consent or a trace row never blocks a purge. Nothing secret is stored.

```sql
CREATE TABLE browser_fallback_consent ( -- a revocable consent to continue a site on a device's
  id TEXT PRIMARY KEY,             -- browser (FR-209); a revoked row is kept for the record
  account_id TEXT NOT NULL REFERENCES account(id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('agent', 'thread')),
  scope_ref TEXT NOT NULL,
  device_id TEXT NOT NULL,
  site TEXT NOT NULL,              -- the site and its subdomains
  profile TEXT NOT NULL CHECK (profile IN ('clean', 'extension')), -- a clean temporary profile on
                                   -- the device, or the user's own browser through the extension
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT,
  revoked_at TEXT, revoked_by TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX ux_browser_fallback_consent_live
  ON browser_fallback_consent(account_id, scope_kind, scope_ref, device_id, site)
  WHERE revoked_at IS NULL;        -- one live consent per scope, device and site
CREATE INDEX idx_browser_fallback_consent_device ON browser_fallback_consent(device_id);

CREATE TABLE browser_fallback_session ( -- one session of a computer's browser moved to a device
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  computer_id TEXT NOT NULL, thread_id TEXT, device_id TEXT NOT NULL,
  site TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('clean', 'extension')),
  cause TEXT NOT NULL CHECK (cause IN ('block_page', 'repeated_challenge', 'requested')),
  consent_id TEXT REFERENCES browser_fallback_consent(id),
  started_at TEXT NOT NULL, ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('closed', 'left_site', 'consent_revoked', 'device_gone',
                                        'error', 'disabled', 'restarted')),
  egress_allowed INTEGER, egress_refused INTEGER, -- the device egress filter's counts at close
  bridge_user TEXT,                -- profile extension: the OS user whose browser it was
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX idx_browser_fallback_session_computer
  ON browser_fallback_session(account_id, computer_id, started_at);

CREATE TABLE browser_fallback_action ( -- the trace mark (FR-098): a browser_action row recorded
  action_id TEXT PRIMARY KEY REFERENCES browser_action(id) ON DELETE CASCADE, -- during a session
  session_id TEXT NOT NULL REFERENCES browser_fallback_session(id) ON DELETE CASCADE
);
CREATE INDEX idx_browser_fallback_action_session ON browser_fallback_action(session_id);

CREATE TABLE browser_bridge_grant ( -- a per-host grant of the extension bridge (FR-096); host '*'
  id TEXT PRIMARY KEY,             -- is the separate "all sites" grant
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL, host TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')), -- pending: the browser
                                   -- allowed the host and the owner has not confirmed it; only
                                   -- active counts
  browser_permission INTEGER NOT NULL DEFAULT 0, -- what the extension last reported for the host
  confirmed_by TEXT, confirmed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  revoked_at TEXT, revoked_by TEXT,
  CHECK (state <> 'active' OR confirmed_at IS NOT NULL),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_browser_bridge_grant_live ON browser_bridge_grant(device_id, host)
  WHERE state <> 'revoked';        -- one live grant per device and host
CREATE INDEX idx_browser_bridge_grant_account ON browser_bridge_grant(account_id, device_id);
```

A fallback session's start and end are also `browser_action` rows (tool `browser.fallback`, action
`local_fallback` and `local_fallback_end`), and every action in between is marked through
`browser_fallback_action`, so `browser_action` keeps its columns. A consent records the profile the
user chose; an `extension` consent whose bridge is gone asks again. At start the Hub ends its own
open sessions with `restarted`. The bridge's connection state (connected, since, extension
version, browser, OS user) and its per-tab consents (the tabs the user shared or the agent opened)
live only in Hub memory, from the events `novad` relays: after a restart a device counts as
disconnected until `novad` reports again, and the extension shares its tabs again on every
reconnect.

### spaces & sites

Migration 0026 (FR-036, FR-037). Every save of a page is a version; the page row keeps the
current text, so lists and reads need no join. A site names its source (a space or an artifact)
and its data sources by plain TEXT ids, so it outlives what it was built from.

```sql
CREATE TABLE space (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  project_id TEXT REFERENCES project(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  agent_edits TEXT NOT NULL DEFAULT 'propose', -- propose (proposals the user accepts) | direct
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE space_page (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES space(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  slug TEXT NOT NULL,              -- its file name in a generated site; unique per space
  position INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, content TEXT NOT NULL, -- the current version and its text
  updated_by TEXT NOT NULL DEFAULT 'user', -- user|agent
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE space_page_version (   -- a restore or an accepted proposal is a new version that says so
  page_id TEXT NOT NULL REFERENCES space_page(id), version INTEGER NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL,
  author_kind TEXT NOT NULL,       -- user|agent
  author_ref TEXT, turn_id TEXT,   -- an agent edit's thread and turn (its provenance)
  summary TEXT, restored_from INTEGER, proposal_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, version)
);

CREATE TABLE space_comment (        -- anchored to the page, a text range or a block
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES space_page(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  parent_id TEXT REFERENCES space_comment(id), -- replies go one level deep
  author_kind TEXT NOT NULL, author_ref TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  anchor_json TEXT NOT NULL,       -- {kind: page} | {kind: range, start, end, quote} |
                                   -- {kind: block, index, quote}; moved forward on every save
  version INTEGER NOT NULL,
  detached INTEGER NOT NULL DEFAULT 0, -- its text is gone
  resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE space_proposal (       -- an agent edit waiting for the user; page_id NULL = a new page
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES space(id),
  page_id TEXT REFERENCES space_page(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  base_version INTEGER,
  title TEXT NOT NULL, content TEXT NOT NULL, summary TEXT,
  author_ref TEXT, turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|accepted|rejected
  decided_at TEXT, created_at TEXT NOT NULL,
  CHECK ((page_id IS NULL) = (base_version IS NULL))
);

CREATE TABLE site (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL, description TEXT,
  source_kind TEXT NOT NULL,       -- space|artifact (HTML or Markdown)
  source_ref TEXT NOT NULL,        -- plain TEXT
  data_json TEXT NOT NULL DEFAULT '[]', -- [{sourceId, name}]: project sources copied in as
                                   -- data/<name>.json
  latest_version INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE site_version (         -- a built version
  site_id TEXT NOT NULL REFERENCES site(id), version INTEGER NOT NULL,
  note TEXT,
  blob_path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, -- the site's files as
                                   -- one deterministic zip (an attachment blob, encrypted at rest)
  files_json TEXT NOT NULL,        -- [{path, size}]
  preview_blob_path TEXT NOT NULL, -- the single-document preview
  scripts INTEGER NOT NULL DEFAULT 0, -- the preview may run the page's own scripts (an HTML
                                   -- artifact's), never same-origin
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, version)
);

CREATE TABLE site_publish (         -- publishes, newest last; the live one is the newest not reverted
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES site(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  version INTEGER NOT NULL,
  target_kind TEXT NOT NULL,       -- folder|zip
  target_ref TEXT,                 -- the folder name under the publish root; NULL for a zip
  reverted_at TEXT,                -- an unpublish reverts it; the previous one is live again
  created_at TEXT NOT NULL,
  CHECK ((target_kind = 'folder') = (target_ref IS NOT NULL))
);
```

Visualizations (FR-076) need no table: they are `chart` artifacts holding a
`nova.visualization` JSON document.

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
  kind TEXT NOT NULL,                   -- markdown|code|html|image|svg|chart|pdf|docx|pptx|xlsx|site|canvas|file
                                        -- (M5 saves DOCX, PPTX and XLSX as kind `file` with their
                                        -- Office media type and the extension in the title, FR-219)
  title TEXT, blob_path TEXT, mime TEXT, sha256 TEXT, version INTEGER NOT NULL DEFAULT 1,
  live INTEGER NOT NULL DEFAULT 0, meta_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE artifact_version (     -- every version of an artifact (FR-038); the artifact row is
  artifact_id TEXT NOT NULL REFERENCES artifact(id), -- the latest
  version INTEGER NOT NULL, message_id TEXT,
  blob_path TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
-- The Library (FR-041) is a query over artifact, attachment and source rows, and terminals
-- (FR-006) live only in Hub memory; neither has a table.

CREATE TABLE usage_event (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  provider TEXT, model TEXT, thread_id TEXT, turn_id TEXT,
  run_id TEXT, goal_id TEXT,       -- copied from the turn (M5); a compaction summary request
                                   -- is a usage_event of its turn
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
  command TEXT, args_json TEXT, url TEXT,
  env_ref_json TEXT,               -- {NAME: secret://mcp/<id>/env/<NAME>}; a bundle's non-sensitive
                                   -- values are kept as written
  config_json TEXT,                -- mcp-config.json#/$defs/server fields without a column (timeouts,
                                   -- tool lists, defaultApproval, a bundle's confirmed `policy`, a
                                   -- plugin server's manifest key); OAuth state is in mcp_oauth
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

CREATE TABLE mcp_oauth (            -- OAuth 2.1 with PKCE for one sse/http server (FR-047)
  server_id TEXT PRIMARY KEY REFERENCES mcp_server(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  issuer TEXT NOT NULL, metadata_json TEXT NOT NULL, -- authorization server and its RFC 8414 metadata
  resource TEXT,                   -- RFC 8707 resource indicator from the protected-resource metadata
  client_id TEXT NOT NULL,         -- Nova's client metadata document URL or a registered client id
  client_secret_ref TEXT,          -- vault reference, when dynamic registration returned a secret
  registration TEXT NOT NULL,      -- metadata_document|dynamic
  scopes_json TEXT NOT NULL DEFAULT '[]',
  access_token_ref TEXT, refresh_token_ref TEXT, -- secret://mcp/<server id>/oauth/…; never the tokens
  status TEXT NOT NULL DEFAULT 'needs_auth', -- needs_auth|connected|expired|error
  expires_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE plugin_install (       -- one installed plugin per account (FR-045); files on disk (§3)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  plugin_id TEXT NOT NULL,         -- manifest id (plugin-manifest.json `id`)
  version TEXT NOT NULL,
  source TEXT NOT NULL,            -- local|catalog|git (an import installs through local)
  origin TEXT NOT NULL,            -- a folder, <catalogId>/<pluginId>, or a Git URL with its commit
  manifest_json TEXT NOT NULL,     -- the validated plugin.json; `permissions` is what the user
                                   -- confirmed; every server env and header value is stored only as
                                   -- the secret:// reference it became
  signature TEXT NOT NULL DEFAULT 'unverified', -- verified|unverified (signing arrives with FR-049)
  install_path TEXT NOT NULL,
  registrations_json TEXT NOT NULL, -- what the install registered: server ids by manifest key,
                                   -- skills, roles, hooks with hashes, hooks trusted at install,
                                   -- UI entry points, the previewed folder digest
  enabled INTEGER NOT NULL DEFAULT 1, error TEXT,
  installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, plugin_id)
);

-- Skills are folders (ADR-067): SKILL.md and its files stay on disk and are discovered from the
-- built-in, user, plugin and project skill folders; there is no `skill` table. This table keeps
-- only what a folder cannot.
CREATE TABLE skill_state (
  account_id TEXT NOT NULL REFERENCES account(id),
  skill_id TEXT NOT NULL,          -- skill:<builtin|user|import|managed>:<name>, skill:<pluginId>:<name>,
                                   -- skill:project:<projectId>:<name>
  enabled INTEGER NOT NULL DEFAULT 1, -- a disabled skill drops out of precedence (FR-046)
  origin TEXT,                     -- NULL|import: a user-folder skill an import created (FR-200)
  provenance_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, skill_id)
);

CREATE TABLE agent_role (           -- sub-agent roles a plugin brings (docs/08 §3.1), for task.spawn
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  role_key TEXT NOT NULL,          -- <pluginId>:<name> (the role role:<pluginId>:<name>)
  plugin_id TEXT,
  name TEXT NOT NULL, description TEXT NOT NULL,
  tools_json TEXT NOT NULL,        -- never more than the plugin's permissions or the parent run's
  model_hint TEXT, instructions TEXT NOT NULL,
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (account_id, role_key)
);
CREATE INDEX idx_agent_role_plugin ON agent_role(account_id, plugin_id);

CREATE TABLE connector (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider TEXT NOT NULL,
  label TEXT, secret_ref TEXT, scopes TEXT, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE app_authorization (    -- per-client tokens: Nova's MCP server (FR-044, FR-192),
                                    -- third-party apps (FR-222)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- mcp_client|app (M4 creates mcp_client only)
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,            -- JSON {tools: [..]|"*", projects: [..]|"*",
                                   -- threads: none|read|read_write, mode: read_only|run_allowed};
                                   -- unreadable scopes grant nothing
  token_hash TEXT UNIQUE,          -- SHA-256 of the bearer token (nvm_…); the token is shown once
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|revoked; revoked rows stay for the audit
                                   -- trail and are not listed
  created_at TEXT NOT NULL, last_used_at TEXT, -- last_used_at written at most once a minute
  expires_at TEXT, revoked_at TEXT, -- default expiry 90 days
  CHECK (status <> 'active' OR token_hash IS NOT NULL)
);
CREATE INDEX idx_app_authorization_account ON app_authorization(account_id, status);
-- ambient_grant_id (required for an ambient scope, FR-233) is not in M4; it arrives with
-- ambient grants.

CREATE TABLE import_record (        -- FR-200 provenance and SHA-256 dedupe; one row per applied item
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  import_id TEXT NOT NULL,         -- groups the items of one apply (ImportResult.importId)
  source_kind TEXT NOT NULL,       -- instruction_file|skill_folder|command_file|plugin|mcp_config|
                                   -- project|memory_export|chat_export
  source_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,            -- of the normalized item
  item_kind TEXT NOT NULL,         -- what it became: instruction|skill|plugin|mcp_server|project|memory|thread
  target_ref TEXT,                 -- id of the created row
  target TEXT,                     -- what it became, as shown, e.g. "MCP server github (disabled)"
  status TEXT NOT NULL,            -- imported|disabled_pending_permissions|failed
  secrets_migrated INTEGER NOT NULL DEFAULT 0, -- secrets moved to the keychain as secret:// refs
  imported_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_import_dedupe ON import_record(account_id, item_kind, sha256)
  WHERE status <> 'failed';           -- a failed item never blocks a retry
CREATE INDEX idx_import_record_account ON import_record(account_id, imported_at);
CREATE INDEX idx_import_record_import ON import_record(import_id);

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
```

Sync is migration 0033 (M7; FR-109, FR-112, FR-129; ADR-010, ADR-036, ADR-095). The Hub is
canonical. Every synced field has one row in `sync_field` with its current value, its hybrid
logical clock and the change-feed cursor of its last change; a replica pulls the rows after its
cursor. The feed is filled from the areas' events and a sweep every 5 minutes. A merge is per
field, last writer wins; the value that lost goes to `sync_merge_entry`, and restoring writes it
back as a new change. Deletes are tombstones (field `_deleted`); a tombstone drops the entity's
other rows and its merge-log entries, and tombstones are kept. A device keeps a replica only while
its device session has the `offline-replica` scope. There is no per-entity `sync_state` table: a
replica's progress is one cursor in `sync_replica`.

What syncs (replicas may write the fields named; others are read-only): threads (title, pinned,
archived, project), messages (one immutable body; finished user and assistant messages of
non-temporary, non-side chats), projects (name, instructions), memory items of global and project
scope (content, status), spaces (name), pages (title, content), schedules (enabled; not agents'
self-set wakes) and the owner's non-security global settings. Replicas may create only threads and
messages, and delete only threads, projects, memory items and pages.

```sql
CREATE TABLE sync_meta (            -- the Hub's clock and counters: hlc (the last clock issued, so it
  key TEXT PRIMARY KEY,            -- never goes back across restarts), cursor (the last change-feed
  value TEXT NOT NULL              -- cursor), message_watermark (the sweep's progress)
);

CREATE TABLE sync_field (           -- the change feed: one row per synced field, its current value
  kind TEXT NOT NULL,              -- thread|message|project|memory|space|page|schedule|setting
  entity_id TEXT NOT NULL,         -- the entity's own id (a setting's key)
  field TEXT NOT NULL,             -- `_deleted` for a tombstone
  account_id TEXT NOT NULL REFERENCES account(id),
  parent_id TEXT,                  -- a message's thread, so a thread's tombstone drops its messages
  value_json TEXT NOT NULL,        -- JSON, `null` included
  hlc TEXT NOT NULL,               -- <15-digit ms>-<4 hex>-<node>: fixed width, sorts in clock order
  device_id TEXT,                  -- the device whose op set it (plain TEXT); NULL for a Hub change
  cursor INTEGER NOT NULL,         -- unique and only grows
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, entity_id, field)
);
CREATE UNIQUE INDEX idx_sync_field_cursor ON sync_field(cursor);
CREATE INDEX idx_sync_field_account ON sync_field(account_id, cursor);
CREATE INDEX idx_sync_field_parent ON sync_field(kind, parent_id);

CREATE TABLE sync_merge_entry (     -- the merge log (Settings → Sync → History); kept
  id TEXT PRIMARY KEY,             -- sync.mergeLogDays (90)
  account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL,              -- as sync_field.kind
  entity_id TEXT NOT NULL, field TEXT NOT NULL,
  reason TEXT NOT NULL,            -- concurrent (a newer op replaced a value its device had not seen)|
                                   -- stale (an op lost to a newer value)|restore (a restore replaced it)
  lost_value_json TEXT NOT NULL, lost_hlc TEXT NOT NULL, lost_device_id TEXT,
  winner_value_json TEXT NOT NULL, winner_hlc TEXT NOT NULL, winner_device_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open|restored
  restored_at TEXT, restored_hlc TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sync_merge_account ON sync_merge_entry(account_id, created_at);
CREATE INDEX idx_sync_merge_entity ON sync_merge_entry(kind, entity_id);

CREATE TABLE sync_replica (         -- a device's replica and its progress
  device_id TEXT PRIMARY KEY REFERENCES device(id),
  account_id TEXT NOT NULL REFERENCES account(id),
  cursor INTEGER NOT NULL DEFAULT 0, -- what it pulled last
  last_pull_at TEXT, last_push_at TEXT,
  last_error TEXT, last_error_at TEXT,
  reset_at TEXT,                   -- the owner reset it: it must load a snapshot again
  revoked_at TEXT,                 -- the device was revoked or lost the offline-replica scope
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_sync_replica_account ON sync_replica(account_id);

CREATE TABLE idempotency_key (      -- the first answer to a request with an Idempotency-Key (FR-112)
  principal TEXT NOT NULL,         -- device:<id> for a device session, else token:<id>
  key TEXT NOT NULL,               -- 1-200 visible ASCII characters
  method TEXT NOT NULL, path TEXT NOT NULL,
  account_id TEXT,
  body_hash TEXT NOT NULL,         -- hex SHA-256 of the body; another body with the key is refused
  status INTEGER,                  -- NULL while the first request runs
  response TEXT, content_type TEXT,
  replayable INTEGER NOT NULL DEFAULT 1, -- 0: the key is kept, the answer is not
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,        -- 24 hours after the first request
  PRIMARY KEY (principal, key, method, path)
);
CREATE INDEX idx_idempotency_key_expires ON idempotency_key(expires_at);
```

Only the writes a client queues offline keep their answer (`REPLAYABLE_ROUTES` in
`apps/hub/src/sync.ts`); on every other route a repeated key gets 409 `idempotency_not_replayable`,
so the effect still never happens twice. An answer marked `no-store`, larger than 256 KiB or
carrying a credential is never written. A 5xx or 429 answer forgets the key, so a retry runs.

## 3. Blob storage layout

```
<appData>/nova/
├── nova.db               # SQLite
├── nova.db-wal
├── blobs/
│   ├── attachments/<sha256>         # also the account avatar (account.avatar_path)
│   ├── artifacts/<artifact-id>/v<N>/<file>
│   ├── staged/<staged-write-id>     # two-phase device writes (FR-210); M6 stages on the device
│   ├── snapshots/<computer-id>/<snapshot-id>/  # a folder copy of the computer (M6)
│   ├── screenshots/<yyyymmdd>/<id>-<before|after>.png  # browser actions, sealed with the data
│   │                                 # key; computer-use screenshots are attachment blobs
│   ├── ambient/<yyyy>/<mm>/<dd>/<record-id>.jpg.age # pixels when the target is the Hub (FR-228)
│   └── voiceprints/<speaker-id>.enc  # FR-231, never leaves the Hub
├── plugins/<plugin-id>/<version>/  # an update swaps the version folder (FR-045)
├── skills/<name>/SKILL.md (+ scripts, templates)  # user and imported skills (ADR-067)
├── mcp/<server-id>/                # an MCP server's working directory
├── mcp/bundles/<name>/<version>/   # unpacked MCP bundles; earlier versions are kept (FR-199)
├── hooks.json                      # the user's hooks file (FR-197)
├── instructions.md                 # user instructions (an import writes it, FR-200); every turn
│                                   # reads it as "User instructions" (FR-185)
├── code/<session-id>/shadow.git    # a Code session's shadow repository (refs/nova/baseline, start)
├── code/<session-id>/patches/<change-id>.patch  # a change's pending part (FR-064)
├── code/<session-id>/merges/<merge-id>.json  # files before a merge, for an abort (M7, FR-073)
├── code/handoffs/<handoff-id>/     # changes.patch and state.bundle of a handoff (M7, FR-213);
│                                   # the bundle goes when it completes, the folder after 7 days
├── code/no-hooks/                  # the empty hooks folder Nova's own Git calls use (FR-211)
├── computers/<computer-id>/{home,browser}/  # an agent's computer (M6, FR-080)
├── cloud-mock/                     # the mock cloud runner's computers (M6)
├── browser/profiles/<computer-id>/ # browser state (state.json, sealed) when no computer folder
├── browser/files/<computer-id>/    # browser downloads without a computer service
├── egress/ca-cert.pem, ca-key.pem  # the egress proxy's inspection CA (key 0600; M6, ADR-063)
├── firmware/snapshots/<snapshot-id>.json  # the Hub's copy of a device's firmware snapshot,
│                                   # sealed with the data key (M7.5, FR-146; §7)
├── boot-images/                    # images the owner puts there for network boot; the Hub only
│                                   # reads them (M7.5, FR-143)
├── sites/<folder>/                 # published sites, unless `sites.publishRoot` names another
│                                   # folder; each carries a `.nova-site` marker (M6, FR-037)
├── plugins-drafts/<id>/            # plugin drafts written by plugin.scaffold (FR-050); never installed
├── import/<import-id>/             # staging copies of imported skills and plugins
├── workspace/hook-context/<thread-id>/  # hook context over 2,500 tokens
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
  per project (rebuildable, git-ignored, safe to delete). M5 ships a pattern-based symbol
  extractor held in Hub memory per session instead (16 indexes, 512 KiB per file, 20,000 files).

## 5. Migration & retention policy

- Forward-only migrations, one per schema version, run in a transaction with a backup first.
- Retention defaults: messages forever; tool results 90 days unless pinned; screenshots 30
  days; logs 14 days; snapshots until deleted or 30 days; resolved or expired
  `server_request` rows 30 days; `mcp_event_delivery` rows 7 days; ambient text 30 days and
  pixels 48 h (FR-154). All configurable; user can disable pruning. M6 applies the screenshot
  default through `browser.screenshotRetentionDays` (swept every 6 hours) and
  `screen.screenshotRetentionDays` (pruned daily); device stages expire after 24 h. Snapshot
  expiry is not enforced yet. M7 keeps `push_delivery` rows 7 days, `idempotency_key` rows 24 h,
  merge-log entries `sync.mergeLogDays` (90) and handoff files 7 days; change-feed tombstones are
  kept. M7.5 prunes none of its rows or files: firmware changes and snapshot copies, boot
  requests and attempts, revoked boot tokens, out-of-band actions, fallback consents and sessions,
  bridge grants and decommissions are kept (`novad` keeps its own last 20 firmware snapshots). A
  fallback trace mark goes with its `browser_action` row.
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
6. An `agent` has at most one computer of its own (`uq_computer_agent`), created on first use
   (`cloud` or `local_container`, `computers.agentComputer`), plus at most one active connected
   device (`agent_device_connection`). M6 creates `local_container` by default; `cloud` uses a
   mock runner on the Hub.
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
    or `expired` (with `expired_reason` timeout, cancelled or restart); later answers are
    rejected (FR-188).
12. **Protected paths** (FR-190) are applied after every permission profile, command rule,
    grant and hook; none of them makes `.git`, `.nova`, `.agents`, the data directory,
    credential locations or shell startup files writable. No allow rule or grant removes the sandbox (ADR-059).
13. A `hook` runs only while `trust_state = 'trusted'` and `trusted_hash = content_hash`
    (managed hooks are trusted by policy); a hook never loosens built-in safety, managed policy, a
    `handoff` or a `deny` (ADR-068).
14. A `command_rule` is stored only after all its examples pass at load; one failing example
    rejects the whole rule file (FR-191).
15. Memory in a `project_only` project is never read outside that project (FR-205).
    Consolidation never writes skills (ADR-069).
16. A `feature_flag` at stage `removed` is never enabled and is rejected at load (ADR-082).
17. An `mcp_event_delivery` row exists only for a delivery with a valid signature; replays of
    a known `delivery_id` start nothing (FR-201).
18. A `memory_item` or `agent_memory` row with `origin_audience = 'private'` reaches a reply in
    a `shared` channel binding only after the policy check (default `ask` the owner; FR-088,
    ADR-070).
19. A schedule never fires the same rule time twice, across restarts too: a fire is claimed by
    inserting its `schedule_fire` row in the transaction that moves `next_run_at` (ADR-079).

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

CREATE TABLE device_management (   -- what the Hub keeps per novad device (M6; FR-142, FR-150)
  device_id TEXT PRIMARY KEY REFERENCES device(id),
  protocol_version INTEGER NOT NULL,
  update_channel TEXT NOT NULL DEFAULT 'stable', -- stable|beta|nightly (FR-148)
  capability_overrides TEXT NOT NULL DEFAULT '{}', -- the Hub's overrides (FR-142)
  policy TEXT NOT NULL DEFAULT '{}', -- per-device policy: modules, caps, routing, quiet hours (FR-150)
  config_revision INTEGER NOT NULL DEFAULT 0, -- bumped on every change; the device has taken the
  pushed_revision INTEGER NOT NULL DEFAULT 0, -- config when pushed_revision catches up
  modules TEXT NOT NULL DEFAULT '[]', power TEXT, -- the last module and power reports
  updated_at TEXT NOT NULL
);

CREATE TABLE device_grant (         -- folder and MCP grants on a device per grantee (FR-210, M6)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  grantee_kind TEXT NOT NULL,      -- user|agent|session|run|thread
  grantee_ref TEXT NOT NULL,
  kind TEXT NOT NULL,              -- folder|mcp
  target TEXT NOT NULL,            -- a canonical folder path on the device, or an MCP server name
  access TEXT NOT NULL,            -- read|write|call
  status TEXT NOT NULL,            -- pending (an access request)|granted|denied|revoked
  device_request_id TEXT, device_grant_id TEXT, -- the ids on the device
  approval_id TEXT REFERENCES approval(id), -- the Hub approval card of a pending request
  reason TEXT,
  decided_by TEXT,                 -- device (`novad access approve`) | hub
  created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE staged_write (         -- two-phase device writes (FR-210)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  device_stage_id TEXT NOT NULL,   -- the stage id on the device
  grantee_kind TEXT NOT NULL, grantee_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,       -- thread, run, Code session or agent that staged it
  path TEXT NOT NULL,              -- canonical path inside a granted scope
  base_sha256 TEXT,                -- file hash at staging (NULL = new file)
  new_sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  blob_path TEXT NOT NULL,         -- the content waits in novad's staging area
  diff TEXT NOT NULL, additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staged', -- staged|committed|discarded|conflict|expired|failed
  approval_id TEXT REFERENCES approval(id),
  error TEXT, created_at TEXT NOT NULL, committed_at TEXT
);

CREATE TABLE wake_request (         -- Wake-on-LAN requests (FR-144): rate-limited and logged
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  target_device_id TEXT NOT NULL REFERENCES device(id),
  helper_device_id TEXT REFERENCES device(id), -- NULL: the Hub sent the packet itself (M6); a
                                   -- Wake Helper sends it from M6.5 (FR-138)
  mac TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending (M6.5, 0029)|sent|failed|rate_limited
  error TEXT, created_at TEXT NOT NULL
);

CREATE TABLE device_update (        -- signed updates pushed to a device and how they ended (FR-148)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  target TEXT NOT NULL,            -- a module name or novad
  from_version TEXT, to_version TEXT NOT NULL, channel TEXT NOT NULL,
  status TEXT NOT NULL,            -- applied|rolled_back|staged|refused|failed
  detail TEXT, created_at TEXT NOT NULL
);

CREATE TABLE agent_device_connection ( -- an agent's connected computer (FR-081)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  agent_id TEXT NOT NULL,          -- plain TEXT: the agent table belongs to the agents area
  device_id TEXT NOT NULL REFERENCES device(id),
  capabilities TEXT NOT NULL,      -- JSON: what the agent may use on the device
  status TEXT NOT NULL,            -- active|revoked
  created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE UNIQUE INDEX idx_agent_device_connection_active ON agent_device_connection(agent_id)
  WHERE status = 'active';         -- one active connection per agent

-- `firmware_change` (FR-146) is built by migration 0040, extended from the design that stood here:
-- see "Firmware, boot, out-of-band and device operations (M7.5)" below.
```

A `novad` device (M6, migration 0024) is a `device` row of kind `client`, `hub` or `wake-helper`,
never `compute`, so it stays out of the M2 compute-node service (the compute role may still be
listed in `roles`). Its management endpoint is a `transport_endpoint`; its enrollment token is an
`add_device_request` hashed in its own domain (`nvd_…`); the management token the Hub presents to
the device lives in the vault at `secret://devices/<id>/management-token`. Every enrollment
rotates the device key, so a revoked device can be added again.

Invariants: a `device` certificate is unique; a `device_capability` exists for every active
compute node; `firmware_change` requires an `approval` before `applied` (a CHECK from M7.5,
below); `wake_request`
requires an active `wake-helper` device on the same LAN; a `staged_write` commits only when the
file's current hash still equals `base_sha256` and policy allows (otherwise `conflict`);
revoking a device also stops relay routing for its `relay_client_id`.

### Add Device, network, trust and the Relay (M6.5)

Migrations 0028 (Add Device), 0029 (network), 0030 (network setup), 0031 (trust) and 0032
(Relay); ADR-094. All timestamps are UTC ISO-8601 and ids UUIDv7. No private key, code, nonce or
token is stored in clear: codes are salted SHA-256 hashes, sessions are hashed `auth_token`
rows, and keys and typed secrets are vault entries named by `secret://` references.

```sql
CREATE TABLE device_pairing (       -- 0028: what the owner started (FR-132)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  role TEXT NOT NULL,              -- client|compute|wake-helper
  scopes TEXT NOT NULL DEFAULT '[]', name TEXT, -- the owner's name wins over the device's
  transport TEXT NOT NULL DEFAULT 'direct',      -- direct|relay
  code_hash TEXT NOT NULL,         -- hex SHA-256 of `nova-add-device-code-v1|<id>|<CODE>`
  relay_pairing_id TEXT,           -- the Relay's slot (transport relay)
  attempts INTEGER NOT NULL DEFAULT 0, -- wrong codes; the fifth burns it
  status TEXT NOT NULL DEFAULT 'open', -- open|used|expired|burned
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);

CREATE TABLE device_pairing_request ( -- 0028: a device's request to join, one per pairing
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  pairing_id TEXT NOT NULL UNIQUE REFERENCES device_pairing(id), -- makes the code single use
  role TEXT NOT NULL, kind TEXT NOT NULL, -- browser|novad|compute|native
  scopes TEXT NOT NULL DEFAULT '[]', name TEXT NOT NULL, platform TEXT NOT NULL,
  public_key TEXT NOT NULL,        -- raw Ed25519, base64url
  fingerprint TEXT NOT NULL,       -- hex SHA-256 of the key, as device.cert_fingerprint
  confirmation TEXT,               -- the six digits; NULL until the reveal (v2)
  commitment TEXT, hub_nonce TEXT, revealed_at TEXT, -- v2 commit-then-reveal
  via TEXT NOT NULL DEFAULT 'direct', relay_client_id TEXT, -- direct|relay
  status TEXT NOT NULL DEFAULT 'pending', -- committed|pending|approved|denied|expired
  device_id TEXT REFERENCES device(id), -- the record approval created
  last_poll INTEGER,               -- newest accepted status poll (Unix s); a poll must be newer
  grant_type TEXT, granted_at TEXT, -- session|novad|compute, handed out once (never the secret)
  decided_at TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE device_session (       -- 0028: a browser's or app's session belongs to its device
  token_id TEXT PRIMARY KEY REFERENCES auth_token(id),
  device_id TEXT NOT NULL REFERENCES device(id), account_id TEXT NOT NULL REFERENCES account(id),
  request_id TEXT REFERENCES device_pairing_request(id), created_at TEXT NOT NULL
);

CREATE TABLE revoked_device_key (   -- 0028: keys of revoked devices; Add Device refuses them
  fingerprint TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT,                  -- plain TEXT: the row outlives a purge of the device
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE network_endpoint_check ( -- 0029: one row per probe; kept 7 days (FR-135)
  id TEXT PRIMARY KEY, transport TEXT NOT NULL, -- lan|mesh|relay|direct
  url TEXT NOT NULL, health TEXT NOT NULL, -- ok|failing
  latency_ms INTEGER, detail TEXT, checked_at TEXT NOT NULL
);

CREATE TABLE network_transport_event ( -- 0029: what is advertised changed; kept 90 days
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- advertised|withdrawn|up|down|off|primary
  transport TEXT, from_transport TEXT, -- for primary: the new and the previous preferred one
  url TEXT, detail TEXT, created_at TEXT NOT NULL
);

CREATE TABLE network_change (       -- 0029: the change log behind one-click rollback (FR-139)
  id TEXT PRIMARY KEY, account_id TEXT REFERENCES account(id), actor TEXT NOT NULL,
  kind TEXT NOT NULL,              -- network.settings|trust.mode|network.setup.step
  summary TEXT NOT NULL,
  undo_json TEXT NOT NULL,         -- read by the kind's undo handler; secret:// refs only
  status TEXT NOT NULL DEFAULT 'applied', -- applied|rolled_back
  error TEXT, created_at TEXT NOT NULL, rolled_back_at TEXT -- error: the last failed rollback
);

CREATE TABLE network_setup_run (    -- 0030: a Network Setup plan (FR-136)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  provider TEXT NOT NULL,          -- headscale|tailscale|netbird|wireguard
  status TEXT NOT NULL,            -- planned|in_progress|completed|failed|rolled_back
  options_json TEXT NOT NULL,      -- write-only secrets replaced by vault refs
  outputs_json TEXT NOT NULL DEFAULT '{}', detection_json TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE network_setup_step (   -- 0030: one step of a run, UNIQUE (run_id, idx)
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES network_setup_run(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id), idx INTEGER NOT NULL,
  kind TEXT NOT NULL, provider TEXT NOT NULL, -- headscale|tailscale|netbird|wireguard|ufw|os|hub
  mode TEXT NOT NULL,              -- change|manual|skip|check
  title TEXT NOT NULL, description TEXT NOT NULL, -- what the owner confirms word for word
  commands_json TEXT NOT NULL,     -- argv lists only
  params_json TEXT NOT NULL, affects_json TEXT NOT NULL, undo_affects_json TEXT NOT NULL,
  expects_json TEXT NOT NULL, system_change INTEGER NOT NULL,
  status TEXT NOT NULL,            -- pending|applied|verified|failed|rolled_back|rollback_failed|
                                   -- manual|skipped
  checks_json TEXT NOT NULL DEFAULT '[]', error TEXT,
  auto_rolled_back INTEGER NOT NULL DEFAULT 0,
  change_ref TEXT,                 -- the network_change entry (plain TEXT)
  applied_at TEXT, verified_at TEXT, rolled_back_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE network_setup_snapshot ( -- 0030: what a step changed, taken before it did
  id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES network_setup_step(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES network_setup_run(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id),
  data_json TEXT NOT NULL, undo_json TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE network_setup_consent ( -- 0030: one active per (account, kind, provider)
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES account(id),
  kind TEXT NOT NULL, provider TEXT NOT NULL,
  description TEXT NOT NULL,       -- a consent covers only this exact text
  granted_at TEXT NOT NULL, revoked_at TEXT
);

CREATE TABLE trust_identity (       -- 0031: the Hub identity's public half; one row (id 'hub')
  id TEXT PRIMARY KEY, public_key TEXT NOT NULL, -- raw Ed25519, base64url
  fingerprint TEXT NOT NULL,       -- base64url SHA-256 of the key: what devices pin
  key_ref TEXT NOT NULL, created_at TEXT NOT NULL -- secret://hub/identity
);

CREATE TABLE trust_ca (             -- 0031: the Hub local CA; one active (retired_at NULL)
  id TEXT PRIMARY KEY, cert_pem TEXT NOT NULL,
  fingerprint TEXT NOT NULL,       -- SHA-256 of the DER, upper-case hex with colons
  key_ref TEXT,                    -- secret://hub/ca/<id>/key; NULL once a retired key left
  name_constraints_json TEXT NOT NULL, -- {"dns": [...], "ip": [...]}
  not_before TEXT NOT NULL, not_after TEXT NOT NULL, created_at TEXT NOT NULL, retired_at TEXT
);

CREATE TABLE trust_certificate (    -- 0031: issued and stored certificates; UNIQUE (ca_id, serial)
  id TEXT PRIMARY KEY, ca_id TEXT REFERENCES trust_ca(id), -- NULL for a mesh certificate
  kind TEXT NOT NULL,              -- hub_tls|device|mesh
  serial TEXT NOT NULL, subject TEXT NOT NULL,
  device_id TEXT, role TEXT,       -- plain TEXT: a novad device or a compute node
  sans_json TEXT NOT NULL DEFAULT '[]', public_key TEXT, cert_pem TEXT NOT NULL,
  key_ref TEXT,                    -- the Hub's own TLS keys; NULL for device certificates
  not_before TEXT NOT NULL, not_after TEXT NOT NULL, created_at TEXT NOT NULL,
  superseded_at TEXT, revoked_at TEXT, revoked_reason TEXT -- revoked rows: the revocation list
);

CREATE TABLE relay_registration (   -- 0032: the Hub at one Relay (FR-137)
  id TEXT PRIMARY KEY, url TEXT NOT NULL,
  route_id TEXT NOT NULL,          -- the Hub's routing id there
  token_ref TEXT NOT NULL,         -- secret://relay/<id>/route-token
  x25519_key_ref TEXT NOT NULL, x25519_public_key TEXT NOT NULL, -- secret://relay/<id>/x25519 (secret-scan: fake)
  status TEXT NOT NULL DEFAULT 'active', -- active|rejected (the Relay forgot it)|retired
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE relay_client (         -- 0032: a client paired through the Relay
  id TEXT PRIMARY KEY,             -- its relay client id
  account_id TEXT NOT NULL REFERENCES account(id),
  registration_id TEXT NOT NULL REFERENCES relay_registration(id),
  route_id TEXT NOT NULL,          -- UNIQUE (registration_id, route_id)
  relay_pairing_id TEXT NOT NULL, add_pairing_id TEXT, request_id TEXT, device_id TEXT,
  name TEXT NOT NULL, platform TEXT NOT NULL, kind TEXT NOT NULL, -- browser|native
  public_key TEXT NOT NULL, x25519_public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|active|denied|expired|revoked
  stream_floor INTEGER NOT NULL DEFAULT 0, -- highest client stream counter accepted
  last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT
);
```

Migration 0029 also rebuilds `wake_request` (SQLite cannot change a CHECK constraint, and nothing
references the table) so that `status` takes `pending`: a wake is counted and recorded as
`pending` in the same transaction before a Wake Helper is called, then becomes `sent` or `failed`
(`rate_limited` stays). `helper_device_id` names the Wake Helper that sent it (FR-138). Ids of
other areas' rows are plain TEXT here (`relay_client.device_id`, `network_setup_step.change_ref`,
`trust_certificate.device_id`). An enrollment token Add Device grants is a 0005
`add_device_request` row whose `scopes` JSON carries `bind: {publicKey, deviceId}`; registration
must present that key and activates that pending `device` row. Only a `revoked` Relay client's key
is refused when it pairs again; `denied` and `expired` rows are kept.

### Device TLS (M7)

Migration 0039 (M7, FR-126; ADR-095) adds no table: the file holds only a comment. Mutual TLS for
`novad` devices and compute nodes checks the device certificates of 0031 (`trust_certificate`,
kind `device`). What each device last presented over HTTPS is kept in Hub memory and rebuilt by its
next heartbeat; a refusal is audited as `device.tls.refuse` (§2). The Relay registration token is a
vault entry (`secret://relay/registration/token`) named by the `relay.registrationTokenRef`
setting, not a `relay_registration` column. A device's offline replica is a `sync_replica` row
(§2, migration 0033).

### Firmware, boot, out-of-band and device operations (M7.5)

Migrations 0040 (firmware), 0041 (boot), 0042 (out-of-band) and 0044 (device operations); FR-146,
FR-143, FR-147, FR-126, FR-150; ADR-096. 0040 also adds `approval.answer_in` (§2), and 0043 holds
the browser fallback and bridge tables (§2, browser & screen). All timestamps are UTC ISO-8601 and
ids UUIDv7. Every privileged change here (a firmware change, a boot try or commit, an out-of-band
action other than a read, a decommission) is the owner's request and needs an approval card the
owner answers in Nova (`answer_in = 'hub'`, §2); firmware changes, low-level boot, network boot
and out-of-band management sit behind switches that are off by default (`docs/14`). No row
holds a credential: the BIOS admin password is the vault entry `secret://devices/<id>/bios-admin`,
a BMC's user name and password are `secret://oob/<id>`, the Hub's client certificate for the
management channel is `secret://hub/client-certificate`, and a boot token is kept only as a hash.

```sql
CREATE TABLE firmware_snapshot (    -- 0040: the Hub's copy of a snapshot the device took when it
  id TEXT PRIMARY KEY,             -- planned a change (the allowlisted values before it)
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  device_snapshot_id TEXT NOT NULL, -- the snapshot's id on the device
  taken_at TEXT NOT NULL,
  keys_json TEXT NOT NULL DEFAULT '[]', -- the keys only; the values are in the sealed file
  sha256 TEXT NOT NULL,            -- hex SHA-256 of the canonical JSON of the values
  blob_path TEXT NOT NULL,         -- firmware/snapshots/<id>.json, relative to the data folder
  created_at TEXT NOT NULL
);
CREATE INDEX idx_firmware_snapshot_device ON firmware_snapshot(device_id, device_snapshot_id);

CREATE TABLE firmware_change (      -- 0040: one plan's settings (apply) or a snapshot restored
  id TEXT PRIMARY KEY,             -- (rollback), with its approval (FR-146)
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  kind TEXT NOT NULL CHECK (kind IN ('apply', 'rollback')),
  setting TEXT NOT NULL,           -- the canonical keys, comma-separated
  old_value TEXT, new_value TEXT,  -- JSON {key: value} before and after
  diff_json TEXT NOT NULL DEFAULT '[]', -- the diff the approval card showed
  refused_json TEXT NOT NULL DEFAULT '[]', -- keys the device would not plan, with the reason
  method TEXT NOT NULL,            -- firmware-attributes|efibootmgr|fake (unknown when the device
                                   -- named none)
  plan_id TEXT,                    -- the device's plan id (kind apply)
  snapshot_ref TEXT REFERENCES firmware_snapshot(id),
  rollback_of TEXT REFERENCES firmware_change(id), -- the change a rollback undoes
  security_degrading INTEGER NOT NULL DEFAULT 0, -- needs devices.firmware.allowSecurityDegrading
  requires_reboot INTEGER NOT NULL DEFAULT 0,
  reboot INTEGER,                  -- what apply asked for
  status TEXT NOT NULL CHECK (status IN ('planned', 'awaiting_approval', 'approved', 'applied',
    'rolled_back', 'failed', 'reverted', 'revert_failed')),
  approval_id TEXT REFERENCES approval(id),
  change_id TEXT,                  -- the changeId (ADR-096 D2) of the last authorization signed for
                                   -- it: a fresh one per attempt, never reused
  watchdog_state TEXT CHECK (watchdog_state IS NULL
    OR watchdog_state IN ('pending', 'ok', 'reverted', 'revert_failed', 'missed')),
  watchdog_deadline TEXT,
  watchdog_reason TEXT,              -- novad's reason for a revert: deadline | not_restarted
  error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT,
  CHECK (status NOT IN ('applied', 'rolled_back', 'reverted', 'revert_failed')
    OR approval_id IS NOT NULL)
);
CREATE INDEX idx_firmware_change_device ON firmware_change(device_id, created_at);
CREATE UNIQUE INDEX idx_firmware_change_authz ON firmware_change(change_id)
  WHERE change_id IS NOT NULL;

CREATE TABLE boot_profile (         -- 0041: a named bootloader entry of a device (FR-143); kernel
  id TEXT PRIMARY KEY,             -- arguments are not part of a profile in M7.5
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  name TEXT NOT NULL,
  entry_id TEXT NOT NULL,          -- the entry as /agent/v1/boot/status lists it
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT                  -- a deleted profile keeps its row for the attempts naming it
);
CREATE UNIQUE INDEX idx_boot_profile_name ON boot_profile(device_id, name)
  WHERE deleted_at IS NULL;

CREATE TABLE boot_request (         -- 0041: a try, commit or revert the owner asked for; sent to
  id TEXT PRIMARY KEY,             -- the device once, with a Hub-signed authorization (D2)
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  kind TEXT NOT NULL CHECK (kind IN ('try', 'commit', 'revert')),
  profile_id TEXT REFERENCES boot_profile(id),
  attempt_id TEXT,                 -- the attempt a commit makes the default, or a sent try started
  entry_id TEXT,
  body_json TEXT NOT NULL,         -- the device body without its authorization, canonical JSON:
                                   -- its SHA-256 is the card's args_hash and the authorization's
                                   -- bodySha256
  before_json TEXT NOT NULL DEFAULT '{}', -- {booted, default, pending} when the owner asked
  approval_id TEXT REFERENCES approval(id),
  change_id TEXT NOT NULL UNIQUE,  -- the authorization's changeId; never reused
  status TEXT NOT NULL
    CHECK (status IN ('awaiting_approval', 'denied', 'expired', 'sent', 'failed')),
  error_code TEXT, error_reason TEXT, error_message TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, sent_at TEXT
);
CREATE INDEX idx_boot_request_device ON boot_request(device_id, created_at);
CREATE INDEX idx_boot_request_approval ON boot_request(approval_id);

CREATE TABLE boot_attempt (         -- 0041: a one-shot trial of a profile
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  profile_id TEXT NOT NULL REFERENCES boot_profile(id),
  request_id TEXT NOT NULL REFERENCES boot_request(id),
  entry_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'reverted', 'failed')),
  reboot INTEGER NOT NULL, watchdog_seconds INTEGER NOT NULL,
  deadline TEXT NOT NULL,          -- when the device gives up on the entry, by the Hub's clock
  reason TEXT, detail TEXT,
  verified INTEGER,                -- the device's boot.watchdog.ok: 1 it saw the trial entry
                                   -- booted, 0 it could not tell (GRUB reports no booted entry),
                                   -- NULL no report yet
  committed_at TEXT,
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX idx_boot_attempt_pending ON boot_attempt(device_id)
  WHERE status = 'pending';        -- at most one pending trial per device
CREATE INDEX idx_boot_attempt_device ON boot_attempt(device_id, created_at);

CREATE TABLE pxe_token (            -- 0041: a device's PXE boot token (nvb_…); the public iPXE
  id TEXT PRIMARY KEY,             -- routes authenticate by it
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  token_hash TEXT NOT NULL UNIQUE, -- hex SHA-256 of `nova-pxe-token\0<token>`; the token itself
                                   -- is shown once
  created_at TEXT NOT NULL, revoked_at TEXT,
  last_used_at TEXT                -- set by every menu and image fetch
);
CREATE UNIQUE INDEX idx_pxe_token_active ON pxe_token(device_id) WHERE revoked_at IS NULL;

CREATE TABLE oob_endpoint (         -- 0042: a BMC the owner registered (FR-147); the registry is
  id TEXT PRIMARY KEY,             -- the allowlist: the Hub contacts no other address
  account_id TEXT NOT NULL REFERENCES account(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('redfish', 'ipmi', 'amt')), -- amt is refused at create
                                   -- (capability_missing {reason: not_built})
  address TEXT NOT NULL,           -- a host name or IP literal: no URL, no credentials
  port INTEGER,                    -- NULL: the protocol's default
  system_id TEXT,                  -- Redfish: the ComputerSystem, when the service lists several
  credential_ref TEXT NOT NULL,    -- secret://oob/<id>
  device_id TEXT REFERENCES device(id) ON DELETE SET NULL, -- the device this BMC belongs to: a
                                   -- failed-boot alert offers its power cycle
  tls_pin TEXT,                    -- SHA-256 of the BMC certificate's DER (lower-case hex), read on
  tls_pinned_at TEXT,              -- first use or entered by the owner
  tls_pin_confirmed_at TEXT,       -- when the owner confirmed the pin (an entered pin counts as
                                   -- confirmed); credentials go to a Redfish BMC only after it
  last_check_at TEXT, last_check_ok INTEGER, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_oob_endpoint_account ON oob_endpoint(account_id, created_at);
CREATE INDEX idx_oob_endpoint_device ON oob_endpoint(device_id);

CREATE TABLE oob_action (           -- 0042: every action asked of a BMC; rows outlive their
  id TEXT PRIMARY KEY,             -- endpoint
  account_id TEXT NOT NULL REFERENCES account(id),
  endpoint_id TEXT REFERENCES oob_endpoint(id) ON DELETE SET NULL,
  endpoint_name TEXT NOT NULL,     -- what the endpoint was called
  action TEXT NOT NULL,            -- check|power.status|power.on|power.off|power.cycle|power.reset|
                                   -- sensors|bios.read|bios.plan|bios.apply|boot.next
  params_json TEXT NOT NULL DEFAULT '{}',
  params_hash TEXT NOT NULL,       -- the card's args_hash: the endpoint id, action and parameters,
                                   -- and the BMC as it was (kind, address, port, system, pin, pin
                                   -- confirmation)
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'approved', 'running', 'done',
    'failed', 'denied', 'expired', 'applied')),
  approval_id TEXT,                -- plain TEXT
  plan_id TEXT,                    -- bios.apply: the bios.plan action it applies
  before_json TEXT, after_json TEXT,
  result_json TEXT,                -- a bios.plan row holds its plan (snapshot and diff) here
  error_code TEXT, error_reason TEXT, error_message TEXT,
  created_at TEXT NOT NULL, expires_at TEXT, decided_at TEXT, finished_at TEXT
);
CREATE INDEX idx_oob_action_endpoint ON oob_action(endpoint_id, created_at);
CREATE INDEX idx_oob_action_account ON oob_action(account_id, created_at);
CREATE INDEX idx_oob_action_approval ON oob_action(approval_id);

CREATE TABLE device_decommission (  -- 0044: one decommission of a novad device (ADR-096 D9)
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id),
  device_id TEXT NOT NULL REFERENCES device(id),
  purge INTEGER NOT NULL DEFAULT 0, -- also delete the device's Nova data (novad uninstall --purge)
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'running', 'done', 'denied',
    'expired', 'cancelled', 'failed')), -- cancelled: withdrawn (card cancelled, device revoked)
  approval_id TEXT REFERENCES approval(id),
  change_id TEXT,                  -- the authorization's changeId (D2), once one was issued
  device_result TEXT CHECK (device_result IS NULL
    OR device_result IN ('wiped', 'unreachable', 'refused', 'not_told')),
  detail TEXT,
  created_at TEXT NOT NULL, decided_at TEXT, finished_at TEXT
);
CREATE INDEX idx_device_decommission_device ON device_decommission(device_id, created_at);
CREATE INDEX idx_device_decommission_approval ON device_decommission(approval_id);
CREATE UNIQUE INDEX idx_device_decommission_open ON device_decommission(device_id)
  WHERE status IN ('awaiting_approval', 'running'); -- at most one open per device

CREATE TABLE node_policy (          -- 0044: the owner's policy for a compute node (FR-126, FR-150);
  device_id TEXT PRIMARY KEY REFERENCES device(id), -- one row per node, made on first change
  quiet_hours TEXT NOT NULL DEFAULT '[]', -- JSON list of HH:MM-HH:MM ranges
  time_zone TEXT,                  -- IANA zone; NULL: the node's declared locale.timezone, else UTC
  routing_eligible INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0, -- bumped on every change
  updated_at TEXT NOT NULL
);
```

**Firmware.** A plan is a dry run on the device; the Hub records it as one `firmware_change` row
(`kind` apply, `planned`) with its snapshot copy, in one transaction. This replaces the
one-setting design that stood in §7: `setting` names every key the plan sets and `old_value` and
`new_value` hold maps. Requesting approval files a card valid 24 hours (`awaiting_approval`); the
owner's own Allow once makes it `approved`, anything else puts it back to `planned`. Applying ends
`applied`, or `failed` when the device refused for good (`base_mismatch`, `apply_failed`). A
rollback is its own change (`kind` rollback, `rollback_of`) with its own approval, run through
the same apply route; applying it marks the change it undoes `rolled_back` (allowed from `applied`
and `revert_failed`). With a reboot, `watchdog_state` is `pending` until the device's heartbeat
reports: `ok`; `reverted` (the status becomes `reverted` too); `revert_failed` (the device's
restore failed or was partial: the status becomes `revert_failed`, the change stays in place and
can still be rolled back); or the Hub sets `missed` when nothing came by `watchdog_deadline` plus
120 s. A watchdog event is matched by `change_id`, and by the snapshot only when it carries none.

**What is sealed or kept outside the database.** The snapshot values the Hub keeps live in
`<dataDir>/firmware/snapshots/<id>.json`, sealed with the data key when encryption at rest is on
and bound to the snapshot id (§3); the row keeps only the keys and the hash. A rollback uses the
device's own copy, or the Hub's when the device lost it (the hash is checked). `novad` keeps the
last 20 snapshots in its own data folder (`firmware/snapshots/`, 0600) and its pending markers
(`firmware/pending.json`, `boot/pending.json`) there too. Boot images are files the owner puts in
`<dataDir>/boot-images/`; the Hub only reads them (plain files directly in that folder, no links
or subfolders) and keeps no row for them. Kept only in Hub memory: a device's firmware read (60 s),
the result of the last management call per device (for diagnostics) and, from 0043, the extension
bridge's connection state and tab consents (§2). The heartbeat answer's `policy` (`firmwareChanges`,
`lowLevelBoot`) is computed from the settings each time, not stored.

**Boot.** A try or commit files a card valid 30 minutes and is sent once, when the owner allows
it; before signing, the Hub checks the card is decided, allowed and its `args_hash` equals the
SHA-256 of `body_json`. A revert works with `devices.boot.allowLowLevel` off: its approval is the
owner's own request and it is sent at once. One request may wait for approval and one trial be
pending per device. A request a restart caught between approval and the device's answer becomes
`failed` (`interrupted`). An attempt ends `ok` or `reverted` from the device's report; one still
pending 120 s after its deadline is `failed` (`no_heartbeat` when the device has not been heard
from since the deadline, else `no_watchdog_report`), and a later report corrects it. An `ok`
without `verified` (an older `novad`) counts as verified; making an unverified trial the default
needs `confirmUnverified`. A new boot token revokes the previous one.

**Out-of-band.** A Redfish endpoint's first `check` reads the certificate fingerprint with a TLS
handshake only; every other action is refused (`pin_unconfirmed`) until the owner confirms it.
Clearing the pin or changing the address clears the confirmation. Changing an endpoint (and
deleting it, which also deletes its vault entry) withdraws its waiting cards and approved plans.
The read actions (`check`, `power.status`, `sensors`, `bios.read`) end `done` or `failed` at once.
Power actions, `boot.next` and `bios.plan` file a card valid 10 minutes; only the owner's own Allow
once counts, else they end `denied` or `expired`. An allowed power or boot action runs (`running`,
then `done` or `failed`). An allowed `bios.plan` becomes `approved` and may be applied for the next
10 minutes: its card covers the `bios.apply` that uses it once (`applied`), and a failure after
the BMC was sent the change makes the plan `failed` (`apply_outcome_unknown`). Actions a restart
interrupted become `failed` (`interrupted`) and never run again.

**Decommission and compute nodes.** A decommission files a card valid 1 hour and runs once, on the
owner's own Allow once: a reachable device is told with a Hub-signed `device.decommission`
authorization (`change_id`), then revoked whatever it answered; an offline device is revoked at
once (`unreachable`) and wipes its credentials at its next contact; `not_told` when the Hub
identity could not sign. After a restart a `running` row ends `done` (the device is revoked) and a
card approved meanwhile runs. The CHECK allows `cancelled`, which M7.5 never writes. The node
policy goes out in every heartbeat answer: the node takes no new jobs in its quiet hours and
routing skips it while quiet or not eligible. A `novad` device's policy stays in
`device_management.policy`.

**Management channel (D1).** Mutual TLS on the Hub-to-`novad` channel adds no table. A device's
`https://` management endpoint is its `transport_endpoint` row (`net = 'lan'`); a heartbeat never
moves it back to plain HTTP. A renewed device certificate is a new `trust_certificate` row (kind
`device`); once the device presents it, the older ones are revoked with `revoked_reason =
'renewed'`.

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
