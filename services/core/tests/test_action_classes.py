"""The action-class table: the DATA the kernel reads, and its tripwire.

The seed was ruling S3-R1 (fetch_url=consent, everything else auto); migration
008 then flipped fetch_url to auto as an owner-directed disposition edit (web
reads need no approval — a read-only, SSRF-guarded fetch is a contained read).
So the seed the kernel now reads is: EVERY currently-registered tool is auto.
The load-bearing property is unchanged and independent of that: every REGISTERED
tool must have a row, or it is denied by default AND this suite reddens — a new
tool is never auto by accident, and the day one lands without a migration row
this test says so. (The consent MECHANISM is proven with a private consent-tier
class in test_chat_consent.py / test_policy_funnel.py, decoupled from fetch_url's
real disposition — see those files.)
"""
from __future__ import annotations

from app import tools
from tests.conftest import requires_db

pytestmark = requires_db


async def test_the_seed_makes_every_registered_tool_auto(pool):
    # Deliberate tripwire update (migration 008): fetch_url was seeded 'consent'
    # under S3-R1 and is now 'auto' by owner directive. The seed carries no
    # consent-tier class at all anymore; the consent flow is exercised via a
    # PRIVATE class in the consent-mechanism suites so it stays fully proven.
    # web_search joined 'auto' with migration 009 (the search half of the same
    # owner directive that flipped fetch_url — web reads need no approval).
    rows = {
        r["action_class"]: r["disposition"]
        for r in await pool.fetch("SELECT action_class, disposition FROM action_classes")
    }
    for name in (
        "fetch_url",
        "web_search",
        "workspace_write_file",
        "workspace_read_file",
        "workspace_list_files",
        "memory_search",
        "memory_save",
        "get_time",
    ):
        assert rows[name] == "auto", name


async def test_every_registered_tool_has_an_action_class_row(pool):
    """The tripwire (ruling S3-R2). A registered tool with no row is denied by
    default; this fails deliberately the day that happens, so the row is added
    with intent, never routed around."""
    classified = {
        r["action_class"] for r in await pool.fetch("SELECT action_class FROM action_classes")
    }
    missing = set(tools.tool_names()) - classified
    assert missing == set(), f"registered tools with no action class (denied by default): {missing}"


async def test_disposition_is_constrained_to_the_known_set(pool):
    """A disposition the kernel does not handle must not be storable by typo —
    the CHECK is widened deliberately when notify/step-up land, never silently."""
    import asyncpg
    import pytest

    with pytest.raises(asyncpg.PostgresError):
        await pool.execute(
            "INSERT INTO action_classes (action_class, risk_tier, disposition) "
            "VALUES ('x', 'y', 'notify')"
        )
