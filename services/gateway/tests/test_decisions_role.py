"""The decision role in routing (docs/plans/rebuild/decision-role/spec.md §1).

Pins: `decisions` is a built-in role whose calls are typed questions
(systemone), never chat; an EMPTY decisions chain borrows nothing — not the
chat chain, not the local standby — and says so; a link whose adapter cannot
carry the role's protocol is refused by name before it is stored, and walked
past with its reason when a chain holds one anyway; the chat endpoint refuses
the decisions role; every adapter states the protocols it carries."""

from __future__ import annotations

import pytest

from app import adapters, backends, engines, routing
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

JEV = "~typesafe/jev-latest"


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


async def _openrouter(client, mount_backend) -> FakeOpenAICompat:
    fake = FakeOpenAICompat(
        accepts_key="sk-1", models_body={"object": "list", "data": [{"id": JEV}]}
    )
    mount_backend("http://openrouter.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


def test_decisions_is_a_built_in_role_that_speaks_typed_questions():
    assert "decisions" in routing.BUILTIN_ROLES
    assert "decisions" not in routing.RESERVED_ROLES
    assert routing.protocol_of("decisions") == routing.SYSTEMONE
    for role in ("chat", "scheduled", "judge", "agent_coder"):
        assert routing.protocol_of(role) == routing.CHAT


def test_each_adapter_states_the_protocols_it_carries():
    """Read off the adapter, never a vendor list: the ENDPOINT decides the
    protocol, and an openai-chat provider (OpenRouter) carries both."""
    assert adapters.for_row({"adapter": "ollama"}).protocols == {"chat"}
    assert adapters.for_row({"adapter": "anthropic-messages"}).protocols == {"chat"}
    assert adapters.for_row({"adapter": "openai-chat"}).protocols == {"chat", "systemone"}


async def test_the_routes_page_lists_decisions_with_its_protocol(client, pool, local):
    roles = {r["role"]: r for r in (await client.get("/admin/routes")).json()["roles"]}
    assert roles["decisions"]["chain"] == [] and roles["decisions"]["builtin"] is True
    assert roles["decisions"]["protocol"] == "systemone"
    assert roles["chat"]["protocol"] == "chat"


async def test_an_empty_decisions_chain_borrows_no_chat_link_and_no_standby(client, pool, local):
    """Review focus 1. Every install starts with NO decisions chain. A chat
    role with no chain borrows chat's, and a chain with nothing runnable and
    no local link falls to the local standby — both right for chat, both
    wrong here: a chat model asked a typed question at /systemone has nothing
    to say. Empty means no decision model, stated, and nothing is asked."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})

    ex = (await client.get("/admin/route/explain?role=decisions")).json()

    assert ex["would_serve"] is None
    assert ex["chain"] == []
    assert ex["reason"] == (
        "no model in the 'decisions' chain can serve right now — the decisions chain is "
        "empty, so no decision model is set (add one in Settings → Routing)"
    )
    with pytest.raises(routing.NothingRunnable) as caught:
        await routing.resolve(
            None,
            pool,
            role="decisions",
            requested=None,
            timezone="UTC",
            fit_context=None,
            latest_probes=None,
        )
    assert caught.value.verdicts == [], "no standby entry was derived"


async def test_a_link_that_cannot_answer_typed_questions_is_refused_by_name(
    client, pool, local, mount_backend
):
    await _openrouter(client, mount_backend)

    bad = await client.put("/admin/routes/decisions", json={"chain": ["hub:qwen3:8b"]})
    assert bad.status_code == 400
    assert bad.json()["error"] == (
        "link 'hub:qwen3:8b' cannot serve the decisions role — hub answers chat — "
        "this role needs typed questions"
    )
    good = await client.put("/admin/routes/decisions", json={"chain": [f"openrouter:{JEV}"]})
    assert good.status_code == 200 and good.json()["chain"] == [f"openrouter:{JEV}"]


async def test_a_chain_link_that_cannot_serve_its_role_is_walked_past_with_its_reason(
    client, pool, local, mount_backend
):
    """A chain written before the check existed — or a provider whose adapter
    was changed since — still holds such a link: the walk says why it is
    skipped and never dials it."""
    await _openrouter(client, mount_backend)
    await pool.execute(
        "INSERT INTO routes (role, chain) VALUES ('decisions', $1::jsonb)",
        f'["hub:qwen3:8b", "openrouter:{JEV}"]',
    )

    ex = (await client.get("/admin/route/explain?role=decisions")).json()

    assert [v["verdict"] for v in ex["chain"]] == ["wrong_protocol", "runnable"]
    assert ex["chain"][0]["reason"] == "hub answers chat — this role needs typed questions"
    assert ex["would_serve"]["served_by"] == f"openrouter:{JEV}"


async def test_the_chat_endpoint_refuses_the_decisions_role(client, pool, local):
    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
        headers={"X-Nova-Role": "decisions", "X-Nova-Purpose": "chat"},
    )

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "the decisions role answers typed questions at POST /v1/systemone — "
        "a chat completion cannot be served from its chain"
    )
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
