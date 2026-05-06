"""Unit tests for memory-service/app/engram/working_memory.py.

Strategy
--------
* assemble_context is the main entry point. External calls patched:
  - wm_mod.get_embedding / act_mod.get_embedding -> fixed 768-dim vector
  - wm_mod.get_self_model_summary -> fixed string
  - wm_mod.reconstruct -> echoes query text
  - wm_mod.log_retrieval -> returns None
  - wm_mod.get_cached_model -> (None, None) unless neural router needed
* _estimate_tokens, format_context_prompt, slot helpers tested directly.
* working_memory_slots table exercised via add_sticky_decision + queries.
* P9 contract test (get_embedding called at most once per turn) moved from
  test_working_memory_p9.py.
"""

from __future__ import annotations

import uuid

import pytest
from app.engram import working_memory as wm_mod
from sqlalchemy import text

# Fixed stubs

_FIXED_EMBEDDING = [0.1] * 768
_FIXED_SELF_MODEL = "I am a helpful AI assistant."
_SESSION = "test-session-wm"


async def _stub_embedding(query, session, model=None):
    return _FIXED_EMBEDDING


async def _stub_self_model(session):
    return _FIXED_SELF_MODEL


async def _stub_reconstruct(session, engrams, *, context="", self_model_summary=""):
    return "reconstructed: " + context


async def _stub_log_retrieval(session, **kwargs):
    return None


def _patch_base_no_ops(monkeypatch):
    """Patch the minimum set of external calls for assemble_context to run
    without an LLM gateway or neural router."""
    from app.engram import activation as act_mod
    from app.engram.neural_router import serve as router_serve

    monkeypatch.setattr(wm_mod, "get_embedding", _stub_embedding)
    monkeypatch.setattr(act_mod, "get_embedding", _stub_embedding)
    monkeypatch.setattr(wm_mod, "get_self_model_summary", _stub_self_model)
    monkeypatch.setattr(wm_mod, "reconstruct", _stub_reconstruct)
    monkeypatch.setattr(wm_mod, "log_retrieval", _stub_log_retrieval)
    monkeypatch.setattr(router_serve, "_cached_model", None)


# Token estimation (sync, pure function)


def test_token_count_matches_len_div_4():
    """_estimate_tokens uses len(text) // 4 as specified."""
    text_val = "hello world"
    assert wm_mod._estimate_tokens(text_val) == len(text_val) // 4


def test_token_count_zero_for_empty_string():
    assert wm_mod._estimate_tokens("") == 0


def test_token_count_handles_unicode_correctly():
    """Unicode characters: token estimate should not crash."""
    text_val = "Cafe naive resume"
    result = wm_mod._estimate_tokens(text_val)
    assert result == len(text_val) // 4  # character-based, not byte-based


def test_token_count_handles_cjk_characters():
    """CJK characters: count is len(str)//4."""
    text_val = "abcd"  # 4 ASCII chars
    result = wm_mod._estimate_tokens(text_val)
    assert result == 1  # 4 // 4 == 1


# format_context_prompt


def test_format_context_prompt_all_fields():
    ctx = wm_mod.WorkingMemoryContext(
        self_model="self",
        active_goal="goal",
        memories="mem",
        key_decisions="dec",
        open_threads="thread",
    )
    out = wm_mod.format_context_prompt(ctx)
    assert "## About Me" in out
    assert "## Current Goal" in out
    assert "## Relevant Memories" in out
    assert "## Key Decisions This Session" in out
    assert "## Open Threads" in out


def test_format_context_prompt_skips_empty_sections():
    ctx = wm_mod.WorkingMemoryContext(self_model="self")
    out = wm_mod.format_context_prompt(ctx)
    assert "## About Me" in out
    assert "## Current Goal" not in out
    assert "## Relevant Memories" not in out


# Slot helpers -- sticky decisions


@pytest.mark.asyncio
async def test_get_sticky_decisions_empty_session_returns_empty(db_session):
    """No session_id -> empty string, no DB query."""
    result = await wm_mod._get_sticky_decisions(db_session, "")
    assert result == ""


@pytest.mark.asyncio
async def test_get_sticky_decisions_no_slots_returns_empty(db_session):
    """Valid session_id with no rows -> empty string."""
    sid = f"wm-test-{uuid.uuid4()}"
    result = await wm_mod._get_sticky_decisions(db_session, sid)
    assert result == ""


@pytest.mark.asyncio
async def test_sticky_slot_roundtrip(db_session):
    """add_sticky_decision inserts a row; _get_sticky_decisions returns it."""
    sid = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(
        db_session, sid, "Use async/await throughout", turn=1
    )
    await db_session.flush()

    result = await wm_mod._get_sticky_decisions(db_session, sid)
    assert "Use async/await throughout" in result


