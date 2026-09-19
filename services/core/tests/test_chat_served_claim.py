"""S40b's served-model and memory-outage guards wired into the real turn.

The S40 live walk (2026-09-19): b851aa91 and b02a5694 marked `qwen3.8:27b`
"Current model in use" in turns hub:qwen3:8b served, and reported the memory
service unreachable in turns whose recall it had just answered; 60834ccf said
"No model was needed for this calculation." in a turn a model wrote — and that
sentence is in his notes now, because nothing stopped the turn being ingested.

These drive the real route through a scripted gateway and a fake memory
service: each guard fires only on the turn's own evidence, APPENDS its
correction after the prose (the reply may carry real content beside the false
line), keeps the turn out of memory, and joins the REPLACE composition when a
whole-stance guard fired too. The regeneration a redirect produces is vetted
by both — and by the serving-state guard, which it never was.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app import chat, guards, scheduler
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.s40_walk import B02A5694, T60834CCF
from tests.test_chat_state_claim import (
    HUB,
    LOCAL,
    MACHINE_QUESTION,
    _corrections,
    _guard_spans,
    _say,
    _stored,
    text,
    tool_call,
)
from tests.test_scheduler import _firings, _scheduled, _set_model
from tests.test_scheduler import _owner as _scheduled_owner

pytestmark = requires_db

WRONG_MODEL = "The model answering right now is qwen3.8:27b."
SERVED_CORRECTION = (
    f"Correction: this reply was written by {HUB} — the gateway recorded that for this "
    "turn — not by qwen3.8:27b."
)
NO_MODEL_CORRECTION = f"Correction: a model wrote this reply — {HUB}."
MEMORY_DOWN = "I can't reach the memory service right now."
MEMORY_CORRECTION = (
    "Correction: the memory service answered this turn — this turn's recall was read from "
    "it — so it is not unreachable now."
)
STATE_CORRECTION = (
    "Correction: I did not check hub this turn — I have no record of doing so, so what "
    "I said about it is not a current reading."
)


async def test_a_wrong_current_model_is_corrected_after_the_prose(owner_client, pool, mount_peers):
    """APPEND: the reply stays, the correction follows it — in the live frames
    and in the record — and the turn is not ingested."""
    gateway = ScriptedGateway(rounds=((text(WRONG_MODEL),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "Which model is answering you right now?")

    assert gateway.calls == 1  # APPEND-class: no redirect
    assert _corrections(sent) == [SERVED_CORRECTION]
    assert await _stored(pool) == f"{WRONG_MODEL}\n\n{SERVED_CORRECTION}"
    (span,) = await _guard_spans(pool)
    assert span["name"] == "served_claim"
    assert span["meta"] == {
        "shape": "sentence",
        "claimed": "qwen3.8:27b",
        "served": [HUB],
        "phrase": "The model answering right now is qwen3.8:27b",
    }
    await chat.drain_background()
    assert memory.ingests == []


async def test_no_model_needed_is_corrected_and_kept_out_of_memory(owner_client, pool, mount_peers):
    """60834ccf, verbatim: the arithmetic stays, the false line is corrected,
    and — the fix for how it reached his notes — nothing is ingested."""
    gateway = ScriptedGateway(rounds=((text(T60834CCF),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "What's 17 times 23?")

    assert _corrections(sent) == [NO_MODEL_CORRECTION]
    assert await _stored(pool) == f"{T60834CCF}\n\n{NO_MODEL_CORRECTION}"
    (span,) = await _guard_spans(pool)
    assert span["name"] == "served_claim"
    assert span["meta"]["shape"] == "no_model"
    assert span["meta"]["claimed"] is None
    assert span["meta"]["served"] == [HUB]
    await chat.drain_background()
    assert memory.ingests == []


async def test_naming_the_model_that_served_is_left_alone_and_ingested(
    owner_client, pool, mount_peers
):
    """The precision half of the DoD walk's step 3: an honest answer draws no
    guard span, persists as written, and is ordinary knowledge."""
    honest = "I'm running on qwen3:8b, served by hub."
    gateway = ScriptedGateway(rounds=((text(honest),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "Which model is answering you right now?")

    assert _corrections(sent) == []
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert await _stored(pool) == honest
    await chat.drain_background()
    assert len(memory.ingests) == 1


async def test_a_memory_outage_claim_is_corrected_when_recall_answered(
    owner_client, pool, mount_peers
):
    gateway = ScriptedGateway(rounds=((text(MEMORY_DOWN),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "Is your memory service working?")

    assert memory.recalls  # the turn's own recall is the evidence
    assert _corrections(sent) == [MEMORY_CORRECTION]
    assert await _stored(pool) == f"{MEMORY_DOWN}\n\n{MEMORY_CORRECTION}"
    (span,) = await _guard_spans(pool)
    assert span["name"] == "memory_claim"
    assert span["meta"] == {
        "subject": "the memory service",
        "phrase": "can't reach the memory service",
        "retrievers_missing": None,
    }
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_memory_outage_claim_stands_when_recall_failed(owner_client, pool, mount_peers):
    """The report may be true: the turn's recall failed, so nothing contradicts it."""
    gateway = ScriptedGateway(rounds=((text(MEMORY_DOWN),),), served_by=HUB)
    mount_peers(gateway=gateway, memory=FakeMemory(recall_status=503))

    sent = await _say(owner_client, "Is your memory service working?")

    assert _corrections(sent) == []
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert await _stored(pool) == MEMORY_DOWN


