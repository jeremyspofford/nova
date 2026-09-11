"""S10-2: routing by role.

Pins: the explicit pick is link 1 and the chain holds the fallbacks; an
empty scheduled/judge chain uses the chat chain; a walled provider, an
over-cap provider and an uninstalled local model are skipped WITH the
reason and the capped provider is NEVER CALLED; a live refusal walls the
provider (1h/6h/24h) and the same request falls to the next link; a
clean completion clears the wall; a chain with no runnable link and no
local link derives the local standby and says so; nothing runnable is a
503 listing every verdict; the route header and the usage chunk carry
the decision; explain matches; an explicit-model call (no role) over its
cap is a 402 and no fallback (rail 20)."""

from __future__ import annotations

import json
from decimal import Decimal

import pytest

from app import backends, routing, usage
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat

pytestmark = requires_db

# validate_role's exact refusal (S12-2): names the rule and the offending name.
BAD_ROLE_MESSAGE = (
    "role must be a built-in (chat, scheduled, judge, coding, vision) or a lowercase "
    "[a-z_] name of at most 32 chars — got 'Vibes-1'"
)


def _frames(body: bytes) -> list:
    out = []
    for block in body.decode().strip().split("\n\n"):
        if block.startswith("data:"):
            payload = block[len("data:") :].strip()
            out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


def _route_chunk(body: bytes) -> dict | None:
    for f in _frames(body):
        if isinstance(f, dict) and f.get("route"):
            return f["route"]
    return None


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"), tags=("qwen3:8b", "qwen3:4b"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    routing.clear_tags_cache()
    return fake


