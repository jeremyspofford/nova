"""S46a T6's wake-claim guard wired into the real turn — both guard sites.

T5-T6 fix (VERIFY, 2026-10-11): removing the turn's paired names from EITHER
call of chat._append_class_claims (the turn body, or a redirect's
regeneration), or dropping wake_claim from append_only_guard_fired, survived
every test — the guard's own file calls it directly, and no chat test said
"I woke the box". With no names, "I woke the box" with no wake fact ships
uncorrected. These drive the real route through a scripted gateway with a
paired machine in the registry, so each wire has a test that reddens when it
is cut.

Documentation names only (box); no MAC anywhere.
"""

from __future__ import annotations

from app import chat, guards
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_state_claim import _corrections, _guard_spans, _pair, _say, _stored, text

pytestmark = requires_db

HUB = "hub:qwen3:8b"
CLAIM = "I woke the box."
CORRECTION = guards.WAKE_CLAIM_NO_RECORD.format(machine="box")


async def test_the_turn_body_corrects_a_wake_claim_beside_the_prose(
    owner_client, pool, mount_peers
):
    """Site 1, the turn body: the paired name reaches the guard, so the claim
    is corrected AFTER the prose (APPEND-class), filed as a guard span, and
    the turn is kept out of memory."""
    await _pair(pool, "box")
    gateway = ScriptedGateway(rounds=((text(CLAIM),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "wake the box")

    assert gateway.calls == 1  # APPEND-class: no redirect
    assert _corrections(sent) == [CORRECTION]
    assert await _stored(pool) == f"{CLAIM}\n\n{CORRECTION}"
    (span,) = await _guard_spans(pool)
    assert span["name"] == "wake_claim"
    assert span["meta"] == {"machine": "box", "phrase": "I woke the box", "evidence": "no_record"}
    await chat.drain_background()
    assert memory.ingests == []


async def test_an_honest_send_is_left_alone_and_ingested(owner_client, pool, mount_peers):
    """The precision half beside it: the same paired machine, a send stated as
    a send — no guard span, persisted as written."""
    await _pair(pool, "box")
    honest = "I can send the box a wake packet from the hub if you'd like."
    gateway = ScriptedGateway(rounds=((text(honest),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "can you wake the box?")

    assert _corrections(sent) == []
    assert [s["name"] for s in await _guard_spans(pool)] == []
    assert await _stored(pool) == honest


async def test_a_redirects_regeneration_corrects_a_wake_claim_beside_it(
    owner_client, pool, mount_peers
):
    """Site 2, a redirect's regeneration (A9): the consent redirect regenerates,
    the regeneration stands, and its wake claim is corrected beside it — over
    the same paired names the turn body reads."""
    await _pair(pool, "box")
    regen = f"Done. {CLAIM}"
    gateway = ScriptedGateway(
        rounds=(
            (text("That's still awaiting your approval — I can't run it until you OK it."),),
            (text(regen),),
        ),
        served_by=HUB,
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    sent = await _say(owner_client, "try again")

    assert gateway.calls == 2
    assert await _stored(pool) == f"{regen}\n\n{CORRECTION}"
    spans = await _guard_spans(pool)
    assert [s["name"] for s in spans] == ["consent_claim", "wake_claim"]
    assert spans[0]["meta"]["redirected"] is True
    assert spans[0]["meta"]["regen_appended"] == ["wake_claim"]
    assert spans[1]["meta"]["machine"] == "box"
    assert _corrections(sent)[-1] == CORRECTION
    await chat.drain_background()
    assert memory.ingests == []


async def test_a_fired_wake_claim_outranks_a_deferral_redirect(owner_client, pool, mount_peers):
    """append_only_guard_fired carries wake_claim: a reply it corrected gets
    no "do it now" regeneration on top, which could re-introduce the very
    line it corrected. One gateway round; the prose and the correction
    persist."""
    await _pair(pool, "box")
    reply = f"I'll search the web for the latest news now. {CLAIM}"
    gateway = ScriptedGateway(rounds=((text(reply),),), served_by=HUB)
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    await _say(owner_client, "what's the latest on OpenAI?")

    assert gateway.calls == 1  # no deferral redirect round
    stored = await _stored(pool)
    assert stored.startswith(f"{reply}\n\n{CORRECTION}")
    names = [s["name"] for s in await _guard_spans(pool)]
    assert names[0] == "wake_claim"
    await chat.drain_background()
    assert memory.ingests == []
