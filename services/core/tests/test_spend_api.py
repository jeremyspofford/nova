"""GET /api/v1/spend — the gateway's rollup with the people named (S10)."""

from __future__ import annotations

from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db

REPORT = {
    "window": "month",
    "since": "2026-09-01T00:00:00-06:00",
    "until": "2026-09-08T04:00:00+00:00",
    "timezone": "America/Denver",
    "totals": {
        "usd": 3.5,
        "calls": 4,
        "unmetered": 1,
        "refusals": 0,
        "gpu_seconds": 12.0,
        "usd_by_basis": {"provider-reported": 3.5},
        "ledger_write_failures": 0,
        "month_usd": 3.5,
        "month_cap_usd": 20.0,
    },
    "by_provider": [
        {
            "provider": "openrouter",
            "local": False,
            "usd": 3.5,
            "calls": 3,
            "unmetered": 1,
            "refusals": 0,
            "gpu_seconds": None,
            "month_usd": 3.5,
            "cap_usd": 10.0,
            "remaining_usd": 6.5,
        }
    ],
    "by_model": [],
    "by_purpose": [],
    "by_role": [],
    "by_day": [],
    "unpriced": [],
    "recent_refusals": [],
    "caps": {"*": 20.0, "openrouter": 10.0},
}


async def test_the_report_names_the_people_and_forwards_the_zone(owner_client, pool, mount_peers):
    owner = await pool.fetchrow("SELECT id, name FROM people WHERE role = 'owner'")
    gateway = FakeGateway(
        spend_body={
            **REPORT,
            "by_person": [
                {"key": str(owner["id"]), "local": False, "usd": 3.0, "calls": 3},
                {
                    "key": "00000000-0000-4000-8000-000000000000",
                    "local": False,
                    "usd": 0.5,
                    "calls": 1,
                },
                {"key": None, "local": True, "usd": 0.0, "calls": 2},
            ],
        }
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await owner_client.put(
        "/api/v1/settings", json={"key": "nova.timezone", "value": "America/Denver"}
    )

    resp = await owner_client.get("/api/v1/spend?window=month")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    people = body["by_person"]
    assert people[0]["person"] == {"name": owner["name"], "role": "owner"}
    assert people[1]["person"] == {"name": "(no longer exists)", "role": None}
    assert people[2]["person"] is None
    assert body["totals"]["usd"] == 3.5
    assert gateway.queries[-1] == b"window=month"
    assert gateway.seen_headers[-1]["x-nova-timezone"] == "America/Denver"

    bad = await owner_client.get("/api/v1/spend?window=year")
    assert bad.status_code == 400


async def test_a_gateway_that_cannot_answer_is_a_stated_502(owner_client, monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "t")
    from app.main import app

    app.state.peer_transports = {}
    resp = await owner_client.get("/api/v1/spend")
    assert resp.status_code == 502 and "could not reach the gateway" in resp.json()["error"]
