"""Unit tests for memory-service/app/engram/neural_router/train.py.

Strategy
--------
* _parse_pgvector, _precision_at_k are pure functions — tested directly.
* assemble_training_data / save_model use get_db() internally — patched via
  monkeypatch to inject the test db_session so we can verify DB behaviour
  against a real PostgreSQL instance without triggering real training.
* train_model runs real PyTorch but only on tiny synthetic data; tests verify
  split sizes, early-stopping guard, and precision-type — not convergence.
* No unittest.mock; no real embedding-dimension tensors for speed-sensitive paths.
"""

from __future__ import annotations

import io
import uuid
from contextlib import asynccontextmanager

import pytest
import torch
from app.engram.neural_router import train
from app.engram.neural_router.model import ScalarReranker
from sqlalchemy import text

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


def _make_get_db(session):
    """Return a drop-in async context manager that yields *session*."""

    @asynccontextmanager
    async def _get_db():
        yield session

    return _get_db


def _scalar_example(label: float = 0.0) -> dict:
    """Minimal training example matching assemble_training_data output shape."""
    return {
        "scalar_features": [0.0] * 25,
        "query_embedding": None,
        "engram_embedding": None,
        "label": label,
    }


async def _insert_retrieval_log(
    session,
    *,
    tenant_id: str = _DEFAULT_TENANT,
    engrams_surfaced: list[str],
    engrams_used: list[str] | None = None,
) -> None:
    """Insert a retrieval_log row with surfaced / used UUID arrays.

    asyncpg requires Python lists (not '{...}' strings) for array parameters.
    We build the literal array in SQL so we stay with named params.
    """
    # Build unnest-based insert so we pass the UUIDs as individual columns
    # instead of trying to pass an array object that asyncpg can't coerce.
    surfaced_literals = ", ".join(f"'{eid}'" for eid in engrams_surfaced)
    if engrams_used is not None:
        used_literals = ", ".join(f"'{eid}'" for eid in engrams_used)
        used_expr = f"ARRAY[{used_literals}]::uuid[]"
    else:
        used_expr = "NULL"

    await session.execute(
        text(f"""
            INSERT INTO retrieval_log
                (tenant_id, engrams_surfaced, engrams_used)
            VALUES
                (CAST(:tid AS uuid),
                 ARRAY[{surfaced_literals}]::uuid[],
                 {used_expr})
        """),  # noqa: S608 — test helper only, no user input
        {"tid": tenant_id},
    )
    await session.flush()


async def _insert_model_row(
    session,
    *,
    tenant_id: str = _DEFAULT_TENANT,
    precision: float = 0.5,
    is_active: bool = True,
    architecture: str = "scalar",
) -> uuid.UUID:
    """Insert a neural_router_models row; returns its UUID."""
    model_id = uuid.uuid4()
    buf = io.BytesIO()
    torch.save(ScalarReranker().state_dict(), buf)
    weights = buf.getvalue()
    await session.execute(
        text("""
            INSERT INTO neural_router_models
                (id, tenant_id, architecture, weights, observation_count,
                 validation_precision_at_k, is_active)
            VALUES
                (CAST(:id AS uuid), CAST(:tid AS uuid), :arch, :weights,
                 :obs, :prec, :active)
        """),
        {
            "id": str(model_id),
            "tid": tenant_id,
            "arch": architecture,
            "weights": weights,
            "obs": 10,
            "prec": precision,
            "active": is_active,
        },
    )
    await session.flush()
    return model_id


# ---------------------------------------------------------------------------
# _parse_pgvector — pure function
# ---------------------------------------------------------------------------


def test_parse_pgvector_valid_string():
    result = train._parse_pgvector("[0.1,0.2,0.3]")
    assert result == pytest.approx([0.1, 0.2, 0.3])


def test_parse_pgvector_returns_none_for_none_input():
    assert train._parse_pgvector(None) is None


def test_parse_pgvector_returns_none_for_malformed_input():
    assert train._parse_pgvector("not-a-vector") is None


# ---------------------------------------------------------------------------
# _precision_at_k — pure function
# ---------------------------------------------------------------------------


def test_precision_at_k_known_input_known_output():
    # Top-2 by score are indices 0 (score 0.9, label 1) and 1 (score 0.8, label 0)
    # → 1 positive out of 2 → 0.5
    scores = [0.9, 0.8, 0.2, 0.1]
    labels = [1.0, 0.0, 1.0, 1.0]
    assert train._precision_at_k(scores, labels, k=2) == pytest.approx(0.5)


