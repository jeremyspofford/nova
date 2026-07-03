# memory-service tests

Unit tests for the OKF markdown backend and the queue-based ingestion
consumer. No Postgres required — the OKF backend is filesystem-based
(tests use tmp dirs) and queue tests need only a local Redis
(docker compose redis works; tests use db15 and FLUSHDB at setup).

## Running tests

```bash
cd memory-service
uv run pytest tests/ -v
```
