"""S37c T8: the senders API — /api/v1/event-senders — and each sender's role.

Spec §2.1 (the owner adds a sender on Settings > Events, which shows the
token once), §2.8 and §9 Q4 (one routing role per sender, `event_<sender>`;
an empty chain is chat's). What these pin:

  * the token is returned exactly once, by the POST that made it; no GET
    returns it, no log line holds it;
  * adding a sender makes its role exist on the gateway, read back from the
    gateway's own answer — a gateway that fails makes the add fail, stated,
    and leaves no sender behind;
  * off stops the intake, on starts it again; deleting a sender stops its
    intake and its waiting events, and removes its role;
  * only an identity reaches these routes — a sender's own token, which
    opens the intake, opens nothing here;
  * core refuses a chain for `event_<x>` when no sender x exists.
"""

from __future__ import annotations

import logging

import pytest

from app import chat, events
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

API = "/api/v1/event-senders"
INTAKE = "/api/v1/events/{}"
LISTED_KEYS = {
    "name",
    "kind",
    "role",
    "enabled",
    "last_sent_at",
    "added_by",
    "created_at",
    "token_waiting",
}


def _explain(role: str) -> dict:
    return {
        "role": role,
        "chain": [],
        "would_serve": {
            "role": role,
            "link": 1,
            "reason": "the chat chain",
            "served_by": "ollama:qwen3:8b",
            "standby": False,
        },
        "reason": None,
    }


def _gateway(role: str = "event_test", **over) -> FakeGateway:
    """A gateway that echoes a route PUT the way the real one does."""
    fields = dict(admin_body={"role": role, "chain": []}, explain_body=_explain(role))
    fields.update(over)
    return FakeGateway(**fields)


def _route_calls(gateway: FakeGateway) -> list[tuple[str, dict | None]]:
    return [(p, b) for p, b in gateway.seen if p.startswith("/admin/routes/")]


async def _post_event(client, name: str, token: str):
    """POST to the intake with core shutting down, so no turn starts and the
    answer is the intake's verdict alone."""
    chat.begin_shutdown()
    try:
        return await client.post(
            INTAKE.format(name), content="x", headers={"Authorization": f"Bearer {token}"}
        )
    finally:
        chat.accept_queued_turns_again()


# -- C2: add --------------------------------------------------------------------------


