"""Task #8 milestone C: signed lockscreen actions + checkpoint screenshots.

The decide endpoint (`POST /api/v1/notify/actions/decide`) is what ntfy
action buttons hit straight from the phone: no admin secret, no session —
a per-approval HMAC token IS the credential. These tests mint tokens
in-process with the seeded `notify.action_key` and prove:

  - a valid token decides the approval and resumes the parked task
  - tampered or expired tokens are rejected (opaquely, 403)
  - a spent token cannot decide twice (409)
  - build_decide_actions only attaches buttons when the operator has
    configured a reachable base URL

Plus the screenshot leg: request_human_checkpoint with a live
browser-worker session stores a page capture on the approval row, which the
list endpoint strips and the detail endpoint returns.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "orchestrator"))
sys.path.insert(0, str(_REPO / "nova-contracts"))
sys.path.insert(0, str(_REPO / "nova-worker-common"))

import json
from uuid import uuid4

import httpx
import pytest
from test_human_checkpoint import (
    TENANT,
    USER,
    _cleanup,
    _insert_running_task,
    _park_task_on_checkpoint,
    _wait_for_task,
)

BROWSER_WORKER_URL = "http://localhost:8150"
NTFY_LOCAL_URL = "http://localhost:8290"


@pytest.fixture
async def app_db_pool(pool):
    """Patch the orchestrator's global db pool for in-process app.* calls."""
    from app import db as app_db
    saved = app_db._pool
    app_db._pool = pool
    try:
        yield
    finally:
        app_db._pool = saved


async def _get_action_key(pool) -> str:
    async with pool.acquire() as conn:
        key = await conn.fetchval(
            "SELECT value #>> '{}' FROM platform_config WHERE key='notify.action_key'",
        )
    assert key, "notify.action_key not seeded — orchestrator startup should have created it"
    return key


def _decide_url(approval_id: str, decision: str, exp: int, sig: str) -> str:
    return (
        f"/api/v1/notify/actions/decide"
        f"?approval_id={approval_id}&decision={decision}&exp={exp}&sig={sig}"
    )


@pytest.mark.asyncio
async def test_action_key_seeded(pool):
    """Startup seeds a 64-hex HMAC key alongside the ntfy topic."""
    key = await _get_action_key(pool)
    assert len(key) == 64
    int(key, 16)  # raises if not hex


@pytest.mark.asyncio
async def test_lockscreen_button_approves_and_resumes(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """The headline path: a signed link — sent with NO auth headers — decides
    the checkpoint and the parked task resumes to completion."""
    from app.notify_actions import mint_sig

    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)
        key = await _get_action_key(pool)
        exp = int(time.time()) + 600
        sig = mint_sig(key, approval_id, "approve", exp)

        # Bare client: the whole point is that the phone has no admin secret.
        resp = await orchestrator.post(_decide_url(approval_id, "approve", exp, sig))
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"status": "ok", "decision": "approve"}

        final = await _wait_for_task(pool, task_id, {"complete", "failed", "cancelled"})
        assert final == "complete", f"resumed task ended '{final}'"

        async with pool.acquire() as conn:
            arow = await conn.fetchrow(
                "SELECT status, decided_via, decided_by FROM approval_requests WHERE id=$1::uuid",
                approval_id,
            )
        assert arow["status"] == "approved"
        assert arow["decided_via"] == "ntfy"
        assert arow["decided_by"] == "operator"
    finally:
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)


@pytest.mark.asyncio
async def test_tampered_and_expired_tokens_rejected(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """Wrong signature, decision swap, and expired tokens all 403 opaquely;
    the approval stays pending and the task stays parked."""
    from app.notify_actions import mint_sig

    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)
        key = await _get_action_key(pool)
        exp = int(time.time()) + 600
        good_sig = mint_sig(key, approval_id, "approve", exp)

        # 1. Tampered signature
        bad_sig = ("0" if good_sig[0] != "0" else "1") + good_sig[1:]
        resp = await orchestrator.post(_decide_url(approval_id, "approve", exp, bad_sig))
        assert resp.status_code == 403, resp.text

        # 2. Signature minted for approve, replayed as reject
        resp = await orchestrator.post(_decide_url(approval_id, "reject", exp, good_sig))
        assert resp.status_code == 403, resp.text

        # 3. Expired token (signature itself valid for that expiry)
        old_exp = int(time.time()) - 10
        old_sig = mint_sig(key, approval_id, "approve", old_exp)
        resp = await orchestrator.post(_decide_url(approval_id, "approve", old_exp, old_sig))
        assert resp.status_code == 403, resp.text

        async with pool.acquire() as conn:
            status = await conn.fetchval(
                "SELECT status FROM approval_requests WHERE id=$1::uuid", approval_id,
            )
            task_status = await conn.fetchval(
                "SELECT status FROM tasks WHERE id=$1::uuid", task_id,
            )
        assert status == "pending"
        assert task_status == "waiting_human"
    finally:
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)


