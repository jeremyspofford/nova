"""The policy gate inside dispatch(): the executor is reachable only on ALLOW.

These drive the real funnel (tools.dispatch) with spy executors, so what is
under test is the wiring the DoD leans on: an auto tool runs; a consent tool
with no approval AWAITS (not an error, executor untouched); an approved+bound
consent runs once and is burned; a denied/unclassified tool refuses without
running; and an authorizer that itself fails is a stated refusal, never a throw.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app import consents, policy, tools
from app.identity import Person
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

NO_ARGS = {"type": "object", "properties": {}, "additionalProperties": False}

# The consent-MECHANISM is proven with a PRIVATE consent-tier class, decoupled
# from fetch_url's real disposition (migration 008 made fetch_url 'auto' by owner
# directive). Mirrors test_policy_e2e.py's e2e_walk_fetch: a monkeypatched Tool +
# an action_classes row seeded 'consent', so the card->await->approve->burn gate
# is still exercised end to end even though no SEEDED tool is consent-tier now.
CONSENT_ACTION = "funnel_consent_probe"
# A permissive url property (no declared type) validates any value — enough for
# the mechanism, same shape test_policy_e2e.py's WALK_SCHEMA uses.
CONSENT_SCHEMA = {"type": "object", "properties": {"url": {}}, "additionalProperties": True}


@dataclass
class Spy:
    calls: list = field(default_factory=list)
    result: str = "ran"

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


async def _arm_consent_tool(pool, monkeypatch, spy: Spy) -> None:
    """Register the private consent-tier tool + its action_classes row.

    action_classes is deliberately NOT per-test truncated (it carries the
    migration seed the kernel reads), so ON CONFLICT re-asserts 'consent' with a
    zeroed streak each run, keeping the class in a known consent state regardless
    of a prior test's burn."""
    monkeypatch.setitem(
        tools.REGISTRY, CONSENT_ACTION, Tool(CONSENT_ACTION, "d", CONSENT_SCHEMA, spy)
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'outward', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        CONSENT_ACTION,
    )


async def _person(pool, role: str = "owner") -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, $2) RETURNING id", role, role
    )
    return Person(id=pid, name=role, role=role)


async def _conversation(pool, person: Person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person.id
    )


def _ctx(person, *, conversation_id=None, sink=None) -> ToolContext:
    return ToolContext(
        app=None,
        person=person,
        workspace_root=Path("/tmp"),
        conversation_id=conversation_id,
        consent_sink=sink,
    )


# -- structural pin: authorize precedes the executor -----------------------


def _dispatch_code() -> str:
    """dispatch()'s CODE, with its docstring cut off — so a token the docstring
    mentions in prose cannot satisfy (or defeat) an ordering pin."""
    src = Path(tools.__file__).read_text(encoding="utf-8")
    body = src.split("async def dispatch")[1]
    if '"""' in body:
        _sig, _doc, body = body.split('"""', 2)
    return body


def test_dispatch_authorizes_before_it_executes():
    """Ruling S3-R2, pinned in the source: within dispatch, policy.authorize is
    awaited before tool.executor ever is — no path reaches an executor first."""
    body = _dispatch_code()
    assert body.index("policy.authorize(") < body.index("tool.executor(")


def test_dispatch_prechecks_before_it_authorizes():
    """The per-tool precheck (a refusal-only hook, see devices.py) runs BEFORE
    the kernel and the kernel before the executor: precheck < authorize <
    executor in the source. A precheck that ran after authorize would be back
    to burning approvals on calls that could never execute."""
    body = _dispatch_code()
    precheck = body.index("tool.precheck(")
    authorize = body.index("policy.authorize(")
    executor = body.index("tool.executor(")
    assert precheck < authorize < executor


# -- auto runs as before ---------------------------------------------------


async def test_an_auto_tool_runs_through_the_gate(pool):
    person = await _person(pool)
    result, ok = await tools.dispatch("get_time", {}, _ctx(person))
    assert ok is True
    assert "UTC" in result


# -- consent without approval: awaits, does not run ------------------------


async def test_a_consent_tool_awaits_approval_without_running(pool, monkeypatch):
    spy = Spy()
    await _arm_consent_tool(pool, monkeypatch, spy)
    person = await _person(pool)
    conv = await _conversation(pool, person)
    sink: list[dict] = []
    result, ok = await tools.dispatch(
        CONSENT_ACTION, {"url": "https://example.com/x"},
        _ctx(person, conversation_id=conv, sink=sink),
    )

    assert ok is False
    assert not result.startswith("Error: ")  # NOT an error — the model tells the operator
    assert result.startswith("Awaiting your approval")
    assert spy.calls == []  # the executor never ran — nothing fetched
    # The card was raised, surfaced via the sink, and is pending in the DB.
    assert len(sink) == 1 and sink[0]["action_class"] == CONSENT_ACTION
    assert len(await consents.pending_for_conversation(pool, conv)) == 1


# -- approved consent: runs once, burns ------------------------------------


async def test_an_approved_consent_lets_the_funnel_run_and_burns_it(pool, monkeypatch):
    spy = Spy()
    await _arm_consent_tool(pool, monkeypatch, spy)
    person = await _person(pool)
    args = {"url": "https://example.com/x"}
    card = await consents.raise_consent(
        pool,
        action_class=CONSENT_ACTION,
        args=args,
        summary="s",
        person_id=person.id,
        agent="chat",
        conversation_id=None,
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )

    result, ok = await tools.dispatch(CONSENT_ACTION, args, _ctx(person))
    assert ok is True
    assert spy.calls == [args]  # it actually ran, exactly once
    row = await consents.get(pool, uuid.UUID(card["consent_id"]))
    assert row["used_at"] is not None  # and the approval is spent

    # Single-use: an identical call now awaits a fresh approval.
    result2, ok2 = await tools.dispatch(CONSENT_ACTION, args, _ctx(person))
    assert ok2 is False and result2.startswith("Awaiting your approval")
    assert spy.calls == [args]  # still just the one run


# -- deny / unclassified: refuse without running ---------------------------


async def test_a_deny_classified_tool_refuses_without_running(pool, monkeypatch):
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, "danger", Tool("danger", "d", NO_ARGS, spy))
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition) "
        "VALUES ('danger', 'test', 'deny') ON CONFLICT (action_class) DO NOTHING"
    )
    person = await _person(pool)
    result, ok = await tools.dispatch("danger", {}, _ctx(person))
    assert ok is False
    assert result.startswith("Error: ")
    assert "danger" in result
    assert spy.calls == []


async def test_an_unclassified_registered_tool_is_denied_by_default(pool, monkeypatch):
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, "unlisted", Tool("unlisted", "d", NO_ARGS, spy))
    person = await _person(pool)
    result, ok = await tools.dispatch("unlisted", {}, _ctx(person))
    assert ok is False
    assert result.startswith("Error: ")
    assert spy.calls == []


# -- fail-closed on an authorizer failure ----------------------------------


async def test_an_authorizer_failure_is_a_stated_refusal_not_a_throw(pool, monkeypatch):
    async def boom(*args, **kwargs):
        raise RuntimeError("kernel down")

    monkeypatch.setattr(policy, "authorize", boom)
    person = await _person(pool)
    result, ok = await tools.dispatch("get_time", {}, _ctx(person))
    assert ok is False  # fail-closed, and no exception escaped
    assert result.startswith("Error: ")
    assert "authorize" in result
