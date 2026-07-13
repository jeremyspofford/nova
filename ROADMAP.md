# Roadmap

v1 is complete and live-verified (2026-07-13): streamed chat, agent index +
dispatch, runtime agent/tool/skill creation, file-backed memory, brain graph.
See README for what works. This file is the ordered backlog.

## Next up

1. **Knowledge ingestion agent** — the proof case for "read from any source."
   Add a `fetch_url` builtin (GET-only, response-size + timeout caps, hard
   SSRF guard: refuse RFC1918/loopback/link-local targets regardless of the
   tool allowlist), then seed or agent-create an `ingestion` agent granted
   `fetch_url` + `write_memory`. Demo: "ingest this article into memory" →
   new topic file appears in the brain.

2. **Per-agent granting of DB tools** — today every enabled `tools` row is
   visible to all agents. Honor `allowed_tools` for DB tools the same way as
   builtins (an agent sees a DB tool only if named, or via a `db:*` grant).

3. **Second brain theme** — exercise the `THEMES` seam for real (orbit/galaxy
   style renderer), add a theme picker in the HUD, persist choice in
   localStorage.

4. **Node detail on click** — clicking a brain node opens the memory item
   (`read_memory_item` already exists server-side; needs a
   `GET /api/v1/memory/item?id=` endpoint + a side panel).

5. **Conversation compaction** — history is the most recent 50 messages; long
   sessions silently lose older turns. Periodically distill older history into
   a topic/journal memory (the retrieval path then recalls it).

## Later

- **Rules/guardrail layer** — pre-execution checks on tool calls (regex or
  allowlist-based blocks), the v1 exclusion that matters most once agents
  multiply.
- **Auth** — required before exposing beyond localhost. Single admin token is
  enough for a first pass.
- **Agent management UI** — list/disable/edit agents visually instead of via
  chat or curl.
- **Ollama live validation** — the fallback path is code-complete but Ollama
  isn't installed on this machine; verify tool-calling quality with a local
  model before relying on it.
- **Journal polish** — pre-rewrite journal files lack a `title:` frontmatter
  key, so the brain labels them by path. Cosmetic; fix by backfilling titles.

## Operational notes

- `docker compose restart backend` does **not** re-read `.env` — use
  `docker compose up -d backend` after env changes.
- Migrations auto-run at backend startup from `backend/app/migrations/*.sql`
  (tracked in `schema_migrations`).
- Memory files live in `./data/memory/` (gitignored) — human-readable, safe to
  edit by hand; the index rescans on startup and reindexes on write.
