"""The whole slice-3 DoD, walked in order through the REAL stack — the tripwire.

This is the model-INDEPENDENT regression gate for the policy kernel's
definition of done (docs/plans/rebuild/slice-03-policy.md §Definition of done).
It drives the same funnel a chat turn drives —
tools.dispatch -> policy.authorize -> consents -> autonomy -> governance — but
with a SPY executor and by calling dispatch()/consents.decide()/autonomy.revoke()
directly, so nothing here depends on a model choosing to emit a tool call. The
model-driven halves of the DoD (ask Nova -> a card appears; approve -> the model
re-attempts and it runs) are the OWNER's live gate, run against the rebuilt
stack after review; this test proves everything underneath them mechanically.

Every assertion reads the LEDGER (governance_events) and the TABLE
(action_classes / consents), never a reply string — a reply is a claim, the
row is the fact.

Why a dedicated action class (`e2e_walk_fetch`) instead of the real demo class
fetch_url: this walk PROMOTES, DEMOTES and REVOKES a class, which mutates
action_classes.disposition — and conftest deliberately does NOT truncate
action_classes between tests (it carries the migration seed the kernel reads,
so it persists like schema). Mutating fetch_url here would leak an auto/earned
disposition into test_policy_funnel.py / test_chat_consent.py, which read
fetch_url expecting it consent-tier. A private class keeps the walk's mutations
out of the shared seed — the same rationale test_policy_autonomy.py documents
for its own `earn_tool_*` classes. fetch_url is the real outward-facing demo
class (migration 004 seeds it 'consent'); the transitions this class exercises
are byte-for-byte the ones fetch_url would.

Why graduation_runs is set small (N below): the default is 5. This walk
promotes twice, so at the default that is ten approve+burn cycles for no added
coverage — a small N keeps the walk short AND proves promotion reads the LIVE
setting (autonomy.record_outcome -> settings_store.read_value) rather than a
hardcoded 5. N is >1 so it still genuinely proves the counter ACCUMULATES
across consecutive runs, not a single-shot promotion.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app import autonomy, consents, db, governance, policy, tools
from app.identity import Person
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db

pytestmark = requires_db

ACTION = "e2e_walk_fetch"
# Permissive schema (a `url` property with no declared type passes any JSON
# value — schema.validate only refuses properties absent from `properties`),
# so the walk can vary the url per graduation cycle without tripping
# validation, exactly as test_policy_autonomy.py's ANY_ARGS does.
WALK_SCHEMA = {"type": "object", "properties": {"url": {}}, "additionalProperties": True}
ARGS = {"url": "https://example.com/pricing"}
GRADUATION_N = 3
UNLISTED = "e2e_walk_unlisted"  # registered but never classified -> fail-closed DENY


@dataclass
class Spy:
    """The stand-in executor. `ok=False` makes it raise, so dispatch records
    ok=False — the failure path earned autonomy demotes on."""

    calls: list = field(default_factory=list)
    ok: bool = True
    result: str = "fetched"

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        if not self.ok:
            raise Exception("boom")
        return self.result


async def _owner(pool) -> Person:
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    return Person(id=row["id"], name=row["name"], role=row["role"])


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


async def _set_graduation(pool, n: int) -> None:
    # Mirrors settings_store.write_setting: the pool's jsonb codec (json.dumps)
    # turns the bound int into a JSON number, so autonomy reads back an int, not
    # a "3" string it cannot compare with >=.
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('autonomy.graduation_runs', $1::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        n,
    )


async def _seed_consent_class(pool) -> None:
    """(Re)seed ACTION as a fresh consent-tier class with a zeroed streak —
    idempotent so the walk can return the class to a known state between the
    promote/revoke/demote phases."""
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'outward', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', earned = false, "
        "consecutive_successes = 0, updated_at = now()",
        ACTION,
    )


async def _class_row(pool):
    return await pool.fetchrow(
        "SELECT disposition, earned, consecutive_successes FROM action_classes "
        "WHERE action_class = $1",
        ACTION,
    )


async def _events(pool) -> list:
    # limit high enough to hold the whole walk's ledger in one read.
    return await governance.recent_events(pool, limit=500)


def _kinds(events) -> set[str]:
    return {e["kind"] for e in events}


async def _approve_and_run(pool, person, spy: Spy, args: dict) -> bool:
    """One approve-then-re-attempt cycle through the real funnel (ruling S3-R4):
    the first dispatch raises a card and AWAITS, the operator approves it, and
    only the SECOND dispatch burns it and runs the tool. Returns dispatch's ok."""
    _, ok = await tools.dispatch(ACTION, args, _ctx(person))
    assert ok is False  # first attempt: no approval yet, awaits
    card = next(
        c for c in await consents.pending_all(pool)
        if c["action_class"] == ACTION and c["args"] == args
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card["consent_id"]), approve=True, decided_by=person.id
    )
    _, ok = await tools.dispatch(ACTION, args, _ctx(person))
    return ok


