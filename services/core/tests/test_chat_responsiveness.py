"""The OPT-IN responsiveness check wired into the live turn.

A soft, LLM-judged, toggleable guard (agents.responsiveness_check, default
OFF): after the mechanical guards run, a cheap judge call decides whether the
reply addressed the user's message and, on drift, re-answers ONCE. These prove
the wiring end to end against a scripted gateway — that OFF makes ZERO extra
model calls, that ON judges and redirects exactly once, that the corrected reply
is what persists and ingests, and that every failure mode ships the original
reply (fail-OPEN).
"""
from __future__ import annotations

import json

from app import chat
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


async def _set_model(client, model: str = "qwen3:8b") -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    assert resp.status_code == 200, resp.text


async def _set_responsiveness(client, value: bool) -> None:
    resp = await client.put(
        "/api/v1/settings", json={"key": "agents.responsiveness_check", "value": value}
    )
    assert resp.status_code == 200, resp.text


async def _say(client, message: str = "what's the pixel phone camera like?") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _guard_spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [row for row in rows if row["name"] == "responsiveness"]


async def _stored_reply(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


async def test_off_by_default_makes_no_judge_call_and_leaves_no_span(
    owner_client, pool, mount_peers
):
    """The invariant that makes it opt-in: with the setting off (its default),
    the turn makes exactly ONE gateway call — the reply — and never touches the
    model again. No responsiveness span, because nothing ran."""
    gateway = ScriptedGateway(rounds=((text("The Pixel camera is excellent."),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(owner_client)

    sent = await _say(owner_client)

    assert gateway.calls == 1  # the reply, and nothing else
    assert await _guard_spans(pool) == []
    assert await _stored_reply(pool) == "The Pixel camera is excellent."
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert sent[-1] == DONE


async def test_on_and_on_topic_judges_once_but_does_not_redirect(
    owner_client, pool, mount_peers
):
    """Setting on, verdict on_topic: the judge call is made (call 2), the reply
    is unchanged, and the span records the clean verdict with no redirect."""
    reply = "The Pixel camera is excellent — great low-light shots."
    gateway = ScriptedGateway(rounds=((text(reply),), (text("on_topic"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    await _set_responsiveness(owner_client, True)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # the reply, then the judge — no redirect
    assert await _stored_reply(pool) == reply
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]

    spans = await _guard_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"] == {"checked": True, "verdict": "on_topic", "redirected": False}


async def test_on_and_off_topic_redirects_exactly_once_and_the_correction_persists(
    owner_client, pool, mount_peers
):
    """The headline case: a drifted reply is judged off_topic and re-answered
    once. The corrected reply is what persists AND ingests (the drift already
    streamed live but is not what the next turn reads), the refocus note reaches
    the stream, and the span says verdict=off_topic redirected=True. Bounded:
    exactly three gateway calls — reply, judge, one redirect — never a fourth."""
    drift = "OpenAI is an AI research company based in San Francisco."
    corrected = "The Pixel camera is superb — class-leading computational photography."
    gateway = ScriptedGateway(
        rounds=((text(drift),), (text("off_topic"),), (text(corrected),))
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(owner_client)
    await _set_responsiveness(owner_client, True)

    sent = await _say(owner_client)

    # Reply, judge, ONE redirect — bounded, no re-judge loop (a fourth call
    # would be the scripted gateway's loud 500).
    assert gateway.calls == 3
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    # The corrected reply REPLACES the drift in the durable record.
    assert await _stored_reply(pool) == corrected

    # The refocus note and the corrected reply both reached the live stream,
    # in order, before [DONE].
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [chat.REFOCUS_NOTE]
    deltas = [f["t"] for f in sent if isinstance(f, dict) and "t" in f]
    assert deltas[0] == drift  # the drift streamed live
    assert deltas[-1] == corrected  # then the corrected reply
    assert sent[-1] == DONE

    # The span makes the redirect legible on the Activity page.
    spans = await _guard_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"] == {"checked": True, "verdict": "off_topic", "redirected": True}

    # Memory keeps the good reply, not the drift.
    await chat.drain_background()
    assert memory.ingests[0]["exchange"]["assistant"] == corrected


async def test_a_judge_gateway_error_fails_open_and_ships_the_original(
    owner_client, pool, mount_peers
):
    """Fail-OPEN: the judge round refuses, so no verdict is reached — the
    original reply ships unchanged, no redirect, no error frame, and the span
    records the failure honestly."""
    reply = "The Pixel camera is excellent."
    gateway = ScriptedGateway(
        rounds=((text(reply),), Refusal(status=500, body={"error": {"message": "down"}}))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    await _set_responsiveness(owner_client, True)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # reply + the failed judge; no redirect attempted
    assert await _stored_reply(pool) == reply
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]

    spans = await _guard_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["verdict"] == "on_topic"
    assert spans[0]["meta"]["redirected"] is False
    assert "error" in spans[0]["meta"]


async def test_an_unparseable_verdict_fails_open_and_ships_the_original(
    owner_client, pool, mount_peers
):
    """A judge that answers with neither word is treated as on_topic — an
    unclear judge must never trigger a redirect."""
    reply = "The Pixel camera is excellent."
    gateway = ScriptedGateway(rounds=((text(reply),), (text("hmm, maybe?"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    await _set_responsiveness(owner_client, True)

    sent = await _say(owner_client)

    assert gateway.calls == 2  # reply + judge; unparseable -> no redirect
    assert await _stored_reply(pool) == reply
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]

    spans = await _guard_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"] == {"checked": True, "verdict": "on_topic", "redirected": False}


async def test_a_redirect_that_produces_no_text_keeps_the_original(
    owner_client, pool, mount_peers
):
    """A redirect regeneration that yields nothing is not a correction — the
    original reply stands rather than persisting an empty message."""
    reply = "The Pixel camera is excellent."
    gateway = ScriptedGateway(
        rounds=((text(reply),), (text("off_topic"),), (text(""),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    await _set_responsiveness(owner_client, True)

    sent = await _say(owner_client)

    assert gateway.calls == 3
    assert await _stored_reply(pool) == reply
    assert not [f for f in sent if isinstance(f, dict) and "correction" in f]

    spans = await _guard_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"] == {"checked": True, "verdict": "off_topic", "redirected": False}
