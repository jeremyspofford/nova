# Memory Subsystem Hardening — Design Spec

**Date:** 2026-05-05
**Status:** IMPLEMENTED — closed 2026-05-06 in PR #4
**Branch:** `mem-001-hardening` (worktree at `.worktrees/mem-001-hardening`, off `origin/main`, matching the SEC-006a pattern)
**Builds on:** [`2026-05-05-nova-audit-findings.md`](./2026-05-05-nova-audit-findings.md) — Tier 1 priority
**Related (orthogonal):** [`docs/designs/2026-04-18-pluggable-memory-and-benchmarks.md`](../../designs/2026-04-18-pluggable-memory-and-benchmarks.md) (FC-011, DRAFT) — strategic question of whether engram earns its complexity. This spec is **scope-orthogonal**: we are hardening what exists, not committing to engram's long-term retention. If FC-011 later concludes engram should be replaced, the test contracts written here document the memory semantics the next backend must preserve.

---

## Problem

Three interlocking problems in `memory-service/app/engram/`:

1. **Two scaling-cliff queries.** Spreading activation's recursive CTE has unbounded fan-out (worst-case ~`O(seed × degree^max_hops)` × 2 directions, with an `OR`-join that defeats the existing single-column edge indexes). Consolidation's duplicate-merge phase does an `O(N²)` cartesian self-join over engram embeddings with no candidate prefilter. Both degrade smoothly until they cliff as the engram count grows past ~10k.

2. **The most algorithmically complex code in Nova has near-zero unit-test coverage.** `consolidation.py` (32k), `activation.py` (13k), `working_memory.py` (13k), `decomposition.py` (13k), `ingestion.py` (23k), `clustering.py` (23k), `entity_resolution.py` (7k), `reconstruction.py` (12k), `neural_router/` are exercised only by black-box log-shape assertions in `tests/test_consolidation.py`. Regressions to scoring formulas, traversal correctness, slot-eviction logic, contradiction resolution, or self-model updates cannot be detected by current tests.

3. **The test infrastructure that exists undermines the rule it claims to follow.** `memory-service/tests/conftest.py` exports `mock_redis` and `mock_session` fixtures (using `unittest.mock.AsyncMock`). `test_outcome_feedback_symmetry.py` documents this in a comment: *"Tests mock the SQLAlchemy session at the .execute() boundary."* This is exactly the kind of internal mocking that produces tests passing while real query plans break. The project's stated rule — "tests must use real services, not mocks" — is being read narrowly to mean only inter-service integration tests. The cliff queries cannot be tested at the `.execute()` mock boundary because the bug *is* in the query plan.

The three problems are entangled: you cannot fix the cliffs safely without unit tests; you cannot write meaningful unit tests at the current mock boundary; you cannot migrate the mocks without first deciding the real-DB fixture pattern.

---

## Goals

1. Eliminate the two production cliffs (P1 activation fan-out, P2 consolidation cartesian) with bounded query plans verified by contract tests.
2. Ship a real-Postgres-with-pgvector unit-test fixture pattern for `memory-service` and migrate every existing mock-based test to it. New tests use real DB by default.
3. Achieve unit-test coverage of the engram subsystem at the contract level: every public function in the listed modules has at least one test asserting its invariants, and every algorithmic property identified during the spec passes covered by a named test.
4. Address the medium-risk perf items in the same surface area: P3 (per-call connection construction in memory-service-related orchestrator config_sync paths affecting memory writes), P4 (schema-synthesis N+1), P6 (composite index for activation seeds), P9 (duplicate query embedding in working_memory).
5. Add a `tenant_id` filter to the activation recursive arm so spread cannot leak across tenants (closes a multi-tenancy isolation bug surfaced by the audit, even though the broader multi-tenancy roadmap item is out of scope).

## Non-Goals

- **FC-011 work.** No `MemoryBackend` interface, no markdown backend, no benchmark harness in this scope. We're hardening the existing engram backend; the strategic decision about whether to keep, simplify, replace, or hybridize engram remains open.
- **Algorithmic redesigns.** No structural rebuilds (precomputed neighborhood materialization, graph-projection rewrite, switch to a graph-native engine). Tactical fixes only — UNION-of-two-indexed-queries, candidate prefilters, batched lookups. Structural rebuilds belong in FC-011 follow-up if benchmarks justify them.
- **Full multi-tenancy isolation.** The activation tenant_id leak is fixed because it's in the same query as P1; the broader multi-tenant gap (roadmap §370–396 on goals/pipeline router read-side leakage) is tracked separately.
- **`runner.py` decomposition.** Mentioned in audit findings but no acute pain; out of scope.
- **Knowledge-worker, intel-worker, voice-service test gaps.** Different services, different scope.
- **Dashboard performance items** (P5 bundle splitting, P8 polling pile-up). Out of subsystem.
- **`asyncio.create_task` strong-ref hygiene.** Cross-cutting; tracked separately.

---

## Scope summary

| In | Out |
|---|---|
| P1 activation fan-out (CTE rewrite, fan-out cap, tenant filter in recursive arm) | FC-011: `MemoryBackend` interface, markdown backend, benchmark harness |
| P2 consolidation cartesian (candidate prefilter via HNSW shortlist) | Multi-tenancy isolation outside activation |
| P4 schema-synthesis N+1 (batch embedding fetch) | Algorithmic redesigns / structural rebuilds |
| P6 composite index for activation seed query | runner.py decomposition |
| P9 duplicate query embedding in working_memory | Knowledge / intel / voice / chat-bridge tests |
| P3 connection-reuse cleanup in memory-service config paths | Dashboard perf |
| Real-Postgres-with-pgvector unit-test fixture pattern (`conftest_db.py`) | Replacing existing pytest framework |
| Unit-test sweep: `consolidation`, `activation`, `working_memory`, `decomposition`, `ingestion`, `clustering`, `entity_resolution`, `reconstruction`, `neural_router/` | `outcome_feedback`, `embedding_cache`, `source_kind_mapping` (already covered) |
| Migration of existing mock-based tests to real-DB fixtures | Repo-root `tests/` integration suite (different layer) |

