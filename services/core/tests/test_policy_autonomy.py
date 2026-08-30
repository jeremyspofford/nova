"""The graduation loop through the REAL funnel (tools.dispatch -> policy.
authorize -> autonomy.record_outcome), not just autonomy.py's unit tests.

This is the property that actually matters (ruling S3-R5 + D-012): promotion
is not a second decision path. autonomy.record_outcome only ever flips the
SAME action_classes.disposition column policy.authorize already reads, in the
same table, so the Nth approved-and-succeeded call promotes a class and the
VERY NEXT authorize() call for that class ALLOWs with no card, no burn, no
consent row involved at all — proving there is nothing autonomy.py decides
that authorize() does not equally see.

A dedicated test-only action_class + tool (`earn_tool`) is registered so this
file's promotions never touch fetch_url and cannot be read by
test_policy.py/test_policy_funnel.py's own fetch_url-based assertions
(action_classes is not truncated between tests — see test_autonomy.py's
docstring).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app import autonomy, consents, governance, policy, tools
from app.identity import Person
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

# schema.validate() refuses ANY property absent from `properties` regardless
# of additionalProperties (its own docstring), so the test tool declares `i`
# with no `type` key (never checked, so any JSON value passes) — these tests
# pass a distinguishing `i` value so pending_all()'s several simultaneously-
# possible cards can be told apart by their args.
ANY_ARGS = {"type": "object", "properties": {"i": {}}, "additionalProperties": True}


@dataclass
class Spy:
    calls: list = field(default_factory=list)
    ok: bool = True
    result: str = "ran"

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        if not self.ok:
            raise Exception("boom")
        return self.result


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


def _ctx(person, *, sink=None) -> ToolContext:
    return ToolContext(app=None, person=person, workspace_root=Path("/tmp"), consent_sink=sink)


async def _seed_consent_class(pool, action_class: str) -> None:
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'test', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', earned = false, "
        "consecutive_successes = 0, updated_at = now()",
        action_class,
    )


async def _approve_and_run(pool, person, action_class: str, spy: Spy, args: dict) -> bool:
    """One approve-then-re-attempt cycle through the real funnel — the shape
    ruling S3-R4 requires: a card is raised, the operator approves it, and
    ONLY THEN does dispatch() burn it and run the tool. Returns dispatch's ok."""
    _, ok = await tools.dispatch(action_class, args, _ctx(person))
    assert ok is False  # first attempt: no approval yet, awaits
    cards = await consents.pending_all(pool)
    card = next(c for c in cards if c["action_class"] == action_class and c["args"] == args)
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    _, ok = await tools.dispatch(action_class, args, _ctx(person))
    return ok


async def test_n_burned_and_succeeded_runs_promote_and_the_next_call_needs_no_card(
    pool, monkeypatch
):
    action_class = "earn_tool_promote"
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, action_class, Tool(action_class, "d", ANY_ARGS, spy))
    await _seed_consent_class(pool, action_class)
    person = await _person(pool)

    threshold = await autonomy.graduation_runs(pool)
    for i in range(threshold):
        ok = await _approve_and_run(pool, person, action_class, spy, {"i": i})
        assert ok is True

    row = await pool.fetchrow(
        "SELECT disposition, earned, consecutive_successes FROM action_classes "
        "WHERE action_class = $1",
        action_class,
    )
    assert row["disposition"] == "auto"
    assert row["earned"] is True
    assert row["consecutive_successes"] == 0

    # The kernel reads the SAME row — no card, no consent, straight ALLOW.
    decision = await policy.authorize(_ctx(person), action_class, {"i": "final"})
    assert decision.outcome == policy.ALLOW

    # And through the real funnel too: no approval needed, runs immediately.
    sink: list[dict] = []
    result, ok = await tools.dispatch(action_class, {"i": "final"}, _ctx(person, sink=sink))
    assert ok is True
    assert sink == []  # no card raised


async def test_a_broken_streak_never_promotes(pool, monkeypatch):
    action_class = "earn_tool_broken_streak"
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, action_class, Tool(action_class, "d", ANY_ARGS, spy))
    await _seed_consent_class(pool, action_class)
    person = await _person(pool)
    threshold = await autonomy.graduation_runs(pool)

    for i in range(threshold - 1):
        assert await _approve_and_run(pool, person, action_class, spy, {"i": i}) is True

    # One failure right before the threshold would have been reached.
    spy.ok = False
    assert await _approve_and_run(pool, person, action_class, spy, {"i": "fail"}) is False
    spy.ok = True

    row = await pool.fetchrow(
        "SELECT disposition, consecutive_successes FROM action_classes WHERE action_class = $1",
        action_class,
    )
    assert row["disposition"] == "consent"
    assert row["consecutive_successes"] == 0

    # Still gated: the next call awaits a fresh approval, not an ALLOW.
    decision = await policy.authorize(_ctx(person), action_class, {"i": "still-gated"})
    assert decision.outcome == policy.REQUIRE_CONSENT


async def test_an_earned_class_that_fails_once_demotes_and_asks_again(pool, monkeypatch):
    action_class = "earn_tool_demote"
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, action_class, Tool(action_class, "d", ANY_ARGS, spy))
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'test', 'auto', true, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'auto', earned = true, "
        "consecutive_successes = 0, updated_at = now()",
        action_class,
    )
    person = await _person(pool)

    # Runs freely while earned-auto — no card, straight through.
    _, ok = await tools.dispatch(action_class, {"i": 0}, _ctx(person))
    assert ok is True

    spy.ok = False
    _, ok = await tools.dispatch(action_class, {"i": "boom"}, _ctx(person))
    assert ok is False

    row = await pool.fetchrow(
        "SELECT disposition, earned FROM action_classes WHERE action_class = $1", action_class
    )
    assert row["disposition"] == "consent"
    assert row["earned"] is False

    # And the kernel reads that immediately — the very next call is gated.
    spy.ok = True
    _, ok = await tools.dispatch(action_class, {"i": "after-demote"}, _ctx(person))
    assert ok is False
    assert spy.calls[-1] != {"i": "after-demote"}  # the executor did not run this time


async def test_promotion_and_demotion_are_governance_events_visible_in_the_ledger(
    pool, monkeypatch
):
    action_class = "earn_tool_ledger"
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, action_class, Tool(action_class, "d", ANY_ARGS, spy))
    await _seed_consent_class(pool, action_class)
    person = await _person(pool)
    threshold = await autonomy.graduation_runs(pool)

    for i in range(threshold):
        assert await _approve_and_run(pool, person, action_class, spy, {"i": i}) is True

    spy.ok = False
    _, ok = await tools.dispatch(action_class, {"i": "fail-after-promote"}, _ctx(person))
    assert ok is False

    events = await governance.recent_events(pool, action_class=action_class)
    kinds = [e["kind"] for e in events]
    assert governance.AUTONOMY_PROMOTED in kinds
    assert governance.AUTONOMY_DEMOTED in kinds
