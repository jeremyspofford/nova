"""GET/POST /api/v1/autonomy — Settings -> Autonomy's read + revoke (Fix 2)."""
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
    assert "fetch_url" in classes
    assert classes["fetch_url"]["disposition"] == "consent"


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
