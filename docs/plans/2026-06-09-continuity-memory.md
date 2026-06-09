# Continuity Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memories become structured, salience-ranked, and continuously injected, so every Nova conversation behaves like one ongoing relationship ("the Paul model").

**Architecture:** memory-service gains extraction (LLM distills chat exchanges into self-contained memories on a Redis queue), salience ranking (similarity + recency + importance + reinforcement), and a profile endpoint. agent-core wires them into every chat turn (profile block, kind-annotated recall, mark-used reinforcement) and gains the missing `/api/v1/memories/*` proxy that the dashboard already calls (404 on main today). Dashboard Memory page surfaces the new fields.

**Tech Stack:** FastAPI + asyncpg + pgvector, Redis queues, llm-gateway `/complete` for extraction, React/TanStack Query, pytest integration tests against the live compose stack.

**Spec:** `docs/specs/2026-06-09-continuity-memory-design.md`
**Baseline (2026-06-09):** `make test-v2` → 79 passed, 1 skipped, 4 failed (all pre-existing ReadTimeout from CPU-only Ollama). Bar: the 79 still pass.

---

### Task 1: Schema — kind + importance columns

**Files:**
- Create: `agent-core/app/migrations/012_memory_salience.sql`
- Modify: `memory-service/app/store.py` (`write_memory`, `get_memory` field lists)
- Modify: `memory-service/app/router.py` (`MemoryWriteRequest`)
- Test: `tests/test_memory.py`