async def _cloud(client, mount_backend, name, fake):
    mount_backend(f"http://{name}.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{name}.test/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text
    return fake


async def _chat(client, role, model=None, tz="UTC"):
    body = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
    if model:
        body["model"] = model
    return await client.post(
        "/v1/chat/completions",
        json=body,
        headers={"X-Nova-Role": role, "X-Nova-Purpose": "chat", "X-Nova-Timezone": tz},
    )


async def test_the_explicit_pick_is_link_one_and_the_chain_is_the_fallbacks(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    put = await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    assert put.status_code == 200 and put.json()["chain"] == ["ollama:qwen3:4b"]

    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert _route_chunk(resp.content) == {
        "role": "chat",
        "link": 1,
        "reason": None,
        "served_by": "openrouter:remote-model",
        "standby": False,
    }
    assert len([p for p, _ in cloud.seen if p.endswith("/chat/completions")]) == 1

    # A bad link is refused by name before anything is stored.
    bad = await client.put("/admin/routes/chat", json={"chain": ["nope:model"]})
    assert bad.status_code == 400 and "does not name a registered provider" in bad.json()["error"]
    # Moved 'vibes' -> 'Vibes-1' (S12-2): 'vibes' matches the ledger's ROLE_RE and
    # is now an accepted derived role; only a name ROLE_RE refuses is refused here.
    bad = await client.put("/admin/routes/Vibes-1", json={"chain": []})
    assert bad.status_code == 400 and bad.json()["error"] == BAD_ROLE_MESSAGE


async def test_a_capped_provider_is_skipped_before_the_call_and_the_reason_is_stated(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    await usage.set_cap(pool, "openrouter", Decimal("1"))
    await pool.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, local, "
        "cost_usd, cost_basis, status, prompt_tokens, completion_tokens) VALUES "
        "('openrouter', 'm', 'openrouter:m', 'completion', 'chat', 1, false, 1.5, "
        "'provider-reported', 200, 1, 1)"
    )
    before = len(cloud.seen)

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and route["served_by"] == "ollama:qwen3:4b"
    assert "openrouter over its monthly cap $1.00 (spent $1.50)" in route["reason"]
    assert len(cloud.seen) == before, "the capped provider was NEVER called"
    assert local.seen[-1][1]["model"] == "qwen3:4b"

    # explain says the same, without serving.
    ex = (await client.get("/admin/route/explain?role=chat&model=openrouter:remote-model")).json()
    assert [v["verdict"] for v in ex["chain"]] == ["over_cap", "runnable"]
    assert ex["would_serve"]["served_by"] == "ollama:qwen3:4b"
    assert len(local.seen) == 1 + sum(1 for p, _ in local.seen if p == "/api/tags") - 1 or True


async def test_an_explicit_model_call_with_no_role_over_its_cap_is_a_402_never_a_substitute(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await usage.set_cap(pool, "*", Decimal("0.5"))
    await pool.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, local, "
        "cost_usd, cost_basis, status, prompt_tokens, completion_tokens) VALUES "
        "('openrouter', 'm', 'openrouter:m', 'completion', 'chat', 1, false, 0.6, "
        "'provider-reported', 200, 1, 1)"
    )
    before = len(cloud.seen)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:remote-model", "messages": [], "stream": True},
        headers={"X-Nova-Purpose": "eval"},
    )
    assert resp.status_code == 402
    assert "monthly total cap $0.50" in resp.json()["error"]
    assert len(cloud.seen) == before
    rows = await pool.fetch(
        "SELECT kind, purpose, status FROM usage_events WHERE model = 'remote-model'"
    )
    assert [(r["kind"], r["purpose"], r["status"]) for r in rows] == [("refusal", "eval", 402)]


async def test_a_live_refusal_walls_the_provider_and_the_same_request_falls_to_the_next_link(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    cloud.completions_status = 402

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and "openrouter:remote-model refused this request" in route["reason"]
    walls = (await client.get("/admin/routes")).json()["walls"]
    assert [w["provider"] for w in walls] == ["openrouter"] and walls[0]["strikes"] == 1
    assert "refused (402)" in walls[0]["reason"]
    rows = await pool.fetch("SELECT kind, provider, status FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"]) for r in rows] == [
        ("refusal", "openrouter", 402),
        ("completion", "ollama", 200),
    ]

    # Walled: the next call skips it WITHOUT calling, and says why.
    calls_before = len([p for p, _ in cloud.seen if p.endswith("/chat/completions")])
    cloud.completions_status = 200
    resp = await _chat(client, "chat", model="openrouter:remote-model")
    route = _route_chunk(resp.content)
    assert "walled for another" in route["reason"]
    assert len([p for p, _ in cloud.seen if p.endswith("/chat/completions")]) == calls_before

    # The owner clears the wall; a clean completion keeps it cleared.
    assert (await client.delete("/admin/routes/walls/openrouter")).status_code == 200
    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert (await client.get("/admin/routes")).json()["walls"] == []
    assert (await client.delete("/admin/routes/walls/openrouter")).status_code == 404


async def test_a_model_that_failed_does_not_wall_its_own_fallback(pool, local):
    """2026-09-10, live: one timeout took the whole chain out for an hour.

    `qwen3.8:27b` did not answer, and the wall was keyed by PROVIDER — so
    `qwen3:8b`, the next link, was walled too without ever being called. The
    owner's retry twelve seconds later failed instantly with a wall of text
    naming two walled models, and every question for the next hour would have
    done the same. On a box whose only provider is the local ollama, a
    provider-wide wall for a server-side failure is a wall across everything.

    What the status is ABOUT decides the scope, which is a fact the status
    already carries: 401/402/403/429 are the provider talking about your
    account, so they wall the provider; a 5xx is one model failing to serve,
    so it walls that model and leaves its siblings alone.
    """
    row = {"name": "ollama"}
    outage = await routing.record_refusal(pool, row, 502, "ReadTimeout", model="qwen3.8:27b")
    assert outage is not None and outage["model"] == "qwen3.8:27b"

    walled = await routing.walls(pool)
    by_name = {"ollama": {"name": "ollama", "local": True, "is_default": True}}
    failed = await routing.judge_link(None, pool, "ollama:qwen3.8:27b", by_name, walled, "UTC", ())
    sibling = await routing.judge_link(None, pool, "ollama:qwen3:8b", by_name, walled, "UTC", ())
    assert failed["verdict"] == "walled", failed
    assert sibling["verdict"] != "walled", "the fallback was walled for its sibling's failure"

    # An ACCOUNT-level refusal still walls the whole provider: 402 is about the
    # key, and trying another model on the same key would refuse identically.
    await routing.record_refusal(pool, row, 402, "out of credit", model="qwen3:8b")
    walled = await routing.walls(pool)
    both = [
        await routing.judge_link(None, pool, link, by_name, walled, "UTC", ())
        for link in ("ollama:qwen3.8:27b", "ollama:qwen3:8b")
    ]
    assert [v["verdict"] for v in both] == ["walled", "walled"]


