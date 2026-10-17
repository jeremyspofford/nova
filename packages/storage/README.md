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
endpoints, enrollment requests). Drizzle tables live one file per domain in `src/schema/`. Search is an external-content FTS5 table over
`message_search`, an INTEGER-keyed copy of non-empty text parts kept in step by triggers, so FTS
rowids stay stable across `VACUUM` (a TEXT-keyed table's rowids may be renumbered).
