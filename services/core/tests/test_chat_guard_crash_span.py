"""verification-2-7 T11: a crashed reply-path guard leaves a guard span.

The verification report (fix 6): chat.py's "<guard> guard raised; shipping the
reply uncorrected" handlers log the crash and set the verdict to None, so in
turn_spans a guard that fell over is indistinguishable from a guard that looked
and found nothing. A turn's trace is the fact, so the crash belongs in it:
one kind='guard' span named for the guard, meta.error "<ExcType>: <message>",
while the reply still ships exactly as she wrote it.

And because every reader of a guard span today reads its presence as a fire
(evals.predicates.guard_fired, skills.guard_fired, agents.run_facts), the span
must never be read as a correction — a crash is not a fire.

Drives the REAL chat round loop through a scripted gateway; each detector is
replaced by one that raises.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

import pytest

from app import agents, chat, guards, skills, traces
from app.evals import predicates
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_tools_agents import _agent_value

pytestmark = requires_db

DONE = "[DONE]"
MESSAGE = "what is the capital of France?"
REPLY = "Paris is the capital of France."


class _GuardBoom(RuntimeError):
    pass


def _frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def _text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


# (detector attribute on app.guards, span name, meta.kind the span must carry
#  or None, the words chat.py's handler logs)
SITES = [
    ("narration_check", "narration", None, "narration guard raised"),
    ("delegation_claim_check", "delegation_claim", None, "delegation-claim guard raised"),
    ("consent_claim_check", "consent_claim", None, "consent-claim guard raised"),
    ("capability_claim_check", "capability_claim", None, "capability-claim guard raised"),
    ("stack_claim_check", "stack_claim", None, "serving-state guard raised"),
    ("state_claim_check", "state_claim", None, "state-claim guard raised"),
    ("presented_listing_check", "presented_listing", None, "presented-listing guard raised"),
    ("deferral_check", "deferral", None, "deferral guard raised"),
    ("bare_intent_check", "deferral", "bare_intent", "bare-intent guard raised"),
]


def _break(monkeypatch, attr: str, message: str) -> None:
    def boom(*args, **kwargs):
        raise _GuardBoom(message)

    monkeypatch.setattr(guards, attr, boom)


async def _turn(owner_client, mount_peers, reply: str = REPLY) -> list:
    gateway = ScriptedGateway(rounds=((_text(reply),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": MESSAGE})
    assert resp.status_code == 200, resp.text
    return _frames(resp.text)


async def _guard_spans(pool) -> list[tuple[str, dict]]:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at, id"
    )
    return [
        (r["name"], json.loads(r["meta"]) if isinstance(r["meta"], str) else (r["meta"] or {}))
        for r in rows
    ]


def _crash_logged(caplog, words: str) -> bool:
    return any(
        r.name == "core"
        and r.levelno >= logging.ERROR
        and words in r.getMessage()
        and r.exc_info
        and isinstance(r.exc_info[1], _GuardBoom)
        for r in caplog.records
    )


@pytest.mark.parametrize(("attr", "name", "kind", "_log"), SITES, ids=[s[0] for s in SITES])
async def test_v27_t11_a_crashed_guard_leaves_one_span_with_the_error(
    owner_client, pool, mount_peers, monkeypatch, attr, name, kind, _log
):
    """C1 + C3: exactly one guard span named for the crashed guard, meta.error
    "<ExcType>: <message>"; no other guard span that turn carries an error."""
    _break(monkeypatch, attr, f"{attr} fell over")

    await _turn(owner_client, mount_peers)

    spans = await _guard_spans(pool)
    crashed = [(n, m) for n, m in spans if "error" in m]
    assert len(crashed) == 1, spans
    got_name, meta = crashed[0]
    assert got_name == name, spans
    assert meta["error"] == f"_GuardBoom: {attr} fell over", meta
    if kind is not None:
        assert meta.get("kind") == kind, meta
    assert [n for n, _ in spans].count(name) == 1, spans


@pytest.mark.parametrize(("attr", "name", "_kind", "log"), SITES, ids=[s[0] for s in SITES])
async def test_v27_t11_the_reply_still_ships_and_the_crash_is_still_logged(
    owner_client, pool, mount_peers, monkeypatch, caplog, attr, name, _kind, log
):
    """C2: a crashed guard changes nothing she reads: ok, [DONE], her reply
    stored as written, no correction frame, and the handler's log line stays.
    (The span from C1 is what is new; this pins that it is the ONLY change.)"""
    caplog.set_level(logging.WARNING)
    _break(monkeypatch, attr, f"{attr} fell over")

    sent = await _turn(owner_client, mount_peers)

    assert sent[-1] == DONE
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f], sent
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == REPLY
    assert _crash_logged(caplog, log), f"{log!r} must still be logged with the exception"
    # And the trace says so — the reason this task exists.
    assert any(n == name and "error" in m for n, m in await _guard_spans(pool))


async def test_v27_t11_a_clean_turn_files_no_error_span(owner_client, pool, mount_peers):
    """C3: no detector raises -> no guard span carries meta.error (and an
    honest reply draws no guard span at all)."""
    sent = await _turn(owner_client, mount_peers)

    assert sent[-1] == DONE
    assert [m for _, m in await _guard_spans(pool) if "error" in m] == []


async def test_v27_t11_no_reader_reads_a_crash_as_a_fire(
    owner_client, pool, mount_peers, monkeypatch
):
    """C4: the crashed span, as stored, is not a correction to any reader —
    the eval predicates, the skills ledger, an agent's run facts."""
    _break(monkeypatch, "narration_check", "narration fell over")
    await _turn(owner_client, mount_peers)

    stored = [(n, m) for n, m in await _guard_spans(pool) if n == "narration"]
    assert len(stored) == 1 and "error" in stored[0][1], stored
    now = datetime.now(UTC)
    span = traces.Span("guard", "narration", now, 1, dict(stored[0][1]))

    fired, detail = predicates.guard_fired([span], REPLY, "narration")
    assert fired is False, detail
    absent, detail = predicates.guard_absent([span], REPLY, "narration")
    assert absent is True, detail

    assert skills.guard_fired(dict(stored[0][1])) is False

    agent = _agent_value()
    turn = traces.Turn(id=uuid.uuid4(), started_at=now, agent_id=agent.id)
    turn.spans.append(span)
    facts = agents.run_facts(agent, turn, status="ok", seconds=1.0, usage=None)
    assert not any("correction" in note for note in facts.notes), facts.notes
    assert any("narration" in note and "raised" in note for note in facts.notes), facts.notes


