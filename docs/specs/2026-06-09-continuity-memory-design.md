# Continuity Memory — Design (v1 → v2 port, increment 1)

**Date:** 2026-06-09
**Status:** Approved for implementation (autonomous session; review surface = PR)
**Author:** Claude (directed by Jeremy)

## Why

Jeremy's brief, distilled:

> Nova should be like talking to your friend Paul. I don't open a new chat with him each
> time. It's all the same person on every platform. Always grows, never forgets, but
> devalues older irrelevant stuff. It must do things on its own — proactively, reactively,
> and via scheduling — and go out on the internet: search, navigate, email.

v0.1.0-alpha (the v1 stack, tagged 2026-05-09) had all of these ambitions and collapsed
under them. This document records what the review of both codebases found, what is worth
bringing forward, the increment order, and the full design for **increment 1: continuity
memory** — the foundation everything else stands on.

## Review findings

### What v1 (v0.1.0-alpha) had

| Feature | v1 implementation | Verdict |
|---|---|---|
| Proactive autonomy | `cortex/`: PERCEIVE→EVALUATE→PLAN→ACT→REFLECT cycle, 7 drives, Redis stimulus wake-up, journal, budget tiers, kill switches | **Port the concept, not the code.** Drives + goal hierarchy was over-built; the stimulus-or-timeout loop and budget/kill-switch discipline are good ideas. |
| Cross-platform identity | `chat-bridge/`: Telegram adapter, linked-accounts resolve/auto-link, one conversation stream per user | **Port later, simplified.** v2 is single-tenant; no account linking needed. Adapter-over-one-stream is the right shape. |
| Memory | `memory-service/` engrams: activation decay, importance, Hebbian edges, consolidation, neural router, working memory | **Port the *properties*, not the architecture.** Decay/importance/reinforcement are exactly "devalues older irrelevant stuff." The graph, spreading activation, and neural router were untested complexity that v2 explicitly rejected. |
| Brain visualization | `Brain.tsx` + Three.js force graph, bloom effects | **Defer.** Loved, but had perf issues, and visualizing today's context-free chunks would disappoint. Build it after memories are worth looking at. |
| Web intake | `intel-worker/` (RSS/Reddit/GitHub pollers), `knowledge-worker/` (crawler, robots.txt, relevance) | **Port as tools/schedules, not services.** v2's scheduler + tools can express "poll feeds" without two dedicated containers. |
| Email | — none in v1 either | Net-new capability. |

### What v2 main already has (and must not be disturbed)

- Clean ReAct agent loop (`agent-core/app/loop/main.py`) with tiered tool registry,
  capability scoping, audit trail, approvals, sandboxed shell/code.
- Tools: `web.fetch`/`web.search` (weak — raw HTML, DDG instant answers), `fs.*`,
  `shell.exec`, `code.execute`, `memory.search`/`memory.write`, secrets, schedules,
  subagent, plus **Playwright MCP (`browser_*`) already seeded** (migration 010).
- Scheduler with six trigger types: `cron`, `once`, `interval`, `webhook`, `fs_watch`,
  `task_complete`. This is the "via scheduling" leg, already working.
- Chat already does naive memory RAG: top-5 cosine search injected as
  "What Nova remembers", fire-and-forget ingest of each exchange.
- Memory service: flat `memories` table, pgvector + tsvector fallback, embed worker on a
  Redis queue, `used_count`/`last_used` columns **that exist but are never used in
  ranking** — `PATCH /memories/{id}/used` has no caller in the chat path.

### The gaps, in Jeremy's terms

1. **"Same friend every time"** — conversations are siloed tasks. Memory ingest partially
   bridges them, but what gets stored is raw `"User: …\nNova: …"` transcript chunks — the
   same context-free-chunk failure v1's brain had.
2. **"Never forgets but devalues"** — ranking is pure cosine similarity. A throwaway
   remark from March outranks yesterday's correction if it embeds 2% closer.
3. **"Does things on its own"** — reactive (chat) and scheduled (cron) exist; *proactive*
   (self-initiated) does not.
4. **"Out on the internet"** — `web.search` via DuckDuckGo instant answers returns empty
   for most real queries; `web.fetch` dumps raw HTML tag soup into the context window.
   `browser_*` exists but is heavyweight for simple reads. No email at all.

## Increment plan (one PR each, in order)

1. **Continuity memory** (this PR) — extraction instead of transcript dumps; salience
   ranking (similarity + recency decay + reinforcement + importance); user-profile block
   injected into every conversation; recall reinforcement loop.
