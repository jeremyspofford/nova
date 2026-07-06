"""Morning briefing delivery plane: the send_push agent tool + seeded goal.

send_push is the informational counterpart to request_human_checkpoint —
scheduled goals use it to DELIVER their output. The seeded 'Morning
briefing' goal (migration 095) composes a daily digest and pushes it to
the operator's phone through the bundled ntfy server.

Covers:
  - send_push appears in the orchestrator tool catalog
  - executing it delivers a real message through the bundled ntfy server
  - the in-process storm brake trips with a clear, non-retriable error
  - argument validation rejects empty title/message
  - migration 095 seeded the goal with the expected UTC cron
"""
from __future__ import annotations

import sys
import time as _time
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "orchestrator"))
sys.path.insert(0, str(_REPO / "nova-contracts"))
sys.path.insert(0, str(_REPO / "nova-worker-common"))

import json

import httpx
import pytest

NTFY_LOCAL_URL = "http://localhost:8290"


@pytest.mark.asyncio
async def test_send_push_in_tool_catalog(orchestrator, admin_headers):
    """send_push is registered as a static built-in (Notify group)."""
    resp = await orchestrator.get("/api/v1/tools", headers=admin_headers)
    if resp.status_code != 200:
        pytest.skip(f"tool catalog returned {resp.status_code}")
    assert '"send_push"' in resp.text, "send_push missing from tool catalog"


@pytest.mark.asyncio
async def test_send_push_delivers_via_ntfy(pool):
    """Executing the tool lands a message in the seeded topic's cache."""
    from app import notifier
    from app.tools import notify_tools

    async with pool.acquire() as conn:
        topic = await conn.fetchval(
            "SELECT value #>> '{}' FROM platform_config WHERE key='notify.ntfy_topic'",
        )
    assert topic, "ntfy topic not seeded — orchestrator startup should have created it"

    # Point the test-process notifier at the host-published ntfy port (the
    # in-network http://ntfy default is unreachable from the host).
    saved_cache, saved_ts = notifier._conf_cache, notifier._conf_fetched_at
    notifier._conf_cache = {
        "enabled": True, "url": NTFY_LOCAL_URL, "topic": topic,
        "action_base_url": "", "action_key": "",
    }
    notifier._conf_fetched_at = _time.monotonic()
    notify_tools._sent_at.clear()
    try:
        result = await notify_tools.execute_tool(
            "send_push",
            {
                "title": "nova-test briefing",
                "message": "integration test — safe to ignore",
                "priority": 2,
            },
        )
        assert result.startswith("Push sent"), result

        async with httpx.AsyncClient(timeout=10) as client:
            poll = await client.get(f"{NTFY_LOCAL_URL}/{topic}/json?poll=1")
        assert poll.status_code == 200
        msgs = [json.loads(line) for line in poll.text.splitlines() if line.strip()]
        mine = [
            m for m in msgs
            if m.get("event") == "message" and m.get("title") == "nova-test briefing"
        ]
        assert mine, "send_push message not found in topic cache"
        assert mine[-1].get("priority") == 2, "priority argument not honored"
    finally:
        notifier._conf_cache, notifier._conf_fetched_at = saved_cache, saved_ts
        notify_tools._sent_at.clear()


@pytest.mark.asyncio
async def test_send_push_storm_brake(monkeypatch):
    """The sliding-window limit trips and tells the agent not to retry."""
    from app.tools import notify_tools

    sent: list[str] = []

    async def fake_notify(event, title, message="", **kwargs):
        sent.append(title)
        return True

    monkeypatch.setattr(notify_tools, "notify", fake_notify)
    monkeypatch.setattr(notify_tools, "_MAX_PER_WINDOW", 2)
    notify_tools._sent_at.clear()
    try:
        ok1 = await notify_tools.execute_tool("send_push", {"title": "a", "message": "x"})
        ok2 = await notify_tools.execute_tool("send_push", {"title": "b", "message": "x"})
        blocked = await notify_tools.execute_tool("send_push", {"title": "c", "message": "x"})
        assert ok1.startswith("Push sent") and ok2.startswith("Push sent")
        assert "rate limit" in blocked and "do not retry" in blocked
        assert sent == ["a", "b"], "publish must not be attempted past the limit"
    finally:
        notify_tools._sent_at.clear()


@pytest.mark.asyncio
async def test_send_push_requires_title_and_message():
    from app.tools import notify_tools

    for args in ({}, {"title": "x"}, {"message": "x"}, {"title": " ", "message": "y"}):
        result = await notify_tools.execute_tool("send_push", args)
        assert result.startswith("Error"), f"accepted bad args {args}: {result}"


@pytest.mark.asyncio
async def test_morning_briefing_goal_seeded(pool):
    """Migration 095 seeds the standing goal; scheduler self-heal arms it."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT schedule_cron, status, description FROM goals "
            "WHERE title = 'Morning briefing'",
        )
    assert row is not None, "migration 095 did not seed the Morning briefing goal"
    assert row["status"] == "active"
    assert row["schedule_cron"] == "0 11 * * *"
    assert "send_push" in row["description"]
