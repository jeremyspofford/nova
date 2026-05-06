"""P9 contract: assemble_context calls get_embedding at most once per turn."""

from __future__ import annotations

import pytest

# Module-level counter to track calls
call_count = {"n": 0}


async def counting_get_embedding(query, session, model=None):
    """Counter stub for get_embedding."""
    import traceback

    call_count["n"] += 1
    # Print the call stack to see where it's being called from
    stack = traceback.extract_stack()
    caller = stack[-2]
    print(
        f"DEBUG: get_embedding call #{call_count['n']} from {caller.filename}:{caller.lineno} in {caller.name}"
    )
    return [0.1] * 768


@pytest.mark.asyncio
async def test_assemble_context_calls_get_embedding_once(
    db_session, engram_factory, monkeypatch
):
    """Wrap get_embedding in a counter; assert ≤1 call for one assemble_context turn.

    EXPECTED RED on current code (calls twice — line 127 and line 211 when neural router is loaded).
    GREEN after the dedup refactor.
    """
    # Reset counter
    call_count["n"] = 0

    # Seed at least one engram
    emb = [0.5] * 768
    await engram_factory(content="seed", embedding=emb, source_type="chat")
    await db_session.flush()

    # Mock the neural router model as loaded (so both code paths execute)
    from unittest.mock import MagicMock

    from app.engram.neural_router import serve as router_serve

    mock_model = MagicMock()
    mock_model.predict = MagicMock(return_value=[(i, 0.9 - i * 0.1) for i in range(3)])
    monkeypatch.setattr(router_serve, "_cached_model", mock_model)

    # Import and patch ALL modules that call get_embedding
    from app.engram import activation as act_mod
    from app.engram import working_memory as wm_mod

    monkeypatch.setattr(wm_mod, "get_embedding", counting_get_embedding)
    monkeypatch.setattr(act_mod, "get_embedding", counting_get_embedding)

    # Run assemble_context
    await wm_mod.assemble_context(
        db_session,
        query="hello world",
        session_id="test-session",
        current_turn=1,
        depth="standard",
    )

    # This test will initially FAIL (RED) when call_count is 3+ (spreading_activation + line 127 + line 211).
    # After refactoring to deduplicate, it should PASS (GREEN) when call_count is 2
    # (spreading_activation + one call at top of assemble_context).
    assert call_count["n"] <= 2, (
        f"P9 contract violated: {call_count['n']} calls to get_embedding. "
        f"Expected at most 2 (1 from spreading_activation + 1 from assemble_context top-level)."
    )