2. **Proactivity** — a lightweight autonomy pulse inside agent-core (not a new service):
   periodic self-review schedule (`created_by='nova'`), an LLM "anything worth doing?"
   gate with a hard budget cap and kill switch, plus a Nova-initiated message surface in
   the dashboard (proactive inbox). Builds directly on the scheduler.
3. **Web that works** — `web.search` backed by a real engine (SearXNG sidecar or Brave
   API key via secrets), `web.fetch` through readability extraction (trafilatura) so
   pages arrive as clean text; RSS digest as a scheduled prompt template.
4. **Email** — IMAP read + SMTP send tools, credentials in the secrets vault, send gated
   behind the existing approvals flow (WRITE-tier tool).
5. **Memory graph view** — 2D force graph (no Three.js bloom) over memories, edges from
   shared tags/entities, lazy-loaded pane in the Memory page. The payoff for increment 1.
6. **Channels** — Telegram (then others) as thin adapters on chat-surface, all feeding
   the same memory + profile. The "phone call vs message vs Facebook post" property.

Increment 1 goes first because every other increment consumes it: proactivity needs to
know what matters to you; web/email actions need user context; the graph needs memories
with structure. And it is the emotional core of the brief.

## Increment 1 design

### Approaches considered

- **A. Scoring-only upgrade.** Keep transcript-chunk ingestion, add recency/usage weights
  to search. Cheapest, but leaves memories context-free — rejected as it preserves v1's
  core failure.
- **B. Extraction + salience + profile (chosen).** Distill exchanges into self-contained
  structured memories in the background; rank by salience; inject a stable profile block
  everywhere. Moderate scope, hits all three gaps.
- **C. Engram-light graph.** B plus typed edges and co-activation. Rebuilds v1's
  over-engineering before the simple version has proven insufficient; Jeremy explicitly
  confirmed flat-memory v2 (2026-05-19). Rejected; edges can come with increment 5 from
  tag co-occurrence without schema changes now.

### Data model (migration `012_memory_salience.sql`, agent-core migrations)

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5;
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
```

`kind ∈ {fact, preference, event, insight}` (CHECK constraint omitted on purpose —
fault-tolerant convention; unknown kinds degrade to display-only). `importance ∈ [0,1]`.
No new tables. No edges. Deletion still never happens automatically — "never forgets."

### Extraction (memory-service)

- `POST /memories` gains `extract: bool = false`. With `extract=true` the service queues
  `{content, source_kind, source_uri}` on Redis `memory:extract:queue` and returns
  `202 {"queued": true}` instead of writing a row.
- The existing worker loop gains a second queue consumer. Extraction calls llm-gateway
  `/complete` (model from `EXTRACTION_MODEL` setting, default `"auto"`; `temperature 0.1`,
  strict-JSON prompt, one few-shot example, input capped at 4000 chars) and expects
  `[{"text": …, "kind": …, "importance": …}]`, max 5 items.
- Each extracted item is dedup-checked first: embed the candidate text (synchronous,
  ~0.5 s), search top-1 at similarity > 0.93. On a hit, update that row (newest text
  wins, `importance = GREATEST(old, new)`, `used_count + 1`, `last_used = now()`) and
  re-push it onto `memory:embed:queue` so the vector tracks the new text. On a miss,
  insert storing the already-computed embedding directly — no second trip through the
  embed queue. Growth without bloat, nothing embedded twice.
- **Failure fallback (no data loss):** if the LLM call fails, times out, or returns
  unparseable JSON after one retry, store the original content verbatim as a single
  memory (`kind='event'`, `importance=0.3`). The transcript layer (`task_messages`)
  remains the verbatim log regardless.
- Designed for small local models: the dev box currently runs CPU-only inference
  (Ollama reports `size_vram: 0`), so the JSON schema is minimal and the prompt is
  few-shot — it must work on a 1.5–3 B model.

### Salience ranking (memory-service search)

Two-stage retrieval so pgvector's index still does the heavy lifting:

```
stage 1: top-50 by embedding distance (index scan), apply min_similarity to raw cosine
stage 2: salience = 0.60·similarity + 0.15·recency + 0.15·importance + 0.10·reinforcement
         recency       = exp(-ln(2) · age_days / 30), age from COALESCE(last_used, created_at)
         reinforcement = ln(1 + used_count) / ln(101), capped at 1