---

## Architecture decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| TDD posture | Contract tests for invariants we want to enforce; characterization tests where current behavior is correct-but-undocumented and must be preserved through the refactor | Contract tests prove specific properties (terminates, doesn't leak tenant, scoring formula yields X for input Y); characterization tests prevent silent behavior changes during the refactor. Per user memory: "tests protect against real regressions, not chase coverage." |
| Test fixture: DB | Real Postgres + pgvector via per-test transaction wrapped in `BEGIN…ROLLBACK`. New `memory-service/tests/conftest_db.py` provides `db_session` fixture; tests opt in via the fixture name. | pgvector queries are exactly the surface where mocks lie. SQLite pgvector shims drop fidelity (the cliffs are pgvector-specific). The `BEGIN/ROLLBACK` pattern gives full pgvector behavior with zero per-test setup cost. |
| Test fixture: Redis | Real Redis (db15 reserved for tests) with `FLUSHDB` per test. New `redis_test` fixture in `conftest_db.py`. | Same reasoning as DB; Redis behavior in caching/embedding-cache paths affects correctness. |
| Test fixture: LLM | A `fake_llm` fixture in `conftest_db.py` that returns canned responses keyed by prompt-hash, with a recording mode for capturing real responses to seed it | LLM calls in tests would be slow, expensive, and non-deterministic. We need a fake — but it's a *recorded* fake, not a hand-rolled mock. Recording mode produces files committed to `memory-service/tests/fixtures/llm/` for reproducibility. |
| Existing mock conftest | Move existing `mock_redis` and `mock_session` to `conftest_legacy.py`; new tests must not import them; existing tests are migrated module-by-module as the surrounding code is touched | Don't break the three existing tests immediately, but stop the bleeding. Migration follows the change footprint. |
| Database for tests | New DB `nova_test` on the same Postgres instance, created by a setup script; per-test transaction wrapping inside it; pgvector + pg_trgm extensions installed via the test setup | Isolates from the live `nova` DB without requiring a separate Postgres deploy. Setup script also runs `memory-service/app/db/schema.sql` so test DB matches prod schema. |
| Schema for activation fan-out (P1) | UNION of two single-direction indexed queries (`source_id = X` ∪ `target_id = X`), plus per-hop fan-out cap (LIMIT-per-spread-row), plus tenant_id filter in the recursive arm | The `OR` predicate is the root cause of index failure. UNION lets each branch use `idx_edges_source` / `idx_edges_target` directly. Fan-out cap bounds the row explosion deterministically. |
| Schema for consolidation cartesian (P2) | HNSW shortlist prefilter: for each engram, find top-K nearest neighbors via `idx_engrams_hnsw`, then refine pairs above threshold; replace the `e1 JOIN e2 ON e2.id > e1.id` cartesian | HNSW gives sublinear nearest-neighbor; we trade exact recall for tractable scaling. Existing index is already there — this is mostly a query rewrite. |
| Composite index (P6) | Add `idx_engrams_seed_filter (tenant_id, source_type, activation) WHERE NOT superseded` to support both seed branches | Current single-column indexes force re-ranking after HNSW probe. Composite reduces re-rank cost. |
| Connection reuse (P3) | Module-level `httpx.AsyncClient` and `aioredis` clients created at service startup, closed in `lifespan`'s shutdown branch; no per-call construction | Standard FastAPI lifespan pattern. CLAUDE.md already names this as a Redis-cleanup convention. |
| Tenant isolation in activation | Add `AND neighbor.tenant_id = CAST(:tenant_id AS uuid)` in the recursive arm join | Currently spread can hop into another tenant's engrams. Filtering at the source side defeats half the point of multi-tenancy. |
| Branching | Fresh worktree at `.worktrees/mem-001-hardening` off `origin/main`; matches the SEC-006a pattern; brainstorm doc lives wherever (gitignored) | Avoids conflict with `flags-001-foundation` and lets implementation proceed in parallel with feature-flags work. |

---

## Findings being addressed

For each, I list: (1) the file/lines, (2) the fix shape, (3) the contracts that tests will assert.

### P1 — Spreading activation: unbounded fan-out + tenant leak

**Current state:** `memory-service/app/engram/activation.py:140–150`. The recursive arm joins `engram_edges` on `(source_id = spread.id OR target_id = spread.id)`. With `engram_max_hops = 3` (`memory-service/app/config.py:38`), seed = 10, average degree d, worst case is ~10·d³ rows examined per query, doubled for the bidirectional traversal. Postgres cannot use either single-column edge index for the `OR` predicate. `NOT (neighbor.id = ANY(spread.path))` is O(path_len) per row. No `tenant_id` filter inside the recursive arm — cross-tenant edges traverse freely.

