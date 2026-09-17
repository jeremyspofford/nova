"""S10-2, core's half of routing.

Pins: a chat turn walks the chat chain (X-Nova-Role: chat) and a scheduled
one the scheduled chain; the gateway's X-Nova-Route lands on the span; a
fallback streams ONE route frame with the gateway's reason and the
transcript keeps it; link 1 streams none; the failure statement names the
route reason; a suite on a capped provider is refused before it starts."""

from __future__ import annotations

from urllib.parse import quote

from app import chat, traces
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model, _spans

pytestmark = requires_db

REASON = (
    "fell back to link 2 (ollama:qwen3:8b) — openrouter:openai/gpt-x: "
    "openrouter over its monthly cap $10.00 (spent $10.20)"
)


async def test_a_fallback_is_on_the_span_streamed_once_and_kept_on_the_transcript(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(
        deltas=("Hi",),
        served_by="ollama:qwen3:8b",
        route_header=f"role=chat;link=2;reason={quote(REASON, safe='')}",
        usage={
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "local": True,
            "metered": True,
            "recorded": True,
        },
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "openrouter:openai/gpt-x")

    status, sent = await _say(owner_client, "hello")
    assert status == 200
    headers = [
        h for (p, _), h in zip(gateway.seen, gateway.seen_headers) if p == "/v1/chat/completions"
    ][0]
    assert headers["x-nova-role"] == "chat"

    turn = await pool.fetchrow("SELECT id FROM turns")
    meta = (await _spans(pool, turn["id"]))["llm_call"]["meta"]
    assert (
        meta["route_role"] == "chat" and meta["route_link"] == 2 and meta["route_reason"] == REASON
    )

    routes = [f for f in sent if isinstance(f, dict) and "route" in f]
    assert len(routes) == 1
    assert routes[0]["route"] == {
        "role": "chat",
        "link": 2,
        "reason": REASON,
        "served_by": "ollama:qwen3:8b",
    }
    order = [next(iter(f)) for f in sent if isinstance(f, dict)]
    assert order.index("served_by") < order.index("route") < order.index("usage")

    conversation = sent[0]["meta"]["conversation_id"]
    messages = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    assistant = [m for m in messages if m["role"] == "assistant"][0]
    assert assistant["route_reason"] == REASON and assistant["served_by"] == "ollama:qwen3:8b"


async def test_link_one_streams_no_route_frame(owner_client, pool, mount_peers):
    gateway = FakeGateway(deltas=("Hi",), route_header="role=chat;link=1")
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    _status, sent = await _say(owner_client, "hello")
    assert not any(isinstance(f, dict) and "route" in f for f in sent)
    turn = await pool.fetchrow("SELECT id FROM turns")
    meta = (await _spans(pool, turn["id"]))["llm_call"]["meta"]
    assert meta["route_link"] == 1 and "route_reason" not in meta
    conversation = sent[0]["meta"]["conversation_id"]
    messages = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()[
        "messages"
    ]
    assert [m for m in messages if m["role"] == "assistant"][0]["route_reason"] is None


def test_the_failure_statement_names_the_route_reason():
    span = traces.Span(
        kind="llm_call",
        name="m",
        started_at=None,
        duration_ms=1,
        meta={
            "served_by": "ollama:qwen3:8b",
            "route_reason": "fell back to link 2 (ollama:qwen3:8b) — openrouter over its cap",
            "round": 1,
        },
    )
    text = chat.model_failure_statement(
        model="openrouter:gpt-x", failure="the stream died", spans=[span]
    )
    assert "after the gateway fell back to link 2" in text and "the stream died" in text


def test_roles_follow_the_turns_kind_and_an_eval_walks_none():
    def turn(kind):
        return traces.Turn(id=None, started_at=None, kind=kind)  # type: ignore[arg-type]

    assert chat._role_of(turn("chat")) == "chat"
    assert chat._role_of(turn("scheduled")) == "scheduled"
    assert chat._role_of(turn("eval")) is None


async def test_a_suite_on_a_capped_provider_is_refused_before_it_starts(owner_client, mount_peers):
    gateway = FakeGateway(
        explain_body={
            "role": "chat",
            "chain": [
                {
                    "link": 1,
                    "id": "openrouter:gpt-x",
                    "verdict": "over_cap",
                    "reason": "openrouter over its monthly cap $10.00 (spent $10.20)",
                }
            ],
            "would_serve": None,
            "reason": "no model in the chain can serve",
        }
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    resp = await owner_client.post(
        "/api/v1/evals/run", json={"suite": "agent_quality", "model": "openrouter:gpt-x"}
    )
    assert resp.status_code == 402, resp.text
    assert "the suite was not started: openrouter over its monthly cap" in resp.json()["error"]
    assert gateway.queries[-1] == b"role=chat&model=openrouter%3Agpt-x"
