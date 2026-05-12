import pytest
from unittest.mock import AsyncMock, MagicMock


def test_schedule_create_registered_as_mutate():
    import app.tools.tools_builtin.schedules
    from app.tools.registry import _registry, Tier
    td = _registry.get("schedule_create")
    assert td is not None
    assert td.tier == Tier.MUTATE
    assert td.reversible is True


def test_schedule_disable_is_mutate():
    import app.tools.tools_builtin.schedules
    from app.tools.registry import _registry, Tier
    assert _registry["schedule_disable"].tier == Tier.MUTATE


def test_schedule_delete_is_destruct():
    import app.tools.tools_builtin.schedules
    from app.tools.registry import _registry, Tier
    assert _registry["schedule_delete"].tier == Tier.DESTRUCT


@pytest.mark.asyncio
async def test_schedule_create_inserts_row():
    import app.tools.tools_builtin.schedules as mod
    ctx = MagicMock()
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value={
        "id": "s-001",
        "name": "check",
        "next_fire": None,
        "enabled": True,
        "created_by": "nova",
        "trigger": {},
    })
    acq = MagicMock()
    acq.__aenter__ = AsyncMock(return_value=conn)
    acq.__aexit__ = AsyncMock(return_value=False)
    ctx.pool = MagicMock()
    ctx.pool.acquire = MagicMock(return_value=acq)

    result = await mod.schedule_create(
        name="check",
        prompt="check open tasks",
        trigger={"type": "cron", "expr": "0 9 * * *"},
        ctx=ctx,
    )
    assert result["id"] == "s-001"
    assert result["created_by"] == "nova"
