"""Agent-loop hardening: failure modes that must not kill a task.

Covers the gaps found in the 2026-06-12 hardening pass:
- unknown/hallucinated tool names → recoverable error result (audited)
- malformed tool arguments → reported to the model, not coerced to {}
- transient gateway failures → bounded retries; outage → task FAILED, not
  "completed: LLM gateway unreachable"
- iteration exhaustion → final no-tools synthesis, not a bare marker
- oversized tool results → clipped before entering model context
"""
import uuid
from unittest.mock import AsyncMock

import httpx
import pytest
from app.loop import main as loop
from app.tools import dispatcher


def tool_call_resp(name: str, arguments: str, call_id: str = "tc1") -> dict:
    return {
        "content": "",
        "tool_calls": [
            {"id": call_id, "type": "function",
             "function": {"name": name, "arguments": arguments}}
        ],
    }


def scripted_llm(responses: list[dict | None]):
    """Fake _llm_complete returning the scripted responses in order
    (sticking on the last). Records every call's messages + tools."""
    calls: list[dict] = []

    async def _fake(messages, tools):
        calls.append({"messages": [dict(m) for m in messages], "tools": list(tools)})
        return responses[min(len(calls) - 1, len(responses) - 1)]

    return _fake, calls


@pytest.fixture
def no_tools(monkeypatch):
    """Empty offered-tool list — these tests script the model's behavior."""
    monkeypatch.setattr(loop, "to_openai_tools", lambda: [])


# ── unknown tool ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_unknown_tool_returns_error_result(monkeypatch):
    events = []

    async def record_event(pool, task_id, kind, payload):
        events.append((kind, payload))

    monkeypatch.setattr(dispatcher.audit, "write_event", record_event)

    result = await dispatcher.dispatch(
        name="ghost.tool", args={}, task_id=str(uuid.uuid4()),
        caller_role="test", caller_caps=["*"], pool=None,
    )
    assert "Unknown tool" in result["error"]
    assert events and events[0][0] == "tool_call_error"
    assert events[0][1]["tool_name"] == "ghost.tool"


@pytest.mark.asyncio
async def test_loop_survives_dispatch_crash(monkeypatch, no_tools):
    """Even if dispatch itself raises, the model gets the error and continues."""
    async def exploding_dispatch(**kwargs):
        raise KeyError("Unknown tool: 'ghost.tool'")

    monkeypatch.setattr(loop, "dispatch", exploding_dispatch)
    fake, calls = scripted_llm([
        tool_call_resp("ghost.tool", "{}"),
        {"content": "recovered"},
    ])
    monkeypatch.setattr(loop, "_llm_complete", fake)

    out = await loop._loop(str(uuid.uuid4()), "goal", "main", ["*"], pool=None)
    assert out["final"] == "recovered"
    tool_msgs = [m for m in calls[1]["messages"] if m["role"] == "tool"]
    assert "ghost.tool" in tool_msgs[0]["content"]


# ── malformed arguments ───────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_args", ["{not json", "[1, 2, 3]"])
async def test_bad_arguments_reported_not_dispatched(monkeypatch, no_tools, bad_args):
    dispatched = AsyncMock()
    monkeypatch.setattr(loop, "dispatch", dispatched)
    fake, calls = scripted_llm([
        tool_call_resp("fs.read", bad_args),
        {"content": "done"},
    ])
    monkeypatch.setattr(loop, "_llm_complete", fake)

    out = await loop._loop(str(uuid.uuid4()), "goal", "main", ["*"], pool=None)
    assert out["final"] == "done"
    dispatched.assert_not_awaited()
    tool_msgs = [m for m in calls[1]["messages"] if m["role"] == "tool"]
    assert "invalid tool arguments" in tool_msgs[0]["content"]


