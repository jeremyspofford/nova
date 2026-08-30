"""The policy kernel: the three decisions, and the single-authorizer pin.

authorize is the ONLY function that returns an ALLOW (D-012). These tests pin
each disposition's decision and — the load-bearing property — that no other
module under app/ constructs an allow.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from app import consents, policy
from app.identity import Person
from app.tools.base import ToolContext
from tests.conftest import requires_db

# -- the grep pin: this one is pure, no DB ---------------------------------

def test_only_policy_constructs_an_allow_decision():
    """D-012, pinned mechanically: search every module under app/ for the
    construction of an allow Decision. Exactly one file — policy.py — may."""
    app_dir = Path(policy.__file__).parent
    allow = re.compile(
        r"outcome\s*=\s*ALLOW|outcome\s*=\s*['\"]allow['\"]|Decision\(\s*ALLOW\b"
    )
    offenders = [
        str(py.relative_to(app_dir))
        for py in sorted(app_dir.rglob("*.py"))
        if py.name != "policy.py" and allow.search(py.read_text(encoding="utf-8"))
    ]
    assert offenders == [], f"only policy.py may construct an ALLOW, found: {offenders}"
    # Meaningful only if policy.py actually does construct one.
    assert allow.search(Path(policy.__file__).read_text(encoding="utf-8"))


# -- the decisions ---------------------------------------------------------

pytestmark = requires_db


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


def _ctx(person: Person | None, conversation_id: uuid.UUID | None = None) -> ToolContext:
    return ToolContext(
        app=None, person=person, workspace_root=Path("/tmp"), conversation_id=conversation_id
    )


async def test_auto_disposition_allows(pool):
    person = await _person(pool)
    decision = await policy.authorize(_ctx(person), "get_time", {})
    assert decision.outcome == policy.ALLOW
    assert decision.is_allow


async def test_an_unknown_action_class_is_denied_fail_closed(pool):
    person = await _person(pool)
    decision = await policy.authorize(_ctx(person), "made_up_tool", {"x": 1})
    assert decision.outcome == policy.DENY
    assert not decision.is_allow
    assert "made_up_tool" in decision.reason


async def test_a_consent_tool_without_approval_requires_consent(pool):
    person = await _person(pool)
    conv = await _conversation(pool, person)
    args = {"url": "https://example.com/pricing"}
    decision = await policy.authorize(_ctx(person, conv), "fetch_url", args)

    assert decision.outcome == policy.REQUIRE_CONSENT
    card = decision.card_spec
    assert card["action_class"] == "fetch_url"
    assert card["args_hash"] == consents.args_hash(args)
    assert card["conversation_id"] == str(conv)
    assert card["requested_by"] == {"person_id": str(person.id), "agent": "chat"}
    assert "example.com" in card["summary"]
    # The card is really pending in the DB, in this conversation.
    pending = await consents.pending_for_conversation(pool, conv)
    assert [c["consent_id"] for c in pending] == [card["consent_id"]]


async def test_asking_twice_reuses_the_one_pending_card(pool):
    person = await _person(pool)
    conv = await _conversation(pool, person)
    args = {"url": "https://example.com/pricing"}
    first = await policy.authorize(_ctx(person, conv), "fetch_url", args)
    second = await policy.authorize(_ctx(person, conv), "fetch_url", args)
    assert first.card_spec["consent_id"] == second.card_spec["consent_id"]
    assert len(await consents.pending_for_conversation(pool, conv)) == 1


async def test_an_approved_consent_is_burned_and_allows(pool):
    person = await _person(pool)
    args = {"url": "https://example.com/pricing"}
    card = await consents.raise_consent(
        pool,
        action_class="fetch_url",
        args=args,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )

    decision = await policy.authorize(_ctx(person), "fetch_url", args)
    assert decision.outcome == policy.ALLOW

    # Single-use: the approval is now spent, so a second identical request
    # falls back to raising a fresh card.
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is not None
    again = await policy.authorize(_ctx(person), "fetch_url", args)
    assert again.outcome == policy.REQUIRE_CONSENT


async def test_a_consent_tool_with_no_identity_is_denied(pool):
    """A consent must bind to a requestor; with no person there is nothing to
    bind, so it is refused (fail-closed) rather than raised unbound."""
    decision = await policy.authorize(_ctx(None), "fetch_url", {"url": "https://x/y"})
    assert decision.outcome == policy.DENY