**Deep-mode follow-up query** (`activation.py:244–261`) has the same `OR`-source/target pattern. **Conditional fix:** the deep-mode query is filtered to `relation IN ('instance_of','part_of')`, which is covered by the existing partial index `idx_edges_structural (relation, target_id) WHERE relation IN ('part_of','instance_of')` (schema.sql:256). Sprint 2 first verifies via `EXPLAIN ANALYZE` whether the partial index already keeps deep-mode performant. If yes, deep-mode stays unchanged (smaller blast radius). If no, apply the same UNION rewrite as the main recursive arm.

**Fix (main recursive arm):**

1. **Rewrite the recursive arm as a UNION ALL of two single-direction queries.** Each branch matches one edge endpoint and uses the corresponding single-column index (`idx_edges_source` or `idx_edges_target`). This recovers index usage without changing semantics. **UNION ALL not UNION:** an edge `(source=X, target=Y)` matches the source-side branch when `spread.id=X` and the target-side branch when `spread.id=Y` — these are distinct edge events, not duplicates. Self-loops (`source=target`) would produce two rows in one branch, but the data model doesn't create self-loops. The final aggregation `GROUP BY a.id` with `MAX(a.activation)` collapses any duplicate visits into a single output row, preserving correctness. Per-hop fan-out cap (next item) bounds the doubled work.
2. **Per-hop fan-out cap.** Add a deterministic `LIMIT N` (configurable via `engram_max_fanout_per_hop`, default 50) ordered by `edge.weight DESC, neighbor.activation DESC` inside each branch. Caps total rows examined at `seed × hop × fanout × 2` independent of graph density.
3. **Tenant filter in the recursive arm.** Add `AND neighbor.tenant_id = :tenant_id` to the neighbor join. Same filter already on the seed branches — extending it through the spread closes the leak. **Pre-fix audit (Sprint 1):** count cross-tenant edges in the live `engram_edges` table before the filter lands. If any exist, plan a cleanup migration — see Migration Plan section.
4. **Deep-mode follow-up:** apply the same UNION rewrite *only if* the EXPLAIN check above shows the partial index isn't carrying its weight. Otherwise, no change.
5. **No changes to scoring formulas.** Convergent amplification, recency boost, source-type multiplier all preserved.

**Test contracts:**

- *Termination:* For any seed set, the result count is bounded by `max_results` and the query completes in O(seed × max_hops × max_fanout) edges examined. Verified with EXPLAIN ANALYZE in a perf test on a synthetic graph of N=10k engrams with degree d=20; runtime must be under a fixed budget (TBD during implementation, baseline established by characterization run).
- *No revisits:* For a constructed graph with cycles, no engram appears in the spread output more than once (`a.id` is unique in the result set).
- *Tenant isolation:* For a graph with engrams in tenants A and B linked by edges, a query with `tenant_id=A` returns zero engrams from tenant B. (This is a new contract — currently violated.)
- *Hop bound:* No engram in the result has a shortest path from any seed exceeding `max_hops`.
- *Fan-out cap:* For an engram with degree > `max_fanout_per_hop`, only `max_fanout_per_hop` of its neighbors appear in the next hop's frontier. Verified by constructing a hub engram with N=200 edges and confirming only 50 neighbors are explored.
- *Convergence amplification:* For an engram reached by K independent paths from distinct seeds, `convergence_paths` field equals K.
- *Source-type multiplier:* Personal seeds (chat, consolidation, self_reflection) get the 1.5/1.2/1.0 multiplier; intel gets 0.5; knowledge gets 0.7. Verified by a fixture seeding one engram per source_type and asserting the relative ordering of `boosted_sim`.
- *Personal/general split:* Of `seed_count` total seeds, exactly `ceil(seed_count × engram_personal_seed_ratio)` come from personal source types. Edge case: when no personal engrams exist, all seeds are general. Edge case: when no general engrams exist, all personal slots fill (rest of `seed_count` empty).
- *Shallow / standard / deep depth modes:* shallow returns only `topic` and `schema`; standard returns all types; deep adds `instance_of`/`part_of` neighbors not reached by activation.
- *Threshold pruning:* An edge with `spread.activation × edge.weight × decay_factor < threshold` is not traversed.
- *Contradicts edges excluded:* Edges with `relation = 'contradicts'` are never traversed.

### P2 — Consolidation duplicate-merge: cartesian self-join

**Current state:** `memory-service/app/engram/consolidation.py:634–650`. `engrams e1 JOIN engrams e2 ON e2.id > e1.id AND e1.type = e2.type AND ... 1 - (e1.embedding <=> e2.embedding) > :threshold LIMIT 20`. Cartesian over the engram table, filtered to upper-triangle pairs, with vector similarity check. `LIMIT 20` lets PG stop after finding 20 matches but doesn't bound the worst case (when very few pairs exceed threshold, all `n × (n-1) / 2` pairs are computed).

**Fix:**

1. **HNSW shortlist prefilter.** Replace the cartesian with a per-engram nearest-neighbor query: for each candidate `e1`, use the HNSW index (`idx_engrams_hnsw`) to find its top-K nearest engrams of the same type/source_type, then check the threshold. K is configurable (default 10). This is sublinear in N.
2. **HNSW determinism — set `ef_search` for stable top-K.** HNSW is approximate; without explicit `ef_search` two runs over the same data may return different top-K at the boundary. Sprint 3 sets `SET LOCAL hnsw.ef_search = 40` (or higher; tunable) inside the consolidation transaction to get stable enough top-K that the merge contract is well-defined. Tradeoff: higher ef_search → better recall, slower probe.
3. **Iterative pairing with set tracking.** Maintain a set of already-merged IDs; skip any `e1` already merged this cycle so we don't try to merge a winner into another candidate.
4. **Cap candidates per cycle.** Process at most `engram_merge_cycle_cap` (default 200) candidate engrams per consolidation run; remaining candidates wait for the next cycle. Bounds work per cycle.