@pytest.mark.asyncio
async def test_spent_token_conflicts(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """A token authorizes one decision — the second POST hits 409."""
    from app.notify_actions import mint_sig

    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)
        key = await _get_action_key(pool)
        exp = int(time.time()) + 600
        sig = mint_sig(key, approval_id, "reject", exp)

        first = await orchestrator.post(_decide_url(approval_id, "reject", exp, sig))
        assert first.status_code == 200, first.text

        second = await orchestrator.post(_decide_url(approval_id, "reject", exp, sig))
        assert second.status_code == 409, second.text
    finally:
        await _wait_for_task(pool, task_id, {"complete", "failed", "cancelled"})
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)


@pytest.mark.asyncio
async def test_build_decide_actions_requires_base_url(pool, app_db_pool):
    """No configured base URL → no buttons. Configured → three actions whose
    signatures verify against the seeded key."""
    from app.notifier import _invalidate_conf_cache
    from app.notify_actions import build_decide_actions, verify_sig

    approval_id = str(uuid4())

    async def _set_base_url(value: str | None):
        async with pool.acquire() as conn:
            if value is None:
                await conn.execute(
                    "DELETE FROM platform_config WHERE key='notify.action_base_url'",
                )
            else:
                await conn.execute(
                    """INSERT INTO platform_config (key, value)
                       VALUES ('notify.action_base_url', to_jsonb($1::text))
                       ON CONFLICT (key) DO UPDATE SET value = to_jsonb($1::text)""",
                    value,
                )
        _invalidate_conf_cache()

    async with pool.acquire() as conn:
        original = await conn.fetchval(
            "SELECT value #>> '{}' FROM platform_config WHERE key='notify.action_base_url'",
        )
    try:
        await _set_base_url(None)
        assert await build_decide_actions(approval_id, kind="checkpoint") is None

        await _set_base_url("http://phone-reachable.test:3000")
        actions = await build_decide_actions(approval_id, kind="checkpoint")
        assert actions is not None and len(actions) == 3

        cont, decline, view = actions
        assert cont["label"] == "Continue" and decline["label"] == "Decline"
        assert view == {"action": "view", "label": "Open", "url": "http://phone-reachable.test:3000"}

        key = await _get_action_key(pool)
        for act, decision in ((cont, "approve"), (decline, "reject")):
            assert act["action"] == "http" and act["method"] == "POST"
            assert act["url"].startswith(
                "http://phone-reachable.test:3000/api/v1/notify/actions/decide?",
            )
            params = dict(
                p.split("=", 1) for p in act["url"].split("?", 1)[1].split("&")
            )
            assert params["approval_id"] == approval_id
            assert params["decision"] == decision
            assert verify_sig(key, approval_id, decision, int(params["exp"]), params["sig"])
    finally:
        await _set_base_url(original)