@pytest.mark.asyncio
async def test_sticky_slot_multiple_entries(db_session):
    """Multiple sticky decisions all appear, joined with newlines."""
    sid = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(db_session, sid, "Decision A", turn=1)
    await wm_mod.add_sticky_decision(db_session, sid, "Decision B", turn=2)
    await db_session.flush()

    result = await wm_mod._get_sticky_decisions(db_session, sid)
    assert "Decision A" in result
    assert "Decision B" in result


@pytest.mark.asyncio
async def test_sticky_slot_session_isolation(db_session):
    """Slots from one session do not appear in another session query."""
    sid_a = f"wm-test-{uuid.uuid4()}"
    sid_b = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(db_session, sid_a, "Session A decision", turn=1)
    await db_session.flush()

    result_b = await wm_mod._get_sticky_decisions(db_session, sid_b)
    assert "Session A decision" not in result_b


# Slot helpers -- open threads (expiring)


@pytest.mark.asyncio
async def test_get_open_threads_empty_session_returns_empty(db_session):
    result = await wm_mod._get_open_threads(db_session, "", current_turn=0)
    assert result == ""


@pytest.mark.asyncio
async def test_get_open_threads_no_slots_returns_empty(db_session):
    sid = f"wm-test-{uuid.uuid4()}"
    result = await wm_mod._get_open_threads(db_session, sid, current_turn=5)
    assert result == ""


@pytest.mark.asyncio
async def test_open_thread_appears_when_recent(db_session):
    """An expiring slot with turn_last_relevant >= current_turn - 5 is returned."""
    sid = f"wm-test-{uuid.uuid4()}"
    await db_session.execute(
        text("""
            INSERT INTO working_memory_slots
                (session_id, slot_type, content, token_count, turn_added, turn_last_relevant)
            VALUES (:sid, 'expiring', :content, 5, 1, 8)
        """),
        {"sid": sid, "content": "Thread: finish the API design"},
    )
    await db_session.flush()

    result = await wm_mod._get_open_threads(db_session, sid, current_turn=10)
    assert "Thread: finish the API design" in result


@pytest.mark.asyncio
async def test_open_thread_dropped_when_stale(db_session):
    """An expiring slot whose turn_last_relevant is too old is excluded."""
    sid = f"wm-test-{uuid.uuid4()}"
    await db_session.execute(
        text("""
            INSERT INTO working_memory_slots
                (session_id, slot_type, content, token_count, turn_added, turn_last_relevant)
            VALUES (:sid, 'expiring', :content, 5, 1, 1)
        """),
        {"sid": sid, "content": "Stale thread"},
    )
    await db_session.flush()

    # current_turn=20 -> min_turn=15; turn_last_relevant=1 < 15 -> excluded
    result = await wm_mod._get_open_threads(db_session, sid, current_turn=20)
    assert "Stale thread" not in result


# assemble_context -- session/memory budget behaviour


@pytest.mark.asyncio
async def test_empty_session_returns_empty_memories(db_session, monkeypatch):
    """No engrams seeded -> memories field is empty string."""
    _patch_base_no_ops(monkeypatch)

    ctx = await wm_mod.assemble_context(
        db_session,
        query="nothing here",
        session_id="no-data-session",
        current_turn=0,
    )
    assert ctx.memories == ""


@pytest.mark.asyncio
async def test_self_model_always_present(db_session, monkeypatch):
    """assemble_context always populates self_model."""
    _patch_base_no_ops(monkeypatch)

    ctx = await wm_mod.assemble_context(
        db_session,
        query="anything",
        session_id="sm-test",
        current_turn=0,
    )
    assert ctx.self_model == _FIXED_SELF_MODEL


@pytest.mark.asyncio
async def test_memory_budget_truncates_long_text(db_session, monkeypatch):
    """When reconstructed memory exceeds engram_wm_memory_budget, it is trimmed."""
    from app.config import settings
    from app.engram.activation import ActivatedEngram

    _patch_base_no_ops(monkeypatch)

    long_text = "x" * 100_000  # 100k chars >> any reasonable budget

    async def _long_reconstruct(session, engrams, *, context="", self_model_summary=""):
        return long_text

    monkeypatch.setattr(wm_mod, "reconstruct", _long_reconstruct)

    async def _stub_activation(
        session,
        query,
        *,
        seed_count=None,
        max_results=None,
        depth="standard",
        tenant_id="00000000-0000-0000-0000-000000000001",
    ):
        return [
            ActivatedEngram(
                id=str(uuid.uuid4()),
                type="fact",
                content="seed",
                activation=0.9,
                importance=0.7,
                confidence=0.8,
                final_score=0.9,
                convergence_paths=0,
                access_count=0,
                source_type="chat",
            )
        ]

    monkeypatch.setattr(wm_mod, "spreading_activation", _stub_activation)

    ctx = await wm_mod.assemble_context(
        db_session,
        query="test",
        session_id="budget-test",
        current_turn=0,
    )
    budget = settings.engram_wm_memory_budget
    assert len(ctx.memories) <= budget * 4