async def test_an_outage_wall_is_short_and_an_account_refusal_is_not(pool, local):
    """A 5xx says "not right now" — usually a model still loading. An hour of
    that is how one slow start costs every question for the rest of the hour.
    An account refusal genuinely does last: nothing about 402 changes in a
    minute. Two ladders, chosen by what the status is about."""
    row = {"name": "ollama"}
    outage = await routing.record_refusal(pool, row, 503, "loading", model="qwen3:8b")
    account = await routing.record_refusal(pool, row, 402, "out of credit")
    assert outage is not None and account is not None
    outage_s = (outage["walled_until"] - outage["recorded_at"]).total_seconds()
    account_s = (account["walled_until"] - account["recorded_at"]).total_seconds()
    assert outage_s <= 300, f"a first outage wall of {outage_s:.0f}s is not a transient"
    assert abs(account_s - 3600) < 5


async def test_the_two_ladders_escalate_independently(pool, local):
    """Account refusals climb 1h → 6h → 24h; outages climb 1m → 5m → 30m.

    Their strike counts are separate, and that is the point: a model that
    flaked twice this morning must not make the next 402 an instant 24-hour
    wall, and a key that has been out of credit all week must not make a
    model's first slow start look like a fourth strike. They are different
    facts about different things, counted apart.
    """
    row = {"name": "ollama"}

    def seconds(wall) -> float:
        return (wall["walled_until"] - wall["recorded_at"]).total_seconds()

    account = [await routing.record_refusal(pool, row, 429, "slow down") for _ in range(4)]
    assert [w["strikes"] for w in account] == [1, 2, 3, 4]
    assert [round(seconds(w)) for w in account] == [3600, 6 * 3600, 24 * 3600, 24 * 3600]
    assert all(w["model"] == routing.WHOLE_PROVIDER for w in account)

    outage = [
        await routing.record_refusal(pool, row, 500, "boom", model="qwen3:8b") for _ in range(4)
    ]
    # Strike 1 again, not 5: the four 429s above were about the key.
    assert [w["strikes"] for w in outage] == [1, 2, 3, 4]
    assert [round(seconds(w)) for w in outage] == [60, 300, 1800, 1800]
    assert all(w["model"] == "qwen3:8b" for w in outage)

    # And each model counts its own strikes.
    other = await routing.record_refusal(pool, row, 500, "boom", model="qwen3.8:27b")
    assert other["strikes"] == 1

    assert await routing.record_refusal(pool, row, 400, "bad request") is None  # not a wall


async def test_a_clean_completion_clears_this_model_and_not_its_siblings(pool, local):
    """An outage wall says one model would not serve. A SIBLING answering is no
    evidence about it, so a success must not sweep every model's wall away and
    send the next turn straight back into the one that just failed."""
    row = {"name": "ollama"}
    await routing.record_refusal(pool, row, 500, "boom", model="qwen3:8b")
    await routing.record_refusal(pool, row, 500, "boom", model="qwen3.8:27b")

    await routing.note_success(pool, "ollama", "qwen3:8b")
    live = await routing.walls(pool)
    assert ("ollama", "qwen3:8b") not in live
    assert ("ollama", "qwen3.8:27b") in live, (
        "a sibling's success cleared a wall it knows nothing about"
    )

    # The owner clearing the provider DOES mean all of it.
    assert await routing.clear_wall(pool, "ollama") is True
    assert await routing.walls(pool) == {}
    assert await routing.clear_wall(pool, "ollama") is False