def test_precision_at_k_all_positive_in_top_k():
    scores = [0.9, 0.8, 0.3]
    labels = [1.0, 1.0, 0.0]
    assert train._precision_at_k(scores, labels, k=2) == pytest.approx(1.0)


def test_precision_at_k_handles_empty_scores():
    assert train._precision_at_k([], [1.0, 0.0], k=5) == 0.0


def test_precision_at_k_k_larger_than_list_clips_to_list():
    # k=10 but only 3 items — should not crash, denominator = 3
    scores = [0.9, 0.8, 0.7]
    labels = [1.0, 0.0, 1.0]
    result = train._precision_at_k(scores, labels, k=10)
    assert result == pytest.approx(2 / 3)


# ---------------------------------------------------------------------------
# train_model — split sizing (no DB, no GPU, deterministic)
# ---------------------------------------------------------------------------


def test_train_model_returns_none_when_too_few_examples():
    """Fewer than 10 examples → training guard returns None."""
    examples = [_scalar_example(label=float(i % 2)) for i in range(5)]
    result = train.train_model(examples, obs_count=5)
    assert result is None


def test_train_model_validation_split_size_matches_config(monkeypatch):
    """train_model splits at (1 - validation_split)*N — verify the val set size.

    We capture the precision returned which is computed on val_examples[split_idx:].
    We do NOT assert convergence — just that the function returns a float precision
    (confirming split was large enough to pass the ≥5 guard).
    """

    class _FakeSettings:
        neural_router_validation_split = 0.2
        neural_router_embedding_threshold = 10_000  # force scalar arch
        neural_router_training_epochs = 1
        neural_router_learning_rate = 1e-3

    monkeypatch.setattr(train, "settings", _FakeSettings())

    # 50 examples → val = 50 * 0.2 = 10 ≥ 5 guard → should succeed
    examples = [_scalar_example(label=float(i % 2)) for i in range(50)]
    result = train.train_model(examples, obs_count=50)

    assert result is not None
    _, arch_name, precision = result
    assert arch_name == "scalar"
    assert isinstance(precision, float)
    assert 0.0 <= precision <= 1.0


def test_train_model_returns_none_when_val_set_too_small(monkeypatch):
    """validation_split=0.05 on 30 examples → val=1 < 5 guard → None."""

    class _FakeSettings:
        neural_router_validation_split = 0.05
        neural_router_embedding_threshold = 10_000
        neural_router_training_epochs = 1
        neural_router_learning_rate = 1e-3

    monkeypatch.setattr(train, "settings", _FakeSettings())

    examples = [_scalar_example(label=float(i % 2)) for i in range(30)]
    result = train.train_model(examples, obs_count=30)
    assert result is None


# ---------------------------------------------------------------------------
# assemble_training_data — DB-backed data assembly
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_assemble_training_data_excludes_rows_with_null_engrams_used(
    db_session, engram_factory, monkeypatch
):
    """Rows where engrams_used IS NULL must be filtered by the SQL WHERE clause."""
    eid = await engram_factory(content="some engram")
    # Insert row with null engrams_used
    await _insert_retrieval_log(
        db_session,
        engrams_surfaced=[str(eid)],
        engrams_used=None,
    )

    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))
    examples = await train.assemble_training_data(_DEFAULT_TENANT)
    # Null-used rows excluded — zero examples built from this log row
    assert examples == []


@pytest.mark.asyncio
async def test_assemble_training_data_builds_example_per_surfaced_engram(
    db_session, engram_factory, monkeypatch
):
    """One retrieval_log row with 2 surfaced engrams → 2 training examples."""
    e1 = await engram_factory(content="engram-A", importance=0.7)
    e2 = await engram_factory(content="engram-B", importance=0.4)

    await _insert_retrieval_log(
        db_session,
        engrams_surfaced=[str(e1), str(e2)],
        engrams_used=[str(e1)],  # only e1 was used
    )

    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))

    # Also patch max_training_obs so we don't trip the cap
    class _FakeSettings:
        neural_router_max_training_obs = 500

    monkeypatch.setattr(train, "settings", _FakeSettings())
    examples = await train.assemble_training_data(_DEFAULT_TENANT)

    assert len(examples) == 2
    labels = {ex["label"] for ex in examples}
    # One used (1.0), one not (0.0)
    assert 1.0 in labels
    assert 0.0 in labels


