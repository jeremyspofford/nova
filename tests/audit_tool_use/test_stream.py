import asyncio
import json
import pytest
from audit_tool_use.stream import parse_ndjson_lines, consume_stream_with_approval_grant


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
