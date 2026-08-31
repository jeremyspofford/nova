"""The ALWAYS-ON deferral guard wired into the live turn.

A deferral is a broken promise: the model says "I'll perform a web search…" and
calls no tool, so the turn ends reading like it is still working (the S3 owner
walk, 2026-08-30). Unlike the opt-in responsiveness check, the detector runs on
EVERY turn — but the one redirect it triggers only fires when a deferral
ACTUALLY happened, so the cost is targeted. These drive the real route through a
scripted gateway to prove the wiring end to end: a deferral is redirected once
and the corrected reply persists; a reply whose tool actually ran does NOT fire;
the redirect budget is SHARED with the responsiveness check (total ≤ 1 redirect,
deferral first); a redirect that still defers degrades to an honest note (no
second redirect); and every failure mode ships the reply (fail-OPEN).
"""
from __future__ import annotations

import json

import pytest

from app import chat, guards
from app.main import app as core_app
from tests import fakes
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


def call_delta(index: int, *, call_id, name, arguments) -> dict:
    """One whole streamed tool-call, as the loop's own tests shape them."""
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": index,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


async def _set(client, key: str, value) -> None:
    resp = await client.put("/api/v1/settings", json={"key": key, "value": value})
    assert resp.status_code == 200, resp.text


async def _say(client, message: str = "what's the latest with the pixel?") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


async def _deferral_spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name, meta FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [row for row in rows if row["name"] == "deferral"]


async def _responsiveness_spans(pool) -> list:
    rows = await pool.fetch(
        "SELECT name FROM turn_spans WHERE kind = 'guard' ORDER BY started_at"
    )
    return [row for row in rows if row["name"] == "responsiveness"]