async def _graduate(pool, person, spy: Spy, tag: str) -> None:
    """Run exactly N approve+burn+succeeded cycles from a zeroed streak and
    assert the class ends promoted-to-auto. Distinct args per cycle so each is
    its own consent (raise_consent dedupes pending by args_hash)."""
    await _seed_consent_class(pool)
    for i in range(GRADUATION_N):
        assert await _approve_and_run(pool, person, spy, {"url": f"https://example.com/{tag}/{i}"})
    row = await _class_row(pool)
    assert row["disposition"] == "auto"
    assert row["earned"] is True
    assert row["consecutive_successes"] == 0


async def test_the_policy_kernel_walks_the_entire_dod(owner_client, pool, monkeypatch):
    await _set_graduation(pool, GRADUATION_N)
    spy = Spy()
    monkeypatch.setitem(tools.REGISTRY, ACTION, Tool(ACTION, "d", WALK_SCHEMA, spy))
    monkeypatch.setitem(tools.REGISTRY, UNLISTED, Tool(UNLISTED, "d", WALK_SCHEMA, spy))
    await _seed_consent_class(pool)
    person = await _owner(pool)
    conv = await _conversation(pool, person)
    hashed = consents.args_hash(ARGS)

    # (a) A consent-tier call with NO approval -> REQUIRE_CONSENT. -----------
    sink_a: list[dict] = []
    result, ok = await tools.dispatch(ACTION, ARGS, _ctx(person, conversation_id=conv, sink=sink_a))
    assert ok is False  # awaiting, mechanically decided — not read from prose
    assert not result.startswith("Error: ")  # NOT an error: tell the operator, do not retry
    assert result.startswith("Awaiting your approval")
    assert spy.calls == []  # the executor never ran — nothing was fetched
    # A pending row exists, bound to the EXACT args.
    pending = await consents.pending_for_conversation(pool, conv)
    assert len(pending) == 1
    card1 = pending[0]
    assert card1["args_hash"] == hashed
    assert sink_a == [card1]  # the funnel surfaced exactly that card
    row = await pool.fetchrow("SELECT * FROM consents WHERE args_hash = $1", hashed)
    assert row["status"] == "pending"
    # A consent.raised event records it, bound to the card and the args.
    raised = [e for e in await _events(pool) if e["kind"] == governance.CONSENT_RAISED]
    assert len(raised) == 1
    assert raised[0]["subject_ref"] == uuid.UUID(card1["consent_id"])
    assert raised[0]["meta"]["args_hash"] == hashed

    # (b) DENY -> authorizes nothing; the same call still awaits. -------------
    await consents.decide(
        pool, consent_id=uuid.UUID(card1["consent_id"]), approve=False, decided_by=person.id
    )
    decided_denied = [
        e for e in await _events(pool)
        if e["kind"] == governance.CONSENT_DECIDED and e["meta"].get("decision") == "denied"
    ]
    assert len(decided_denied) == 1
    # A deny is the strongest distrust signal — the graduation streak is 0.
    assert (await _class_row(pool))["consecutive_successes"] == 0
    # The very next dispatch of the SAME args is still gated (deny granted
    # nothing) and raises a FRESH card, not the denied one.
    sink_b: list[dict] = []
    result, ok = await tools.dispatch(ACTION, ARGS, _ctx(person, conversation_id=conv, sink=sink_b))
    assert ok is False and result.startswith("Awaiting your approval")
    assert spy.calls == []  # still nothing ran
    pending = await consents.pending_for_conversation(pool, conv)
    assert len(pending) == 1
    card2 = pending[0]
    assert card2["consent_id"] != card1["consent_id"]

    # (c) APPROVE + re-attempt -> runs once, burns; no double-spend. ----------
    await consents.decide(
        pool, consent_id=uuid.UUID(card2["consent_id"]), approve=True, decided_by=person.id
    )
    # Approving alone ran nothing (ruling S3-R4) — still unspent.
    assert (await consents.get(pool, uuid.UUID(card2["consent_id"])))["used_at"] is None
    assert spy.calls == []
    # The re-attempt burns the approval and runs the tool exactly once.
    result, ok = await tools.dispatch(ACTION, ARGS, _ctx(person, conversation_id=conv))
    assert ok is True
    assert spy.calls == [ARGS]
    burned_row = await consents.get(pool, uuid.UUID(card2["consent_id"]))
    assert burned_row["used_at"] is not None  # spent
    burned = [
        e for e in await _events(pool)
        if e["kind"] == governance.CONSENT_BURNED
        and e["subject_ref"] == uuid.UUID(card2["consent_id"])
    ]
    assert len(burned) == 1
    assert burned[0]["meta"]["args_hash"] == hashed
    # A second re-attempt with the now-spent consent does NOT run again and
    # re-raises a fresh card (single-use — no double-spend).
    sink_c: list[dict] = []
    result, ok = await tools.dispatch(ACTION, ARGS, _ctx(person, conversation_id=conv, sink=sink_c))
    assert ok is False and result.startswith("Awaiting your approval")
    assert spy.calls == [ARGS]  # still just the one run
    pending = await consents.pending_for_conversation(pool, conv)
    assert len(pending) == 1 and pending[0]["consent_id"] != card2["consent_id"]

    # (c2) ARGS-BINDING: an approval for args A cannot be spent on args B. -----
    # v3's D-029 id-only-burn loophole is NOT carried — the burn binds to the
    # EXACT args_hash. This proves it inside the walk itself (not only in
    # test_consents.py): approve a card for URL-A, then dispatch URL-B — B must
    # raise its OWN card and run nothing, and A's approval must stay unspent.
    # (No successful burn happens here, so the graduation counter is untouched
    # and step (d)'s _seed_consent_class re-zeroes it regardless.)
    args_a = {"url": "https://example.com/bound-A"}
    args_b = {"url": "https://example.com/bound-B"}
    calls_before = len(spy.calls)
    _, ok = await tools.dispatch(ACTION, args_a, _ctx(person, conversation_id=conv))
    assert ok is False  # A raises its own card
    card_a = next(
        c for c in await consents.pending_all(pool)
        if c["action_class"] == ACTION and c["args"] == args_a
    )
    await consents.decide(
        pool, consent_id=uuid.UUID(card_a["consent_id"]), approve=True, decided_by=person.id
    )
    # A dispatch for B must NOT burn A's approval — it re-raises its own card.
    result, ok = await tools.dispatch(ACTION, args_b, _ctx(person, conversation_id=conv))
    assert ok is False and result.startswith("Awaiting your approval")
    assert len(spy.calls) == calls_before  # B never ran on A's approval
    assert (await consents.get(pool, uuid.UUID(card_a["consent_id"])))["used_at"] is None

    # (d) N approve+succeed cycles -> PROMOTED to auto; next call needs no card.
    await _graduate(pool, person, spy, tag="promote")
    promoted = [e for e in await _events(pool) if e["kind"] == governance.AUTONOMY_PROMOTED]
    assert len(promoted) >= 1
    # The kernel reads the SAME row it always reads: straight ALLOW, no card.
    decision = await policy.authorize(_ctx(person), ACTION, {"url": "post-promote"})
    assert decision.outcome == policy.ALLOW
    calls_before = len(spy.calls)
    sink_d: list[dict] = []
    _, ok = await tools.dispatch(ACTION, {"url": "post-promote"}, _ctx(person, sink=sink_d))
    assert ok is True
    assert sink_d == []  # no approval card raised — it just runs
    assert len(spy.calls) == calls_before + 1  # the executor ran with no consent

    # (e) REVOKE -> back to consent; the card returns on the next call. -------
    assert await autonomy.revoke(pool, action_class=ACTION, actor=str(person.id)) is True
    revoked_row = await _class_row(pool)
    assert revoked_row["disposition"] == "consent"
    assert revoked_row["earned"] is False
    assert any(e["kind"] == governance.AUTONOMY_REVOKED for e in await _events(pool))
    calls_before = len(spy.calls)
    sink_e: list[dict] = []
    _, ok = await tools.dispatch(ACTION, {"url": "post-revoke"}, _ctx(person, sink=sink_e))
    assert ok is False  # gated again — a card is back
    assert len(spy.calls) == calls_before  # nothing ran
    assert len(sink_e) == 1 and sink_e[0]["action_class"] == ACTION

    # (f) A FAILURE demotes a promoted class. --------------------------------
    # Put the class straight into earned-auto (the promote path is already
    # proven in (d); a second full graduation would add cycles, not coverage —
    # the same direct seed test_policy_autonomy.py uses for its demote case),
    # then a run that fails must demote it and record autonomy.demoted.
    await pool.execute(
        "UPDATE action_classes SET disposition = 'auto', earned = true, "
        "consecutive_successes = 0, updated_at = now() WHERE action_class = $1",
        ACTION,
    )
    spy.ok = False
    _, ok = await tools.dispatch(ACTION, {"url": "will-fail"}, _ctx(person))
    assert ok is False  # the executor ran and failed
    spy.ok = True
    demoted_row = await _class_row(pool)
    assert demoted_row["disposition"] == "consent"
    assert demoted_row["earned"] is False
    assert any(e["kind"] == governance.AUTONOMY_DEMOTED for e in await _events(pool))

    # A policy.denied: an unclassified (fail-closed) tool is refused, ledgered.
    result, ok = await tools.dispatch(UNLISTED, {"url": "x"}, _ctx(person))
    assert ok is False and result.startswith("Error: ")
    assert any(
        e["kind"] == governance.POLICY_DENIED and e["action_class"] == UNLISTED
        for e in await _events(pool)
    )

    # (g) DoD item 4: every decision kind is in the operator's audit. --------
    every_kind = {
        governance.CONSENT_RAISED,
        governance.CONSENT_DECIDED,
        governance.CONSENT_BURNED,
        governance.POLICY_DENIED,
        governance.AUTONOMY_PROMOTED,
        governance.AUTONOMY_DEMOTED,
        governance.AUTONOMY_REVOKED,
    }
    # Read straight off the ledger (governance.recent_events)...
    from_ledger = _kinds(await _events(pool))
    assert every_kind <= from_ledger, f"missing from ledger: {every_kind - from_ledger}"
    # ...and through the operator-visible route the DoD requires (GET
    # /api/v1/governance), authenticated as the owner.
    resp = await owner_client.get("/api/v1/governance?limit=200")
    assert resp.status_code == 200, resp.text
    from_route = {e["kind"] for e in resp.json()["events"]}
    assert every_kind <= from_route, f"missing from the audit route: {every_kind - from_route}"
