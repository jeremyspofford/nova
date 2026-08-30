"""The governance ledger: a row for every decision an operator must audit,
none for a plain auto-allow, and each written with (or as) the fact it records.
"""
from __future__ import annotations

import uuid

from app import consents, governance, policy
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

ARGS = {"url": "https://example.com/pricing"}


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


def _ctx(person: Person | None) -> ToolContext:
    from pathlib import Path

    return ToolContext(app=None, person=person, workspace_root=Path("/tmp"))


async def _of_kind(pool, kind: str) -> list:
    return [e for e in await governance.recent_events(pool) if e["kind"] == kind]


async def test_raising_a_consent_writes_a_raised_event_pointing_at_it(pool):
    person = await _person(pool)
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=ARGS,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    events = await governance.recent_events(pool)
    raised = [e for e in events if e["kind"] == governance.CONSENT_RAISED]
    assert len(raised) == 1
    assert str(raised[0]["subject_ref"]) == card["consent_id"]
    assert raised[0]["action_class"] == "fetch_url"
    assert raised[0]["meta"]["args_hash"] == card["args_hash"]


async def test_deciding_writes_a_decided_event(pool):
    person = await _person(pool)
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=ARGS,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    decided = await _of_kind(pool, governance.CONSENT_DECIDED)
    assert len(decided) == 1
    assert decided[0]["meta"]["decision"] == "approved"


async def test_burning_writes_a_burned_event(pool):
    person = await _person(pool)
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=ARGS,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    await consents.validate_and_use(
        pool,
        action_class="fetch_url",
        args_hash=consents.args_hash(ARGS),
        person_id=person.id,
        agent="chat",
    )
    burned = await _of_kind(pool, governance.CONSENT_BURNED)
    assert len(burned) == 1
    assert str(burned[0]["subject_ref"]) == card["consent_id"]


async def test_a_denial_writes_a_policy_denied_event(pool):
    person = await _person(pool)
    await policy.authorize(_ctx(person), "made_up_tool", {"x": 1})
    denied = await _of_kind(pool, governance.POLICY_DENIED)
    assert len(denied) == 1
    assert denied[0]["action_class"] == "made_up_tool"


async def test_an_auto_allow_writes_no_governance_event(pool):
    """The ledger is for gated decisions, not every read — an auto tool leaves
    no row, so an audit is decisions, not noise."""
    person = await _person(pool)
    await policy.authorize(_ctx(person), "get_time", {})
    assert await pool.fetchval("SELECT count(*) FROM governance_events") == 0
