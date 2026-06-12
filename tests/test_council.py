"""Council mode end-to-end: gateway MoA mechanics, chat refinement, guards.

The sandbox fields a degenerate council (one manifest-scored model + jitter
seats) — the mechanics are identical to a full pool, just humbler proposals.
"""
import json
import os
import uuid

import httpx
from dotenv import dotenv_values

BASE = "http://localhost:8000"
GATEWAY = "http://localhost:8001"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}


def test_council_complete_mechanics():
    r = httpx.post(f"{GATEWAY}/complete", json={
        "messages": [{"role": "user", "content": "Reply with one short sentence: what is 2+2?"}],
        "max_tokens": 60,
        "mode": "council",
    }, timeout=320.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["content"].strip()
    meta = body["council"]
    assert len(meta["proposers"]) == 3
    assert all({"model", "endpoint", "ok", "elapsed_s"} <= set(p) for p in meta["proposers"])
    assert meta["seeded"] is False
    assert "elapsed_s" in meta and "total_tokens" in meta
    assert body["model"].startswith("council/")


def test_council_with_tools_downgrades():
    r = httpx.post(f"{GATEWAY}/complete", json={
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 30,
        "mode": "council",
        "tools": [{"type": "function", "function": {"name": "noop", "parameters": {"type": "object", "properties": {}}}}],
    }, timeout=180.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "downgraded" in body["council"]
    assert body["content"] is not None  # the standard completion still answered


def test_council_control_api():
    assert httpx.get(f"{BASE}/api/v1/council").status_code == 401
    state = httpx.get(f"{BASE}/api/v1/council", headers=ADMIN).json()
    assert state["enabled"] is True
    assert state["daily_budget"] >= 0
    r = httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"daily_budget": 5})
    assert r.status_code == 200 and r.json()["daily_budget"] == 5
    httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"daily_budget": 20})


def _chat_turn(council: bool) -> tuple[str, dict | None]:
    """Run a chat turn; return (final_text, council_meta_or_None)."""
    task_id = str(uuid.uuid4())
    text, meta = "", None
    with httpx.stream("POST", f"{BASE}/api/v1/tasks/{task_id}/message",
                      headers=ADMIN,
                      json={"text": "Reply with one short sentence: name a primary color.",
                            "council": council},
                      timeout=400.0) as r:
        assert r.status_code == 200, r.text
        for line in r.iter_lines():
            if not line.strip():
                continue
            evt = json.loads(line)
            if evt.get("type") == "meta" and "council" in evt:
                meta = evt["council"]
            elif "text" in evt and "type" not in evt:
                text = evt["text"]
    return text, meta


def test_chat_turn_with_council_refines_and_reports():
    text, meta = _chat_turn(council=True)
    assert text.strip()
    assert meta is not None, "council metadata event must be emitted"
    if "downgraded" not in meta:
        assert meta["seeded"] is True, "the draft must ride along as proposal 0"
        assert len(meta["proposers"]) >= 1


def test_council_budget_blocks_and_reports():
    httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"daily_budget": 0})
    try:
        text, meta = _chat_turn(council=True)
        assert text.strip()
        assert meta is not None and "downgraded" in meta
        assert "budget" in meta["downgraded"]
    finally:
        httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"daily_budget": 20})


def test_kill_switch_blocks_and_reports():
    httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"enabled": False})
    try:
        text, meta = _chat_turn(council=True)
        assert text.strip()
        assert meta is not None and "kill switch" in (meta.get("downgraded") or "")
    finally:
        httpx.put(f"{BASE}/api/v1/council", headers=ADMIN, json={"enabled": True})
