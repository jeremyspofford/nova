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


# --- verification-2-7 T12: the remaining guard-raised sites -----------------
#
# T11 wired the nine reply-path handlers. T12 wires every other place in
# chat.py where a guard can raise and the handler logs it and moves on: the
# REWRITE-class pair (_rewrite_class_claims), the APPEND-class trio
# (_append_class_claims), the own-tool handback and cleared-offer checks, the
# said-not-done loop, and every RE-CHECK over a redirect's regeneration. Each
# was silent in turn_spans; after T12 none is.

# (detector attribute on app.guards, span name, the words chat.py's handler logs)
T12_SITES = [
    ("code_claim_check", "code_claim", "code_claim guard raised"),
    ("address_claim_check", "address_claim", "address_claim guard raised"),
    ("served_claim_check", "served_claim", "served_claim guard raised"),
    ("memory_claim_check", "memory_claim", "memory_claim guard raised"),
    ("wake_claim_check", "wake_claim", "wake_claim guard raised"),
    ("own_tool_handback_check", "own_tool_handback", "own-tool handback guard raised"),
    ("cleared_offer_check", "cleared_offer", "cleared-offer guard raised"),
    ("written_call_check", "written_call", "written_call guard raised"),
    ("device_completion_check", "device_completion", "device_completion guard raised"),
    ("server_denial_check", "mcp_server_denial", "mcp_server_denial guard raised"),
    ("server_claim_check", "mcp_server_claim", "mcp_server_claim guard raised"),
]


def _raised(spans: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    return [(n, m) for n, m in spans if traces.guard_raised(m)]


@pytest.mark.parametrize(("attr", "name", "_log"), T12_SITES, ids=[s[0] for s in T12_SITES])
async def test_v27_t12_a_crashed_guard_leaves_one_raised_span(
    owner_client, pool, mount_peers, monkeypatch, attr, name, _log
):
    """C1 + C3: exactly one guard span named for the crashed guard, marked
    raised (traces.guard_raised) with meta.error "<ExcType>: <message>"; no
    other guard span that turn is marked raised."""
    _break(monkeypatch, attr, f"{attr} fell over")

    await _turn(owner_client, mount_peers)

    spans = await _guard_spans(pool)
    raised = _raised(spans)
    assert len(raised) == 1, spans
    got_name, meta = raised[0]
    assert got_name == name, spans
    assert meta["error"] == f"_GuardBoom: {attr} fell over", meta
    assert [n for n, _ in spans].count(name) == 1, spans


@pytest.mark.parametrize(("attr", "name", "log"), T12_SITES, ids=[s[0] for s in T12_SITES])
async def test_v27_t12_the_reply_still_ships_and_the_crash_is_still_logged(
    owner_client, pool, mount_peers, monkeypatch, caplog, attr, name, log
):
    """C2: the crash changes nothing she reads — ok, [DONE], her reply stored
    as written, no correction frame, the handler's log line kept — and the
    trace now says the guard fell over."""
    caplog.set_level(logging.WARNING)
    _break(monkeypatch, attr, f"{attr} fell over")

    sent = await _turn(owner_client, mount_peers)

    assert sent[-1] == DONE
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f], sent
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == REPLY
    assert _crash_logged(caplog, log), f"{log!r} must still be logged with the exception"
    assert any(n == name for n, _ in _raised(await _guard_spans(pool)))


def _rechecks(spans: list[tuple[str, dict]], name: str) -> list[dict]:
    return [m for n, m in _raised(spans) if n == name and m.get("recheck") is True]


def _fired(spans: list[tuple[str, dict]], name: str) -> list[dict]:
    return [m for n, m in spans if n == name and not traces.guard_raised(m)]


