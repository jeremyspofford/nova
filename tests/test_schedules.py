"""Schedules end-to-end: CRUD, poll-loop firing, webhook firing, chat-thread output.

The firing tests are the slowest in the v2 suite by design — the scheduler polls
every 30s, so verifying a real fire costs up to ~40s. They use trivial prompts to
keep LLM latency minimal.
"""
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}

FIRE_TIMEOUT_S = 75       # poll interval is 30s; allow two cycles + slack
RESULT_TIMEOUT_S = 120    # includes LLM completion time (slow on CPU-only boxes)


def _cleanup_schedule(schedule_id: str) -> None:
    httpx.delete(f"{BASE}/api/v1/schedules/{schedule_id}", headers=ADMIN)


def _find_thread(title_fragment: str) -> str | None:
    r = httpx.get(f"{BASE}/api/v1/conversations", headers=ADMIN)
    if r.status_code != 200:
        return None
    for conv in r.json():
        if title_fragment in conv["title"]:
            return conv["id"]
    return None


def _wait_for_thread_message(title_fragment: str, timeout_s: int) -> str | None:
    """Poll the conversations list until the schedule's thread has an assistant message."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        thread_id = _find_thread(title_fragment)
        if thread_id:
            r = httpx.get(f"{BASE}/api/v1/tasks/{thread_id}/messages", headers=ADMIN)
            if r.status_code == 200:
                msgs = [m for m in r.json() if m["role"] == "assistant"]
                if msgs:
                    return msgs[-1]["content"]
        time.sleep(3)
    return None


# ── CRUD ──────────────────────────────────────────────────────────────────────


def test_schedules_unauthenticated_401():
    assert httpx.get(f"{BASE}/api/v1/schedules").status_code == 401


def test_create_interval_schedule_sets_next_fire():
    r = httpx.post(
        f"{BASE}/api/v1/schedules",
        headers=ADMIN,
        json={
            "name": f"itest-interval-{uuid.uuid4().hex[:6]}",
            "prompt": "noop",
            "trigger": {"type": "interval", "every_seconds": 86400},
        },
    )
    assert r.status_code == 201
    body = r.json()
    try:
        assert body["enabled"] is True
        assert body["next_fire"] is not None
        assert body["fire_count"] == 0
    finally:
        _cleanup_schedule(body["id"])


def test_invalid_trigger_is_422():
    r = httpx.post(
        f"{BASE}/api/v1/schedules",
        headers=ADMIN,
        json={"name": "bad", "prompt": "x", "trigger": {"type": "bogus"}},
    )
    assert r.status_code == 422


def test_update_and_delete_schedule():
    r = httpx.post(
        f"{BASE}/api/v1/schedules",
        headers=ADMIN,
        json={
            "name": f"itest-upd-{uuid.uuid4().hex[:6]}",
            "prompt": "noop",
            "trigger": {"type": "interval", "every_seconds": 86400},
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]

    r = httpx.patch(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN, json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False

    assert httpx.delete(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN).status_code == 204
    assert httpx.get(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN).status_code == 404


# ── Poll-loop firing (the core "schedules fire on time" verification) ─────────


def test_once_schedule_fires_and_surfaces_result_in_chat():
    name = f"itest-once-{uuid.uuid4().hex[:6]}"
    at = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
    r = httpx.post(
        f"{BASE}/api/v1/schedules",
        headers=ADMIN,
        json={
            "name": name,
            "prompt": "Reply with exactly the word OK and nothing else. Do not use tools.",
            "trigger": {"type": "once", "at": at},
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]
    thread_id = None

    try:
        # 1. The schedule fires within the poll window.
        deadline = time.time() + FIRE_TIMEOUT_S
        fired = None
        while time.time() < deadline:
            fired = httpx.get(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN).json()
            if fired["fire_count"] >= 1:
                break
            time.sleep(3)
        assert fired["fire_count"] >= 1, f"schedule did not fire within {FIRE_TIMEOUT_S}s"
        assert fired["last_fired"] is not None

        # 2. A 'once' schedule disables itself after firing.
        assert fired["enabled"] is False
        assert fired["next_fire"] is None

        # 3. The run's output lands in the schedule's chat thread.
        content = _wait_for_thread_message(name, RESULT_TIMEOUT_S)
        assert content is not None, "no assistant message appeared in the schedule's conversation"
        thread_id = _find_thread(name)
    finally:
        _cleanup_schedule(sid)
        if thread_id:
            httpx.delete(f"{BASE}/api/v1/conversations/{thread_id}", headers=ADMIN)


# ── Webhook firing ────────────────────────────────────────────────────────────


def test_webhook_schedule_fires_and_records():
    token = uuid.uuid4().hex
    secret_name = f"itest_webhook_token_{uuid.uuid4().hex[:6]}"
    name = f"itest-webhook-{uuid.uuid4().hex[:6]}"

    r = httpx.post(
        f"{BASE}/api/v1/secrets",
        headers=ADMIN,
        json={"name": secret_name, "value": token},
    )
    assert r.status_code in (200, 201)

    r = httpx.post(
        f"{BASE}/api/v1/schedules",
        headers=ADMIN,
        json={
            "name": name,
            "prompt": "Reply with exactly the word OK and nothing else. Do not use tools.",
            "trigger": {"type": "webhook", "token_secret": f"${{secret:{secret_name}}}"},
        },
    )
    assert r.status_code == 201
    sid = r.json()["id"]
    thread_id = None

    try:
        # Wrong token → 401, and nothing fires.
        r = httpx.post(f"{BASE}/api/v1/webhooks/{sid}", headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

        # Right token → 202 and a recorded fire.
        r = httpx.post(f"{BASE}/api/v1/webhooks/{sid}", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 202
        assert r.json()["queued"] is True

        sched = httpx.get(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN).json()
        assert sched["fire_count"] >= 1, "webhook fire must bump fire_count"
        assert sched["last_fired"] is not None

        # Output surfaces in the schedule's chat thread.
        content = _wait_for_thread_message(name, RESULT_TIMEOUT_S)
        assert content is not None, "no assistant message appeared in the schedule's conversation"
        thread_id = _find_thread(name)
    finally:
        _cleanup_schedule(sid)
        if thread_id:
            httpx.delete(f"{BASE}/api/v1/conversations/{thread_id}", headers=ADMIN)
        httpx.delete(f"{BASE}/api/v1/secrets/{secret_name}", headers=ADMIN)