async def test_v27_t11_the_error_is_bounded(owner_client, pool, mount_peers, monkeypatch):
    """C5: a huge exception message is clipped to the span head bound and
    still opens with the exception's type."""
    _break(monkeypatch, "capability_claim_check", "x" * 5000)

    await _turn(owner_client, mount_peers)

    crashed = [m for n, m in await _guard_spans(pool) if n == "capability_claim" and "error" in m]
    assert len(crashed) == 1, crashed
    error = crashed[0]["error"]
    assert error.startswith("_GuardBoom: x"), error[:40]
    assert len(error) <= traces.SPAN_RESULT_HEAD_CHARS, len(error)


def test_v27_t11_the_handler_sites_are_the_nine_this_task_names():
    """Tripwire for the site list above: each SITES log line is one of chat.py's
    own handler messages, so a renamed handler cannot leave a parametrized case
    driving a guard chat.py no longer catches in that place."""
    import inspect

    source = inspect.getsource(chat)
    for _attr, _name, _kind, log in SITES:
        assert f'"{log}; shipping the reply uncorrected"' in source, log


def test_v27_t11_a_fired_guard_whose_redirect_failed_is_still_a_fire():
    """C4, the other side (COVERAGE): meta.error alone is not the crash marker.
    A guard that FIRED and whose redirect then failed files meta.error too
    (_deferral_redirect, _claim_redirect: redirected False + peers.reason) —
    every reader must still read that span as the correction it is."""
    now = datetime.now(UTC)
    meta = {"detected": True, "redirected": False, "error": "gateway: timed out"}
    span = traces.Span("guard", "deferral", now, 1, dict(meta))

    assert traces.guard_raised(meta) is False
    assert predicates.guard_fired([span], REPLY, "deferral")[0] is True
    assert predicates.guard_absent([span], REPLY, "deferral")[0] is False
    assert skills.guard_fired(dict(meta)) is True

    agent = _agent_value()
    turn = traces.Turn(id=uuid.uuid4(), started_at=now, agent_id=agent.id)
    turn.spans.append(span)
    facts = agents.run_facts(agent, turn, status="ok", seconds=1.0, usage=None)
    assert any("deferral correction" in note for note in facts.notes), facts.notes
    assert not any("raised" in note for note in facts.notes), facts.notes