@pytest.mark.asyncio
async def test_assemble_training_data_observation_cap(
    db_session, engram_factory, monkeypatch
):
    """When max_training_obs=1, only the most recent log row is fetched."""

    class _FakeSettings:
        neural_router_max_training_obs = 1  # cap to 1 observation

    monkeypatch.setattr(train, "settings", _FakeSettings())
    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))

    # Two engrams, two log rows
    e1 = await engram_factory(content="cap-engram-A")
    e2 = await engram_factory(content="cap-engram-B")
    await _insert_retrieval_log(
        db_session,
        engrams_surfaced=[str(e1)],
        engrams_used=[str(e1)],
    )
    await _insert_retrieval_log(
        db_session,
        engrams_surfaced=[str(e2)],
        engrams_used=[str(e2)],
    )

    examples = await train.assemble_training_data(_DEFAULT_TENANT)
    # Cap=1 → only 1 observation fetched → at most 1 engram's examples
    assert len(examples) <= 1


# ---------------------------------------------------------------------------
# save_model — promotion and retention policy
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_model_promoted_when_gain_meets_threshold(db_session, monkeypatch):
    """New model with precision above current → is_active flips to new row."""

    class _FakeSettings:
        neural_router_min_precision_gain = 0.0
        neural_router_max_inactive_models = 5

    monkeypatch.setattr(train, "settings", _FakeSettings())
    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))

    # Insert existing active model with precision 0.4
    await _insert_model_row(db_session, precision=0.4, is_active=True)

    stub_model = ScalarReranker()
    promoted = await train.save_model(
        stub_model, "scalar", precision=0.5, obs_count=50, tenant_id=_DEFAULT_TENANT
    )
    assert promoted is True

    # New row should be active; old row should be inactive
    result = await db_session.execute(
        text("""
            SELECT COUNT(*) AS cnt
            FROM neural_router_models
            WHERE tenant_id = CAST(:tid AS uuid) AND is_active
        """),
        {"tid": _DEFAULT_TENANT},
    )
    assert result.scalar() == 1


@pytest.mark.asyncio
async def test_model_not_promoted_below_threshold(db_session, monkeypatch):
    """New model whose precision doesn't beat current → promoted=False, old stays active."""

    class _FakeSettings:
        neural_router_min_precision_gain = 0.1  # require 10% gain
        neural_router_max_inactive_models = 5

    monkeypatch.setattr(train, "settings", _FakeSettings())
    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))

    await _insert_model_row(db_session, precision=0.5, is_active=True)

    stub_model = ScalarReranker()
    # New precision 0.55 < 0.5 + 0.1 = 0.60 → not promoted
    promoted = await train.save_model(
        stub_model, "scalar", precision=0.55, obs_count=50, tenant_id=_DEFAULT_TENANT
    )
    assert promoted is False

    # Original active row should still be active
    result = await db_session.execute(
        text("""
            SELECT validation_precision_at_k
            FROM neural_router_models
            WHERE tenant_id = CAST(:tid AS uuid) AND is_active
        """),
        {"tid": _DEFAULT_TENANT},
    )
    row = result.fetchone()
    assert row is not None
    assert float(row.validation_precision_at_k) == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_inactive_models_pruned_to_max(db_session, monkeypatch):
    """After save, inactive model count is capped at neural_router_max_inactive_models."""

    class _FakeSettings:
        neural_router_min_precision_gain = (
            99.0  # never promote → new model stored inactive
        )
        neural_router_max_inactive_models = 2

    monkeypatch.setattr(train, "settings", _FakeSettings())
    monkeypatch.setattr(train, "get_db", _make_get_db(db_session))

    # Insert 2 inactive models (high precision so new model won't replace active)
    await _insert_model_row(db_session, precision=0.8, is_active=True)
    await _insert_model_row(db_session, precision=0.3, is_active=False)
    await _insert_model_row(db_session, precision=0.2, is_active=False)

    stub_model = ScalarReranker()
    # precision=0.1 < 0.8 + 99 → stored as inactive → triggers prune
    await train.save_model(
        stub_model, "scalar", precision=0.1, obs_count=10, tenant_id=_DEFAULT_TENANT
    )

    result = await db_session.execute(
        text("""
            SELECT COUNT(*) AS cnt
            FROM neural_router_models
            WHERE tenant_id = CAST(:tid AS uuid) AND NOT is_active
        """),
        {"tid": _DEFAULT_TENANT},
    )
    inactive_count = result.scalar()
    assert inactive_count <= 2