async def test_adding_a_sender_returns_its_token_once_and_makes_its_role(
    owner_client, pool, mount_peers, caplog
):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    with caplog.at_level(logging.DEBUG):
        resp = await owner_client.post(API, json={"name": "test"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    token = body["token"]
    assert isinstance(token, str) and len(token) >= 32
    assert body["name"] == "test" and body["role"] == "event_test"
    assert body["kind"] == "token" and body["added_by"] == "owner" and body["enabled"] is True
    assert body["route"]["registered"] is True
    assert "route event_test registered" in body["route"]["detail"]
    # The role exists on the gateway: core PUT its empty chain and read it back.
    assert ("/admin/routes/event_test", {"chain": []}) in _route_calls(gateway)
    # Stored only hashed; the token is in no log line.
    row = await pool.fetchrow("SELECT * FROM event_senders WHERE name = 'test'")
    assert row["token_hash"] != token and token not in row["token_hash"]
    assert row["token_once"] is None
    assert token not in " ".join(r.getMessage() for r in caplog.records)
    # The token it returned is the one the intake takes.
    assert (await _post_event(owner_client, "test", token)).status_code == 202


async def test_no_get_ever_returns_a_token(owner_client, pool, mount_peers):
    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    _, kept = await events.add_sender(pool, "kept", added_by="nova", reveal_once=True)
    for path in (API, f"{API}/test", f"{API}/kept"):
        resp = await owner_client.get(path)
        if resp.status_code == 405:
            continue
        assert resp.status_code == 200, (path, resp.text)
        assert token not in resp.text and kept not in resp.text
        assert "token_hash" not in resp.text and "token_once" not in resp.text
        for row in resp.json():
            assert "token" not in row
    # The kept token is still waiting: no GET spent its one reveal.
    assert await pool.fetchval("SELECT token_once FROM event_senders WHERE name = 'kept'") == kept


async def test_the_list_names_every_sender_and_holds_no_token(owner_client, pool, mount_peers):
    mount_peers(gateway=_gateway())
    await events.ensure_builtins(pool)
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    await events.add_sender(pool, "kept", added_by="nova", reveal_once=True)
    resp = await owner_client.get(API)
    assert resp.status_code == 200
    rows = resp.json()
    assert [r["name"] for r in rows] == ["github_ci", "kept", "monitor", "test"]
    for r in rows:
        assert set(r) == LISTED_KEYS
        assert r["role"] == f"event_{r['name']}"
    by = {r["name"]: r for r in rows}
    assert by["kept"]["token_waiting"] is True
    assert by["test"]["token_waiting"] is False
    assert by["monitor"]["kind"] == "monitor" and by["github_ci"]["kind"] == "poll"
    assert token not in resp.text


@pytest.mark.parametrize(
    "name, said",
    [
        ("Bad-Name", "a sender name is"),
        ("monitor", "built-in"),
        ("github_ci", "built-in"),
        ("", "a sender name is"),
    ],
)
async def test_a_bad_name_is_refused_with_the_reason_and_the_gateway_is_not_asked(
    owner_client, pool, mount_peers, name, said
):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    resp = await owner_client.post(API, json={"name": name})
    assert resp.status_code == 400, resp.text
    assert said in resp.json()["error"]
    assert "token" not in resp.json()
    assert _route_calls(gateway) == []
    assert await pool.fetchval("SELECT count(*) FROM event_senders WHERE kind = 'token'") == 0


async def test_a_duplicate_is_refused_and_the_first_keeps_its_token(owner_client, mount_peers):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    calls = len(_route_calls(gateway))
    resp = await owner_client.post(API, json={"name": "test"})
    assert resp.status_code == 400
    assert "already exists" in resp.json()["error"]
    assert len(_route_calls(gateway)) == calls, "a duplicate never touches the live role"
    assert (await _post_event(owner_client, "test", token)).status_code == 202


@pytest.mark.parametrize("body", [{}, {"name": 3}, {"name": "test", "token": "mine"}, []])
async def test_a_malformed_body_is_refused(owner_client, mount_peers, body):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    resp = await owner_client.post(API, json=body)
    assert resp.status_code in (400, 422), resp.text
    assert _route_calls(gateway) == []


@pytest.mark.parametrize(
    "gateway_over, said",
    [
        ({"admin_status": 500, "admin_body": {"error": "routes table is gone"}}, "routes table"),
        ({"admin_body": {"role": "event_test"}}, "did not echo"),
    ],
)
async def test_a_gateway_that_fails_fails_the_add_and_leaves_no_sender(
    owner_client, pool, mount_peers, caplog, gateway_over, said
):
    mount_peers(gateway=_gateway(**gateway_over))
    with caplog.at_level(logging.DEBUG):
        resp = await owner_client.post(API, json={"name": "test"})
    assert resp.status_code == 502, resp.text
    body = resp.json()
    assert said in body["error"]
    assert "token" not in body
    assert await pool.fetchval("SELECT count(*) FROM event_senders WHERE name = 'test'") == 0
    # Nothing was left that takes calls.
    resp = await _post_event(owner_client, "test", "anything")
    assert resp.status_code == 401


async def test_an_unreachable_gateway_fails_the_add(owner_client, pool, mount_peers, monkeypatch):
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    resp = await owner_client.post(API, json={"name": "test"})
    assert resp.status_code == 502, resp.text
    assert "gateway" in resp.json()["error"]
    assert "token" not in resp.json()
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 0


async def test_a_kept_token_is_revealed_once(owner_client, pool, mount_peers):
    mount_peers(gateway=_gateway())
    _, token = await events.add_sender(pool, "kept", added_by="nova", reveal_once=True)
    first = await owner_client.post(f"{API}/kept/token")
    assert first.status_code == 200, first.text
    assert first.json() == {"name": "kept", "token": token}
    again = await owner_client.post(f"{API}/kept/token")
    assert again.status_code == 404
    assert token not in again.text
    assert (await owner_client.post(f"{API}/nobody/token")).status_code == 404


# -- C3: on/off -----------------------------------------------------------------------


async def test_off_stops_the_intake_and_on_starts_it_again(owner_client, pool, mount_peers):
    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    resp = await owner_client.patch(f"{API}/test", json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["enabled"] is False and "token" not in resp.json()
    assert (await _post_event(owner_client, "test", token)).status_code == 401
    refused = await pool.fetchval(
        "SELECT reason FROM events WHERE state = 'refused' ORDER BY received_at DESC LIMIT 1"
    )
    assert refused == events.SENDER_OFF
    resp = await owner_client.patch(f"{API}/test", json={"enabled": True})
    assert resp.status_code == 200 and resp.json()["enabled"] is True
    assert (await _post_event(owner_client, "test", token)).status_code == 202


async def test_a_built_in_can_be_switched_off(owner_client, pool):
    await events.ensure_builtins(pool)
    resp = await owner_client.patch(f"{API}/monitor", json={"enabled": False})
    assert resp.status_code == 200
    assert await pool.fetchval("SELECT enabled FROM event_senders WHERE name = 'monitor'") is False


@pytest.mark.parametrize(
    "body",
    [{"enabled": "no"}, {"enabled": 0}, {}, {"enabled": True, "name": "x"}, {"kind": "poll"}],
)
async def test_a_patch_takes_only_enabled_as_a_bool(owner_client, pool, mount_peers, body):
    mount_peers(gateway=_gateway())
    await owner_client.post(API, json={"name": "test"})
    resp = await owner_client.patch(f"{API}/test", json=body)
    assert resp.status_code in (400, 422), resp.text
    assert await pool.fetchval("SELECT enabled FROM event_senders WHERE name = 'test'") is True


async def test_an_unknown_sender_is_a_404(owner_client):
    resp = await owner_client.patch(f"{API}/nobody", json={"enabled": False})
    assert resp.status_code == 404
    assert "nobody" in resp.json()["error"]
    assert (await owner_client.delete(f"{API}/nobody")).status_code == 404


# -- C4: delete -----------------------------------------------------------------------


async def test_deleting_a_sender_stops_its_intake_and_its_waiting_events(
    owner_client, pool, mount_peers
):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    assert (await _post_event(owner_client, "test", token)).status_code == 202
    done_id = await pool.fetchval(
        "INSERT INTO events (sender, payload, state) VALUES ('test', 'old', 'done') RETURNING id"
    )
    gateway.admin_body = {"deleted": "event_test"}
    resp = await owner_client.delete(f"{API}/test")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == "test"
    assert body["failed_events"] == 1
    assert body["route"]["registered"] is True and "removed" in body["route"]["detail"]
    assert ("/admin/routes/event_test", None) in _route_calls(gateway)
    assert await pool.fetchval("SELECT count(*) FROM event_senders WHERE name = 'test'") == 0
    # The waiting event never runs; it says why. History stays.
    waiting = await pool.fetchrow("SELECT state, reason FROM events WHERE payload = 'x'")
    assert (waiting["state"], waiting["reason"]) == ("failed", events.SENDER_DELETED)
    assert await pool.fetchval("SELECT state FROM events WHERE id = $1", done_id) == "done"
    # The intake refuses it now, whatever token.
    resp = await _post_event(owner_client, "test", token)
    assert resp.status_code == 401
    refused = await pool.fetchval(
        "SELECT reason FROM events WHERE state = 'refused' ORDER BY received_at DESC LIMIT 1"
    )
    assert refused == events.UNKNOWN_SENDER
    # Nothing is left for a later tick to start.
    assert await events.start_queued(app, pool) == []


async def test_a_gateway_failure_on_delete_is_stated_and_the_sender_still_goes(
    owner_client, pool, mount_peers
):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    gateway.admin_status, gateway.admin_body = 500, {"error": "db down"}
    resp = await owner_client.delete(f"{API}/test")
    assert resp.status_code == 200, resp.text
    route = resp.json()["route"]
    assert route["registered"] is False
    assert "db down" in route["detail"]
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 0
    assert (await _post_event(owner_client, "test", token)).status_code == 401


@pytest.mark.parametrize("name", ["monitor", "github_ci"])
async def test_a_built_in_cannot_be_deleted(owner_client, pool, mount_peers, name):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    await events.ensure_builtins(pool)
    resp = await owner_client.delete(f"{API}/{name}")
    assert resp.status_code == 400
    assert "switch it off" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM event_senders WHERE name = $1", name) == 1
    assert _route_calls(gateway) == []


# -- C3/C4: a delete or switch-off racing a call already past the token check ----------


async def _call_while(owner_client, pool, monkeypatch, name: str, token: str, act):
    """POST to the intake with `act` run while its body is read — after the
    token check, before the accept — the way a delete or switch-off lands
    while a client is still streaming its body."""
    from app import events_api

    real = events_api._read_capped

    async def reading(request):
        body = await real(request)
        await act()
        return body

    monkeypatch.setattr(events_api, "_read_capped", reading)
    return await _post_event(owner_client, name, token)


async def _no_event_waits(pool, name: str) -> None:
    rows = await pool.fetch(
        "SELECT state, reason FROM events WHERE sender = $1 AND state <> 'refused'", name
    )
    assert rows == [], [dict(r) for r in rows]
    assert await events.start_queued(app, pool) == []


async def test_a_delete_while_the_body_is_read_refuses_the_call(
    owner_client, pool, mount_peers, monkeypatch
):
    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]

    async def delete():
        await events.delete_sender(app, pool, "test")

    resp = await _call_while(owner_client, pool, monkeypatch, "test", token, delete)
    assert resp.status_code == 401, resp.text
    assert resp.json() == {"error": "refused: this sender does not take that token"}
    refused = await pool.fetchval(
        "SELECT reason FROM events WHERE state = 'refused' ORDER BY received_at DESC LIMIT 1"
    )
    assert refused == events.UNKNOWN_SENDER
    await _no_event_waits(pool, "test")


async def test_a_switch_off_while_the_body_is_read_refuses_the_call(
    owner_client, pool, mount_peers, monkeypatch
):
    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]

    async def switch_off():
        await events.set_enabled(pool, "test", False)

    resp = await _call_while(owner_client, pool, monkeypatch, "test", token, switch_off)
    assert resp.status_code == 401, resp.text
    refused = await pool.fetchval(
        "SELECT reason FROM events WHERE state = 'refused' ORDER BY received_at DESC LIMIT 1"
    )
    assert refused == events.SENDER_OFF
    await _no_event_waits(pool, "test")
    assert await pool.fetchval("SELECT last_sent_at FROM event_senders WHERE name = 'test'") is None


async def test_an_uncommitted_delete_holds_the_accept_until_it_lands(
    owner_client, pool, mount_peers
):
    """The delete holds the sender's row lock; the accept waits on the same
    lock and reads the row after the delete committed: 401, nothing queued."""
    import asyncio

    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    async with pool.acquire() as conn:
        tx = conn.transaction()
        await tx.start()
        await conn.execute("SELECT 1 FROM event_senders WHERE name = 'test' FOR UPDATE")
        await conn.execute("DELETE FROM event_senders WHERE name = 'test'")
        call = asyncio.create_task(_post_event(owner_client, "test", token))
        for _ in range(200):
            if call.done() or await pool.fetchval(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE wait_event_type = 'Lock' AND datname = current_database()"
            ):
                break
            await asyncio.sleep(0.02)
        await tx.commit()
    resp = await call
    assert resp.status_code == 401, resp.text
    await _no_event_waits(pool, "test")


async def test_a_queued_event_whose_sender_is_gone_is_failed_never_run(pool):
    """Defence in depth: whatever left it queued, a sender with no row runs no turn."""
    event_id = await pool.fetchval(
        "INSERT INTO events (sender, payload) VALUES ('ghost', 'x') RETURNING id"
    )
    assert await events.start_queued(app, pool) == []
    row = await pool.fetchrow("SELECT state, reason, turn_id FROM events WHERE id = $1", event_id)
    assert (row["state"], row["reason"], row["turn_id"]) == ("failed", events.SENDER_DELETED, None)


async def test_a_queued_event_whose_sender_was_switched_off_is_failed_never_run(
    owner_client, pool, mount_peers
):
    mount_peers(gateway=_gateway())
    token = (await owner_client.post(API, json={"name": "test"})).json()["token"]
    assert (await _post_event(owner_client, "test", token)).status_code == 202
    await events.set_enabled(pool, "test", False)
    assert await events.start_queued(app, pool) == []
    row = await pool.fetchrow(
        "SELECT state, reason, turn_id FROM events WHERE sender = 'test' AND state <> 'refused'"
    )
    assert (row["state"], row["reason"], row["turn_id"]) == (
        "failed",
        events.SENDER_SWITCHED_OFF,
        None,
    )


# -- C5: who may call -----------------------------------------------------------------


@pytest.mark.parametrize(
    "method, path, body",
    [
        ("GET", API, None),
        ("POST", API, {"name": "evil"}),
        ("PATCH", f"{API}/test", {"enabled": False}),
        ("DELETE", f"{API}/test", None),
        ("POST", f"{API}/test/token", None),
    ],
)
async def test_only_an_identity_reaches_the_api(client, pool, method, path, body):
    """No cookie, or a sender's own token as the bearer: 401, nothing done."""
    _, token = await events.add_sender(pool, "test", added_by="owner")
    for headers in ({}, {"Authorization": f"Bearer {token}"}):
        resp = await client.request(method, path, json=body, headers=headers)
        assert resp.status_code == 401, (method, path, headers, resp.text)
        assert token not in resp.text
    row = await pool.fetchrow("SELECT enabled FROM event_senders WHERE name = 'test'")
    assert row is not None and row["enabled"] is True
    assert await pool.fetchval("SELECT count(*) FROM event_senders") == 1


# -- C6: the role ---------------------------------------------------------------------


async def test_a_chain_for_an_event_role_with_no_sender_is_refused(owner_client, mount_peers):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    resp = await owner_client.put("/api/v1/routes/event_nobody", json={"chain": []})
    assert resp.status_code == 400
    assert "no event sender named 'nobody'" in resp.json()["error"]
    assert gateway.seen == []
    resp = await owner_client.put("/api/v1/routes/event_nobody/jev-router", json={"on": False})
    assert resp.status_code == 400
    assert gateway.seen == []


async def test_a_chain_for_a_live_sender_role_reaches_the_gateway(owner_client, pool, mount_peers):
    gateway = _gateway()
    mount_peers(gateway=gateway)
    await events.ensure_builtins(pool)
    resp = await owner_client.put("/api/v1/routes/event_monitor", json={"chain": []})
    assert resp.status_code == 200, resp.text
    assert gateway.seen[-1] == ("/admin/routes/event_monitor", {"chain": []})
