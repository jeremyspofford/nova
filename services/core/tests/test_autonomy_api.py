"""GET/POST/PUT /api/v1/autonomy — Settings -> Autonomy's read, revoke (Fix 2)
and the owner's disposition control (PUT)."""
from __future__ import annotations

from app import governance
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
