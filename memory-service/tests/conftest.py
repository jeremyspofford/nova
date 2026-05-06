"""Real-Postgres-with-pgvector fixtures for memory-service unit tests.

Pattern: a session-scoped `db_engine` connects to nova_test (already
populated by `memory-service/scripts/setup_test_db.py`). A function-scoped `db_session`
wraps each test in an outer BEGIN; teardown ROLLBACKs everything.

This gives full pgvector / HNSW / recursive-CTE fidelity with zero
per-test schema cost.
"""

from __future__ import annotations

import json as _json
import os
import uuid
from pathlib import Path as _Path
from typing import Any

import pytest
import pytest_asyncio
import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from ._llm_prompt_norm import hash_prompt as _hash_prompt


def _test_database_url() -> str:
    """Compose async DB URL from env, defaulting to local docker-compose Postgres."""
    user = os.environ.get("POSTGRES_USER", "nova")
    password = os.environ.get("POSTGRES_PASSWORD", "nova_dev_password")
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    db = os.environ.get("TEST_DB_NAME", "nova_test")
    return f"postgresql+asyncpg://{user}:{password}@{host}:{port}/{db}"


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def db_engine():
    """One async engine per pytest session.

    `loop_scope="session"` keeps the engine bound to a single event loop
    that lives for the whole session, sidestepping pytest-asyncio's default
    function-scoped event loop (which would invalidate session-scoped async
    objects). Requires pytest-asyncio>=0.23.
    """
    engine = create_async_engine(_test_database_url(), pool_pre_ping=True)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture(scope="function", loop_scope="session")
async def db_session(db_engine):
    """Per-test AsyncSession wrapped in BEGIN…ROLLBACK.

    Inserts/updates inside the test do not persist. Tests are fully
    isolated from each other.
    """
    connection = await db_engine.connect()
    transaction = await connection.begin()
    factory = async_sessionmaker(
        bind=connection,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    session = factory()
    try:
        yield session
    finally:
        await session.close()
        await transaction.rollback()
        await connection.close()


@pytest_asyncio.fixture(loop_scope="session")
async def redis_test():
    """Per-test isolated Redis client on db15.

    FLUSHDB at setup (not teardown) so a previous failed test
    doesn't leave keys around.
    """
    host = os.environ.get("REDIS_HOST", "localhost")
    port = int(os.environ.get("REDIS_PORT", "6379"))
    client = aioredis.from_url(f"redis://{host}:{port}/15")
    await client.flushdb()
    try:
        yield client
    finally:
        await client.aclose()


def _to_pg_vector_str(vec: list[float]) -> str:
    """halfvec literal: '[0.1,0.2,...]'."""
    return "[" + ",".join(f"{v:.6f}" for v in vec) + "]"


@pytest_asyncio.fixture(loop_scope="session")
async def engram_factory(db_session):
    """Insert an engram with sensible defaults.

    Returns the inserted engram's UUID.
    """

    async def _make(
        *,
        content: str,
        type: str = "fact",  # noqa: A002 (shadowing builtin is intentional — matches column name)
        source_type: str = "chat",
        importance: float = 0.5,
        activation: float = 1.0,
        confidence: float = 0.8,
        tenant_id: str = "00000000-0000-0000-0000-000000000001",
        embedding: list[float] | None = None,
        superseded: bool = False,
    ) -> uuid.UUID:
        eid = uuid.uuid4()
        params: dict[str, Any] = {
            "id": str(eid),
            "type": type,
            "content": content,
            "source_type": source_type,
            "importance": importance,
            "activation": activation,
            "confidence": confidence,
            "tenant_id": tenant_id,
            "superseded": superseded,
        }
        if embedding is not None:
            assert len(embedding) == 768, "engrams.embedding is halfvec(768)"
            params["embedding"] = _to_pg_vector_str(embedding)
            sql = text(
                "INSERT INTO engrams (id, type, content, source_type, importance, "
                "activation, confidence, tenant_id, superseded, embedding) "
                "VALUES (CAST(:id AS uuid), :type, :content, :source_type, :importance, "
                ":activation, :confidence, CAST(:tenant_id AS uuid), :superseded, "
                "CAST(:embedding AS halfvec))"
            )
        else:
            sql = text(
                "INSERT INTO engrams (id, type, content, source_type, importance, "
                "activation, confidence, tenant_id, superseded) "
                "VALUES (CAST(:id AS uuid), :type, :content, :source_type, :importance, "
                ":activation, :confidence, CAST(:tenant_id AS uuid), :superseded)"
            )
        await db_session.execute(sql, params)
        await db_session.flush()
        return eid

    return _make


@pytest_asyncio.fixture(loop_scope="session")
async def edge_factory(db_session):
    """Insert an engram_edge.

    Returns the inserted edge's UUID.
    """

    async def _make(
        *,
        source: uuid.UUID,
        target: uuid.UUID,
        relation: str = "related_to",
        weight: float = 0.5,
        co_activations: int = 1,
    ) -> uuid.UUID:
        eid = uuid.uuid4()
        await db_session.execute(
            text(
                "INSERT INTO engram_edges (id, source_id, target_id, relation, weight, co_activations) "
                "VALUES (CAST(:id AS uuid), CAST(:src AS uuid), CAST(:tgt AS uuid), :rel, :w, :coa)"
            ),
            {
                "id": str(eid),
                "src": str(source),
                "tgt": str(target),
                "rel": relation,
                "w": weight,
                "coa": co_activations,
            },
        )
        await db_session.flush()
        return eid

    return _make


_DEFAULT_LLM_FIXTURE_DIR = _Path(__file__).parent / "fixtures" / "llm"


@pytest.fixture
def fake_llm_factory():
    """Returns a callable that constructs a fake_llm async function.

    The factory pattern lets tests override extra_normalizers.
    Default mode: replay from LLM_FIXTURE_DIR.
    Set RECORD_LLM_FIXTURES=1 to record (separate task).
    """

    def _factory(*, extra_normalizers=()):
        fixture_dir = _Path(os.environ.get("LLM_FIXTURE_DIR", _DEFAULT_LLM_FIXTURE_DIR))

        async def _fake_llm(*, prompt: str, model: str, **kwargs) -> str:
            key = _hash_prompt(prompt, extra_normalizers=extra_normalizers)
            path = fixture_dir / f"{key}.json"
            if not path.exists():
                if os.environ.get("RECORD_LLM_FIXTURES") == "1":
                    raise NotImplementedError(
                        "Record mode not yet implemented (Task 1.9)"
                    )
                raise FileNotFoundError(
                    f"No LLM fixture for prompt key={key} at {path}. "
                    f"Run with RECORD_LLM_FIXTURES=1 to record. Prompt prefix: "
                    f"{prompt[:80]!r}"
                )
            data = _json.loads(path.read_text())
            return data["response"]

        return _fake_llm

    return _factory


@pytest.fixture
def fake_llm(fake_llm_factory):
    """Default fake_llm with no extra normalizers."""
    return fake_llm_factory()