**Test contracts:**

- *Sublinearity:* On N=10k engrams with ~5% near-duplicates, runtime is O(N log N) not O(N²). Verified by characterization run: total query time under fixed budget.
- *Merge correctness preserved:* For a fixture of three near-duplicate engrams, the highest-`access_count` one is kept, others marked `superseded`. (Characterization test against current behavior.)
- *Edge re-pointing:* When engram A is merged into engram B, all edges where A was source/target are re-pointed to B, except where doing so would create a duplicate (existing UNIQUE constraint handled).
- *No false merges below threshold:* Pairs with similarity ≤ `engram_merge_similarity_threshold` are never merged.
- *Bounded merge churn between runs (weakened from "idempotent"):* A second consolidation run on the same dataset produces no additional merges that violate the threshold contract. HNSW non-determinism may surface a previously-unseen pair that legitimately exceeds the threshold; that's a true positive, not a flake. Test asserts: any new merges in the second run satisfy the threshold contract.

### P4 — Schema synthesis: N+1 embedding lookups

**Current state:** `memory-service/app/engram/consolidation.py:347–370`. For each `frequent_entity` (~10) × `related_item` (≤10), two sequential `session.execute` calls per item — one to fetch the source embedding, one to compute cosine similarity against the synthesized schema's embedding. Up to 200 serial round-trips per consolidation cycle.

**Fix:**

Replace the per-item loop with a single batched query:

```sql
SELECT e.id, 1 - (e.embedding <=> CAST(:schema_emb AS halfvec)) AS sim
FROM engrams e
WHERE e.id = ANY(CAST(:source_ids AS uuid[]))
  AND e.embedding IS NOT NULL
```

Embedding fetch and similarity computation collapse into one round-trip per entity (10 total per cycle).

**Test contracts:**

- *Round-trip count:* For N source engrams, the number of `session.execute` calls during coherence-gate evaluation is exactly 1 (constant), not N. Verified by counting calls on a real session via a `session.execute` spy installed at fixture setup. (The "spy" is a real session with a wrapping decorator that records but forwards — not a mock.)
- *Coherence-gate decision unchanged:* Given the same input engrams and schema, the coherence-gate accept/reject decision matches the pre-refactor behavior. Characterization test.

### P6 — Missing composite index for activation seeds (CONDITIONAL)

**Current state:** Seed query (`activation.py:79–130`) filters by `tenant_id + superseded + source_type + activation` for the cosine-distance shortlist. The HNSW index `idx_engrams_hnsw` (schema.sql:120) handles the `embedding <=> query` probe; PG then applies the WHERE filters and re-ranks by `boosted_sim`. Existing single-column indexes (`idx_engrams_tenant`, `idx_engrams_activation`, `idx_engrams_type`) are not composite.

**Diagnosis correction:** The HNSW probe likely dominates the cost of the seed query, not the WHERE-filter scan. Adding a composite index would only help if PG chooses a non-HNSW plan (e.g., the index-and-rescore strategy). Without `EXPLAIN ANALYZE` evidence on real data, adding the index is write-amplification cost (every engram insert/update maintains an extra index) for no measurable read benefit.

**Conditional fix — gated on EXPLAIN evidence:**

1. **Sprint 1 baseline:** Run `EXPLAIN ANALYZE` on the seed query against the live database (~7k engrams). Capture the chosen plan and the time breakdown.
2. **If HNSW probe dominates (>80% of query time):** No index added. Spec marks P6 as "diagnosed and dismissed."
3. **If PG chooses a non-HNSW plan or the WHERE-filter scan is >20% of query time:** Add `idx_engrams_seed_filter (tenant_id, source_type, activation) WHERE NOT superseded` via the schema.sql append described in the Migration Plan section.

**Test contracts (only if the index is added):**

- *Index used:* `EXPLAIN` for the seed-selection query on a populated table includes `idx_engrams_seed_filter`.
- *No correctness regression:* Result set unchanged for all seed-selection queries.

**If the index is dismissed:** Capture the EXPLAIN output in `docs/superpowers/specs/2026-05-05-memory-perf-explain-baselines.md` so future readers see why the audit's P6 was a false alarm.

### P9 — Duplicate query embedding in working_memory

**Current state:** `memory-service/app/engram/working_memory.py:124` and `:206` both call `await get_embedding(query, session)` in the same function. Redis cache absorbs the second call but it's still an extra round-trip.

**Fix:** Compute `query_embedding` once at the top of the calling function (or pass it in if already computed by the caller); reuse for both neural-rerank feature extraction and retrieval logging.

**Test contracts:**

- *Single embedding call per turn:* For a single call to the working-memory function, `get_embedding` is invoked exactly once. Verified via the same spy pattern as P4.

### P3 — Per-call client construction in memory-service (NARROWED SCOPE)

**Current state:** The audit's P3 is broad — it names per-call `aioredis.from_url` in `orchestrator/app/config_sync.py` (8 sites) and 36 `async with httpx.AsyncClient(...)` blocks across services. Fixing the orchestrator-side pattern requires orchestrator test infrastructure that this spec doesn't extend.

**Scope narrowed to memory-service only.** This spec addresses connection-reuse only inside `memory-service/app/`. The orchestrator and cross-service equivalents are tracked separately as a future cross-cutting cleanup.

