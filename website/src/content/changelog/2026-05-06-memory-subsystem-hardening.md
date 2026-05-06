---
title: "Memory subsystem hardening — two production-cliff queries fixed, real-DB test infrastructure"
date: 2026-05-06
---

Five sprints of work on `memory-service/app/engram/` close two scaling-cliff queries that would have stalled the subsystem at production scale, plus 214 unit tests on what was previously the most under-tested complex code in Nova.

- **Spreading-activation cliff fixed (P1).** The recursive CTE used to join `engram_edges` on `(source_id = X OR target_id = X)` — an `OR` predicate that defeated both single-column edge indexes and forced Postgres into a Bitmap-OR plan. Rewritten as a single recursive reference with a LATERAL UNION ALL of two indexed branches (source-side + target-side), each with a per-hop fan-out cap (default 50) and a tenant filter on the neighbor join. The activation deep-mode follow-up got the same treatment: 1.507 ms → 0.129 ms (~12× speedup) measured on a 4156-engram database.
- **Consolidation merge cliff fixed (P2).** The duplicate-merge phase used to do an `O(N²)` cartesian self-join over engram embeddings, generating 5.7M candidate pairs in 2.68s on the same database. Replaced with a per-candidate HNSW shortlist (top-K nearest neighbors of the same type/source_type, `SET LOCAL hnsw.ef_search = 40` for stable top-K) plus a `loser_ids` exclusion set so popular winners can absorb additional duplicates within a cycle.
- **Schema-synthesis batched.** The coherence-gate that compares each source engram's embedding against a synthesized schema's embedding used to make 5 round-trips per cycle (one per source). Now one batched `WHERE id = ANY(...)` query.
- **Working-memory dedup.** `assemble_context` used to call `get_embedding(query)` twice — once for neural-router rerank, once for retrieval logging. Now computed at the top of the function and reused.
- **memory-service connection reuse.** Eight per-call `httpx.AsyncClient(...)` sites collapsed to one shared singleton (`get_http_client()`) registered in the FastAPI lifespan. Mirrors the existing `get_redis()` pattern.
- **Real-Postgres + pgvector unit-test fixtures.** New `conftest.py` provides `db_session` (per-test BEGIN/ROLLBACK), `redis_test` (db15 with FLUSHDB), `engram_factory`, `edge_factory`, `fake_llm` (replay+record with prompt-hash normalization), `graph_builder`, and a JSON snapshot helper. The previous mock-based fixtures are quarantined in `conftest_legacy.py`. 214 tests run end-to-end on real services in ~6 seconds.

If you're upgrading: schema changes are additive and run automatically at memory-service startup. The 214 unit tests are gated behind `cd memory-service && uv run scripts/setup_test_db.py && uv run pytest tests/` — you only need them if you're modifying the engram subsystem.

A handful of spec/code mismatches surfaced during the test sweep — `working_memory.py`'s "five-tier slot system" is a DB-schema artifact only (no runtime promotion/demotion), `decompose()` is pure (no DB writes; persistence happens in `ingestion.py`), and `reconstruction.py` does no token-budget truncation (the caller is responsible). Tests now document the actual contracts; reconciling docs/audits with reality is follow-up work.
