# memory-service tests

## Setup (first time)

```bash
cd memory-service
uv run scripts/setup_test_db.py
```

Creates `nova_test` database, installs pgvector + pg_trgm, applies schema. Idempotent — safe to re-run. Uses asyncpg (no host-level psql install required).

To wipe and rebuild after schema changes:

```bash
uv run scripts/setup_test_db.py --reset
```

To point at a different Postgres (e.g., a managed cloud DB), set:

```bash
POSTGRES_HOST=db.example.com POSTGRES_USER=... POSTGRES_PASSWORD=... \
  uv run scripts/setup_test_db.py
```

## Running tests

```bash
cd memory-service
uv run pytest tests/ -v
```

## Test layers

- `conftest.py` — real-Postgres fixtures (`db_session`, `redis_test`, `engram_factory`, `edge_factory`, `fake_llm`, snapshot helper). New tests use these.
- `conftest_legacy.py` — legacy mock fixtures (`mock_redis`, `mock_session`). No longer imported by any tests (as of MEM-001 Task 5.7). Retained for reference; delete when confirmed safe.
- `fixtures/llm/*.json` — recorded LLM responses keyed by normalized prompt hash. Regenerate with `RECORD_LLM_FIXTURES=1 uv run pytest`.
- `fixtures/snapshots/*.json` — characterization snapshots. Regenerate with `UPDATE_SNAPSHOTS=1 uv run pytest`.

## Test taxonomy

After MEM-001 (Sprints 1–5), `memory-service/tests/` covers:

| File | Module under test | Tests | Notes |
|---|---|---|---|
| test_conftest_smoke.py | conftest fixtures | 5 | db_session BEGIN/ROLLBACK + redis_test isolation |
| test_factories.py | engram_factory + edge_factory | 4 | Sensible-defaults validation |
| test_graph_builder.py | _GraphBuilder | 3 | chain / hub-spoke / two-tenant topologies |
| test_llm_prompt_norm.py | _llm_prompt_norm | 7 | Hash normalization (timestamps, UUIDs, session_ids) |
| test_fake_llm.py + test_fake_llm_record.py | fake_llm | 5 | Replay + record modes |
| test_snapshot.py | _snapshot | 6 | UPDATE_SNAPSHOTS=1 mode |
| test_activation.py | activation.py | 8 | Contract: termination, no-revisits, fan-out cap, tenant filter |
| test_activation_characterization.py | activation.py | 2 | Snapshot pre/post-refactor |
| test_consolidation_unit.py | consolidation.py | 5 | P2 + P4 contracts |
| test_consolidation_characterization.py | consolidation.py | 1 | Merge snapshot |
| test_decomposition.py | decomposition.py | 18 | Happy paths, error paths, model resolution |
| test_ingestion_unit.py | ingestion.py | 25 | Worker loop, semaphore, dedup, error handling, source-kind mapping (10 cases) |
| test_working_memory.py | working_memory.py | 23 | Token estimation, sticky decisions, assemble_context, P9 |
| test_clustering.py | clustering.py | 15 | HDBSCAN/UMAP determinism, topic engrams |
| test_entity_resolution.py | entity_resolution.py | 20 | Embedding-similarity dedup |
| test_reconstruction.py | reconstruction.py | 16 | Template assembly, type formatting |
| test_neural_router_serve.py | neural_router/serve.py | 9 | Model cache, rerank gating |
| test_neural_router_train.py | neural_router/train.py | 16 | Data assembly, validation split, promotion |
| test_cortex_stimulus.py | cortex_stimulus.py | 5 | Redis db5 push semantics |
| test_retrieval_logger.py | retrieval_logger.py | 6 | Insert + backfill + halfvec round-trip |
| test_outcome_feedback_symmetry.py | outcome_feedback.py | 10 | Positive/negative symmetry, clamping |
| test_embedding_cache.py | embedding.py | 3 | Redis hit, full miss (gateway + write-through), partial hit |
| test_source_kind_mapping.py | engram/ingestion.py | 2 | screenpipe mapping, unknown fallback |

**Total: 214 tests** (verified with `pytest --collect-only -q`)

### Fixture conventions

- `db_session` — real Postgres + pgvector, per-test BEGIN/ROLLBACK (session-scoped engine, function-scoped connection)
- `redis_test` — db15, FLUSHDB on setup
- `engram_factory(content=..., access_count=..., embedding=..., ...)` — insert with sensible defaults; embedding must be list[float] of len 768 if provided
- `edge_factory(source=..., target=..., relation=..., weight=...)` — insert engram_edge
- `fake_llm` / `fake_llm_factory` — recorded-replay or hand-stubbed via monkeypatch
- `graph_builder.chain(n=)` / `.hub_and_spoke(k=)` / `.two_tenant_split(per_tenant=)` — topology builders

### How to add a new test

1. New unit tests use `conftest.py` fixtures (real Postgres). Don't add to `conftest_legacy.py`.
2. For tests that exercise an LLM call, monkeypatch the function directly rather than recording a fake_llm fixture (faster, no gateway dependency).
3. Tests that need an existing engram structure use `engram_factory` + `edge_factory` (or `graph_builder` for common topologies).
4. Snapshot tests use `assert_snapshot(actual, path=SNAPSHOT_DIR / "...json")`. First run with `UPDATE_SNAPSHOTS=1` to seed.
5. Float-equality assertions on REAL columns: use `abs(x - expected) < 1e-5` not `==` (Postgres REAL is single-precision; 0.9 round-trips imprecisely).
6. Embedding-related tests must use 768-dimension vectors; `halfvec(768)` schema rejects anything else.
