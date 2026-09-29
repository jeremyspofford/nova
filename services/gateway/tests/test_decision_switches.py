"""The decision-model switches in the walk (decision-role spec §6): local
(alpha) and cloud (beta). A link's kind is its provider's own `local` flag —
never a list of names — and core states the kinds the owner allows on every
decision call, as X-Nova-Decision-Kinds.

Pins: a link whose kind the header does not name is passed over for the
request — never dialled, never walled, never metered — in words, and the next
link answers, whether it is local or cloud, and whether it is in the chain or
the requested model; with nothing left the 503 says so and nothing is dialled;
no header allows every kind, and so does a header naming both; a header naming
a kind that does not exist is a 400 in words. And explain, with
`?decision_kinds=`, gives such a link its own verdict, `kind_off`, ahead of a
wall it also has, and names the link that would answer; the parameter is
refused, in words, on a role that has no decision models."""

from __future__ import annotations

from urllib.parse import unquote

import pytest

from app import backends, engines, routing
from tests.conftest import requires_db
from tests.fakes import FakeOllama
from tests.test_systemone_route import (
    JEV,
    KEV,
    QUESTIONS,
    STATE,
    TURN,
    _asked,
    _chain,
    _kev,
    _openrouter,
)

pytestmark = requires_db

LOCAL_OFF = f"{KEV}: local decision models are switched off in Settings (alpha)"
CLOUD_OFF = f"openrouter:{JEV}: cloud decision models are switched off in Settings (beta)"


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("qwen3:8b",))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    engines.clear_cache()
    return fake


async def _decide(client, kinds: str | None, **body):
    headers = {"X-Nova-Role": "decisions", "X-Nova-Purpose": "chat", "X-Nova-Turn-Id": TURN}
    if kinds is not None:
        headers["X-Nova-Decision-Kinds"] = kinds
    return await client.post(
        "/v1/systemone", json={"state": STATE, "questions": QUESTIONS, **body}, headers=headers
    )


def _route_reason(resp) -> str:
    header = dict(part.split("=", 1) for part in resp.headers["x-nova-route"].split(";"))
    return unquote(header.get("reason", ""))


async def test_a_switched_off_local_link_is_passed_over_undialled_and_the_next_answers(
    client, pool, local, mount_backend
):
    """The owner's default: Kev first in his chain, local switched off. Kev is
    never asked — no dial, no wall, no ledger row — the route says why in
    words, and Jev answers."""
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")

    resp = await _decide(client, "cloud")

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    route = resp.json()["route"]
    assert route["link"] == 2
    assert route["reason"] == f"fell back to link 2 (openrouter:{JEV}) — {LOCAL_OFF}"
    assert _route_reason(resp) == route["reason"]
    assert _asked(kev) == [], "a switched-off link is never dialled"
    assert len(_asked(jev)) == 1
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    rows = await pool.fetch("SELECT provider, kind FROM usage_events")
    assert [(r["provider"], r["kind"]) for r in rows] == [("openrouter", "completion")]


async def test_a_switched_off_cloud_link_is_passed_over_the_same_way(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}", KEV)

    resp = await _decide(client, "local")

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == KEV
    assert resp.json()["route"]["reason"] == f"fell back to link 2 ({KEV}) — {CLOUD_OFF}"
    assert _asked(jev) == [], "a switched-off link is never dialled"
    assert len(_asked(kev)) == 1
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_requested_model_is_judged_by_its_kind_like_any_link(
    client, pool, local, mount_backend
):
    """A body `model` is link 1 (a measurement names Jev or Kev by it). The
    switches reach it too: a switched-off requested model is passed over and
    the chain answers."""
    kev = await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, f"openrouter:{JEV}")

    resp = await _decide(client, "cloud", model=KEV)

    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert resp.json()["route"]["reason"] == f"fell back to link 2 (openrouter:{JEV}) — {LOCAL_OFF}"
    assert _asked(kev) == []


@pytest.mark.parametrize(
    ("kinds", "chain", "said"),
    [
        ("cloud", (KEV,), LOCAL_OFF),
        ("", (KEV, f"openrouter:{JEV}"), f"{LOCAL_OFF}; {CLOUD_OFF}"),
    ],
    ids=["the-one-link-switched-off", "every-kind-switched-off"],
)
async def test_with_nothing_left_the_503_says_so_and_nothing_is_dialled(
    client, pool, local, mount_backend, kinds, chain, said
):
    """Core fails open at once on this 503 — nothing waited on, nothing spent."""
    kev = await _kev(client, mount_backend)
    jev = await _openrouter(client, mount_backend)
    await _chain(client, *chain)

    resp = await _decide(client, kinds)

    assert resp.status_code == 503
    assert resp.json()["error"] == (
        f"no model in the 'decisions' chain can serve right now — {said}"
    )
    assert (_asked(kev), _asked(jev)) == ([], [])
    assert await pool.fetchval("SELECT count(*) FROM usage_events") == 0
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