**Fix:** Audit `memory-service/app/main.py` lifespan and every `memory-service/app/engram/*.py` and `memory-service/app/db/*.py` file for `aioredis.from_url` or `httpx.AsyncClient(...)` constructed per-call. Move any such usage to module-level singletons created in `lifespan` startup; close in shutdown. CLAUDE.md already names the `close_redis()` pattern for memory-service; extend to httpx.

**Acceptance:** A grep over `memory-service/app/` finds zero `aioredis.from_url` outside `lifespan` startup, and zero `async with httpx.AsyncClient(` outside startup. Recovery audit by inspection, not unit test (test for "no connection leak" requires production-load-like fixtures that aren't worth building for this scope).

**Test contracts:** None. This is enforced by code review and a one-shot grep, not by tests.

---

## Test infrastructure migration

The existing `memory-service/tests/conftest.py` is a 23-line file with two `unittest.mock.AsyncMock` fixtures. Three test files (`test_embedding_cache.py`, `test_outcome_feedback_symmetry.py`, `test_source_kind_mapping.py`) depend on them. We need to migrate without breaking the three existing tests overnight.

### New file: `memory-service/tests/conftest_db.py`

```python
"""Real-DB unit-test fixtures for memory-service.

Pattern: per-test transaction wrapped in BEGIN…ROLLBACK. Tests opt in
via the `db_session` fixture name. pgvector and pg_trgm are installed
once during test-DB setup (see scripts/setup_test_db.sh).
"""
```

Key fixtures:

| Fixture | Scope | Yields | Purpose |
|---|---|---|---|
| `db_engine` | session | `AsyncEngine` connected to `nova_test` DB | One engine per pytest session |
| `db_session` | function | `AsyncSession` inside `BEGIN…ROLLBACK` | Per-test isolation; nothing persists |
| `redis_test` | function | `aioredis.Redis` on db15 with FLUSHDB | Per-test Redis isolation |
| `fake_llm` | function | Callable returning canned responses keyed by prompt hash | Deterministic LLM behavior; recording mode for fixture seeding |
| `engram_factory` | function | Helper to insert engrams with sensible defaults | Reduces test boilerplate |
| `edge_factory` | function | Helper to insert engram_edges | Same |
| `graph_builder` | function | Builds named graph topologies (chain, star, hub-and-spoke, two-tenant) | Common cliff-test scaffolding |

### Setup script: `scripts/setup_test_db.sh`

One-shot script: creates `nova_test` DB on the running Postgres container, installs `vector` and `pg_trgm` extensions, runs `memory-service/app/db/schema.sql`. Idempotent. Documented in `memory-service/tests/README.md`. CI calls this in the `make test` chain (or its memory-service subset).

### Existing fixtures: `conftest_legacy.py`

Move `mock_redis` and `mock_session` here. Existing three tests update their imports. New tests must not import from this file (enforced by a CI check or by review). Files migrate to real-DB fixtures as the surrounding production code is touched in this work.

### LLM-call recording

Real LLM calls in tests would be expensive, slow, and non-deterministic. The `fake_llm` fixture supports two modes:

- **Replay (default):** prompt hash → canned response file in `memory-service/tests/fixtures/llm/`.
- **Record:** when `RECORD_LLM_FIXTURES=1`, calls go to the real gateway and responses are written to fixture files. Used to seed initial fixtures and regenerate when prompts change.

**Prompt-hash normalization (mandatory).** Prompts often embed timestamps (`now()`, ISO 8601 strings), session identifiers, and UUIDs that would make a naive hash differ on every run. Before hashing, the fixture applies:

- Strip ISO 8601 timestamps (regex `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?` → `<ISO8601>`)
- Strip UUIDs (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` → `<UUID>`)
- Strip session_id values when keyed by name (`session_id=` → `session_id=<SID>`)

The normalized prompt is what gets hashed. Record mode emits both the raw prompt and the normalized hash to the fixture file (raw for human review, hash for replay-mode lookup).

If a test exercises a path where prompts contain other variable content (model versions, file paths, etc.), the test declares additional normalizers via a fixture parameter. Documented per fixture file.

### Snapshot fixtures (characterization tests)

Characterization tests for consolidation phases capture pre-refactor output and assert post-refactor matches. Snapshots live in `memory-service/tests/fixtures/snapshots/<test_name>.json`. Implementation: a small custom helper (no `pytest-syrupy` dep) that diffs JSON-serializable output against the fixture file. Updating snapshots requires `UPDATE_SNAPSHOTS=1`. Snapshot files committed to the repo (per the gitignore exception path; this directory is NOT under `superpowers/`).

### Suite-runtime baseline

Median per-test wall time is **measured, not assumed**. Phase 1 deliverable includes: run the 3 migrated tests against real DB and report median wall time. If above 100ms, revisit fixture design (transaction reuse, factory-Boy patterns, schema diet). Full memory-service unit suite must complete under 30 seconds for `make test` integration; otherwise the suite gets `@pytest.mark.slow` segregation.

---

## Per-module test plan

For each module: target test file, what to cover, approximate count.

| Module | Test file | What to cover | Tests |
|---|---|---|---|
| `activation.py` | `tests/test_activation.py` | All P1 contracts (above), `_touch_accessed` semantics, depth modes (shallow/standard/deep), structural follow-up | ~25 |
| `consolidation.py` | `tests/test_consolidation_unit.py` | All 6 phases (replay, pattern extraction, Hebbian, contradiction, prune/merge, self-model). All P2 + P4 contracts. Mutex behavior. | ~30 |
| `working_memory.py` | `tests/test_working_memory.py` | Five-tier slot system (pinned/sticky/refreshed/sliding/expiring), token budgeting per tier, eviction order, P9 contract | ~20 |
| `decomposition.py` | `tests/test_decomposition.py` | LLM-driven structured engram extraction, fragment shape, model resolution, error paths (invalid JSON, oversized output) | ~15 |
| `ingestion.py` | `tests/test_ingestion_unit.py` | Queue worker loop, Semaphore(5) backpressure, source-type → source-kind translation table, dedup, error handling on poison messages | ~15 |
| `clustering.py` | `tests/test_clustering.py` | UMAP+HDBSCAN topic discovery, topic engram creation, cluster reassignment on new engrams, regeneration trigger | ~15 |
| `entity_resolution.py` | `tests/test_entity_resolution.py` | Embedding-similarity entity dedup, threshold behavior, edge re-pointing | ~10 |
| `reconstruction.py` | `tests/test_reconstruction.py` | Template assembly from activated engrams, personal/non-personal interleaving, token-budget truncation | ~12 |
| `neural_router/serve.py` | `tests/test_neural_router_serve.py` | Re-rank invocation when model loaded, fallback when not, candidate dict shape | ~8 |
| `neural_router/train.py` | `tests/test_neural_router_train.py` | Training data assembly, validation split, precision-at-K computation, model promotion criteria | ~10 |
| `cortex_stimulus.py` | `tests/test_cortex_stimulus.py` | Push to Redis db5 stimulus key, payload shape, error handling | ~5 |
| `outcome_feedback.py` | (existing — migrate from mocks) | Symmetric reinforcement, activation/importance adjustments, edge weight updates | unchanged count |
| `retrieval_logger.py` | `tests/test_retrieval_logger.py` | Insert observations, tenant_id propagation, engrams_used backfill | ~6 |

**Approximate total:** ~170 new unit tests + 3 migrated tests. Per-test wall time is **measured during Phase 1**, not assumed. Target: full memory-service unit suite under 30s for `make test` integration. If real measurement exceeds that, slow tests get `@pytest.mark.slow` segregation.

---

## Migration plan

memory-service uses a single declarative schema file (`memory-service/app/db/schema.sql`) with `IF NOT EXISTS` guards for indexes and `DO $$ … EXCEPTION WHEN duplicate_column $$` blocks for `ALTER TABLE`. There is no Alembic. Schema changes are appended to that file and run via `run_schema_migrations()` at memory-service startup (`memory-service/app/db/database.py`). This spec follows that convention.

**Schema changes proposed:**

| Change | File | Method | Conditional? |
|---|---|---|---|
| `idx_engrams_seed_filter (tenant_id, source_type, activation) WHERE NOT superseded` | `memory-service/app/db/schema.sql` (append) | `CREATE INDEX IF NOT EXISTS` | **YES** — only added if Sprint 1 EXPLAIN evidence justifies (see P6 conditional fix). If dismissed, no schema change. |
| Cross-tenant edge cleanup (only if Sprint 1 audit finds non-zero rows) | New file `memory-service/app/db/migrations/cleanup-cross-tenant-edges.sql` | One-shot `DELETE` against `engram_edges` keyed by tenant mismatch, run manually before the activation tenant-filter fix lands | **YES** — only if audit finds offending rows |

**Test-DB pickup.** `scripts/setup_test_db.sh` runs `schema.sql` end-to-end on `nova_test` DB creation. Any schema change (added index, added column) is picked up by the test setup automatically. The cross-tenant cleanup file is *not* run during test-DB setup (test data is built per-test via factories, never inherited from prod).

**Live-DB rollout.** memory-service runs `run_schema_migrations()` at startup, which executes `schema.sql`. New indexes are created with `IF NOT EXISTS`; rolling restart of memory-service applies them safely. The cleanup migration (if needed) is run manually as a one-shot `psql` invocation against the live DB *before* deploying the activation tenant-filter code.

**Operational risk gate:** the activation tenant-filter fix MUST NOT ship until the cross-tenant audit is complete and any necessary cleanup migration has run on the live DB. Otherwise, valid cross-tenant edges (if any exist) silently disappear from results.

---

## Phasing

| Phase | Sprint | Deliverable | Gate |
|---|---|---|---|
| 1 | Sprint 1 | Test infrastructure: `conftest_db.py` (`db_session`, `redis_test`, `engram_factory`, `edge_factory`), `setup_test_db.sh`, `fake_llm` fixture with prompt-hash normalization + recording mode, snapshot helper, migrated existing 3 tests, **EXPLAIN baselines** for activation seed query and deep-mode follow-up, **cross-tenant edge audit** of live data, **migration plan execution** (any new index appended to `schema.sql` with `IF NOT EXISTS`, test-DB picks it up) | All 3 existing tests pass on real DB; setup script idempotent; EXPLAIN baselines captured to `2026-05-05-memory-perf-explain-baselines.md`; cross-tenant edge count reported (and cleanup migration scoped if non-zero) |
| 2 | Sprint 2 | P1 main-arm fix: activation CTE rewrite (UNION ALL + fan-out cap + tenant filter); deep-mode UNION rewrite **only if** Sprint 1 EXPLAIN showed partial-index isn't carrying it; `graph_builder` fixture; ~25 contract tests for activation; characterization tests captured before refactor | All activation contract tests pass; tenant-isolation contract test passes on a two-tenant graph fixture; characterization tests pass on both pre- and post-refactor code |
| 3 | Sprint 3 | P2 fix: consolidation HNSW shortlist with `ef_search` set; ~30 consolidation tests including P4 batched query; P9 working_memory dedup | All consolidation contracts pass; consolidation cycle on 10k-engram fixture under agreed time budget; embedding spy confirms single `get_embedding` per turn |
| 4 | Sprint 3 (parallel) | P6 conditional fix (only if EXPLAIN evidence justifies); P3 memory-service connection-reuse audit + lifespan-singleton refactor | If P6 added: `EXPLAIN` confirms index used. If P6 dismissed: rationale captured in baselines doc. Grep over `memory-service/app/` returns zero per-call client construction. |
| 5 | Sprint 4 | Test sweep: `decomposition`, `ingestion`, `working_memory`, `clustering` | ~65 tests landed |
| 6 | Sprint 4 | Test sweep: `entity_resolution`, `reconstruction`, `neural_router/`, `cortex_stimulus`, `retrieval_logger` | ~50 tests landed |
| 7 | Sprint 5 | Hardening pass: address gaps surfaced during the sweep, EXPLAIN-driven query review, doc updates (memory-service README, schema.sql comments) | All targeted modules at the contract-coverage bar |

**Total:** 5 sprints (revised up from 3.5 after reviewer flagged Phase 1 was overstuffed; the reviewer's catch was correct). Sprint 1 is infrastructure-heavy; Sprints 2–3 ship the cliff fixes; Sprints 4–5 ship the rest of the test sweep. Sprint 3 has two parallel tracks (P2/P9 work + P3/P6 work) that can be sequenced inside the sprint as appetite allows.

**Phase 1 sizing risk:** Sprint 1 deliverable list is ambitious. If it slips, Sprint 2 starts when Sprint 1's *prerequisites for the P1 fix* land — specifically `db_session`, `engram_factory`, `edge_factory`, the EXPLAIN baselines, and the cross-tenant audit. Other Phase 1 items (`fake_llm` recording mode, snapshot helper, `graph_builder`) can complete in parallel with Phase 2 if they're not yet done. **Phase 2 cannot start without the cross-tenant edge audit being complete** — the tenant-filter fix's blast radius depends on that count.

---

## Verification

Per phase:

- **Test suites:** `pytest memory-service/tests/` runs in CI per PR. New tests must pass; characterization tests gate refactors.
- **EXPLAIN ANALYZE:** Sprint 1 establishes baseline plans for activation seed query, recursive arm, deep-mode follow-up, consolidation merge. Sprint 4 confirms post-refactor plans use intended indexes (`idx_edges_source`, `idx_edges_target`, `idx_engrams_hnsw`, `idx_engrams_seed_filter`).
- **Synthetic-graph perf budget:** A perf test (`tests/test_activation_perf.py`, opt-in via marker) seeds N=10k engrams with degree d=20, runs spreading activation, asserts wall-time under a budget (TBD during Sprint 2 baseline).
- **Real-instance smoke:** Run consolidation cycle on Jeremy's existing engram database (~7k engrams per the FC-011 reference) and confirm no behavior regression vs current.
- **Production canary:** After Sprint 4 ships, monitor consolidation cycle duration and `/api/v1/engrams/context` p99 latency for one week. Roll back if either regresses (feature-flag kill switch from the `flags-001-foundation` work makes this easy).

---

## Coordination with other in-flight work

### Feature Flags v1 (`flags-001-foundation`, design committed earlier today)

- The flags spec proposes `kill.consolidation.cycle` and `kill.engram.ingestion` flags. Both pause the relevant code path; neither alters the algorithms inside.
- **Sequencing:** Whichever ships first, the other bolts on cleanly.
  - If feature flags ships first: this work adds flag check sites at the existing pause points (consolidation cycle entry, ingestion worker loop). Trivial.
  - If this work ships first: feature flags adds the same check sites later. Trivial.
- **No merge conflict expected** — different files within `memory-service/app/engram/` mostly, and even shared files have non-overlapping change regions.
- **Recommended:** acknowledge the flag names in the consolidation/ingestion test design (test for kill-switch behavior added when the flag lands).

### SEC-006a (`.worktrees/sec-006a-platform-secrets`)

- Touches chat-bridge, llm-gateway, recovery, nova-worker-common. **No overlap** with engram modules or memory-service code.

### FC-011 (Pluggable Memory + Benchmarks, DRAFT)

- Strategic question, not in execution. This work is orthogonal:
  - Test contracts written here document the memory semantics any future backend must preserve.
  - Cliff fixes apply to engram regardless of FC-011 outcome (you wouldn't ship the unbounded version to SaaS tenants under any backend choice).
  - Benchmark harness (FC-011 Phase 3) is explicitly out of scope.
- If FC-011 is later approved, the `MemoryBackend` interface should accept the test fixtures defined here as inputs to the benchmark suite.

---

## Open questions (for implementation phase, not blocking spec approval)

1. **Activation perf budget number.** What's the wall-time budget for `spreading_activation` on N=10k, d=20? Established empirically during Sprint 2 baseline.
2. **`engram_max_fanout_per_hop` default.** 50 is a guess; real value depends on observed graph density on Jeremy's database. Tunable via config; default set in Sprint 2 after measurement.
3. **Consolidation merge cycle cap.** 200 is a guess for the same reason. Adjust after Sprint 3 baseline.
4. **HNSW shortlist K.** 10 is a guess. Trade-off: higher K = better recall, worse perf. Tunable.
5. **Test DB migration management.** `setup_test_db.sh` runs `schema.sql` once; how do we keep it in sync with future schema changes? Option A: re-run schema.sql each test session (slow). Option B: a `--reset` flag that drops/re-creates the test DB. Option C: lightweight migration tracking. Default: B for now, revisit if pain.
6. **Should the `fake_llm` recording mode commit responses to the repo?** Pro: reproducibility; con: LLM responses get stale fast. Default: yes commit, with a `make refresh-llm-fixtures` target to regenerate.
7. **Perf-test marker.** Should perf tests run in CI by default, or opt-in via `pytest -m perf`? Default: opt-in (avoids flaky CI on slow runners), with a nightly job for trend tracking.
**Note:** OQ8 from the prior draft (cross-tenant edge audit) has been **promoted into Sprint 1 scope** — see Migration Plan and Phasing tables. It is no longer an open question.

---

## Acceptance criteria

This work is "done" when all of the following hold:

- [ ] All 170+ unit tests in the listed modules exist and pass on real Postgres + pgvector.
- [ ] No test in `memory-service/tests/` imports from `unittest.mock` (except `conftest_legacy.py`).
- [ ] `EXPLAIN ANALYZE` on the activation recursive arm shows index usage on `idx_edges_source` and `idx_edges_target` (no seq scan, no bitmap-OR).
- [ ] Activation perf test on N=10k, d=20 completes under the agreed budget.
- [ ] Consolidation cycle on N=10k completes under the agreed budget; HNSW shortlist used in `EXPLAIN`.
- [ ] Tenant-isolation contract tests pass: a tenant_id=A query on a graph spanning A and B returns zero B engrams.
- [ ] Working memory issues exactly one `get_embedding` call per turn (verified by spy).
- [ ] Schema synthesis coherence-gate uses one batched query, not N (verified by spy).
- [ ] `idx_engrams_seed_filter` migration applied; seed query uses it (verified by `EXPLAIN`).
- [ ] memory-service connection counts flat under sustained load (Redis + Postgres `SHOW pool_stats` or equivalent).
- [ ] No characterization test fails on production database (Jeremy's instance).
- [ ] One week of canary data shows no regression in consolidation duration or `/context` p99.

---

## Next step

After user approval of this spec, transition to `superpowers:writing-plans` to produce a step-by-step implementation plan keyed to the phasing above. The plan will spell out individual subtasks, ordering, dependencies, review checkpoints, and the worktree setup.

---

## Appendix: Files touched

For coordination with `flags-001-foundation` and any other in-flight work, this spec proposes changes to the following files. Listed for merge-conflict prediction; not exhaustive of every test file added.

**Code changes:**

- `memory-service/app/engram/activation.py` — main recursive arm rewrite (P1), tenant filter, deep-mode conditional rewrite, `_touch_accessed` left as-is
- `memory-service/app/engram/consolidation.py` — `_merge_duplicates` rewrite (P2), schema-synthesis batch query (P4)
- `memory-service/app/engram/working_memory.py` — embedding-call dedup (P9)
- `memory-service/app/main.py` — lifespan singletons for redis + httpx (P3)
- `memory-service/app/db/schema.sql` — append composite index *if* P6 evidence justifies; otherwise unchanged
- `memory-service/app/config.py` — add `engram_max_fanout_per_hop` (default 50) and `engram_merge_cycle_cap` (default 200)
- `memory-service/app/db/migrations/cleanup-cross-tenant-edges.sql` — new one-shot, *if* cross-tenant audit finds offending rows

**Test infrastructure:**

- `memory-service/tests/conftest.py` — `pytest_plugins = ["conftest_db"]` only. Legacy mock fixtures are NOT auto-registered globally — the 3 migrated test files import them explicitly: `from .conftest_legacy import mock_redis, mock_session`. New tests have no path to the mocks.
- `memory-service/tests/conftest_db.py` — new
- `memory-service/tests/conftest_legacy.py` — new (relocates `mock_redis` and `mock_session`); imported by name from migrating tests, never auto-loaded
- `memory-service/tests/fixtures/llm/*.json` — recorded LLM responses
- `memory-service/tests/fixtures/snapshots/*.json` — characterization snapshots
- `scripts/setup_test_db.sh` — new
- `memory-service/tests/README.md` — new

**Test files (new):** `test_activation.py`, `test_consolidation_unit.py`, `test_working_memory.py`, `test_decomposition.py`, `test_ingestion_unit.py`, `test_clustering.py`, `test_entity_resolution.py`, `test_reconstruction.py`, `test_neural_router_serve.py`, `test_neural_router_train.py`, `test_cortex_stimulus.py`, `test_retrieval_logger.py`, `test_activation_perf.py` (opt-in marker)

**Test files (migrated):** `test_embedding_cache.py`, `test_outcome_feedback_symmetry.py`, `test_source_kind_mapping.py`

**Documentation:**

- `docs/superpowers/specs/2026-05-05-memory-perf-explain-baselines.md` — new (EXPLAIN captures from Sprint 1)

**Coordination check vs. `flags-001-foundation`:** the feature-flags spec adds `kill.consolidation.cycle` and `kill.engram.ingestion` flag check sites. Most likely sites: `memory-service/app/engram/consolidation.py` (entry of the consolidation cycle) and `memory-service/app/engram/ingestion.py` (worker loop). This spec also touches `consolidation.py` (different functions: `_merge_duplicates` and the schema-synthesis path) and does **not** touch `ingestion.py` for code changes (only tests). Conflict risk: low; both specs touch `consolidation.py` but in different functions. Resolve by sequencing whichever ships first; the other rebase is mechanical.

**Coordination check vs. `sec-006a-platform-secrets`:** that work touches `chat-bridge`, `llm-gateway`, `recovery`, `nova-worker-common`. Zero overlap with `memory-service/`. No conflict.