async def _stored_reply(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


DEFER = "I'll perform a web search for the latest Pixel news."


async def test_a_deferral_with_no_tool_call_redirects_once_and_persists_the_correction(
    owner_client, pool, mount_peers
):
    """The headline case: the reply COMMITS to a search and calls nothing. The
    detector fires (always-on, no setting), the turn regenerates ONCE with a
    do-it-now nudge, and the corrected reply REPLACES what persists and ingests.
    Bounded: exactly two gateway calls — the deferral, then the one redirect."""
    corrected = "The Pixel 10 has a 50-megapixel main camera with strong low-light."
    gateway = ScriptedGateway(rounds=((text(DEFER),), (text(corrected),)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client)

    # The deferral (call 1) then ONE redirect (call 2) — never a third.
    assert gateway.calls == 2
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    # The corrected reply REPLACES the deferral in the durable record.
    assert await _stored_reply(pool) == corrected

    # The deferral streamed live, then the note and the corrected reply, in order.
    deltas = [f["t"] for f in sent if isinstance(f, dict) and "t" in f]
    assert deltas[0] == DEFER
    assert deltas[-1] == corrected
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [chat.DEFERRAL_NOTE]
    assert sent[-1] == DONE

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    meta = spans[0]["meta"]
    assert meta["detected"] is True
    assert meta["action"] == "web_search"
    assert meta["redirected"] is True

    # Memory keeps the corrected answer, not the promise.
    await chat.drain_background()
    assert memory.ingests[0]["exchange"]["assistant"] == corrected


async def test_a_deferral_whose_tool_actually_ran_does_not_fire(
    owner_client, pool, mount_peers, monkeypatch
):
    """The precision crux at the wiring level: the reply says 'let me search' AND
    a web_search span really ran this turn, so it is an honest narration of work
    done — no detector fire, no redirect. Only the reply and the answering round
    reach the gateway (two calls)."""
    searx = fakes.FakeSearx(
        results=(
            {"title": "Pixel news", "url": "https://example.com/pixel", "content": "the latest"},
        )
    )
    gateway = ScriptedGateway(
        rounds=(
            (
                text("Let me search the web for that. "),
                call_delta(0, call_id="c1", name="web_search", arguments={"query": "pixel latest"}),
            ),
            (text("Here is what I found about the Pixel."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    monkeypatch.setenv("SEARXNG_URL", fakes.SEARXNG_URL)
    core_app.state.peer_transports[fakes.SEARXNG_URL] = fakes.StreamingASGITransport(searx.app)
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client)

    # The search actually ran, so no redirect: reply round + answer round only.
    assert gateway.calls == 2
    assert searx.queries == ["pixel latest"]
    assert await _deferral_spans(pool) == []
    # The whole turn's text persists, promise and answer alike — it is honest.
    assert await _stored_reply(pool) == (
        "Let me search the web for that. Here is what I found about the Pixel."
    )
    assert sent[-1] == DONE


async def test_the_shared_redirect_budget_stops_responsiveness_redirecting_too(
    owner_client, pool, mount_peers
):
    """One redirect per turn, TOTAL. The deferral guard runs first and has first
    claim, so even with the responsiveness check ON, it does not run this turn —
    exactly two gateway calls (deferral + the one deferral redirect), no judge
    call, no responsiveness span, no loop."""
    corrected = "The Pixel 10 launched with a Tensor G5 and a 50-megapixel camera."
    gateway = ScriptedGateway(rounds=((text(DEFER),), (text(corrected),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")
    await _set(owner_client, "agents.responsiveness_check", True)

    sent = await _say(owner_client)

    # Deferral + ONE redirect. A judge call would be a third; a re-judge redirect
    # a fourth — both are the scripted gateway's loud 500.
    assert gateway.calls == 2
    assert await _stored_reply(pool) == corrected
    assert await _responsiveness_spans(pool) == []  # it never ran — deferral had the budget

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is True
    assert sent[-1] == DONE


async def test_a_redirect_that_still_defers_appends_an_honest_note(
    owner_client, pool, mount_peers
):
    """Bounded to ONE redirect: if the regeneration STILL commits without acting,
    it is not retried — an honest one-sentence note is appended so the operator
    is never left waiting. Exactly two gateway calls."""
    gateway = ScriptedGateway(
        rounds=((text(DEFER),), (text("Sure — I'll look it up in a moment."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client)

    assert gateway.calls == 2  # deferral + one redirect; never a second redirect
    assert await pool.fetchval("SELECT status FROM turns") == "ok"

    note = chat._deferral_honest_note("search the web")
    assert await _stored_reply(pool) == f"{DEFER}\n\n{note}"
    corrections = [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]
    assert corrections == [note]
    # The still-deferring regeneration is NOT streamed as a reply.
    deltas = [f["t"] for f in sent if isinstance(f, dict) and "t" in f]
    assert deltas == [DEFER]

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["detected"] is True
    assert spans[0]["meta"]["redirected"] is False


async def test_a_redirect_gateway_error_degrades_to_the_honest_note(
    owner_client, pool, mount_peers
):
    """Fail-OPEN + fail-safe: the redirect round refuses, so the action could not
    be completed automatically — the reply ships with an honest note, never an
    error frame or a lost turn, and never a second redirect."""
    gateway = ScriptedGateway(
        rounds=((text(DEFER),), Refusal(status=500, body={"error": {"message": "down"}}))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client)

    assert gateway.calls == 2  # deferral + the failed redirect; no retry
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]

    note = chat._deferral_honest_note("search the web")
    assert await _stored_reply(pool) == f"{DEFER}\n\n{note}"

    spans = await _deferral_spans(pool)
    assert len(spans) == 1
    assert spans[0]["meta"]["redirected"] is False
    assert "error" in spans[0]["meta"]


async def test_a_detector_error_fails_open_and_ships_the_reply(
    owner_client, pool, mount_peers, monkeypatch
):
    """The detector itself is fail-OPEN: if deferral_check raises, the reply ships
    unchanged — one gateway call, no redirect, no span, no error frame."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, "deferral_check", boom)
    gateway = ScriptedGateway(rounds=((text(DEFER),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set(owner_client, "chat.model", "qwen3:8b")

    sent = await _say(owner_client)

    assert gateway.calls == 1  # no redirect was attempted
    assert await _stored_reply(pool) == DEFER
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    assert await _deferral_spans(pool) == []
    assert not [f for f in sent if isinstance(f, dict) and "error" in f]
