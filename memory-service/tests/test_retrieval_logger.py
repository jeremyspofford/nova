"""Unit tests for memory-service/app/engram/retrieval_logger.py.

Strategy
--------
* `log_retrieval` and `mark_engrams_used` accept an AsyncSession directly --
  the `db_session` fixture (BEGIN...ROLLBACK) is passed straight through.
* `_train_redis` is the module-level Redis singleton used by the internal
  `_maybe_emit_train_signal` helper.  We monkeypatch it to a no-op stub so
  tests do not need a real db6 connection.
* `engram_factory` creates real engram rows so UUID foreign-key references in
  `engrams_surfaced` are valid.
* `to_pg_vector` is used by the module for halfvec serialisation -- we verify
  the round-trip by reading the stored value back from the DB.
"""

from __future__ import annotations

import uuid

import pytest
from app.engram import retrieval_logger
from sqlalchemy import text

# constants

_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"
_ALT_TENANT = "00000000-0000-0000-0000-000000000002"

_ZERO_EMBEDDING = [0.0] * 768


# helpers


class _FakeTrainRedis:
    """Drop-in for the internal _train_redis singleton -- ignores all calls."""

    async def get(self, *_a, **_kw):
        return None

    async def lpush(self, *_a, **_kw):
        return 0

    async def set(self, *_a, **_kw):
        return True


def _patch_train_redis(monkeypatch):
    """Replace the lazy Redis singleton with a no-op stub."""
    monkeypatch.setattr(retrieval_logger, "_train_redis", _FakeTrainRedis())


async def _fetch_log_row(session, log_id: str):
    """Return the retrieval_log row for *log_id*, or None."""
    result = await session.execute(
        text("SELECT * FROM retrieval_log WHERE id = CAST(:id AS uuid)"),
        {"id": log_id},
    )
    return result.fetchone()


# tests


@pytest.mark.asyncio
async def test_insert_observation_persists_row(db_session, engram_factory, monkeypatch):
    """log_retrieval inserts a row that can be read back from the DB."""
    _patch_train_redis(monkeypatch)
    eid = await engram_factory(content="test engram for retrieval log")

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=_ZERO_EMBEDDING,
        query_text="what is the sky?",
        engram_ids_surfaced=[str(eid)],
    )

    assert log_id is not None, "log_retrieval should return a non-None id on success"

    row = await _fetch_log_row(db_session, log_id)
    assert row is not None, "Expected a row in retrieval_log for the returned id"
    assert row.query_text == "what is the sky?"


@pytest.mark.asyncio
async def test_tenant_id_propagated_to_log_row(db_session, engram_factory, monkeypatch):
    """tenant_id passed to log_retrieval appears on the persisted row."""
    _patch_train_redis(monkeypatch)
    eid = await engram_factory(content="tenant test engram", tenant_id=_ALT_TENANT)

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=_ZERO_EMBEDDING,
        query_text="tenant check",
        engram_ids_surfaced=[str(eid)],
        tenant_id=_ALT_TENANT,
    )

    assert log_id is not None
    row = await _fetch_log_row(db_session, log_id)
    assert row is not None
    assert str(row.tenant_id) == _ALT_TENANT


@pytest.mark.asyncio
async def test_engrams_used_backfill_updates_existing_row(
    db_session, engram_factory, monkeypatch
):
    """mark_engrams_used fills engrams_used on the row created by log_retrieval."""
    _patch_train_redis(monkeypatch)
    e1 = await engram_factory(content="engram used A")
    e2 = await engram_factory(content="engram used B")

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=_ZERO_EMBEDDING,
        query_text="backfill test",
        engram_ids_surfaced=[str(e1), str(e2)],
    )
    assert log_id is not None

    # Before backfill -- engrams_used should be NULL
    row_before = await _fetch_log_row(db_session, log_id)
    assert row_before.engrams_used is None

    await retrieval_logger.mark_engrams_used(db_session, log_id, [str(e1)])

    row_after = await _fetch_log_row(db_session, log_id)
    assert row_after.engrams_used is not None, (
        "engrams_used should be set after backfill"
    )
    used_strs = [str(u) for u in row_after.engrams_used]
    assert str(e1) in used_strs
    assert str(e2) not in used_strs


@pytest.mark.asyncio
async def test_backfill_idempotent_second_call_no_op(
    db_session, engram_factory, monkeypatch
):
    """Calling mark_engrams_used twice does not raise or corrupt the row."""
    _patch_train_redis(monkeypatch)
    eid = await engram_factory(content="idempotent backfill engram")

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=_ZERO_EMBEDDING,
        query_text="idempotent test",
        engram_ids_surfaced=[str(eid)],
    )
    assert log_id is not None

    await retrieval_logger.mark_engrams_used(db_session, log_id, [str(eid)])
    # Second call -- should not raise
    await retrieval_logger.mark_engrams_used(db_session, log_id, [str(eid)])

    row = await _fetch_log_row(db_session, log_id)
    used_strs = [str(u) for u in row.engrams_used]
    assert str(eid) in used_strs


@pytest.mark.asyncio
async def test_log_id_returned_from_insert(db_session, engram_factory, monkeypatch):
    """The returned log_id is a valid UUID that matches the inserted row PK."""
    _patch_train_redis(monkeypatch)
    eid = await engram_factory(content="log id check engram")

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=_ZERO_EMBEDDING,
        query_text="log id test",
        engram_ids_surfaced=[str(eid)],
    )

    assert log_id is not None
    # Must be parseable as a UUID
    parsed = uuid.UUID(log_id)
    assert str(parsed) == log_id

    # The PK in the DB must match
    row = await _fetch_log_row(db_session, log_id)
    assert row is not None
    assert str(row.id) == log_id


@pytest.mark.asyncio
async def test_query_embedding_persisted_as_halfvec(
    db_session, engram_factory, monkeypatch
):
    """A 768-dim embedding round-trips through the halfvec column without error."""
    _patch_train_redis(monkeypatch)
    eid = await engram_factory(content="halfvec test engram")

    # Non-trivial embedding -- alternating 0.1 / -0.1
    embedding = [0.1 if i % 2 == 0 else -0.1 for i in range(768)]

    log_id = await retrieval_logger.log_retrieval(
        db_session,
        query_embedding=embedding,
        query_text="halfvec round-trip",
        engram_ids_surfaced=[str(eid)],
    )

    assert log_id is not None, "Insertion with a real embedding should succeed"

    # Confirm the row exists; halfvec stored successfully (no type error)
    row = await _fetch_log_row(db_session, log_id)
    assert row is not None
    assert row.query_embedding is not None, "query_embedding should be stored"
