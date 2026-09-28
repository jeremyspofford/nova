"""S42a: the devices family — two live agents reporting one machine."""

from __future__ import annotations

from app import checks
from app.checks import devices as devices_checks
from tests.conftest import requires_db

pytestmark = requires_db

PUBKEY = "cd" * 32


async def _agent(pool, name: str, uid: str | None, *, revoked: bool = False) -> None:
    facts = None if uid is None else {"v": 2, "machine_uid": uid}
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey, facts, facts_at, revoked_at) "
        "VALUES ($1, 'windows', 'h', $2, $3, CASE WHEN $3::jsonb IS NULL THEN NULL ELSE now() END, "
        "CASE WHEN $4 THEN now() ELSE NULL END)",
        name,
        PUBKEY,
        facts,
        revoked,
    )


async def test_two_live_agents_on_one_machine_are_one_finding_naming_both(pool):
    await _agent(pool, "pc-windows", "a" * 64)
    await _agent(pool, "pc-other", "a" * 64)
    await _agent(pool, "laptop", "b" * 64)
    await _agent(pool, "old", None)
    found = await devices_checks.duplicate_agents(None, pool)
    assert [f.key for f in found] == ["duplicate_agent:" + "a" * 12]
    assert found[0].facts == {"machine_uid": "a" * 64, "agents": ["pc-other", "pc-windows"]}
    assert "revoke" in found[0].title


async def test_a_revoked_agent_is_not_a_duplicate(pool):
    await _agent(pool, "pc-windows", "a" * 64)
    await _agent(pool, "pc-gone", "a" * 64, revoked=True)
    assert await devices_checks.duplicate_agents(None, pool) == []


def test_the_family_is_registered_and_not_urgent():
    assert set(devices_checks.NAMES) <= set(checks.REGISTRY)
    assert not any(checks.REGISTRY[name].urgent for name in devices_checks.NAMES)