@pytest.mark.parametrize("kinds", [None, "cloud,local", " local , cloud "])
async def test_no_header_or_both_kinds_allows_every_kind(client, pool, local, mount_backend, kinds):
    """No header is every kind: a caller that states no switches — an older
    core, a measurement pinning a model — walks the chain as the owner ordered
    it, exactly as before the switches existed."""
    kev = await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")

    resp = await _decide(client, kinds)

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == KEV
    assert resp.headers["x-nova-route"] == "role=decisions;link=1"
    assert len(_asked(kev)) == 1


async def test_a_header_naming_a_kind_that_does_not_exist_is_a_400_in_words(
    client, pool, local, mount_backend
):
    kev = await _kev(client, mount_backend)
    await _chain(client, KEV)

    resp = await _decide(client, "cloud,gpu")

    assert resp.status_code == 400
    assert resp.json()["error"] == (
        "X-Nova-Decision-Kinds names 'gpu' — a decision model is local or cloud"
    )
    assert _asked(kev) == []
    assert await pool.fetchval("SELECT count(*) FROM usage_events") == 0


async def test_explain_gives_a_switched_off_link_its_own_verdict_and_names_who_would_answer(
    client, pool, local, mount_backend
):
    """The Routing page's "right now: X would answer" and her routing tool
    both read this walk, so both follow the switches."""
    await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")

    ex = (await client.get("/admin/route/explain?role=decisions&decision_kinds=cloud")).json()

    assert [(v["id"], v["verdict"]) for v in ex["chain"]] == [
        (KEV, "kind_off"),
        (f"openrouter:{JEV}", "runnable"),
    ]
    assert ex["chain"][0]["reason"] == "local decision models are switched off in Settings (alpha)"
    assert ex["chain"][0]["local"] is True
    assert ex["would_serve"]["served_by"] == f"openrouter:{JEV}"
    assert ex["would_serve"]["link"] == 2
    assert ex["reason"] == f"fell back to link 2 (openrouter:{JEV}) — {LOCAL_OFF}"

    every = (await client.get("/admin/route/explain?role=decisions")).json()
    assert every["would_serve"]["served_by"] == KEV, "no parameter is every kind"

    none = (await client.get("/admin/route/explain?role=decisions&decision_kinds=")).json()
    assert [f"{v['id']}: {v['reason']}" for v in none["chain"]] == [LOCAL_OFF, CLOUD_OFF]
    assert {v["verdict"] for v in none["chain"]} == {"kind_off"}
    assert none["would_serve"] is None
    assert none["reason"] == "no model in the 'decisions' chain can serve right now"


async def test_a_switched_off_link_is_said_as_switched_off_before_its_wall(
    client, pool, local, mount_backend
):
    """The owner's switch is the first reason a link will not answer. Its wall
    is left exactly as it was — not cleared, not climbed."""
    await _kev(client, mount_backend)
    await _openrouter(client, mount_backend)
    await _chain(client, KEV, f"openrouter:{JEV}")
    await routing.record_refusal(pool, {"name": "dell-kev"}, 502, "asleep", model="kev-latest")
    before = [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")]

    ex = (await client.get("/admin/route/explain?role=decisions&decision_kinds=cloud")).json()
    resp = await _decide(client, "cloud")

    assert ex["chain"][0]["verdict"] == "kind_off"
    assert resp.headers["x-nova-served-by"] == f"openrouter:{JEV}"
    assert [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")] == before


@pytest.mark.parametrize(
    ("query", "said"),
    [
        (
            "role=chat&decision_kinds=cloud",
            "decision_kinds names the decision-model kinds allowed, and the chat role has no "
            "decision models — it answers chat",
        ),
        (
            "role=decisions&decision_kinds=gpu",
            "decision_kinds names 'gpu' — a decision model is local or cloud",
        ),
    ],
    ids=["a-chat-role", "an-unknown-kind"],
)
async def test_explain_refuses_decision_kinds_it_cannot_apply_in_words(
    client, pool, local, query, said
):
    resp = await client.get(f"/admin/route/explain?{query}")

    assert resp.status_code == 400
    assert resp.json()["error"] == said
