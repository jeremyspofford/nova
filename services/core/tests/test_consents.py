"""The consent burn: mechanical, args-bound, single-use, requestor-bound, TTL'd,
and atomic with its governance event — plus approve-runs-nothing (ruling S3-R4).

The burn is the control the whole slice leans on, so every way it must REFUSE
is pinned here, and so is the atomicity: a failed ledger write leaves the
approval intact and retryable, never a spent consent with no record.
"""
from __future__ import annotations

import uuid

import pytest

from app import consents, governance
from app.identity import Person
from tests.conftest import requires_db

pytestmark = requires_db

ARGS = {"url": "https://example.com/pricing"}


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _approved(pool, person: Person, args=ARGS, *, agent="chat") -> dict:
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=args,
        summary="s",
        person_id=person.id,
        agent=agent,
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    return card


async def _burn(pool, person: Person, args=ARGS, *, agent="chat") -> bool:
    return await consents.validate_and_use(
        pool,
        action_class="fetch_url",
        args_hash=consents.args_hash(args),
        person_id=person.id,
        agent=agent,
    )


# -- single-use ------------------------------------------------------------


async def test_a_consent_burns_exactly_once(pool):
    person = await _person(pool)
    await _approved(pool, person)
    assert await _burn(pool, person) is True
    assert await _burn(pool, person) is False  # the second attempt finds nothing to spend


# -- args-bound (ruling S3-R3; D-029 loopholes not carried) ----------------


async def test_a_consent_will_not_burn_for_different_args(pool):
    person = await _person(pool)
    await _approved(pool, person, {"url": "https://example.com/a"})
    other = consents.args_hash({"url": "https://example.com/b"})
    assert (
        await consents.validate_and_use(
            pool, action_class="fetch_url", args_hash=other, person_id=person.id, agent="chat"
        )
        is False
    )


# -- requestor-bound -------------------------------------------------------


async def test_a_consent_will_not_burn_for_a_different_person(pool):
    owner = await _person(pool, "owner")
    other = await _person(pool, "adult")
    await _approved(pool, owner)
    assert await _burn(pool, other) is False  # not the requestor
    assert await _burn(pool, owner) is True  # the requestor still can


async def test_a_consent_will_not_burn_for_a_different_agent(pool):
    person = await _person(pool)
    await _approved(pool, person, agent="chat")
    assert await _burn(pool, person, agent="daemon") is False


# -- status and TTL --------------------------------------------------------


async def test_a_pending_consent_will_not_burn(pool):
    person = await _person(pool)
    await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=ARGS,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    assert await _burn(pool, person) is False  # approved-only; pending never burns


async def test_an_expired_consent_will_not_burn(pool):
    person = await _person(pool)
    card = await _approved(pool, person)
    await pool.execute(
        "UPDATE consents SET expires_at = now() - interval '1 second' WHERE id = $1",
        uuid.UUID(card["consent_id"]),
    )
    assert await _burn(pool, person) is False


# -- burn + governance atomicity -------------------------------------------


async def test_a_failed_governance_write_rolls_the_burn_back(pool, monkeypatch):
    """The event and the burn share a transaction: if the event write fails,
    the burn is undone — the approval survives, unused, and is retryable. A
    spent consent with no ledger entry is exactly what this forbids."""
    person = await _person(pool)
    card = await _approved(pool, person)

    async def boom(conn, **kwargs):
        raise RuntimeError("ledger write failed")

    monkeypatch.setattr(consents.governance, "record_event", boom)
    with pytest.raises(RuntimeError):
        await _burn(pool, person)

    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["status"] == "approved"
    assert row["used_at"] is None  # rolled back — nothing was spent

    monkeypatch.undo()
    events = await governance.recent_events(pool)
    assert not any(e["kind"] == governance.CONSENT_BURNED for e in events)
    # Truly retryable: with the ledger restored, the burn now succeeds.
    assert await _burn(pool, person) is True


# -- approve-has-an-executor (ruling S3-R4) --------------------------------


async def test_approving_a_card_runs_nothing_and_only_the_funnel_burns_it(pool):
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
    updated = await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    assert updated["status"] == "approved"
    # Approval consumed nothing — used_at is still NULL. No execute-at-approval.
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is None
    # The burn happens only when the funnel re-checks.
    assert await _burn(pool, person) is True


async def test_deciding_a_second_time_is_a_safe_no_op(pool):
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
    cid = uuid.UUID(card["consent_id"])
    assert await consents.decide(pool, consent_id=cid, approve=True, decided_by=person.id)
    # Already decided: a second decide changes nothing and writes no event.
    assert await consents.decide(pool, consent_id=cid, approve=False, decided_by=person.id) is None
    row = await consents.get(pool, cid)
    assert row["status"] == "approved"


async def test_a_denied_card_never_burns(pool):
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
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=False, decided_by=person.id
    )
    assert await _burn(pool, person) is False
