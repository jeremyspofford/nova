"""Unit tests for memory-service/app/engram/ingestion.py.

Strategy
--------
* `decompose` is monkeypatched in `app.engram.ingestion` to return a canned
  DecompositionResult — no LLM gateway required.
* `get_embedding` is monkeypatched to return a fixed 768-dim vector.
* `find_similar_engram`, `find_similar_engram_any_type`, `find_existing_entity`
  are monkeypatched to return None (no dedup collisions) unless a test
  specifically exercises dedup.
* `find_or_create_source`, `notify_new_engrams`, `emit_to_cortex` are
  monkeypatched to no-ops to avoid external calls.
* `get_redis` in `app.engram.ingestion` is monkeypatched to return
  `redis_test` so the queue-worker tests use the real isolated Redis.
* The `db_session` fixture wraps each test in BEGIN…ROLLBACK, so inserts
  are not persisted between tests.

Source-type → source-kind mapping
-----------------------------------
`test_source_kind_mapping.py` already covers the `screenpipe` and `unknown`
fallback cases.  This file covers the remaining six explicit mappings
(chat, intel, knowledge, pipeline, consolidation, self_reflection) plus the
aliases (tool → task_output, cortex → task_output, journal → manual_paste,
external → knowledge_crawl) as pure-function tests.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

import pytest
from app.engram import ingestion as _ing
from nova_contracts.engram import (
    DecomposedEngram,
    DecompositionResult,
    EngramType,
)
from sqlalchemy import text

# ── Fixed embedding used by all tests ─────────────────────────────────────────

_FIXED_EMBEDDING = [0.01] * 768


# ── Helpers ───────────────────────────────────────────────────────────────────


def _canned_result(
    content: str = "The sky is blue.", source_type: str = "chat"
) -> DecompositionResult:
    """Minimal single-engram DecompositionResult for happy-path stubs."""
    return DecompositionResult(
        engrams=[
            DecomposedEngram(
                type=EngramType.fact,
                content=content,
                importance=0.6,
                entities_referenced=[],
                temporal={},
                temporal_validity="permanent",
            )
        ],
        relationships=[],
        contradictions=[],
    )


def _make_payload(
    content: str = "The sky is blue.",
    source_type: str = "chat",
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
    source_id: str | None = None,
) -> str:
    return json.dumps(
        {
            "raw_text": content,
            "source_type": source_type,
            "source_id": source_id,
            "session_id": None,
            "occurred_at": None,
            "metadata": {},
            "tenant_id": tenant_id,
        }
    )


# ── Shared monkeypatching helpers ──────────────────────────────────────────────


def _patch_all_no_ops(
    monkeypatch, *, decompose_result: DecompositionResult | None = None
):
    """Patch every external call in _process_event to safe no-ops.

    Returns a dict of call-count trackers where useful.
    """
    result = decompose_result or _canned_result()
    monkeypatch.setattr(_ing, "decompose", _async_return(result))
    monkeypatch.setattr(_ing, "get_embedding", _async_return(_FIXED_EMBEDDING))
    monkeypatch.setattr(_ing, "find_existing_entity", _async_return(None))
    monkeypatch.setattr(_ing, "find_similar_engram", _async_return(None))
    monkeypatch.setattr(_ing, "find_similar_engram_any_type", _async_return(None))
    monkeypatch.setattr(_ing, "find_contradiction_candidates", _async_return([]))
    monkeypatch.setattr(_ing, "update_existing_engram", _async_return(None))
    monkeypatch.setattr(_ing, "notify_new_engrams", lambda _n: None)
    monkeypatch.setattr(_ing, "emit_to_cortex", _async_return(None))

    # Patch the lazily-imported sources helpers
    import app.engram.sources as _src

    monkeypatch.setattr(_src, "find_or_create_source", _async_return(None))
    monkeypatch.setattr(_src, "generate_source_summary", _async_return(None))
    monkeypatch.setattr(_src, "update_source_summary", _async_return(None))


def _async_return(value):
    """Return a coroutine function that always returns `value`."""

    async def _inner(*_args, **_kwargs):
        return value

    return _inner


# ── Source-type → source-kind mapping (pure function, no DB/Redis) ─────────────

# test_source_kind_mapping.py already covers: screenpipe, unknown.
# We cover the remaining explicit entries here.


def test_chat_source_type_maps_to_chat_kind():
    assert _ing._map_source_type_to_kind("chat") == "chat"


def test_intel_source_type_maps_to_intel_feed():
    assert _ing._map_source_type_to_kind("intel") == "intel_feed"


def test_knowledge_source_type_maps_to_knowledge_crawl():
    assert _ing._map_source_type_to_kind("knowledge") == "knowledge_crawl"


def test_pipeline_source_type_maps_to_pipeline_extraction():
    assert _ing._map_source_type_to_kind("pipeline") == "pipeline_extraction"


def test_consolidation_source_type_maps_to_consolidation():
    assert _ing._map_source_type_to_kind("consolidation") == "consolidation"


def test_self_reflection_source_type_maps_to_consolidation():
    assert _ing._map_source_type_to_kind("self_reflection") == "consolidation"


def test_tool_alias_maps_to_task_output():
    assert _ing._map_source_type_to_kind("tool") == "task_output"


def test_cortex_alias_maps_to_task_output():
    assert _ing._map_source_type_to_kind("cortex") == "task_output"


def test_journal_alias_maps_to_manual_paste():
    assert _ing._map_source_type_to_kind("journal") == "manual_paste"


def test_external_alias_maps_to_knowledge_crawl():
    assert _ing._map_source_type_to_kind("external") == "knowledge_crawl"


# ── Worker loop — BLMOVE semantics ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_blmove_timeout_returns_to_loop(redis_test, monkeypatch):
    """If BLMOVE times out (returns None), the loop continues without crashing."""
    # Make BLMOVE return None immediately to simulate timeout
    blmove_call_count = [0]

    async def _fake_blmove(*_args, **_kwargs):
        blmove_call_count[0] += 1
        return None  # timeout

    monkeypatch.setattr(redis_test, "blmove", _fake_blmove)
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    # Patch settings so ingestion is enabled but loop exits quickly
    from app.config import settings as _settings

    monkeypatch.setattr(_settings, "engram_ingestion_enabled", True)
    monkeypatch.setattr(_settings, "engram_ingestion_batch_timeout", 0)

    # Run the loop with a CancelledError after 2 blmove calls
    cancel_after = [2]

    async def _counting_blmove(*_args, **_kwargs):
        count = blmove_call_count[0]
        blmove_call_count[0] += 1
        if count >= cancel_after[0]:
            raise asyncio.CancelledError
        return None

    monkeypatch.setattr(redis_test, "blmove", _counting_blmove)

    # Should complete cleanly (CancelledError is caught internally and breaks loop)
    await _ing.ingestion_loop()

    assert blmove_call_count[0] >= cancel_after[0], "BLMOVE was never called"


@pytest.mark.asyncio
async def test_worker_pops_message_via_blmove(redis_test, monkeypatch):
    """Worker calls BLMOVE with src=RIGHT, dest=LEFT (atomically moves from queue tail to processing head)."""
    blmove_kwargs_captured = {}
    call_count = [0]

    async def _capturing_blmove(src_key, dst_key, timeout, *, src, dest):
        blmove_kwargs_captured["src_key"] = src_key
        blmove_kwargs_captured["dst_key"] = dst_key
        blmove_kwargs_captured["src"] = src
        blmove_kwargs_captured["dest"] = dest
        call_count[0] += 1
        if call_count[0] >= 2:
            raise asyncio.CancelledError
        return None  # timeout on first call

    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)
    monkeypatch.setattr(redis_test, "blmove", _capturing_blmove)

    from app.config import settings as _settings

    monkeypatch.setattr(_settings, "engram_ingestion_enabled", True)
    monkeypatch.setattr(_settings, "engram_ingestion_batch_timeout", 0)

    await _ing.ingestion_loop()

    assert blmove_kwargs_captured["src"] == "RIGHT", "BLMOVE must pop from RIGHT (FIFO)"
    assert blmove_kwargs_captured["dest"] == "LEFT", (
        "BLMOVE must push to LEFT of processing list"
    )
    assert "processing" in blmove_kwargs_captured["dst_key"], (
        "Destination must be the processing list"
    )


@pytest.mark.asyncio
async def test_worker_processes_message_from_queue(db_session, redis_test, monkeypatch):
    """A pushed message is processed end-to-end (decompose called, engram inserted)."""
    _patch_all_no_ops(monkeypatch)
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    # Wire the session produced by _process_event to our test transaction
    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    payload = _make_payload("Hydrogen is the lightest element.")
    decompose_calls = [0]
    real_result = _canned_result("Hydrogen is the lightest element.")

    async def _counting_decompose(text, *, source_type="chat"):
        decompose_calls[0] += 1
        return real_result

    monkeypatch.setattr(_ing, "decompose", _counting_decompose)

    await _ing._process_event(payload)

    assert decompose_calls[0] == 1, "decompose should be called exactly once per event"


# ── Backpressure — Semaphore(5) ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_six_concurrent_payloads_run_five_in_parallel(
    db_session, redis_test, monkeypatch
):
    """Launching 6 concurrent _process_event_guarded calls → at most 5 run concurrently."""
    _patch_all_no_ops(monkeypatch)
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    # Track peak concurrency inside _process_event
    active = [0]
    peak = [0]
    gate = asyncio.Event()

    async def _slow_decompose(text, *, source_type="chat"):
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await gate.wait()  # block until released
        active[0] -= 1
        return _canned_result(text)

    monkeypatch.setattr(_ing, "decompose", _slow_decompose)

    # Patch lrem so the processing-list cleanup doesn't fail (no real processing list)
    async def _noop_lrem(*_a, **_kw):
        return 0

    monkeypatch.setattr(redis_test, "lrem", _noop_lrem)

    processing_list = _ing._processing_list_name()

    # Launch 6 guarded tasks
    tasks = [
        asyncio.create_task(
            _ing._process_event_guarded(
                _make_payload(f"fact number {i}"),
                f"fact number {i}".encode(),
                processing_list,
            )
        )
        for i in range(6)
    ]

    # Give tasks time to acquire the semaphore and reach the gate
    await asyncio.sleep(0.05)

    assert peak[0] <= 5, f"Semaphore(5) violated: {peak[0]} tasks ran concurrently"
    assert active[0] <= 5, "More than 5 tasks active simultaneously"

    # Release all blocked tasks and await completion
    gate.set()
    await asyncio.gather(*tasks)


@pytest.mark.asyncio
async def test_semaphore_releases_after_each_payload(
    db_session, redis_test, monkeypatch
):
    """Semaphore is released after each payload so subsequent payloads can run."""
    _patch_all_no_ops(monkeypatch)
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    async def _noop_lrem(*_a, **_kw):
        return 0

    monkeypatch.setattr(redis_test, "lrem", _noop_lrem)

    processing_list = _ing._processing_list_name()

    # Run 6 sequential payloads — all should complete (semaphore was released each time)
    for i in range(6):
        await _ing._process_event_guarded(
            _make_payload(f"sequential fact {i}"),
            f"sequential fact {i}".encode(),
            processing_list,
        )

    # If the semaphore were leaked, subsequent tasks would deadlock / timeout.
    # Reaching here means semaphore was properly released 6 times.
    assert _ing._decomposition_semaphore._value == 5, (
        "Semaphore should be back to 5 after all payloads finished"
    )


# ── Dedup ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_same_content_hash_skips_second_insert(
    db_session, redis_test, monkeypatch
):
    """Identical content → embedding similarity collapses second insert into first (dedup)."""
    _patch_all_no_ops(monkeypatch)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    unique_content = f"unique-dedup-test-{uuid.uuid4()}"
    payload = _make_payload(unique_content)

    # First call — no existing match, inserts a new engram
    result1 = await _ing._process_event(payload)
    assert result1["engrams_created"] == 1, "First insert should create 1 engram"
    first_id = result1["engram_ids"][0]

    # Simulate what happens on a second identical call:
    # find_similar_engram now returns the first engram (dedup collision).
    async def _return_first(*_args, **_kwargs):
        row = await db_session.execute(
            text("SELECT id, importance FROM engrams WHERE id = CAST(:id AS uuid)"),
            {"id": str(first_id)},
        )
        r = row.fetchone()
        if r:
            return {"id": r.id, "importance": r.importance, "type": "fact"}
        return None

    monkeypatch.setattr(_ing, "find_similar_engram", _return_first)
    monkeypatch.setattr(_ing, "find_similar_engram_any_type", _return_first)

    result2 = await _ing._process_event(payload)

    # Second call should NOT create a new engram — it should update the existing one
    assert result2["engrams_created"] == 0, (
        "Dedup should suppress second insert for identical content"
    )
    assert result2["engrams_updated"] == 1, "Dedup should count as an update"


@pytest.mark.asyncio
async def test_different_source_id_same_content_inserts_separately(
    db_session, redis_test, monkeypatch
):
    """Without dedup collision, same content from different sources creates two engrams."""
    _patch_all_no_ops(monkeypatch)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    # Different UUIDs as source_id → provenance is different
    src_a = str(uuid.uuid4())
    src_b = str(uuid.uuid4())
    content = f"same text two sources {uuid.uuid4()}"

    payload_a = _make_payload(content, source_id=src_a)
    payload_b = _make_payload(content, source_id=src_b)

    # find_similar_engram always returns None → no dedup
    result_a = await _ing._process_event(payload_a)
    result_b = await _ing._process_event(payload_b)

    assert result_a["engrams_created"] == 1
    assert result_b["engrams_created"] == 1, (
        "Without dedup match, second call should create its own engram"
    )
    assert result_a["engram_ids"][0] != result_b["engram_ids"][0], (
        "Each insert produces a distinct UUID"
    )


# ── Error handling ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_malformed_json_payload_logged_and_dropped(
    redis_test, monkeypatch, caplog
):
    """Malformed JSON → logged at WARNING, dropped, no crash, processing list cleaned."""
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    from app.config import settings as _settings

    monkeypatch.setattr(_settings, "engram_ingestion_enabled", True)
    monkeypatch.setattr(_settings, "engram_ingestion_batch_timeout", 0)

    call_count = [0]
    malformed = b"this is not json {"

    async def _one_shot_blmove(src_key, dst_key, timeout, *, src, dest):
        call_count[0] += 1
        if call_count[0] == 1:
            return malformed
        raise asyncio.CancelledError

    monkeypatch.setattr(redis_test, "blmove", _one_shot_blmove)

    async def _fake_lrem(key, count, value):
        return 1  # indicate successful removal

    monkeypatch.setattr(redis_test, "lrem", _fake_lrem)

    with caplog.at_level(logging.WARNING, logger="app.engram.ingestion"):
        await _ing.ingestion_loop()

    assert any(
        "Malformed" in r.message or "not valid JSON" in r.message
        for r in caplog.records
    ), "Expected a WARNING about malformed JSON"


@pytest.mark.asyncio
async def test_missing_required_field_payload_dropped(db_session, monkeypatch, caplog):
    """Payload missing `raw_text` → _process_event returns empty result (no crash)."""
    _patch_all_no_ops(monkeypatch, decompose_result=DecompositionResult())

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    # Empty raw_text triggers early return in _process_event
    payload = json.dumps(
        {
            "raw_text": "",
            "source_type": "chat",
            "tenant_id": "00000000-0000-0000-0000-000000000001",
        }
    )
    result = await _ing._process_event(payload)

    assert result["engrams_created"] == 0
    assert result["engrams_updated"] == 0
    assert result["engram_ids"] == []


@pytest.mark.asyncio
async def test_llm_gateway_error_drops_payload_and_continues(
    db_session, redis_test, monkeypatch, caplog
):
    """LLM gateway raises exception → payload caught in _process_event_guarded, loop continues."""
    monkeypatch.setattr(_ing, "get_redis", lambda: redis_test)

    async def _failing_decompose(*_args, **_kwargs):
        raise RuntimeError("LLM gateway exploded")

    monkeypatch.setattr(_ing, "decompose", _failing_decompose)

    async def _noop_lrem(*_a, **_kw):
        return 1

    monkeypatch.setattr(redis_test, "lrem", _noop_lrem)

    processing_list = _ing._processing_list_name()

    with caplog.at_level(logging.ERROR, logger="app.engram.ingestion"):
        # Should not raise — exception is swallowed inside _process_event_guarded
        await _ing._process_event_guarded(
            _make_payload("some content"),
            b"some content",
            processing_list,
        )

    assert any(
        "ingestion failed" in r.message.lower()
        or "Engram ingestion failed" in r.message
        for r in caplog.records
    ), "Expected an error-level log from _process_event_guarded"


@pytest.mark.asyncio
async def test_empty_decomposition_result_produces_no_engrams(db_session, monkeypatch):
    """decompose() returning zero engrams → no DB inserts, result counts are 0."""
    _patch_all_no_ops(monkeypatch, decompose_result=DecompositionResult())

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    result = await _ing._process_event(_make_payload("Some meaningful text."))

    assert result["engrams_created"] == 0
    assert result["engrams_updated"] == 0
    assert result["edges_created"] == 0
    assert result["engram_ids"] == []


# ── Tenant propagation ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_payload_tenant_id_lands_on_engram(db_session, monkeypatch):
    """tenant_id from the payload propagates to the inserted engram row."""
    _patch_all_no_ops(monkeypatch)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    tenant = "00000000-0000-0000-0000-000000000099"
    content = f"tenant propagation test {uuid.uuid4()}"
    payload = _make_payload(content, tenant_id=tenant)

    result = await _ing._process_event(payload)
    assert result["engrams_created"] == 1

    engram_id = result["engram_ids"][0]
    row = await db_session.execute(
        text("SELECT tenant_id FROM engrams WHERE id = CAST(:id AS uuid)"),
        {"id": str(engram_id)},
    )
    fetched = row.fetchone()
    assert fetched is not None, "Engram should exist in DB"
    assert str(fetched.tenant_id) == tenant, (
        f"Expected tenant_id={tenant}, got {fetched.tenant_id}"
    )


@pytest.mark.asyncio
async def test_missing_tenant_id_defaults_and_warns(db_session, monkeypatch, caplog):
    """Payload without tenant_id falls back to DEFAULT_TENANT with a WARNING log."""
    _patch_all_no_ops(monkeypatch)

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(
        bind=db_session.bind,
        class_=AsyncSession,
        expire_on_commit=False,
    )
    monkeypatch.setattr(_ing, "AsyncSessionLocal", factory)

    # Omit tenant_id entirely
    payload = json.dumps(
        {"raw_text": f"no-tenant {uuid.uuid4()}", "source_type": "chat"}
    )

    with caplog.at_level(logging.WARNING, logger="app.engram.ingestion"):
        result = await _ing._process_event(payload)

    assert result["engrams_created"] == 1

    engram_id = result["engram_ids"][0]
    row = await db_session.execute(
        text("SELECT tenant_id FROM engrams WHERE id = CAST(:id AS uuid)"),
        {"id": str(engram_id)},
    )
    fetched = row.fetchone()
    assert str(fetched.tenant_id) == _ing.DEFAULT_TENANT, (
        "Missing tenant_id should default to DEFAULT_TENANT"
    )

    assert any(
        "missing tenant_id" in r.message.lower() or "tenant_id" in r.message
        for r in caplog.records
    ), "Expected a WARNING about missing tenant_id"


# ── Processing list / crash recovery ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_recover_processing_list_restores_orphaned_payloads(
    redis_test, monkeypatch
):
    """_recover_processing_list() pushes orphaned in-flight payloads back to main queue."""
    from app.config import settings as _settings

    queue = _settings.engram_ingestion_queue
    processing = _ing._processing_list_name()

    # Simulate 3 orphaned items in the processing list (from a prior crash)
    orphans = [b"orphan-1", b"orphan-2", b"orphan-3"]
    for item in orphans:
        await redis_test.lpush(processing, item)

    count = await _ing._recover_processing_list(redis_test)
    assert count == 3, "Should recover exactly 3 orphaned payloads"

    # Processing list should now be empty
    remaining = await redis_test.lrange(processing, 0, -1)
    assert remaining == [], "Processing list should be empty after recovery"

    # All items should be back in the main queue
    restored = await redis_test.lrange(queue, 0, -1)
    assert len(restored) == 3, "All orphans should appear in main queue"
    # Order note: lpush of recovered items puts them at head; set comparison is fine
    assert set(restored) == set(orphans)


@pytest.mark.asyncio
async def test_recover_processing_list_noop_when_empty(redis_test):
    """_recover_processing_list() returns 0 and does nothing when processing list is empty."""
    count = await _ing._recover_processing_list(redis_test)
    assert count == 0