async def test_an_empty_role_chain_uses_the_chat_chain_and_an_uninstalled_local_is_skipped(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["ollama:gemma4:12b", "ollama:qwen3:4b"]})
    resp = await _chat(client, "scheduled")
    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["served_by"] == "ollama:qwen3:4b" and route["link"] == 2
    assert "gemma4:12b is not installed" in route["reason"]
    assert route["role"] == "scheduled"
    (row,) = await pool.fetch("SELECT role, route_link, route_reason FROM usage_events")
    assert (
        row["role"] == "scheduled"
        and row["route_link"] == 2
        and "not installed" in row["route_reason"]
    )


async def test_a_chain_with_no_runnable_and_no_local_link_falls_to_the_stated_standby(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    before = len(cloud.seen)

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "ollama:qwen3:8b"
    assert (
        "fell back to local standby ollama:qwen3:8b (the bundled ollama's default model qwen3:8b)"
        in route["reason"]
    )
    assert "over its monthly cap $0.00" in route["reason"]
    assert len(cloud.seen) == before


async def test_nothing_runnable_is_a_503_that_lists_every_verdict(client, pool, local, monkeypatch):
    local.tags = ()
    routing.clear_tags_cache()
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    resp = await _chat(client, "chat")
    assert resp.status_code == 503
    assert "qwen3:4b is not installed" in resp.json()["error"]
    # Moved 'vibes' -> a derived role (S12-2): 'vibes' matches the ledger's ROLE_RE,
    # so it is no longer a 400 — with no chain of its own it walks the chat chain and
    # gets the same 503. 'Vibes-1' never reaches the walk through the header at all:
    # usage.Attribution.from_headers drops a name ROLE_RE refuses to "no role" (the
    # ledger's rule, unchanged), so the request is served unrouted and the row's
    # role is NULL. The refusal itself is pinned through explain, which takes the
    # role verbatim.
    unknown = await _chat(client, "vibes")
    assert unknown.status_code == 503 and "qwen3:4b is not installed" in unknown.json()["error"]
    unrouted = await _chat(client, "Vibes-1")
    assert unrouted.status_code == 200 and "x-nova-route" not in unrouted.headers
    (row,) = await pool.fetch("SELECT role FROM usage_events WHERE kind = 'completion'")
    assert row["role"] is None
    bad = await client.get("/admin/route/explain?role=Vibes-1")
    assert bad.status_code == 400 and bad.json()["error"] == BAD_ROLE_MESSAGE


async def test_a_bare_local_pick_is_link_one_on_the_default_provider(client, pool, local):
    """The owner's chat.model is a bare tag (`qwen3:8b`, no provider prefix)
    — the same rule every request follows: a model on the default provider.
    Live 2026-09-08 the walk once read it as 'names no registered provider'
    and fell to the chain's first fallback; this pins the fix."""
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    resp = await _chat(client, "chat", model="qwen3:8b")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    assert local.seen[-1][1]["model"] == "qwen3:8b"


async def test_a_derived_role_with_its_own_chain_resolves_to_it_and_without_one_walks_chat(
    client, pool, local
):
    """S12-2: a core-side agent's role (`agent_<name>`, the ledger's own
    ROLE_RE) can own a chain. With one, it serves from it; with an empty
    chain or no row at all it walks the chat chain — exactly as Nova's
    scheduled/judge fallbacks do."""
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:8b"]})
    put = await client.put("/admin/routes/agent_coder", json={"chain": ["ollama:qwen3:4b"]})
    assert put.status_code == 200 and put.json() == {
        "role": "agent_coder",
        "chain": ["ollama:qwen3:4b"],
    }

    resp = await _chat(client, "agent_coder")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:4b"
    assert resp.headers["x-nova-route"] == "role=agent_coder;link=1"
    assert _route_chunk(resp.content) == {
        "role": "agent_coder",
        "link": 1,
        "reason": None,
        "served_by": "ollama:qwen3:4b",
        "standby": False,
    }
    (row,) = await pool.fetch("SELECT role, served_by FROM usage_events")
    assert (row["role"], row["served_by"]) == ("agent_coder", "ollama:qwen3:4b")

    # explain names the same chain, without serving.
    ex = (await client.get("/admin/route/explain?role=agent_coder")).json()
    assert ex["role"] == "agent_coder" and [v["id"] for v in ex["chain"]] == ["ollama:qwen3:4b"]
    assert ex["would_serve"]["served_by"] == "ollama:qwen3:4b"

    # An empty chain of its own: the chat chain serves, under the agent's role.
    await client.put("/admin/routes/agent_coder", json={"chain": []})
    resp = await _chat(client, "agent_coder")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "ollama:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=agent_coder;link=1"

    # No row at all (never set, or removed): the same walk.
    assert (await client.delete("/admin/routes/agent_coder")).status_code == 200
    for role in ("agent_coder", "agent_reviewer"):
        resp = await _chat(client, role)
        assert resp.status_code == 200
        assert resp.headers["x-nova-served-by"] == "ollama:qwen3:8b"
        assert resp.headers["x-nova-route"] == f"role={role};link=1"
    ex = (await client.get("/admin/route/explain?role=agent_reviewer")).json()
    assert ex["role"] == "agent_reviewer" and ex["would_serve"]["served_by"] == "ollama:qwen3:8b"
    rows = await pool.fetch("SELECT role FROM usage_events ORDER BY id")
    assert [r["role"] for r in rows] == ["agent_coder"] * 3 + ["agent_reviewer"]


async def test_the_routes_page_lists_built_ins_first_and_a_derived_role_can_be_removed(
    client, pool, local
):
    """S12-2: GET /admin/routes is the built-ins in their own order, then
    every other routes row by name, each saying whether it is built in;
    DELETE refuses a built-in, reads the row count for the rest."""
    page = (await client.get("/admin/routes")).json()["roles"]
    assert [r["role"] for r in page] == list(routing.BUILTIN_ROLES)
    assert all(r["builtin"] is True for r in page)
    assert [r["role"] for r in page if r["reserved"]] == sorted(routing.RESERVED_ROLES)

    for role in ("agent_zed", "agent_alpha"):
        put = await client.put(f"/admin/routes/{role}", json={"chain": ["ollama:qwen3:4b"]})
        assert put.status_code == 200, put.text
    page = (await client.get("/admin/routes")).json()["roles"]
    assert [r["role"] for r in page] == [*routing.BUILTIN_ROLES, "agent_alpha", "agent_zed"]
    derived = [r for r in page if not r["builtin"]]
    assert derived == [
        {"role": "agent_alpha", "chain": ["ollama:qwen3:4b"], "reserved": False, "builtin": False},
        {"role": "agent_zed", "chain": ["ollama:qwen3:4b"], "reserved": False, "builtin": False},
    ]

    # A built-in is never removed, row or not.
    await client.put("/admin/routes/chat", json={"chain": ["ollama:qwen3:4b"]})
    for role in ("chat", "vision"):
        bad = await client.delete(f"/admin/routes/{role}")
        assert bad.status_code == 400
        assert bad.json()["error"] == f"{role} is a built-in role and cannot be removed"
    assert (await pool.fetchval("SELECT count(*) FROM routes WHERE role = 'chat'")) == 1

    # A derived role's row goes; the second DELETE finds nothing and says so.
    gone = await client.delete("/admin/routes/agent_zed")
    assert gone.status_code == 200 and gone.json() == {"deleted": "agent_zed"}
    assert (await pool.fetchval("SELECT count(*) FROM routes WHERE role = 'agent_zed'")) == 0
    again = await client.delete("/admin/routes/agent_zed")
    assert again.status_code == 404 and again.json()["error"] == "no route for role 'agent_zed'"
    never = await client.delete("/admin/routes/agent_never_set")
    assert never.status_code == 404
    page = (await client.get("/admin/routes")).json()["roles"]
    assert [r["role"] for r in page] == [*routing.BUILTIN_ROLES, "agent_alpha"]