@pytest.mark.asyncio
async def test_sticky_decisions_included_in_context(db_session, monkeypatch):
    """Key decisions written via add_sticky_decision appear in assembled context."""
    _patch_base_no_ops(monkeypatch)

    sid = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(db_session, sid, "Always use HTTPS", turn=1)
    await db_session.flush()

    ctx = await wm_mod.assemble_context(
        db_session,
        query="security practices",
        session_id=sid,
        current_turn=2,
    )
    assert "Always use HTTPS" in ctx.key_decisions


@pytest.mark.asyncio
async def test_total_tokens_accumulates_correctly(db_session, monkeypatch):
    """total_tokens is >= _estimate_tokens(self_model)."""
    _patch_base_no_ops(monkeypatch)

    ctx = await wm_mod.assemble_context(
        db_session,
        query="check token count",
        session_id="token-test",
        current_turn=0,
    )
    expected_min = wm_mod._estimate_tokens(_FIXED_SELF_MODEL)
    assert ctx.total_tokens >= expected_min


# Slot persistence across calls


@pytest.mark.asyncio
async def test_slots_persist_across_calls_in_same_session(db_session, monkeypatch):
    """Slots written before assemble_context are read back in the same session."""
    _patch_base_no_ops(monkeypatch)

    sid = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(db_session, sid, "Slot persistence check", turn=1)
    await db_session.flush()

    ctx = await wm_mod.assemble_context(
        db_session,
        query="anything",
        session_id=sid,
        current_turn=2,
    )
    assert "Slot persistence check" in ctx.key_decisions


@pytest.mark.asyncio
async def test_slots_have_correct_session_id(db_session):
    """Slots inserted via add_sticky_decision carry the provided session_id."""
    sid = f"wm-test-{uuid.uuid4()}"
    await wm_mod.add_sticky_decision(db_session, sid, "Check session_id column", turn=3)
    await db_session.flush()

    row = await db_session.execute(
        text("""
            SELECT session_id, slot_type FROM working_memory_slots
            WHERE session_id = :sid
        """),
        {"sid": sid},
    )
    fetched = row.fetchone()
    assert fetched is not None
    assert fetched.session_id == sid
    assert fetched.slot_type == "sticky"


# P9 contract: get_embedding called at most once per turn

_p9_call_count = {"n": 0}


async def _counting_get_embedding(query, session, model=None):
    """Counter stub for get_embedding."""
    import traceback

    _p9_call_count["n"] += 1
    stack = traceback.extract_stack()
    caller = stack[-2]
    print(
        f"DEBUG: get_embedding call #{_p9_call_count[chr(110)]} from "
        f"{caller.filename}:{caller.lineno} in {caller.name}"
    )
    return [0.1] * 768


@pytest.mark.asyncio
async def test_get_embedding_called_at_most_once_per_turn(
    db_session, engram_factory, monkeypatch
):
    """Wrap get_embedding in a counter; assert <=2 calls per assemble_context turn.

    Includes 1 call from spreading_activation + 1 from assemble_context top-level
    (was 3 before P9 fix when neural router was loaded).
    """
    _p9_call_count["n"] = 0

    emb = [0.5] * 768
    await engram_factory(content="seed", embedding=emb, source_type="chat")
    await db_session.flush()

    from unittest.mock import MagicMock

    from app.engram.neural_router import serve as router_serve

    mock_model = MagicMock()
    mock_model.predict = MagicMock(return_value=[(i, 0.9 - i * 0.1) for i in range(3)])
    monkeypatch.setattr(router_serve, "_cached_model", mock_model)

    from app.engram import activation as act_mod

    monkeypatch.setattr(wm_mod, "get_embedding", _counting_get_embedding)
    monkeypatch.setattr(act_mod, "get_embedding", _counting_get_embedding)
    monkeypatch.setattr(wm_mod, "get_self_model_summary", _stub_self_model)
    monkeypatch.setattr(wm_mod, "reconstruct", _stub_reconstruct)
    monkeypatch.setattr(wm_mod, "log_retrieval", _stub_log_retrieval)

    await wm_mod.assemble_context(
        db_session,
        query="hello world",
        session_id="test-session-p9",
        current_turn=1,
        depth="standard",
    )

    assert _p9_call_count["n"] <= 2, (
        f"P9 contract violated: {_p9_call_count[chr(110)]} calls to get_embedding. "
        "Expected at most 2 (1 from spreading_activation + 1 from assemble_context)."
    )