# ── gateway failure semantics ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gateway_outage_raises_not_completes(monkeypatch, no_tools):
    fake, _ = scripted_llm([None])
    monkeypatch.setattr(loop, "_llm_complete", fake)
    with pytest.raises(loop.GatewayUnreachableError):
        await loop._loop(str(uuid.uuid4()), "goal", "main", ["*"], pool=None)


class FlakyClient:
    """post() raises ConnectError n times, then succeeds."""

    def __init__(self, failures: int, status: int = 200):
        self.failures = failures
        self.status = status
        self.posts = 0

    async def post(self, url, json=None):
        self.posts += 1
        if self.posts <= self.failures:
            raise httpx.ConnectError("boom")
        request = httpx.Request("POST", url)
        return httpx.Response(self.status, json={"content": "ok"}, request=request)


@pytest.mark.asyncio
async def test_llm_complete_retries_transient_then_succeeds(monkeypatch):
    client = FlakyClient(failures=2)
    monkeypatch.setattr(loop, "get_llm_client", lambda: client)
    monkeypatch.setattr(loop, "_sleep", AsyncMock())

    resp = await loop._llm_complete([{"role": "user", "content": "hi"}], [])
    assert resp == {"content": "ok"}
    assert client.posts == 3


@pytest.mark.asyncio
async def test_llm_complete_gives_up_after_attempts(monkeypatch):
    client = FlakyClient(failures=99)
    monkeypatch.setattr(loop, "get_llm_client", lambda: client)
    monkeypatch.setattr(loop, "_sleep", AsyncMock())

    assert await loop._llm_complete([], []) is None
    assert client.posts == loop.LLM_ATTEMPTS


@pytest.mark.asyncio
async def test_llm_complete_does_not_retry_4xx(monkeypatch):
    client = FlakyClient(failures=0, status=422)
    monkeypatch.setattr(loop, "get_llm_client", lambda: client)
    monkeypatch.setattr(loop, "_sleep", AsyncMock())

    assert await loop._llm_complete([], []) is None
    assert client.posts == 1


# ── iteration exhaustion ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_exhaustion_ends_with_no_tools_synthesis(monkeypatch, no_tools):
    monkeypatch.setattr(loop, "MAX_ITERATIONS", 2)

    async def ok_dispatch(**kwargs):
        return {"ok": True}

    monkeypatch.setattr(loop, "dispatch", ok_dispatch)
    calls: list[dict] = []

    async def fake_llm(messages, tools):
        calls.append({"messages": [dict(m) for m in messages], "tools": list(tools)})
        if tools or len(calls) <= 2:  # scripted: keep calling tools until synthesis
            return tool_call_resp("fs.read", "{}")
        return {"content": "did X; Y remains"}

    monkeypatch.setattr(loop, "_llm_complete", fake_llm)

    out = await loop._loop(str(uuid.uuid4()), "goal", "main", ["*"], pool=None)
    assert out == {"final": "did X; Y remains", "iterations": 2, "exhausted": True}
    assert calls[-1]["tools"] == [], "synthesis pass must offer no tools"
    assert "tool-call limit" in calls[-1]["messages"][-1]["content"]


# ── context-size guard ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_huge_tool_result_clipped_in_context(monkeypatch, no_tools):
    async def huge_dispatch(**kwargs):
        return {"content": "x" * 100_000}

    monkeypatch.setattr(loop, "dispatch", huge_dispatch)
    fake, calls = scripted_llm([
        tool_call_resp("web.fetch", "{}"),
        {"content": "done"},
    ])
    monkeypatch.setattr(loop, "_llm_complete", fake)

    await loop._loop(str(uuid.uuid4()), "goal", "main", ["*"], pool=None)
    tool_msg = [m for m in calls[1]["messages"] if m["role"] == "tool"][0]
    assert len(tool_msg["content"]) <= loop._RESULT_CONTEXT_CAP + 64
    assert "truncated" in tool_msg["content"]


def test_clip_tool_result_passthrough_under_cap():
    s = "short result"
    assert loop.clip_tool_result(s) is s
