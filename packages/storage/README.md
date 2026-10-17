# @nova/storage

The Hub's SQLite database (ADR-002, ADR-084): one connection on Node's built-in `node:sqlite`,
serialized transactions, forward-only migrations in `migrations/` with a backup before every
upgrade (`docs/06` §5), restore-from-backup as the rollback path, and a Drizzle schema that a test
keeps in agreement with the SQL.

Migrations: `0001_init` (accounts, settings, events, flags, tokens), `0002_chat` (projects,
provider accounts, model preferences, threads, turns, messages and parts, attachments, usage
events, and the chat search index), `0003_thread_flags` (side chats, memory opt-out),
`0004_conversation` (message tree, queued follow-ups, sources and chunks, citations, memory
items with their FTS index) and `0005_nodes` (devices, capability documents, transport
endpoints, enrollment requests).

M3: `0006_tools` (tool calls, artifacts and their versions), `0007_policy` (policy rules, command
rules, permission profiles, approvals, grants, tool defaults), `0008_mcp` (MCP servers, secrets
as `secret://` references only), `0009_ops` (the hash-chained audit log with triggers that refuse
UPDATE and DELETE, notifications) and `0010_consolidation` (consolidation runs, memory topics,
per-thread read marks).

M4 (ADR-091):

| Migration | Tables |
| --- | --- |
| `0011_plugins` | `plugin_install` (one per plugin and account; the manifest with secret values replaced by references, what it registered, its signature status and on/off switch; the plugin itself stays on disk), `skill_state` (only a skill's enabled switch and import provenance; skills stay on disk), `agent_role` (a plugin's sub-agent roles) |
| `0012_hooks` | `hook`: one row per hook found in a source, with its definition, base folder, limits, content hash and trust record (trusted hash, state, by whom, when) and its last run. A hook runs only while trusted with the current hash. The per-source unique index uses `COALESCE` because NULLs are distinct in a plain UNIQUE |
| `0013_apps` | `app_authorization` (clients of Nova's MCP server: scopes, token hash only, expiry, status; revoked rows kept for the audit trail), `mcp_oauth` (a remote server's authorization server, registration and token state; tokens are vault references; deleted with its server) |
| `0014_workspace` | `project_folder` (a folder bound to a project, canonical path, access, index status, file count, error; terminals have no table), `project_folder_file` (each indexed file linked to the file-backed source that holds its chunks) |
| `0015_profile` | a partial unique index on live usernames, `provider_active` (the active account per provider kind), an index on `turn.started_at` for usage, and `import_record` (the import ledger with import id, target and SHA-256 dedupe) |

Drizzle tables live one file per domain in `src/schema/`. Search is an external-content FTS5 table over
`message_search`, an INTEGER-keyed copy of non-empty text parts kept in step by triggers, so FTS
rowids stay stable across `VACUUM` (a TEXT-keyed table's rowids may be renumbered).