async def test_v27_t12_a_deferral_recheck_that_raises_is_filed_beside_the_redirect(
    owner_client, pool, mount_peers, monkeypatch
):
    """C4, the deferral re-check (~:5061): the detector fires over her promise,
    the text-only redirect regenerates, and the re-check over the regeneration
    raises. The redirect still stands (as today); the trace now holds ONE
    raised deferral span marked recheck beside the one fired deferral span."""
    from tests.test_chat_deferral import DEFER, _set
    from tests.test_chat_deferral import text as dtext

    corrected = "The Pixel 10 has a 50-megapixel main camera with strong low-light."
    real = guards.deferral_check

    def flaky(reply, *args, **kwargs):
        if reply == corrected:
            raise _GuardBoom("deferral re-check fell over")
        return real(reply, *args, **kwargs)

    monkeypatch.setattr(guards, "deferral_check", flaky)
    gateway = ScriptedGateway(rounds=((dtext(DEFER),), (dtext(corrected),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")
    resp = await owner_client.post(
        "/api/v1/chat/stream", json={"message": "what's the latest with the pixel?"}
    )
    sent = _frames(resp.text)

    assert sent[-1] == DONE
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == corrected
    spans = await _guard_spans(pool)
    fired = _fired(spans, "deferral")
    assert len(fired) == 1 and fired[0]["redirected"] is True, spans
    rechecks = _rechecks(spans, "deferral")
    assert len(rechecks) == 1, spans
    assert rechecks[0]["error"] == "_GuardBoom: deferral re-check fell over", rechecks


async def test_v27_t12_a_regen_vetting_check_that_raises_is_filed_beside_the_redirect(
    owner_client, pool, mount_peers, monkeypatch
):
    """C4, _regen_rejected_by (~:5447): the cleared-offer detector is sound
    over her offer and raises over the regenerated answer. The redirect stands
    (T10 C6); the trace now holds a raised cleared_offer span marked recheck,
    named for the check that raised, beside the one fired cleared_offer span."""
    from tests.test_chat_cleared_offer import (
        ANSWER,
        CHANGE,
        OFFER,
        READ,
        _arm_run,
        _say,
        call_delta,
    )
    from tests.test_chat_cleared_offer import text as ctext

    _arm_run(monkeypatch)
    real = guards._cleared_offer

    def flaky(reply: str):
        if reply == ANSWER:
            raise _GuardBoom("cleared-offer check fell over on the regen")
        return real(reply)

    monkeypatch.setattr(guards, "_cleared_offer", flaky)
    gateway = ScriptedGateway(
        rounds=(
            (call_delta(0, call_id="a1", name="device_run", arguments=READ),),
            (ctext(OFFER),),
            (call_delta(0, call_id="a2", name="device_run", arguments=CHANGE),),
            (ctext(ANSWER),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client)

    assert sent[-1] == DONE
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == ANSWER
    spans = await _guard_spans(pool)
    fired = _fired(spans, "cleared_offer")
    assert len(fired) == 1 and fired[0]["redirected"] is True, spans
    rechecks = _rechecks(spans, "cleared_offer")
    assert len(rechecks) == 1, spans
    assert rechecks[0]["error"] == "_GuardBoom: cleared-offer check fell over on the regen"


@pytest.mark.parametrize(
    ("kind", "stands_attr", "detector"),
    [
        ("listing", "_listing_claim_stands", "presented_listing_check"),
        ("state", "_state_claim_stands", "state_claim_check"),
    ],
    ids=["listing ~:5143", "state ~:5125"],
)
async def test_v27_t12_a_claim_stands_recheck_that_raises_is_filed(
    owner_client, pool, mount_peers, monkeypatch, tmp_path, kind, stands_attr, detector
):
    """C4, _state_claim_stands / _listing_claim_stands: the guard's own
    re-check, run from inside the helper after a redirect that stood, raises.
    Fail-open as today (the turn closes ok with her regenerated answer); the
    trace now holds one raised span marked recheck per raising re-check,
    beside the one fired span of that guard."""
    from tests.test_chat_said_not_done import I1_KINDS

    guard, _reply, ask, rounds, answer, _notes = await I1_KINDS[kind](
        pool, monkeypatch, tmp_path, its_own_kind=True
    )
    real_stands = getattr(chat, stands_attr)
    real_detector = getattr(guards, detector)
    inside: list[bool] = []
    raised_inside: list[int] = []

    def stands(*args, **kwargs):
        inside.append(True)
        try:
            return real_stands(*args, **kwargs)
        finally:
            inside.pop()

    def detector_in_stands(*args, **kwargs):
        if inside:
            raised_inside.append(1)
            raise _GuardBoom(f"{detector} re-check fell over")
        return real_detector(*args, **kwargs)

    monkeypatch.setattr(chat, stands_attr, stands)
    monkeypatch.setattr(guards, detector, detector_in_stands)
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": ask})
    sent = _frames(resp.text)

    assert sent[-1] == DONE
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == answer
    assert raised_inside, f"the {stands_attr} re-check never ran in this flow"
    spans = await _guard_spans(pool)
    assert len(_fired(spans, guard)) == 1, spans
    rechecks = _rechecks(spans, guard)
    assert len(rechecks) == len(raised_inside), spans
    assert all(m["error"] == f"_GuardBoom: {detector} re-check fell over" for m in rechecks)


async def test_v27_t12_a_claim_backed_recheck_that_raises_is_filed(
    owner_client, pool, mount_peers, monkeypatch, tmp_path
):
    """C4, _claim_redirect's claim_backed re-check (~:5823): the re-check
    itself raises after the regeneration stood. The no-call note shows as
    today (claim_backed False); the trace now holds ONE raised span named for
    the claim's kind, marked recheck."""
    from tests.test_chat_said_not_done import I1_KINDS

    guard, _reply, ask, rounds, answer, (_doing, no_call) = await I1_KINDS["listing"](
        pool, monkeypatch, tmp_path, its_own_kind=True
    )

    def raises(*args, **kwargs):
        raise _GuardBoom("claim-backed re-check fell over")

    monkeypatch.setattr(chat, "_listing_claim_stands", raises)
    mount_peers(gateway=ScriptedGateway(rounds=rounds), memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": ask})
    sent = _frames(resp.text)

    assert sent[-1] == DONE
    assert [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f] == [no_call]
    stored = await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")
    assert stored == answer
    spans = await _guard_spans(pool)
    fired = _fired(spans, guard)
    assert len(fired) == 1 and fired[0]["claim_backed"] is False, spans
    rechecks = _rechecks(spans, guard)
    assert len(rechecks) == 1, spans
    assert rechecks[0]["error"] == "_GuardBoom: claim-backed re-check fell over", rechecks


def _guard_handlers() -> list[tuple[int, str, bool]]:
    """(line, logged message, files the crash?) for every except handler in
    chat.py whose logger.exception says a guard or a re-check raised."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(chat))
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        calls = [c for stmt in node.body for c in ast.walk(stmt) if isinstance(c, ast.Call)]
        messages = [
            c.args[0].value
            for c in calls
            if isinstance(c.func, ast.Attribute)
            and c.func.attr == "exception"
            and isinstance(c.func.value, ast.Name)
            and c.func.value.id == "logger"
            and c.args
            and isinstance(c.args[0], ast.Constant)
            and isinstance(c.args[0].value, str)
        ]
        guard_messages = [m for m in messages if "guard raised" in m or "re-check raised" in m]
        if not guard_messages:
            continue
        files = any(
            isinstance(c.func, ast.Name) and c.func.id == "_file_guard_crash" for c in calls
        )
        found.append((node.lineno, guard_messages[0], files))
    return found


def test_v27_t12_every_guard_handler_in_chat_files_the_crash():
    """C5: the tripwire. Every handler in chat.py that logs a guard or a
    re-check raising also files it with _file_guard_crash — so the day someone
    adds a guard with a log-and-move-on handler, this reddens. At T12 RED there
    are 19 such handlers: T11's nine, the rewrite/append helpers, own-tool
    handback, cleared offer, the said-not-done loop, and five re-checks."""
    handlers = _guard_handlers()
    assert len(handlers) >= 19, handlers
    silent = [(line, msg) for line, msg, files in handlers if not files]
    assert silent == [], f"guard handlers that log a crash but leave no span: {silent}"
