# Roadmap

v1 is complete and live-verified (2026-07-13): streamed chat, agent index +
dispatch, runtime agent/tool/skill creation, file-backed memory, brain graph.
See README for what works. This file is the ordered backlog.

## Shipped

- **Knowledge ingestion agent** (2026-07-13) — `fetch_url` builtin
  (GET-only, 20s/200KB caps, per-redirect-hop SSRF guard in
  `backend/app/tools/web_fetch.py`) + seeded `ingestion` agent that distills
  URLs into tagged, provenance-stamped topic files. Live-verified: Wikipedia
  article ingested through an http→https redirect; localhost / link-local /
  RFC1918 / docker-internal targets all refused; later questions answered
  from memory without refetching.

- **Memory freshness** (2026-07-13) — memory is a cache with provenance, not
  a terminal archive. Retrieval headers now show `(learned <date>, source:
  <url>)`; main's policy: memory-first for stable facts, refresh-then-answer
  for volatile/aged knowledge, "as of <date>" attribution otherwise; ingestion
  updates topics **in place** via `write_memory(item_id=...)` (prompt-only
  title matching failed live — the id pin is mechanical). Verified: backdated
  topic + "right now" question → re-fetch + in-place update (timestamp bumped,
  no duplicate); stable-fact question → zero fetches.

- **Source discovery** (2026-07-13) — Nova finds new sources, not just
  re-fetches known ones. Bundled **SearXNG** metasearch service (keyless,
  self-hosted, JSON) is the primary `web_search` provider with keyless DDG
  HTML as automatic fallback (`backend/app/tools/web_search.py`); no keyed
  providers by design (product principles: batteries-included, privacy-first,
  local-model users primary). Ingestion agent now has three modes:
  INGEST / REFRESH (item_id in-place) / RESEARCH (search → fetch up to 3
  candidates → store durable knowledge, report ephemeral). Verified: zoo-hours
  question discovered + fetched parks.ny.gov, answered with current hours;
  cold-subject research created a tagged topic; provider fallback fires when
  searxng is stopped; stable facts stay memory-only.

- **Brain graph = metadata index with pointers** (2026-07-13) — graph nodes
  carry frontmatter only (description, tags, source_url, learned date; bodies
  never ship); clicking a node fetches full content on demand
  (`GET /api/v1/memory/item/{id}`) into a detail panel with a "View source"
  external link. Path-traversal guard added to `store.read_file` (item ids are
  LLM/user-supplied).

- **Per-agent DB-tool granting** (2026-07-13) — `allowed_tools` now governs
  DB-created tools like builtins (named grants or `db:*` wildcard; `main` holds
  `db:*` so created tools stay reachable at the front door). Plus
  execution-layer enforcement: `execute_tool` refuses names not offered to the
  calling agent, so a hallucinated tool name is refused, not executed.

## Next up

1. **Second brain theme** — exercise the `THEMES` seam for real (orbit/galaxy
   style renderer), add a theme picker in the HUD, persist choice in
   localStorage.

2. **Conversation compaction** — history is the most recent 50 messages; long
   sessions silently lose older turns. Periodically distill older history into
   a topic/journal memory (the retrieval path then recalls it).

## Later

- **Scheduled staleness sweep** — background loop that periodically re-ingests
  topics whose `source_url` + age exceed a threshold. Nova's first autonomous
  background behavior; needs its own design (scheduler, budget, failure
  policy). The on-demand refresh path is its foundation.
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