@pytest.mark.asyncio
async def test_push_with_action_buttons_accepted_by_ntfy(pool, app_db_pool):
    """A publish carrying our actions array must be ACCEPTED by the bundled
    ntfy server and come back with the buttons intact. If ntfy rejected the
    shape, every approval push would silently break — not just the buttons."""
    import time as _time

    from app import notifier
    from app.notify_actions import build_decide_actions

    async with pool.acquire() as conn:
        topic = await conn.fetchval(
            "SELECT value #>> '{}' FROM platform_config WHERE key='notify.ntfy_topic'",
        )
    assert topic, "ntfy topic not seeded"

    # Point the test-process notifier at the host-published ntfy port (the
    # in-network http://ntfy default is unreachable from the host), with a
    # configured action base + key so build_decide_actions produces buttons.
    saved_cache, saved_ts = notifier._conf_cache, notifier._conf_fetched_at
    notifier._conf_cache = {
        "enabled": True, "url": NTFY_LOCAL_URL, "topic": topic,
        "action_base_url": "http://example.test:3000",
        "action_key": "nova-test-action-key",
    }
    notifier._conf_fetched_at = _time.monotonic()
    try:
        actions = await build_decide_actions(str(uuid4()), kind="checkpoint")
        assert actions and len(actions) == 3

        sent = await notifier.notify(
            "checkpoint_requested",
            title="nova-test checkpoint with buttons",
            message="integration test — safe to ignore",
            actions=actions,
        )
        assert sent is True, "ntfy rejected the publish — actions payload broke pushes"

        async with httpx.AsyncClient(timeout=10) as client:
            poll = await client.get(f"{NTFY_LOCAL_URL}/{topic}/json?poll=1")
        assert poll.status_code == 200
        msgs = [json.loads(line) for line in poll.text.splitlines() if line.strip()]
        mine = [
            m for m in msgs
            if m.get("event") == "message"
            and m.get("title") == "nova-test checkpoint with buttons"
        ]
        assert mine, "push with buttons not found in topic cache"
        labels = [a.get("label") for a in (mine[-1].get("actions") or [])]
        assert labels == ["Continue", "Decline", "Open"], f"buttons mangled: {labels}"
    finally:
        notifier._conf_cache, notifier._conf_fetched_at = saved_cache, saved_ts


@pytest.mark.asyncio
async def test_checkpoint_screenshot_stored_and_stripped(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool, monkeypatch,
):
    """With a live browser session, the checkpoint attaches a real page
    screenshot; the approvals LIST strips it, the detail endpoint returns it."""
    # Browser profile is optional — skip cleanly where it isn't running.
    try:
        async with httpx.AsyncClient(timeout=3) as probe:
            health = await probe.get(f"{BROWSER_WORKER_URL}/health/ready")
        assert health.status_code == 200
    except Exception:
        pytest.skip("browser-worker not reachable on localhost:8150")

    # The tool targets the in-network hostname; from the host we go via the
    # published port. BROWSER_BASE is read at call time, so patching works.
    from app.tools import browser_tools
    monkeypatch.setattr(
        browser_tools, "BROWSER_BASE", f"{BROWSER_WORKER_URL}/api/v1/browser",
    )

    from app.tools import execute_tool

    task_id = await _insert_running_task(pool)
    approval_id = None
    session_id = None
    try:
        async with httpx.AsyncClient(timeout=30) as bw:
            opened = await bw.post(
                f"{BROWSER_WORKER_URL}/api/v1/browser/sessions",
                json={"url": "data:text/html,<h1>nova-test checkpoint page</h1>"},
            )
            assert opened.status_code == 200, opened.text
            session_id = opened.json()["session_id"]

        result = json.loads(await execute_tool(
            "request_human_checkpoint",
            {
                "reason": "Screenshot test",
                "instructions": "Verify the attached capture",
                "browser_session_id": session_id,
            },
            context={
                "tenant_id": str(TENANT), "user_id": str(USER),
                "task_id": task_id, "actor_kind": "agent", "actor_id": "task",
            },
        ))
        assert result["status"] == "checkpoint_pending", result
        approval_id = result["approval_id"]

        async with pool.acquire() as conn:
            stored = await conn.fetchval(
                "SELECT screenshot_b64 FROM approval_requests WHERE id=$1::uuid",
                approval_id,
            )
        assert stored and len(stored) > 1000, "screenshot was not captured/stored"

        listing = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers,
        )
        assert listing.status_code == 200
        row = next(a for a in listing.json() if a["id"] == approval_id)
        assert "screenshot_b64" not in row, "list endpoint must strip screenshots"

        detail = await orchestrator.get(
            f"/api/v1/capabilities/approvals/{approval_id}", headers=admin_headers,
        )
        assert detail.status_code == 200
        assert detail.json()["screenshot_b64"] == stored
    finally:
        if session_id:
            async with httpx.AsyncClient(timeout=10) as bw:
                await bw.delete(f"{BROWSER_WORKER_URL}/api/v1/browser/sessions/{session_id}")
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)
