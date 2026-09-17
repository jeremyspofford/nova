"""The governance ledger: a RECORD of what happened, never a gate.

Two pins. An event written with the mutation it records reads back verbatim
(the ledger is the operator's audit of device enrol/revoke/audit-break). And
running a tool through dispatch writes NOTHING here — nothing in v4 decides
whether Nova may act (owner ruling 2026-09-03), so there is no decision to
record; the tool call's own record is its turn_span, written by the chat loop.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from app import governance, tools
from app.identity import Person
from app.tools.base import Tool, ToolContext, ToolFailure
from tests.conftest import requires_db

pytestmark = requires_db


async def test_record_event_round_trips_through_recent_events(pool):
    device = uuid.uuid4()
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(
            conn,
            kind=governance.DEVICE_ENROLLED,
            actor="jeremy",
            subject_ref=device,
            meta={"name": "laptop", "pubkey": "ab" * 32},
        )
    # A standalone event (no mutation to share a transaction with) lands the
    # same way — its writer opens the one transaction it needs, as
    # devices_ws._audit_break does — and newest-first ordering holds.
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(
            conn, kind=governance.DEVICE_AUDIT_BREAK, subject_ref=device, meta={"seq": 3}
        )

    events = await governance.recent_events(pool)
    assert [e["kind"] for e in events] == [
        governance.DEVICE_AUDIT_BREAK,
        governance.DEVICE_ENROLLED,
    ]
    enrolled = events[1]
    assert enrolled["actor"] == "jeremy"
    assert enrolled["subject_ref"] == device
    assert enrolled["meta"] == {"name": "laptop", "pubkey": "ab" * 32}
    assert enrolled["created_at"] is not None
    assert events[0]["meta"] == {"seq": 3}
    # The ledger row carries no decision column: there is no decision.
    assert "action_class" not in dict(enrolled)


async def test_dispatching_a_tool_writes_no_governance_row(pool, monkeypatch, tmp_path):
    """dispatch reads no table and writes no row — a tool runs because it was
    called. Both a success and a stated refusal leave the ledger exactly as it
    was, so the ledger can never become a gate's log by accident."""
    calls: list[dict] = []

    async def runs(args: dict, ctx: ToolContext) -> str:
        calls.append(args)
        return "did the thing"

    async def refuses(args: dict, ctx: ToolContext) -> str:
        raise ToolFailure("the path is outside the workspace")

    schema = {"type": "object", "properties": {}, "additionalProperties": False}
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_ok",
        Tool(name="spy_ok", description="d", parameters=schema, executor=runs),
    )
    monkeypatch.setitem(
        tools.REGISTRY,
        "spy_refuses",
        Tool(name="spy_refuses", description="d", parameters=schema, executor=refuses),
    )
    ctx = ToolContext(
        app=None,
        person=Person(id=uuid.uuid4(), name="jeremy", role="owner"),
        workspace_root=Path(tmp_path),
    )
    assert await pool.fetchval("SELECT count(*) FROM governance_events") == 0

    result, ok = await tools.dispatch("spy_ok", "{}", ctx)
    assert (result, ok) == ("did the thing", True)
    assert calls == [{}]
    result, ok = await tools.dispatch("spy_refuses", "{}", ctx)
    assert (result, ok) == ("Error: the path is outside the workspace", False)

    assert await pool.fetchval("SELECT count(*) FROM governance_events") == 0
