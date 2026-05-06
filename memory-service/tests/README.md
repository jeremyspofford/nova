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
- `conftest_legacy.py` — legacy mock fixtures (`mock_redis`, `mock_session`). Imported only by the 3 tests being progressively migrated. Not auto-loaded.
- `fixtures/llm/*.json` — recorded LLM responses keyed by normalized prompt hash. Regenerate with `RECORD_LLM_FIXTURES=1 uv run pytest`.
- `fixtures/snapshots/*.json` — characterization snapshots. Regenerate with `UPDATE_SNAPSHOTS=1 uv run pytest`.
