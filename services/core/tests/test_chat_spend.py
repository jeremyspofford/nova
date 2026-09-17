"""S10-1, core's half of metering.

Pins: every gateway round carries the attribution headers (purpose, turn,
person, timezone) and the judge/redirect rounds carry theirs and now
record llm_call spans of their own; the gateway's usage chunk lands on the
span (cost, basis, cache counts, local, metered) and a null is never a
measurement; the turn streams ONE usage frame after the rounds; the
transcript's message carries the turn's cost; the person is on the turn."""

from __future__ import annotations

from app import chat, traces
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import DONE, _say, _set_model, _spans, frames  # noqa: F401

pytestmark = requires_db

USAGE = {
    "prompt_tokens": 120,
    "completion_tokens": 30,
    "cache_read_tokens": 400,
    "cache_write_tokens": None,
    "cost_usd": 0.00135,
    "cost_basis": "provider-reported",
    "provider": "openrouter",
    "model": "openai/gpt-x",
    "local": False,
    "metered": True,
    "recorded": True,
}


async def test_a_round_is_attributed_and_its_cost_lands_on_the_span_and_the_stream(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(deltas=("Hi",), usage=USAGE, served_by="openrouter:openai/gpt-x")
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "openrouter:openai/gpt-x")
    await owner_client.put(
        "/api/v1/settings", json={"key": "nova.timezone", "value": "America/Denver"}
    )

    status, sent = await _say(owner_client, "hello")
    assert status == 200

    # What the gateway was told about the call.
    headers = [
        h
        for (path, _), h in zip(gateway.seen, gateway.seen_headers)
        if path == "/v1/chat/completions"
    ][0]
    turn = await pool.fetchrow("SELECT id, person_id FROM turns")
    owner = await pool.fetchrow("SELECT id FROM people WHERE role = 'owner'")
    assert headers["x-nova-purpose"] == "chat"
    assert headers["x-nova-turn-id"] == str(turn["id"])
    assert headers["x-nova-person"] == str(owner["id"]) == str(turn["person_id"])
    assert headers["x-nova-timezone"] == "America/Denver"
    assert headers["x-nova-role"] == "chat"  # S10-2: a chat turn walks the chat chain

    # What the gateway said back, on the span — only what it stated.
    span = (await _spans(pool, turn["id"]))["llm_call"]
    meta = span["meta"]
    assert meta["purpose"] == "chat" and meta["served_by"] == "openrouter:openai/gpt-x"
    assert meta["cost_usd"] == 0.00135 and meta["cost_basis"] == "provider-reported"
    assert meta["cache_read_tokens"] == 400 and "cache_write_tokens" not in meta
    assert meta["local"] is False and meta["metered"] is True and "usage_recorded" not in meta

    # ONE usage frame after served_by, summed over the turn.
    usage_frames = [f for f in sent if isinstance(f, dict) and "usage" in f]
    assert len(usage_frames) == 1
    assert usage_frames[0]["usage"] == {
        "rounds": 1,
        "priced_rounds": 1,
        "cost_usd": 0.00135,
        "cost_basis": ["provider-reported"],
        "prompt_tokens": 120,
        "completion_tokens": 30,
        "unmetered_rounds": 0,
        "local_rounds": 0,
        "unrecorded_rounds": 0,
    }
    order = [next(iter(f)) for f in sent if isinstance(f, dict)]
    assert order.index("served_by") < order.index("usage")

    # The transcript carries the turn's cost, derived from the spans.
    conversation = sent[0]["meta"]["conversation_id"]
    messages = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()
    assistant = [m for m in messages["messages"] if m["role"] == "assistant"][0]
    assert assistant["cost_usd"] == 0.00135 and assistant["served_by"] == "openrouter:openai/gpt-x"


async def test_an_unmetered_local_round_carries_no_dollars_and_says_so(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(
        deltas=("Hi",),
        usage={
            "prompt_tokens": None,
            "completion_tokens": None,
            "cost_usd": None,
            "cost_basis": None,
            "provider": "ollama",
            "local": True,
            "metered": False,
            "recorded": False,
        },
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    status, sent = await _say(owner_client, "hello")
    assert status == 200
    turn = await pool.fetchrow("SELECT id FROM turns")
    meta = (await _spans(pool, turn["id"]))["llm_call"]["meta"]
    assert "prompt_tokens" not in meta and "cost_usd" not in meta
    assert meta["local"] is True and meta["metered"] is False and meta["usage_recorded"] is False
    usage = [f for f in sent if isinstance(f, dict) and "usage" in f][0]["usage"]
    assert usage["cost_usd"] is None and usage["priced_rounds"] == 0
    assert usage["unmetered_rounds"] == 1 and usage["local_rounds"] == 1
    assert usage["unrecorded_rounds"] == 1


async def test_the_judge_round_is_a_span_of_its_own_with_its_purpose(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(deltas=("on_topic",), usage=USAGE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    await owner_client.put(
        "/api/v1/settings", json={"key": "agents.responsiveness_check", "value": True}
    )
    status, _sent = await _say(owner_client, "what's the pixel camera like?")
    assert status == 200
    rows = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at"
    )
    purposes = [r["meta"]["purpose"] for r in rows]
    assert purposes == ["chat", "judge"]
    judge = rows[1]["meta"]
    assert (
        judge["ok"] is True and judge["cost_usd"] == 0.00135 and judge["tools_advertised"] is False
    )
    judge_headers = [
        h
        for (path, _), h in zip(gateway.seen, gateway.seen_headers)
        if path == "/v1/chat/completions"
    ][1]
    assert judge_headers["x-nova-purpose"] == "judge" and judge_headers["x-nova-role"] == "judge"


def test_turn_usage_sums_only_what_the_gateway_stated():
    def span(**meta):
        return traces.Span(kind="llm_call", name="m", started_at=None, duration_ms=1, meta=meta)

    assert chat.turn_usage([span(model="m")]) is None  # no usage ever arrived
    summary = chat.turn_usage(
        [
            span(
                metered=True,
                cost_usd=0.001,
                cost_basis="listing-price",
                prompt_tokens=10,
                completion_tokens=5,
            ),
            span(metered=False, local=True),
            span(metered=True, prompt_tokens=7, completion_tokens=1),  # metered, unpriced
        ]
    )
    assert summary == {
        "rounds": 3,
        "priced_rounds": 1,
        "cost_usd": 0.001,
        "cost_basis": ["listing-price"],
        "prompt_tokens": 17,
        "completion_tokens": 6,
        "unmetered_rounds": 1,
        "local_rounds": 1,
        "unrecorded_rounds": 0,
    }
