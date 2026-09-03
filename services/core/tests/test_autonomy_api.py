"""GET/POST/PUT /api/v1/autonomy — Settings -> Autonomy's read, revoke (Fix 2)
and the owner's disposition control (PUT)."""
from __future__ import annotations

import pytest

from app import governance
from app.main import app
from tests.conftest import requires_db

pytestmark = requires_db


async def _seed(pool, action_class: str, *, disposition="consent", earned=False, n=0) -> None:
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'test', $2, $3, $4) "
        "ON CONFLICT (action_class) DO UPDATE SET "
        "disposition = EXCLUDED.disposition, earned = EXCLUDED.earned, "
        "consecutive_successes = EXCLUDED.consecutive_successes, updated_at = now()",
        action_class,
        disposition,
        earned,
        n,
    )


async def test_get_needs_an_identity(client):
    assert (await client.get("/api/v1/autonomy")).status_code == 401


async def test_revoke_needs_an_identity(client):
    assert (await client.post("/api/v1/autonomy/fetch_url/revoke")).status_code == 401


async def test_get_reports_the_real_stored_state(owner_client, pool):
    await _seed(pool, "api_state_class", disposition="consent", n=3)
    resp = await owner_client.get("/api/v1/autonomy")
    assert resp.status_code == 200
    classes = {c["action_class"]: c for c in resp.json()["classes"]}
    entry = classes["api_state_class"]
    assert entry["disposition"] == "consent"
    assert entry["consecutive_successes"] == 3
    assert entry["graduation_runs"] == 5
    assert entry["earned"] is False
    # The seeded classes are visible too — this really is every gateable class.
    # fetch_url is 'auto' now (migration 008: owner-directed, web reads need no
    # approval); it stays LISTED here so Settings -> Autonomy can set it back to
    # consent later, which is exactly what makes this route "every gateable class".
    assert "fetch_url" in classes
    assert classes["fetch_url"]["disposition"] == "auto"


async def test_revoking_an_earned_auto_class_demotes_it_and_is_a_governance_event(
    owner_client, pool
):
    await _seed(pool, "api_revoke_class", disposition="auto", earned=True)
    resp = await owner_client.post("/api/v1/autonomy/api_revoke_class/revoke")
    assert resp.status_code == 200
    classes = {c["action_class"]: c for c in resp.json()["classes"]}
    assert classes["api_revoke_class"]["disposition"] == "consent"

    events = await governance.recent_events(pool, action_class="api_revoke_class")
    kinds = [e["kind"] for e in events]
    assert governance.AUTONOMY_REVOKED in kinds


async def test_revoking_a_class_that_never_graduated_is_a_404(owner_client, pool):
    await _seed(pool, "api_revoke_never", disposition="consent")
    resp = await owner_client.post("/api/v1/autonomy/api_revoke_never/revoke")
    assert resp.status_code == 404


async def test_revoking_an_unknown_class_is_a_404(owner_client):
    resp = await owner_client.post("/api/v1/autonomy/does_not_exist/revoke")
    assert resp.status_code == 404


# -- PUT /{action_class}: the owner sets a class's disposition -----------------


async def test_set_disposition_needs_an_identity(client):
    resp = await client.put("/api/v1/autonomy/fetch_url", json={"disposition": "auto"})
    assert resp.status_code == 401


async def test_set_disposition_writes_the_row_and_returns_it(owner_client, pool):
    await _seed(pool, "api_disp_class", disposition="consent", n=2)
    resp = await owner_client.put(
        "/api/v1/autonomy/api_disp_class", json={"disposition": "auto"}
    )
    assert resp.status_code == 200, resp.text
    entry = resp.json()["class"]
    assert entry["action_class"] == "api_disp_class"
    assert entry["disposition"] == "auto"
    assert entry["earned"] is False
    assert entry["consecutive_successes"] == 0
    assert entry["graduation_runs"] == 5
    assert set(entry) == {
        "action_class",
        "risk_tier",
        "disposition",
        "earned",
        "consecutive_successes",
        "graduation_runs",
        "updated_at",
    }

    # The GET agrees (the row, not an echo), and the ledger names the person.
    listing = (await owner_client.get("/api/v1/autonomy")).json()["classes"]
    listed = {c["action_class"]: c for c in listing}
    assert listed["api_disp_class"]["disposition"] == "auto"
    me = (await owner_client.get("/api/v1/auth/me")).json()["person"]["id"]
    events = await governance.recent_events(pool, action_class="api_disp_class")
    set_events = [e for e in events if e["kind"] == governance.AUTONOMY_DISPOSITION_SET]
    assert len(set_events) == 1
    assert set_events[0]["actor"] == me
    assert set_events[0]["meta"]["before"] == "consent"
    assert set_events[0]["meta"]["after"] == "auto"


async def test_set_disposition_deny_then_consent_round_trips(owner_client, pool):
    await _seed(pool, "api_disp_rt", disposition="auto", earned=True)
    deny = await owner_client.put("/api/v1/autonomy/api_disp_rt", json={"disposition": "deny"})
    assert deny.status_code == 200 and deny.json()["class"]["disposition"] == "deny"
    back = await owner_client.put(
        "/api/v1/autonomy/api_disp_rt", json={"disposition": "consent"}
    )
    assert back.status_code == 200
    assert back.json()["class"]["disposition"] == "consent"
    assert back.json()["class"]["earned"] is False


