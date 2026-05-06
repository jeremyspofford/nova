# Memory Subsystem Hardening — MEM-001 Design Spec

**Status:** IMPLEMENTED — closed 2026-05-06 in PR #4

**Sprint:** MEM-001 (Sprints 1–5)

---

## Scope

Performance and correctness hardening of the memory-service engram subsystem.
Addressed 9 performance problems (P1–P9) identified in the pre-MEM-001 EXPLAIN baseline audit.

## Problems addressed

| ID | Description | Outcome |
|---|---|---|
| P1 | Activation recursive arm: BitmapOr fan-out, no tenant filter | REWRITE — UNION strategy + tenant filter + fan-out cap (50) |
| P1-deep | Activation deep-mode: idx_edges_structural unused, BitmapOr | REWRITE — UNION of two arms, idx_edges_structural used by target arm |
| P2 | Consolidation merge: cartesian self-join, 5.7M rows, 2680 ms | REWRITE — HNSW per-candidate top-K probe (ef_search=40) |
| P3 | httpx connections: 8+ per-call AsyncClient instantiations | REFACTOR — shared singleton via get_http_client() |
| P4 | Schema-synthesis coherence: 5 queries per call | BATCHED — 1 query across all sources |
| P6 | Composite index on (type, source_type): dismissed | DISMISSED — Seq Scan filter 60.7%, total time 5ms (acceptable) |
| P9 | Working memory: 2 get_embedding calls per turn | DEDUPED — early exit on second call within same turn |

## Test coverage (Sprint 5)

214 tests across 24 test files. All pass as of MEM-001 Task 5.7.
See `memory-service/tests/README.md` for full taxonomy.

## Key documents

- EXPLAIN baselines (pre- and post-refactor): `docs/superpowers/specs/2026-05-05-memory-perf-explain-baselines.md`
- Schema with index comments: `memory-service/app/db/schema.sql`
- Test taxonomy and fixture conventions: `memory-service/tests/README.md`
