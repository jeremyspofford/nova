"""Proactivity end-to-end: capability verification, control API, dispatch guards.

The guard test drives the seeded nova-self-review schedule through real scheduler
poll cycles (30s each), so this file adds ~1-2 min — that's the point: it verifies
autonomous dispatch is actually gated, live.
"""
import os
import time

import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}

POLL_WINDOW_S = 75  # one 30s scheduler cycle + slack


def _proactivity() -> dict:
    r = httpx.get(f"{BASE}/api/v1/proactivity", headers=ADMIN)
    assert r.status_code == 200, r.text
    return r.json()


def _put(payload: dict) -> dict:
    r = httpx.put(f"{BASE}/api/v1/proactivity", headers=ADMIN, json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def _pulse_schedule() -> dict:
    state = _proactivity()
    assert state["schedule_id"], "seeded nova-self-review schedule missing"
    r = httpx.get(f"{BASE}/api/v1/schedules/{state['schedule_id']}", headers=ADMIN)
    assert r.status_code == 200
    return r.json()


def test_proactivity_requires_auth():
    assert httpx.get(f"{BASE}/api/v1/proactivity").status_code == 401


def test_seeded_pulse_schedule_exists():
    sched = _pulse_schedule()
    assert sched["name"] == "nova-self-review"
    assert sched["created_by"] == "nova"
    assert "NOTHING" in sched["prompt"]


def test_capabilities_endpoint_distinguishes_models():
    # Probe INSTALLED models — hardcoded names fail on hosts that didn't pull them.
    pulled = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN, timeout=20.0).json()
    names = [m["name"].removesuffix(":latest") for m in pulled]
    if not names:
        pytest.skip("no local models installed")

    target = next((n for n in names if "embed" not in n), names[0])
    r = httpx.get(
        f"{BASE}/api/v1/llm/models/capabilities",
        headers=ADMIN, params={"model": target}, timeout=15.0,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method"] == "ollama/api/show", body
    assert body["tools"] in (True, False)

    embed = next((n for n in names if "embed" in n), None)
    if embed is None:
        pytest.skip("no embedding model installed for the tools=False case")
    r = httpx.get(
        f"{BASE}/api/v1/llm/models/capabilities",
        headers=ADMIN, params={"model": embed}, timeout=15.0,
    )
    assert r.status_code == 200, r.text
    assert r.json()["tools"] is False


def test_control_api_round_trip():
    original = _proactivity()
    try:
        state = _put({"enabled": False, "daily_task_budget": 5})
        assert state["enabled"] is False
        assert state["daily_task_budget"] == 5
        assert _proactivity()["enabled"] is False
    finally:
        _put({"enabled": original["enabled"], "daily_task_budget": original["daily_task_budget"]})


def test_kill_switch_blocks_pulse_dispatch_then_restore_fires():
    """Drive the seeded pulse through real poll cycles: blocked, then dispatched."""
    sched = _pulse_schedule()
    sid = sched["id"]
    fire_count_0 = sched["fire_count"]
    dispatches_0 = _proactivity()["dispatches_today"]

    try:
        # Phase 1 — kill switch on, schedule due now: must NOT fire.
        _put({"enabled": False})
        r = httpx.patch(
            f"{BASE}/api/v1/schedules/{sid}",
            headers=ADMIN,
            json={"trigger": {"type": "interval", "every_seconds": 2}},
        )
        assert r.status_code == 200

        deadline = time.time() + POLL_WINDOW_S
        blocked_reason = None
        while time.time() < deadline:
            state = _proactivity()
            if state["last_block_reason"]:
                blocked_reason = state["last_block_reason"]
                break
            time.sleep(3)
        assert blocked_reason and "kill switch" in blocked_reason, (
            f"expected a kill-switch block within {POLL_WINDOW_S}s, got {blocked_reason!r}"
        )
        sched_now = httpx.get(f"{BASE}/api/v1/schedules/{sid}", headers=ADMIN).json()
        assert sched_now["fire_count"] == fire_count_0, "blocked pulse must not record a fire"

        # Phase 2 — kill switch off: the next cycle dispatches a real task.
        _put({"enabled": True})
        deadline = time.time() + POLL_WINDOW_S
        dispatched = False
        while time.time() < deadline:
            state = _proactivity()
            if state["dispatches_today"] > dispatches_0:
                dispatched = True
                break
            time.sleep(3)
        assert dispatched, f"pulse did not dispatch within {POLL_WINDOW_S}s of re-enabling"
        assert _proactivity()["last_block_reason"] is None, "block reason should clear on dispatch"
    finally:
        # Restore: 4h cadence, defaults on. (The dispatched run finishes on its own;
        # its output — or quiet NOTHING — lands in the pulse's chat thread.)
        httpx.patch(
            f"{BASE}/api/v1/schedules/{sid}",
            headers=ADMIN,
            json={"trigger": {"type": "interval", "every_seconds": 14400}},
        )
        _put({"enabled": True, "daily_task_budget": 12})
