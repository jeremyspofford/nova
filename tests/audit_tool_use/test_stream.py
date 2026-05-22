import asyncio

import pytest

from audit_tool_use.stream import consume_stream_with_approval_grant, parse_ndjson_lines


async def _async_iter(lines):
    for line in lines:
        yield line


@pytest.mark.asyncio
async def test_parses_lines_no_data_prefix():
    raw = [b'{"type":"meta","model":"x"}', b'{"text":"hi"}']
    parsed = [item async for item in parse_ndjson_lines(_async_iter(raw))]
    assert parsed[0]["type"] == "meta"
    assert parsed[1]["text"] == "hi"


@pytest.mark.asyncio
async def test_skips_blank_and_invalid_lines():
    raw = [b"", b"   ", b'{"text":"ok"}', b"not-json"]
    parsed = [item async for item in parse_ndjson_lines(_async_iter(raw))]
    assert parsed == [{"text": "ok"}]


@pytest.mark.asyncio
async def test_approval_grant_called_once_per_id_when_request_appears():
    raw = [
        b'{"type":"meta","model":"x"}',
        b'{"type":"tool_approval_request","tool_call_id":"call_1","name":"fs.write","tier":"MUTATE","args":{}}',
        b'{"type":"tool_approval_request","tool_call_id":"call_1","name":"fs.write","tier":"MUTATE","args":{}}',
        b'{"text":"done"}',
    ]
    granted: list[str] = []
    async def grant(call_id: str) -> None:
        granted.append(call_id)
    final = await consume_stream_with_approval_grant(_async_iter(raw), grant_fn=grant)
    assert granted == ["call_1"]
    assert final["text"] == "done"


@pytest.mark.asyncio
async def test_trailing_meta_does_not_clobber_text():
    """A trailing meta/error event must NOT overwrite an already-captured text.
    Regression: harness reads final['text'] for ResponseContains verification."""
    raw = [
        b'{"type":"meta","model":"x"}',
        b'{"text":"the answer is AUDIT-TOKEN-123"}',
        b'{"type":"meta","trailing":"summary"}',  # MUST NOT clobber
    ]
    async def _no_grant(_): pass
    final = await consume_stream_with_approval_grant(_async_iter(raw), grant_fn=_no_grant)
    assert "text" in final, f"text was clobbered by trailing meta; final={final!r}"
    assert final["text"] == "the answer is AUDIT-TOKEN-123"


@pytest.mark.asyncio
async def test_meta_or_error_only_is_returned_when_no_text():
    """If the stream contains no text-bearing event, fall back to meta/error."""
    raw = [b'{"type":"meta","model":"x"}', b'{"type":"error","message":"boom"}']
    async def _no_grant(_): pass
    final = await consume_stream_with_approval_grant(_async_iter(raw), grant_fn=_no_grant)
    assert final.get("type") == "error"  # error came last, no text ever seen


@pytest.mark.asyncio
async def test_cancellation_cancels_pending_grants():
    """When the harness wall-clock fires, asyncio.wait_for cancels the consume
    coroutine. The finally block must cancel pending grant tasks so they don't
    leak as 'Task was destroyed but it is pending!' warnings."""
    grant_started = asyncio.Event()
    grant_finished = asyncio.Event()

    async def slow_grant(call_id: str) -> None:
        grant_started.set()
        try:
            await asyncio.sleep(60)  # would block past any sensible wall-clock
            grant_finished.set()
        except asyncio.CancelledError:
            raise

    async def slow_stream():
        # Send one approval request, then hang — caller will cancel us
        yield b'{"type":"tool_approval_request","tool_call_id":"slow","name":"x","tier":"MUTATE","args":{}}'
        await asyncio.sleep(60)

    # Race the consume against a 0.1s timeout — emulates the harness wall-clock
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            consume_stream_with_approval_grant(slow_stream(), grant_fn=slow_grant),
            timeout=0.1,
        )

    # The grant must have started but NOT finished (it was cancelled by the finally)
    assert grant_started.is_set(), "grant task didn't start"
    assert not grant_finished.is_set(), "grant should have been cancelled, not allowed to complete"
