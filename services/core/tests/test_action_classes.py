"""The action-class table: the DATA the kernel reads, and its tripwire.

The seed was ruling S3-R1 (fetch_url=consent, everything else auto); migration
008 then flipped fetch_url to auto as an owner-directed disposition edit (web
reads need no approval — a read-only, SSRF-guarded fetch is a contained read).

Slice 5 (migration 012) is the first seed that is NOT all-auto: the nine device
tools land with the six reads/harmless effects auto and the three that change a
machine or run code on it (device_run, device_write_file, device_launch_app) at
CONSENT — exactly the irreversible set rd6 keeps a gate on. So the auto-set test
below now asserts dispositions PER TOOL, not "everything is auto".

The load-bearing property is unchanged and independent of that: every REGISTERED
tool must have a row, or it is denied by default AND this suite reddens — a new
tool is never auto by accident, and the day one lands without a migration row
this test says so. (The consent MECHANISM is proven with a private consent-tier
class in test_chat_consent.py / test_policy_funnel.py.)
"""
from __future__ import annotations

from app import tools
from tests.conftest import requires_db

pytestmark = requires_db


async def test_the_seed_gives_each_tool_its_intended_disposition(pool):
    # Deliberate tripwire update (migration 008): fetch_url was seeded 'consent'
    # under S3-R1 and is now 'auto' by owner directive. web_search joined 'auto'
    # with migration 009 (the search half of the same directive — web reads need
    # no approval).
    #
    # Deliberate tripwire update (slice 5 / migration 012): the nine device tools
    # arrive. Six are auto (device_info/list/list_files/read_file/list_apps and
    # device_notify — reads plus one reversible, harmless effect); THREE are
    # consent (device_run, device_write_file, device_launch_app — the irreversible
    # set: run code, write a file, launch an app on a real machine). This test was
    # "every registered tool is auto" until here; it now asserts each disposition,
    # because the all-auto invariant is deliberately no longer true.
    rows = {
        r["action_class"]: r["disposition"]
        for r in await pool.fetch("SELECT action_class, disposition FROM action_classes")
    }
    auto = (
        "fetch_url",
        "web_search",
        "workspace_write_file",
        "workspace_read_file",
        "workspace_list_files",
        "memory_search",
        "memory_save",
        "get_time",
        "device_list",
        "device_info",
        "device_list_files",
        "device_read_file",
        "device_list_apps",
        "device_notify",
    )
    consent = ("device_run", "device_write_file", "device_launch_app")
    for name in auto:
        assert rows[name] == "auto", name
    for name in consent:
        assert rows[name] == "consent", name


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