async def test_the_walk_replay_persists_the_three_corrections(owner_client, pool, mount_peers):
    """b02a5694's path exactly (verdict §3.4, walk outcome): something ran
    before the reply (there, the unasked catalogue check), so the state guard
    cannot redirect; it REPLACES the prose, and the two APPEND-class
    corrections join the replacement after it. What persists is the three
    corrections and no line of the replay; nothing is ingested."""
    gateway = ScriptedGateway(
        rounds=((tool_call("t1", "get_time", {}), LOCAL), (text(B02A5694), LOCAL)),
        served_by=HUB,
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, MACHINE_QUESTION)

    assert gateway.calls == 2  # no redirect round
    assert await _stored(pool) == "\n\n".join(
        [STATE_CORRECTION, SERVED_CORRECTION, MEMORY_CORRECTION]
    )
    # Live, each streamed as its guard ran: served and memory right after the
    # serving-state guard, the state guard's after them.
    assert _corrections(sent) == [SERVED_CORRECTION, MEMORY_CORRECTION, STATE_CORRECTION]
    names = [s["name"] for s in await _guard_spans(pool)]
    assert names == ["served_claim", "memory_claim", "state_claim"]
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_consent_regen_that_names_the_wrong_model_is_refused(
    owner_client, pool, mount_peers
):
    """The redirect's output REPLACES the record and would be ingested, so it
    is vetted by the new checks too: a regeneration that claims the wrong
    model is refused by name and the correction persists alone."""
    gateway = ScriptedGateway(
        rounds=(
            (text("That's still awaiting your approval — I can't run it until you OK it."),),
            (text("Done. I'm running on qwen3.8:27b."),),
        ),
        served_by=HUB,
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "try again")

    assert gateway.calls == 2
    assert await _stored(pool) == guards.CONSENT_CLAIM_CORRECTION
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim"]
    assert spans[0]["meta"]["redirected"] is False
    assert spans[0]["meta"]["regen_rejected_by"] == "served_claim"
    await chat.drain_background()
    assert memory.ingests == []


@pytest.mark.parametrize("reply", [WRONG_MODEL, MEMORY_DOWN, T60834CCF])
async def test_a_scheduled_turn_is_not_armed(pool, mount_peers, reply):
    """Armed only where measured (STACK_CLAIM_KINDS): a scheduled turn's reply
    persists as written."""
    person, conversation = await _scheduled_owner(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=((text(reply),),), served_by=HUB), memory=FakeMemory()
    )
    await _set_model(pool)
    row = await _scheduled(pool, person, conversation, instruction="check my machines")
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok"
    names = await pool.fetch(
        "SELECT name FROM turn_spans WHERE turn_id = $1 AND kind = 'guard'", firing["turn_id"]
    )
    assert [r["name"] for r in names] == []
    persisted = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'",
        firing["turn_id"],
    )
    assert persisted == reply


async def test_a_fired_served_claim_outranks_a_deferral_redirect(owner_client, pool, mount_peers):
    """mechanical_guard_fired carries both new guards: a reply the served-model
    guard corrected gets no "do it now" regeneration on top, which could
    re-introduce the very line it corrected (the responsiveness and deferral
    rule for every mechanical guard). One gateway round, the prose and the
    correction persist."""
    reply = "I'll search the web for the latest news now. I'm running on qwen3.8:27b."
    gateway = ScriptedGateway(rounds=((text(reply),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what's the latest on OpenAI?")

    assert gateway.calls == 1  # no deferral redirect round
    stored = await _stored(pool)
    assert stored.startswith(f"{reply}\n\n{SERVED_CORRECTION}")
    names = [s["name"] for s in await _guard_spans(pool)]
    assert names[0] == "served_claim"
    await chat.drain_background()
    assert memory.ingests == []