- [ ] Write failing test `test_write_kind_importance_roundtrip`: POST `/memories` with `kind="preference"`, `importance=0.9` → GET returns both; POST without them → defaults `fact`/`0.5`.
- [ ] Run: `cd tests && uv run --with pytest --with httpx pytest test_memory.py -k roundtrip -v` → FAIL (fields absent).
- [ ] Migration 012: `ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact'; ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5; CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);`
- [ ] Apply to running DB (worktree services not rebuilt yet): `docker compose -p nova exec -T postgres psql -U postgres -d nova -f -` < the migration file (or paste SQL). The file still ships so fresh installs get it at agent-core startup.
- [ ] `store.write_memory(pool, content, source_kind, source_uri, kind="fact", importance=0.5, tags=None, embedding=None)` — extend INSERT (embedding/tags used by Task 4's direct-store path); add `kind, importance` to `get_memory`/search SELECT lists. Clamp importance to [0,1] in router (pydantic `ge=0 le=1`).
- [ ] `MemoryWriteRequest` += `kind: str = "fact"`, `importance: float = Field(0.5, ge=0, le=1)`.
- [ ] Restart memory-service from worktree code: `docker compose -p nova up -d --build memory-service` (first copy `.env` from main checkout into worktree root).
- [ ] Test passes → commit `feat(memory): kind + importance columns`.

### Task 2: Salience ranking

**Files:**
- Modify: `memory-service/app/store.py` (`_semantic_search`, `_keyword_search`)
- Test: `tests/test_memory.py`

- [ ] Failing tests:
  - `test_salience_reinforcement_ranks_used_first`: two near-identical-content rows, PATCH `/used` ×5 on one → it ranks first for that query; response rows include `salience`, `kind`, `importance`.
  - `test_salience_devalue_not_bury`: write `A` (unique topic), age it via direct SQL (`asyncpg` connect to `localhost:5432`, password parsed from repo `.env`, fallback `changeme`): `UPDATE memories SET created_at = now() - interval '120 days' WHERE id=$1`; write fresh `B` on a different topic. Query for A's topic → A still first (similarity dominates); both A and B searchable.
  - `test_salience_importance_orders_equal_sim`: same content, importance 0.9 vs 0.1 → 0.9 first.
- [ ] Run → FAIL (no `salience` key).
- [ ] Implement two-stage SQL (spec formula): inner top-50 by `embedding <=> $1` with raw-cosine `min_similarity` filter, outer `0.60*similarity + 0.15*exp(-ln(2)*age_days/30.0) + 0.15*importance + 0.10*LEAST(ln(1+used_count)/ln(101),1) AS salience`, `age_days` from `COALESCE(last_used, created_at)`. Keyword path: `ts_rank/(ts_rank+1)` as similarity, same blend.
- [ ] Tests pass; existing search tests still pass → commit `feat(memory): salience-ranked retrieval`.

### Task 3: Profile endpoint

**Files:**
- Modify: `memory-service/app/store.py` (+`get_profile`), `memory-service/app/router.py`
- Test: `tests/test_memory.py`

- [ ] Failing test `test_profile_returns_facts_and_preferences`: high-importance preference appears; event-kind excluded; low-importance fact ranks below high-importance fact (covers ordering, not just filter).
- [ ] `GET /memories/profile?limit=12` — **registered above `GET /{memory_id}`** (route-shadow gotcha): `WHERE kind IN ('fact','preference') ORDER BY importance DESC, used_count DESC, last_used DESC NULLS LAST LIMIT $1`.
- [ ] Pass → commit `feat(memory): profile endpoint`.

### Task 4: Extraction pipeline

**Files:**
- Create: `memory-service/app/extraction.py` (prompt, JSON parse, dedup, fallback)
- Modify: `memory-service/app/worker.py` (second queue consumer), `router.py` (`extract` flag → 202), `config.py` (`extraction_model: str = "auto"`, `extraction_timeout_s: float = 90`)
- Test: `tests/test_memory.py`

- [ ] Failing tests:
  - `test_extract_lossless`: POST `extract=true` → 202 `{"queued": true}`; poll search (90 s budget) until ≥1 row whose content relates to the input → guaranteed by fallback even when LLM is down.
  - `test_extract_structured_kinds`: probe llm-gateway with a 5-token completion (20 s); `pytest.skip("local LLM unavailable/slow")` on failure; else assert extracted rows carry kind ∈ {fact, preference, event, insight} and content is NOT the raw `User:/Nova:` transcript.
- [ ] `extraction.py`: prompt (system: "Extract durable memories worth keeping about the user and their world… Output ONLY a JSON array, max 5 items, each {\"text\",\"kind\",\"importance\"}. kinds: fact|preference|event|insight. Empty array if nothing durable."; one few-shot example pair; input truncated 4000 chars; `temperature 0.1`, `max_tokens 500`). Parse with ```-fence stripping (same idiom as `worker._get_tags`); one retry; on failure → fallback single row (`kind='event'`, `importance=0.3`, original text).
  Per item: sync `embed.embed_text` → if vector, top-1 search > 0.93 sim → hit: UPDATE content/importance=GREATEST/used_count+1/last_used=now + rpush embed queue (vector refresh); miss: insert with embedding + tags-from-kind (skip embed queue). No vector (degraded): plain insert (embed queue does it later, dedup skipped).
- [ ] `worker.py`: extraction consumer mirroring `embed_worker` on `memory:extract:queue` (BLPOP, JSON payload `{content, source_kind, source_uri}`); start/stop in `main.py` lifespan alongside the embed worker.
- [ ] Rebuild memory-service; tests pass (structured test may skip on this box) → commit `feat(memory): LLM extraction pipeline with lossless fallback`.

### Task 5: agent-core wiring

**Files:**
- Create: `agent-core/app/memories_proxy_router.py` (`/api/v1/memories/{stats,search,profile,{id}/used,{id} GET/DELETE}` → memory-service; admin-auth like other routers; mounted in `main.py`)
- Modify: `agent-core/app/tasks_router.py` (`_search_memory` returns rows w/ ids; `_build_system_prompt` adds profile block + kind annotations + same-Nova line; `generate()` fire-and-forget `memory_client.mark_used` per injected id after stream completes; `_ingest_memory` → `{"extract": true}` and 201/202 both OK)
- Modify: `agent-core/app/tools/tools_builtin/memory.py` (memory.write gains optional kind/importance)
- Test: `tests/test_agent_core.py` (proxy endpoints), `tests/test_memory.py` (used_count increments via proxy path)

- [ ] Failing tests: `test_memories_proxy_stats/search/profile` (200 via agent-core with admin header; 401 without).
- [ ] Implement proxy (httpx passthrough, 10 s timeout, JSON in/out; no auth header added downstream — memory-service is unauthenticated inside the network).
- [ ] Profile block: module-level cache `{data, fetched_at}`, 60 s TTL; failure → no block. Injected as "## What Nova knows about the user"; recall block becomes "## Relevant memories for this message" with `- [kind] content` lines; add identity line: "You are the same Nova across all of the user's conversations and platforms — what you remember above is yours. Use it naturally."
- [ ] mark_used: after `final_text` persisted, `asyncio.create_task(...)` per injected memory id (ids captured from `_search_memory` results).
- [ ] Rebuild agent-core; tests pass → commit `feat(agent-core): profile injection, recall reinforcement, memories proxy`.

### Task 6: Dashboard Memory page

**Files:**
- Modify: `dashboard/src/pages/Memory.tsx`

- [ ] Profile strip at top (GET `/api/v1/memories/profile`): pill list of fact/preference contents.
- [ ] Memory cards: kind badge (color per kind), importance bar/percent, `used_count`× recalled, salience when present. Interface fields += `kind`, `importance`, `used_count`, `salience?`.
- [ ] Rebuild dashboard; verify in browser (Task 7 covers full Playwright pass) → commit `feat(dashboard): memory page shows kind/importance/recall + profile`.

### Task 7: Verification gate

- [ ] `make test-v2` from worktree → compare to baseline (79 must pass; pre-existing 4 may still fail).
- [ ] Playwright (against `http://localhost:3000`, services rebuilt from worktree):
  1. Settings sanity: admin secret already in localStorage (else set).
  2. Conversation A: "Remember this: my favorite color is teal, and I use WSL2 on a Dell." → response streams.
  3. Wait ≤90 s (extraction), confirm Memory page shows extracted memory rows with kind badges + profile strip.
  4. New conversation B: "What's my favorite color?" → answer contains "teal". Screenshot A, B, Memory page.
  5. If chat stalls on the 7B CPU model: switch active local model to `qwen2.5:1.5b` via Settings/LLM config API, note the change for Jeremy, retry.
- [ ] Commit any fixes; push branch; `gh pr create` against main with summary, test evidence, screenshots, env caveats (GPU, model switch if done).

### Rollback / safety

Migration is additive (two columns + index, both `IF NOT EXISTS`); no destructive data path; extraction failures always fall back to verbatim storage; all new network calls are try/except-warn. Reverting = revert the PR; columns are harmless if left.