async def test_set_disposition_refuses_a_bad_value_with_a_400(owner_client, pool):
    await _seed(pool, "api_disp_bad", disposition="consent")
    resp = await owner_client.put(
        "/api/v1/autonomy/api_disp_bad", json={"disposition": "sometimes"}
    )
    assert resp.status_code == 400
    assert "sometimes" in resp.json()["error"]


async def test_set_disposition_on_an_unknown_class_is_a_404(owner_client):
    resp = await owner_client.put(
        "/api/v1/autonomy/does_not_exist", json={"disposition": "auto"}
    )
    assert resp.status_code == 404
    assert "does_not_exist" in resp.json()["error"]


# -- PUT / (no class): the master control sets every class at once --------------
#
# A bulk write reaches the migration seed too and action_classes is never
# truncated, so each test snapshots the table and restores it (the same
# fixture test_autonomy.py carries, for the same reason).


@pytest.fixture
async def restored_action_classes(pool):
    before = await pool.fetch(
        "SELECT action_class, risk_tier, disposition, earned, consecutive_successes "
        "FROM action_classes"
    )
    yield
    for row in before:
        await pool.execute(
            "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
            "consecutive_successes) VALUES ($1, $2, $3, $4, $5) "
            "ON CONFLICT (action_class) DO UPDATE SET risk_tier = EXCLUDED.risk_tier, "
            "disposition = EXCLUDED.disposition, earned = EXCLUDED.earned, "
            "consecutive_successes = EXCLUDED.consecutive_successes, updated_at = now()",
            row["action_class"],
            row["risk_tier"],
            row["disposition"],
            row["earned"],
            row["consecutive_successes"],
        )
    await pool.execute(
        "DELETE FROM action_classes WHERE action_class <> ALL($1::text[])",
        [row["action_class"] for row in before],
    )


async def test_set_all_needs_an_identity(client):
    resp = await client.put("/api/v1/autonomy", json={"disposition": "auto"})
    assert resp.status_code == 401
    # The 401 must be THIS route's identity gate, not the identity middleware
    # answering for a route that does not exist (which also reads 401 here) —
    # so pin that PUT is registered on the bare prefix.
    assert "put" in app.openapi()["paths"]["/api/v1/autonomy"]


async def test_set_all_changes_exactly_the_differing_classes_and_returns_every_row(
    owner_client, pool, restored_action_classes
):
    await _seed(pool, "api_all_consent", disposition="consent", n=2)
    await _seed(pool, "api_all_deny", disposition="deny")
    await _seed(pool, "api_all_auto", disposition="auto", earned=True)
    before = (await owner_client.get("/api/v1/autonomy")).json()["classes"]
    expected_changed = sorted(c["action_class"] for c in before if c["disposition"] != "auto")
    assert "api_all_consent" in expected_changed and "api_all_deny" in expected_changed

    resp = await owner_client.put("/api/v1/autonomy", json={"disposition": "auto"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["changed"] == expected_changed  # exactly the differing classes, in order
    classes = {c["action_class"]: c for c in body["classes"]}
    assert set(classes) == {c["action_class"] for c in before}  # every row came back
    assert all(c["disposition"] == "auto" for c in classes.values())
    assert classes["api_all_auto"]["earned"] is True  # untouched — still earned
    assert classes["api_all_consent"]["consecutive_successes"] == 0

    # The GET agrees (rows, not an echo) and the ledger names the person, once
    # per changed class, under one batch.
    listed = (await owner_client.get("/api/v1/autonomy")).json()["classes"]
    listing = {c["action_class"]: c for c in listed}
    assert all(c["disposition"] == "auto" for c in listing.values())
    me = (await owner_client.get("/api/v1/auth/me")).json()["person"]["id"]
    events = [
        e
        for e in await governance.recent_events(pool, limit=1000)
        if e["kind"] == governance.AUTONOMY_DISPOSITION_SET
    ]
    assert sorted(e["action_class"] for e in events) == expected_changed
    assert {e["actor"] for e in events} == {me}
    assert len({e["meta"]["batch"] for e in events}) == 1


async def test_set_all_with_nothing_differing_is_a_200_with_an_empty_changed(
    owner_client, pool, restored_action_classes
):
    first = await owner_client.put("/api/v1/autonomy", json={"disposition": "deny"})
    assert first.status_code == 200
    again = await owner_client.put("/api/v1/autonomy", json={"disposition": "deny"})
    assert again.status_code == 200
    assert again.json()["changed"] == []
    assert all(c["disposition"] == "deny" for c in again.json()["classes"])


async def test_set_all_refuses_a_bad_value_with_a_400(owner_client, pool, restored_action_classes):
    await _seed(pool, "api_all_bad", disposition="consent", n=2)
    resp = await owner_client.put("/api/v1/autonomy", json={"disposition": "sometimes"})
    assert resp.status_code == 400
    assert "sometimes" in resp.json()["error"]
    row = await pool.fetchrow(
        "SELECT disposition, consecutive_successes FROM action_classes WHERE action_class = $1",
        "api_all_bad",
    )
    assert (row["disposition"], row["consecutive_successes"]) == ("consent", 2)