order by salience, return top-k with salience/kind/importance in the payload
```

Weights are deliberately additive (predictable, testable) with similarity dominant: an
old, never-recalled memory with high similarity still wins over a fresh weak match —
"devalued" never means "buried." Recalling a memory refreshes `last_used`, so relevant
old memories stay warm: Hebbian behavior without a graph. Keyword-fallback path gets the
same blend with `ts_rank/(ts_rank+1)` standing in for similarity.

### Profile ("what Nova knows about you")

- `GET /memories/profile?limit=12`: `kind IN ('fact','preference')` ordered by
  `importance DESC, used_count DESC, last_used DESC NULLS LAST`. Must be registered
  **before** `GET /{memory_id}` or FastAPI parses "profile" as a memory id.
- agent-core injects it into **every** chat system prompt as a stable
  "What Nova knows about the user" block (60 s in-process cache), above the existing
  query-relevant memories block, which now annotates each line with its kind.
- One added system-prompt line makes the contract explicit to the model: it is the same
  Nova across all conversations and should use remembered context naturally.

### Reinforcement loop (agent-core)

After a chat response streams to completion, fire-and-forget `PATCH /memories/{id}/used`
for every memory that was injected into that turn's prompt. This is what makes
`used_count`/`last_used` real signals instead of dead columns.

### Dashboard (Memory page)

Kind badge, importance, and recall count on each memory card; profile block surfaced at
the top. Modest scope — the graph view is increment 5.

### Error handling

Service conventions hold throughout: every new network call is try/except +
`logger.warning`; extraction failures fall back to verbatim storage; profile fetch
failure degrades to no-profile-block; mark-used failures are silent. Chat must never
break because memory is sick.

### Testing (real services, no mocks)

`tests/test_memory.py` additions, run via `make test-v2`:

1. kind/importance round-trip through POST → GET.
2. Salience ordering: two same-topic memories, one reinforced via `PATCH /used` →
   reinforced one ranks first; both still beat an unrelated memory.
3. Devalue-not-bury: high-similarity old/unused memory still outranks low-similarity
   fresh one (age manipulated directly in postgres from the test).
4. Profile endpoint: high-importance preference appears; low-importance event is
   excluded (kind filter); and a low-importance fact ranks below a high-importance one
   (importance ordering, not just kind filtering).
5. Extraction, lossless guarantee: `extract=true` → poll until ≥1 memory exists for the
   content (extracted or fallback — either proves no data loss).
6. Extraction, quality: structured kinds appear — auto-skipped with an explicit reason
   when a 20 s LLM probe fails (CPU-only dev box), green when inference is healthy.

Browser verification (Playwright, mandatory): the Paul test. Tell Nova a fact in
conversation A; open a brand-new conversation B; ask for the fact; Nova answers from
memory. Screenshot evidence. Memory page shows extracted memories with kinds.

### Hardening found during browser verification (shipped in this increment)

Three defects surfaced live and were fixed before completion:

1. **Self-poisoning**: the model hallucinated "blue" for the user's favorite color;
   extraction stored it as a 0.95-importance preference that outranked the true
   "teal" on recency. Fix: extraction never stores the assistant's own claims —
   prompt rule plus a deterministic token-overlap attribution filter.
2. **Few-shot bleed**: small models bled the extraction example into storage
   ("User's favorite color is green", invented). Fix: example rewritten with no
   extractable false content; distinctive example fragments hard-dropped.
3. **Profile pollution**: pre-extraction transcript blobs (backfilled at
   importance 0.5 by the migration) qualified for the profile. Fix: profile
   requires `importance > 0.5` — distilled memories score above the default.

`EXTRACTION_MODEL` env var (default `auto`) pins extraction to a small fast model
on CPU-only boxes; set to `qwen2.5:1.5b` on the dev machine.

### Out of scope (this increment)

Task-loop memory ingestion (chat only for now), memory edges/graph, proactivity pulse,
web/email tools, channel adapters, multi-user anything.

## Known environment caveat (dev box, 2026-06-09)

Windows-host Ollama currently reports `size_vram: 0` — GPU not visible, CPU-only
inference. The configured default completion model (qwen2.5-coder:7b) takes >90 s per
response; qwen2.5:1.5b responds in ~3 s; embeddings are fast (~0.5 s). Four pre-existing
`make test-v2` failures (all ReadTimeout) trace to this. Baseline recorded 2026-06-09:
**79 passed, 1 skipped, 4 failed** — the bar for this PR is "those 79 still pass."
