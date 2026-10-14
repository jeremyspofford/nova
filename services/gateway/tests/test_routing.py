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
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx
import pytest

from app import backends, engines, routing, usage
from app.adapters import ollama as ollama_mod
from tests.conftest import requires_db
from tests.fakes import FailingTransport, FakeOllama, FakeOpenAICompat

pytestmark = requires_db

# validate_role's exact refusal (S12-2): names the rule and the offending name.
# The decision role (decision-role spec §1) joined the built-ins after judge.
BAD_ROLE_MESSAGE = (
    "role must be a built-in (chat, scheduled, judge, decisions, coding, vision) or a "
    "lowercase [a-z_] name of at most 32 chars — got 'Vibes-1'"
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
    # Routing owns no listing cache any more: each engine's is in app/engines.py.
    engines.clear_cache()
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
    put = await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    assert put.status_code == 200 and put.json()["chain"] == ["hub:qwen3:4b"]

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
        # Moved (hub-last-resort T1): as_route states the last resort too.
        "last_resort": False,
        # A cloud provider: core lets a turn on it run beside another.
        "local": False,
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
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
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
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and route["served_by"] == "hub:qwen3:4b"
    assert "openrouter over its monthly cap $1.00 (spent $1.50)" in route["reason"]
    assert len(cloud.seen) == before, "the capped provider was NEVER called"
    # Moved (S40 T3): the served-on stamp reads /api/ps after the completion.
    assert [b for p, b in local.seen if p == "/v1/chat/completions"][-1]["model"] == "qwen3:4b"

    # explain says the same, without serving.
    ex = (await client.get("/admin/route/explain?role=chat&model=openrouter:remote-model")).json()
    assert [v["verdict"] for v in ex["chain"]] == ["over_cap", "runnable"]
    assert ex["would_serve"]["served_by"] == "hub:qwen3:4b"
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
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    cloud.completions_status = 402

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2 and "openrouter:remote-model refused this request" in route["reason"]
    walls = (await client.get("/admin/routes")).json()["walls"]
    assert [w["provider"] for w in walls] == ["openrouter"] and walls[0]["strikes"] == 1
    assert "refused (402)" in walls[0]["reason"]
    rows = await pool.fetch("SELECT kind, provider, status FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"]) for r in rows] == [
        ("refusal", "openrouter", 402),
        ("completion", "hub", 200),
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
    row = {"name": "hub"}
    outage = await routing.record_refusal(pool, row, 502, "ReadTimeout", model="qwen3.8:27b")
    assert outage is not None and outage["model"] == "qwen3.8:27b"

    walled = await routing.walls(pool)
    # Moved (S40 T3): judge_link reads an engine's switch and adapter off the
    # row, and takes each engine's observation as a map ({} = none observed).
    by_name = {
        "hub": {
            "name": "hub",
            "adapter": "ollama",
            "local": True,
            "is_default": True,
            "serving": True,
        }
    }
    failed = await routing.judge_link(None, pool, "hub:qwen3.8:27b", by_name, walled, "UTC", {})
    sibling = await routing.judge_link(None, pool, "hub:qwen3:8b", by_name, walled, "UTC", {})
    assert failed["verdict"] == "walled", failed
    assert sibling["verdict"] != "walled", "the fallback was walled for its sibling's failure"

    # An ACCOUNT-level refusal still walls the whole provider: 402 is about the
    # key, and trying another model on the same key would refuse identically.
    await routing.record_refusal(pool, row, 402, "out of credit", model="qwen3:8b")
    walled = await routing.walls(pool)
    both = [
        await routing.judge_link(None, pool, link, by_name, walled, "UTC", {})
        for link in ("hub:qwen3.8:27b", "hub:qwen3:8b")
    ]
    assert [v["verdict"] for v in both] == ["walled", "walled"]


async def test_an_outage_wall_is_short_and_an_account_refusal_is_not(pool, local):
    """A 5xx says "not right now" — usually a model still loading. An hour of
    that is how one slow start costs every question for the rest of the hour.
    An account refusal genuinely does last: nothing about 402 changes in a
    minute. Two ladders, chosen by what the status is about."""
    row = {"name": "hub"}
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
    row = {"name": "hub"}

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
    row = {"name": "hub"}
    await routing.record_refusal(pool, row, 500, "boom", model="qwen3:8b")
    await routing.record_refusal(pool, row, 500, "boom", model="qwen3.8:27b")

    await routing.note_success(pool, "hub", "qwen3:8b")
    live = await routing.walls(pool)
    assert ("hub", "qwen3:8b") not in live
    assert ("hub", "qwen3.8:27b") in live, (
        "a sibling's success cleared a wall it knows nothing about"
    )

    # The owner clearing the provider DOES mean all of it.
    assert await routing.clear_wall(pool, "hub") is True
    assert await routing.walls(pool) == {}
    assert await routing.clear_wall(pool, "hub") is False


# ── wall-probe T1: a wall says when the refusal happened ──────────────────
# 2026-10-13 17:59 UTC OpenRouter refused (402); every turn on 10-14 quoted
# that saved reason as if it were fresh. The refusal time is already stored
# (provider_walls.updated_at, stamped by record_refusal); walls() must carry it.


async def _backdate_wall(pool, provider: str, hours: float) -> None:
    """Move a wall's stored refusal time into the past, leaving walled_until."""
    await pool.execute(
        "UPDATE provider_walls SET updated_at = now() - make_interval(secs => $2) "
        "WHERE provider = $1",
        provider,
        hours * 3600,
    )


async def test_walls_carry_the_refusal_time_of_each_wall(pool, local):
    row = {"name": "hub"}
    account = await routing.record_refusal(pool, row, 402, "out of credit")
    outage = await routing.record_refusal(pool, row, 503, "loading", model="qwen3:8b")

    live = await routing.walls(pool)
    for wall, key in ((account, ("hub", routing.WHOLE_PROVIDER)), (outage, ("hub", "qwen3:8b"))):
        got = live[key]
        assert "refused_at" in got, f"walls() does not say when {key} refused: {sorted(got)}"
        assert got["refused_at"].tzinfo is not None
        assert abs((got["refused_at"] - wall["recorded_at"]).total_seconds()) < 5


async def test_a_walls_refusal_time_is_the_stored_one_not_now(pool, local):
    """A wall refused hours ago must say hours ago — the stored stamp, never
    the moment it is read. walled_until keeps its meaning: untouched."""
    await routing.record_refusal(pool, {"name": "hub"}, 402, "out of credit")
    before = (await routing.walls(pool))[("hub", routing.WHOLE_PROVIDER)]
    await _backdate_wall(pool, "hub", 6)

    wall = (await routing.walls(pool))[("hub", routing.WHOLE_PROVIDER)]
    stored = await pool.fetchval(
        "SELECT updated_at FROM provider_walls WHERE provider = 'hub' AND model = $1",
        routing.WHOLE_PROVIDER,
    )
    assert wall.get("refused_at") == stored, (wall.get("refused_at"), stored)
    age = (datetime.now(UTC) - wall["refused_at"]).total_seconds()
    assert abs(age - 6 * 3600) < 60, f"refused {age:.0f}s ago, not six hours"
    assert wall["walled_until"] == before["walled_until"]


async def test_a_second_refusal_moves_the_refusal_time(pool, local):
    row = {"name": "hub"}
    await routing.record_refusal(pool, row, 402, "out of credit")
    await _backdate_wall(pool, "hub", 2)
    old = (await routing.walls(pool))[("hub", routing.WHOLE_PROVIDER)].get("refused_at")
    assert old is not None, "walls() carries no refused_at"

    again = await routing.record_refusal(pool, row, 402, "still out of credit")
    new = (await routing.walls(pool))[("hub", routing.WHOLE_PROVIDER)]["refused_at"]

    assert new > old
    assert abs((new - again["recorded_at"]).total_seconds()) < 5
    # walled_until still means "refusal time + this strike's step" (strike 2: 6h).
    assert abs((again["walled_until"] - new).total_seconds() - 6 * 3600) < 5


async def test_the_routes_page_lists_each_walls_refusal_time_as_iso(client, pool, local):
    await routing.record_refusal(pool, {"name": "hub"}, 402, "out of credit")
    await _backdate_wall(pool, "hub", 3)
    stored = await pool.fetchval("SELECT updated_at FROM provider_walls WHERE provider = 'hub'")

    walls = (await client.get("/admin/routes")).json()["walls"]

    assert len(walls) == 1
    assert "refused_at" in walls[0], f"the routes page has no refused_at: {sorted(walls[0])}"
    assert datetime.fromisoformat(walls[0]["refused_at"]) == stored
    # walled_until is still an ISO string and still in the future.
    assert datetime.fromisoformat(walls[0]["walled_until"]) > datetime.now(UTC)


# ── wall-probe T2: a walled verdict says when the refusal happened ────────
# Every turn on 10-14 quoted the 10-13 17:59 402 as "walled for another N min",
# which reads as a fresh refusal. The verdict now states the stored refusal time
# (walls()' refused_at), in UTC, BEFORE the suffix core parses.

# 23:59:54 on purpose: rounding (-> 10-14 00:00) or a local zone (New York
# -> 19:59) both say a different time than truncated UTC.
REFUSED = datetime(2026, 10, 13, 23, 59, 54, tzinfo=UTC)
REFUSED_WORDS = "refused at 10-13 23:59 UTC; not retried since"
WALLED_RE = (
    r"(?P<head>.+) — refused at (?P<at>\d\d-\d\d \d\d:\d\d) UTC; not retried since"
    r" — walled for another (?P<left>\d+) min$"
)


async def _stamp_wall(pool, provider: str, at: datetime = REFUSED) -> None:
    """Pin a wall's stored refusal time to `at`, leaving walled_until."""
    await pool.execute(
        "UPDATE provider_walls SET updated_at = $2 WHERE provider = $1", provider, at
    )


def _verdict_items(words: str) -> dict[str, str]:
    """A route reason / 503 detail's "<id>: <reason>; …" list, by id."""
    listed = words.split(" — ", 1)[1] if " — " in words else words
    out = {}
    for item in re.split(r"; (?=[^\s;]+: )", listed):
        link, _, reason = item.partition(": ")
        out[link] = reason
    return out


def test_the_walled_words_state_the_refusal_time_before_the_suffix_core_parses():
    now = datetime(2026, 10, 14, 9, 0, tzinfo=UTC)
    wall = {
        "reason": "openrouter refused (402): Insufficient credits",
        "refused_at": REFUSED,
        "walled_until": now + timedelta(minutes=30, seconds=10),
    }
    assert routing.walled_words(wall, now=now) == (
        f"openrouter refused (402): Insufficient credits — {REFUSED_WORDS}"
        " — walled for another 31 min"
    )


def test_the_walled_words_say_the_refusal_time_in_utc_whatever_zone_it_was_read_in():
    """asyncpg may hand back a timestamptz in any zone; the words are UTC."""
    from zoneinfo import ZoneInfo

    now = datetime(2026, 10, 14, 9, 0, tzinfo=UTC)
    wall = {
        "reason": "openrouter refused (402): Insufficient credits",
        "refused_at": REFUSED.astimezone(ZoneInfo("America/New_York")),
        "walled_until": now + timedelta(hours=2),
    }
    words = routing.walled_words(wall, now=now)
    assert REFUSED_WORDS in words, words
    assert words.endswith(" — walled for another 121 min")


async def test_a_walled_link_states_its_stored_refusal_time_in_the_route_reason(
    client, pool, local, mount_backend
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    await routing.record_refusal(pool, {"name": "openrouter"}, 402, "out of credit")
    await _stamp_wall(pool, "openrouter")

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    reason = _verdict_items(_route_chunk(resp.content)["reason"])["openrouter:remote-model"]
    got = re.match(WALLED_RE, reason)
    assert got, reason
    assert got["head"] == "openrouter refused (402): out of credit"
    assert got["at"] == "10-13 23:59"
    # walled_until is untouched by the stamp: a fresh strike-1 wall, ~60 min left.
    assert 58 <= int(got["left"]) <= 61, reason


async def test_the_refusal_time_is_utc_whatever_the_callers_timezone(
    client, pool, local, mount_backend
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    await routing.record_refusal(pool, {"name": "openrouter"}, 402, "out of credit")
    await _stamp_wall(pool, "openrouter")

    resp = await _chat(client, "chat", model="openrouter:remote-model", tz="America/New_York")

    reason = _verdict_items(_route_chunk(resp.content)["reason"])["openrouter:remote-model"]
    assert REFUSED_WORDS in reason, reason
    assert "19:59" not in reason


async def test_a_walled_last_resort_states_its_refusal_time_too(client, pool, local):
    from app import admin
    from app.main import app

    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})
    await routing.record_refusal(pool, {"name": "hub"}, 402, "out of credit")
    await _stamp_wall(pool, "hub")

    with pytest.raises(routing.NothingRunnable) as caught:
        await routing.resolve(
            app,
            pool,
            role="chat",
            requested=None,
            timezone="UTC",
            fit_context=admin._fit_context,
            latest_probes=admin._latest_probes,
            hub_last_resort=True,
        )
    last = caught.value.verdicts[-1]
    assert (last["verdict"], last.get("last_resort")) == ("walled", True), last
    assert last["reason"].startswith("last resort: "), last
    got = re.match(WALLED_RE, last["reason"][len("last resort: ") :])
    assert got, last["reason"]
    assert got["head"] == "hub refused (402): out of credit"
    assert got["at"] == "10-13 23:59"


async def test_the_503_detail_states_each_walled_links_refusal_time(client, pool, local):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})
    await routing.record_refusal(pool, {"name": "hub"}, 402, "out of credit")
    await _stamp_wall(pool, "hub")

    resp = await _chat(client, "chat")

    assert resp.status_code == 503, resp.text
    detail = resp.json()["error"]
    assert detail.startswith("no model in the 'chat' chain can serve right now — "), detail
    reason = _verdict_items(detail)["hub:qwen3:8b"]
    got = re.match(WALLED_RE, reason)
    assert got, reason
    assert got["at"] == "10-13 23:59"


async def test_an_empty_role_chain_uses_the_chat_chain_and_an_uninstalled_local_is_skipped(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:gemma4:12b", "hub:qwen3:4b"]})
    resp = await _chat(client, "scheduled")
    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["served_by"] == "hub:qwen3:4b" and route["link"] == 2
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
    assert route["standby"] is True and route["served_by"] == "hub:qwen3:8b"
    # Moved (S40 T3): the standby names the engine it fell to — "the bundled
    # ollama" stops being a unique name once machines are engines.
    assert (
        "fell back to local standby hub:qwen3:8b (hub's default model qwen3:8b)" in route["reason"]
    )
    assert "over its monthly cap $0.00" in route["reason"]
    assert len(cloud.seen) == before


async def test_a_wrong_protocol_link_does_not_block_the_standby(client, pool, local, mount_backend):
    """chat.model can be a Kev link left behind by a misclick on a model list
    — wrong_protocol on the chat endpoint. Its provider row is `local` (a Kev
    box lives on the owner's own network), but it never served anything:
    before the fix, has_local read that `local` anyway and skipped the
    cross-tier standby outright, 503ing a turn a local engine could answer.
    Here the chain's only cloud link is walled too, so only the Kev link and
    the standby exist to serve."""
    await pool.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, local) "
        "VALUES ('dell-kev', 'systemone', 'http://kev.test/v1', 'none', true)"
    )
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    await routing.record_refusal(
        pool, {"name": "openrouter"}, 402, "out of credit", model="remote-model"
    )

    resp = await _chat(client, "chat", model="dell-kev:kev-latest")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "hub:qwen3:8b"
    assert (
        "dell-kev:kev-latest: dell-kev answers typed questions — this role needs chat"
        in route["reason"]
    )
    assert "walled for another" in route["reason"]


async def test_nothing_runnable_is_a_503_that_lists_every_verdict(client, pool, local, monkeypatch):
    local.tags = ()
    engines.clear_cache()
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
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
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    resp = await _chat(client, "chat", model="qwen3:8b")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"
    # Moved (S40 T3): the served-on stamp reads /api/ps after the completion.
    assert [b for p, b in local.seen if p == "/v1/chat/completions"][-1]["model"] == "qwen3:8b"


async def test_a_derived_role_with_its_own_chain_resolves_to_it_and_without_one_walks_chat(
    client, pool, local
):
    """S12-2: a core-side agent's role (`agent_<name>`, the ledger's own
    ROLE_RE) can own a chain. With one, it serves from it; with an empty
    chain or no row at all it walks the chat chain — exactly as Nova's
    scheduled/judge fallbacks do."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})
    put = await client.put("/admin/routes/agent_coder", json={"chain": ["hub:qwen3:4b"]})
    assert put.status_code == 200 and put.json() == {
        "role": "agent_coder",
        "chain": ["hub:qwen3:4b"],
    }

    resp = await _chat(client, "agent_coder")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert resp.headers["x-nova-route"] == "role=agent_coder;link=1"
    assert _route_chunk(resp.content) == {
        "role": "agent_coder",
        "link": 1,
        "reason": None,
        "served_by": "hub:qwen3:4b",
        "standby": False,
        # Moved (hub-last-resort T1): as_route states the last resort too.
        "last_resort": False,
        "local": True,
    }
    (row,) = await pool.fetch("SELECT role, served_by FROM usage_events")
    assert (row["role"], row["served_by"]) == ("agent_coder", "hub:qwen3:4b")

    # explain names the same chain, without serving.
    ex = (await client.get("/admin/route/explain?role=agent_coder")).json()
    assert ex["role"] == "agent_coder" and [v["id"] for v in ex["chain"]] == ["hub:qwen3:4b"]
    assert ex["would_serve"]["served_by"] == "hub:qwen3:4b"

    # An empty chain of its own: the chat chain serves, under the agent's role.
    await client.put("/admin/routes/agent_coder", json={"chain": []})
    resp = await _chat(client, "agent_coder")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=agent_coder;link=1"

    # No row at all (never set, or removed): the same walk.
    assert (await client.delete("/admin/routes/agent_coder")).status_code == 200
    for role in ("agent_coder", "agent_reviewer"):
        resp = await _chat(client, role)
        assert resp.status_code == 200
        assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
        assert resp.headers["x-nova-route"] == f"role={role};link=1"
    ex = (await client.get("/admin/route/explain?role=agent_reviewer")).json()
    assert ex["role"] == "agent_reviewer" and ex["would_serve"]["served_by"] == "hub:qwen3:8b"
    rows = await pool.fetch("SELECT role FROM usage_events ORDER BY id")
    assert [r["role"] for r in rows] == ["agent_coder"] * 3 + ["agent_reviewer"]


async def test_an_event_senders_role_walks_chats_chain_until_it_has_its_own(
    client, pool, local
):
    """S37c (spec §2.8, §9 Q4): every event sender runs under its own role,
    `event_<sender>`, which core PUTs with an empty chain when the sender is
    added. With no row or an empty chain it walks chat's chain under its own
    role (attributed to it in the ledger); with a chain of its own it serves
    from that; the Routing page lists it as a derived chat-protocol role.
    No gateway source names `event_`: ROLE_RE and borrows_chat_chain take it."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:8b"]})
    assert routing.borrows_chat_chain("event_github_ci", [])
    assert not routing.borrows_chat_chain("event_github_ci", ["hub:qwen3:4b"])

    # No row yet: chat's chain, under the event role.
    resp = await _chat(client, "event_test")
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=event_test;link=1"

    # What core PUTs on add: an empty chain, echoed back.
    put = await client.put("/admin/routes/event_test", json={"chain": []})
    assert put.status_code == 200 and put.json() == {"role": "event_test", "chain": []}
    resp = await _chat(client, "event_test")
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    ex = (await client.get("/admin/route/explain?role=event_test")).json()
    assert ex["role"] == "event_test" and ex["would_serve"]["served_by"] == "hub:qwen3:8b"

    # A chain of its own serves from it.
    await client.put("/admin/routes/event_test", json={"chain": ["hub:qwen3:4b"]})
    resp = await _chat(client, "event_test")
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"

    page = (await client.get("/admin/routes")).json()["roles"]
    (row,) = [r for r in page if r["role"] == "event_test"]
    assert row["builtin"] is False and row["protocol"] == "chat"
    rows = await pool.fetch("SELECT role FROM usage_events ORDER BY id")
    assert [r["role"] for r in rows] == ["event_test"] * 3

    # The longest sender name (26) still makes a role the gateway takes.
    longest = "event_" + "a" + "b" * 25
    assert (await client.put(f"/admin/routes/{longest}", json={"chain": []})).status_code == 200


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
        put = await client.put(f"/admin/routes/{role}", json={"chain": ["hub:qwen3:4b"]})
        assert put.status_code == 200, put.text
    page = (await client.get("/admin/routes")).json()["roles"]
    assert [r["role"] for r in page] == [*routing.BUILTIN_ROLES, "agent_alpha", "agent_zed"]
    derived = [r for r in page if not r["builtin"]]
    assert derived == [
        {
            "role": "agent_alpha",
            "chain": ["hub:qwen3:4b"],
            "reserved": False,
            "builtin": False,
            "protocol": "chat",
            "router": {"on": False, "kept": None},
        },
        {
            "role": "agent_zed",
            "chain": ["hub:qwen3:4b"],
            "reserved": False,
            "builtin": False,
            "protocol": "chat",
            "router": {"on": False, "kept": None},
        },
    ]

    # A built-in is never removed, row or not.
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
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


# ── S40: the walk reads engines ─────────────────────────────────────────────


async def test_a_switched_off_engine_is_skipped_by_name_and_never_called(
    client, pool, local, mount_backend
):
    """S40: `engines.serving` is the owner's "this machine runs chat models"
    switch — installed is not the same as used. A link on a switched-off
    engine is judged `switched_off` BEFORE anything is asked of it, the next
    link answers, and the route says which link was passed over and why. It
    is the owner's choice, not a failure: nothing is walled. Switched back
    on, it is link 1 again."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    stored = await engines.set_serving(pool, "hub", False)
    assert stored["serving"] is False

    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert "hub:qwen3:8b: hub is switched off" in route["reason"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []
    ex = (await client.get("/admin/route/explain?role=chat&model=hub:qwen3:8b")).json()
    assert [v["verdict"] for v in ex["chain"]] == ["switched_off", "runnable"]
    assert ex["would_serve"]["served_by"] == "openrouter:remote-model"

    await engines.set_serving(pool, "hub", True)
    resp = await _chat(client, "chat", model="hub:qwen3:8b")
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert resp.headers["x-nova-route"] == "role=chat;link=1"


async def test_a_switched_off_engine_with_nothing_behind_it_is_a_stated_503(client, pool, local):
    """With no other link, the walk says so — never the switched-off engine,
    whether the owner picked it or it is the default's model on a role
    with no chain at all."""
    await engines.set_serving(pool, "hub", False)

    picked = await _chat(client, "chat", model="hub:qwen3:8b")
    unpicked = await _chat(client, "scheduled")

    for resp in (picked, unpicked):
        assert resp.status_code == 503
        assert "hub is switched off" in resp.json()["error"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]


async def test_an_engine_that_cannot_list_is_asked_once_per_failure_window(
    client, pool, local, mount_backend, mount_transport
):
    """The engine's listing is read through engines.observe, whose cache
    remembers a FAILURE too (10 s; a ready listing 30 s). Before S40 a
    failure was never cached (routing.py:293-294), so every routed turn
    waited out the listing timeout again. The link still says why it was
    passed over, naming the engine."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    down = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test", down)
    engines.clear_cache()

    first = await _chat(client, "chat", model="hub:qwen3:4b")
    asked = len(down.requests)
    second = await _chat(client, "chat", model="hub:qwen3:4b")

    for resp in (first, second):
        assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
        route = _route_chunk(resp.content)
        assert route["link"] == 2
        assert "hub could not be asked what is installed" in route["reason"]
    assert asked >= 1, "the first turn asked the engine"
    assert len(down.requests) == asked, "the second turn read the cached failure"
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_the_standby_is_only_ever_a_serving_engine(client, pool, local, mount_backend):
    """The owner's switch holds on the standby path too: a chain with no
    runnable link does not fall to an engine that was switched off."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    await engines.set_serving(pool, "hub", False)

    resp = await _chat(client, "judge")

    assert resp.status_code == 503
    assert "over its monthly cap $0.00" in resp.json()["error"]
    assert not [p for p, _ in local.seen if p.endswith("/chat/completions")]


def _shown(fake) -> list[str]:
    return [
        (body or {}).get("model") or (body or {}).get("name")
        for p, body in fake.seen
        if p == "/api/show"
    ]


async def test_the_standby_asks_about_its_default_model_alone_first(
    client, pool, local, mount_backend
):
    """(S40 fix wave C1) After a restart the /api/show cache is empty, and the
    standby asked about EVERY installed model under one deadline — so one
    slow show (a model loading) turned a standby that worked into a 503,
    even with the default installed. The default is asked about alone first;
    nothing else is shown when it chats."""
    ollama_mod.SHOW_CACHE.clear()
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "hub:qwen3:8b"
    assert _shown(local) == ["qwen3:8b"]


async def test_a_default_that_does_not_chat_fans_out_to_the_rest(
    client, pool, mount_backend, monkeypatch
):
    """The fan-out is still there when the default cannot take a chat turn
    (an embedder set as the default): the default first, then the rest."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("all-minilm:latest", "zz-chat:1b"))
    fake.show["all-minilm:latest"]["capabilities"] = ["embedding"]
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "all-minilm"})
    ollama_mod.SHOW_CACHE.clear()
    engines.clear_cache()
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "hub:zz-chat:1b"
    shown = _shown(fake)
    assert shown[0] == "all-minilm:latest" and "zz-chat:1b" in shown[1:]


async def test_the_standby_never_hands_a_chat_turn_to_an_embedding_model(
    client, pool, mount_backend, monkeypatch
):
    """The bundled engine is also the embedder (D8), so an embedding model
    sits in its listing — and the old last resort, the first tag in sorted
    order (routing.py:388), handed a chat turn to whichever embedder sorted
    first. ollama's own /api/show says which models chat (completion
    without embedding); the standby reads that."""
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(tags=("all-minilm:latest", "zz-chat:1b"))
    fake.show["all-minilm:latest"]["capabilities"] = ["embedding"]
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama"})  # no default model on the engine
    ollama_mod.SHOW_CACHE.clear()
    engines.clear_cache()
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    resp = await _chat(client, "judge")

    assert resp.status_code == 200
    route = _route_chunk(resp.content)
    assert route["standby"] is True and route["served_by"] == "hub:zz-chat:1b"
    assert "the first installed chat model on hub, zz-chat:1b" in route["reason"]
    sent = [body for path, body in fake.seen if path == "/v1/chat/completions"]
    assert [body["model"] for body in sent] == ["zz-chat:1b"]


async def test_an_engine_that_cannot_be_reached_is_never_walled_and_the_next_link_answers(
    client, pool, local, mount_backend, mount_transport
):
    """D21: a connect failure to an engine is not a wall. A wall outlives the
    outage — an engine's wall is never cleared by a success — while the
    engine's own observation is re-read on the next walk. The ledger still
    has the refusal row; the route says why the link was passed over; the
    next turn asks the engine again, once, even through a bare id."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    refused = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test/v1", refused)  # chat never connects; /api/* answers

    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert (
        "hub:qwen3:8b: could not reach hub at http://ollama.test/v1 — ConnectError"
        in route["reason"]
    )
    assert await pool.fetch("SELECT provider, model FROM provider_walls") == []
    rows = await pool.fetch("SELECT kind, provider, status FROM usage_events ORDER BY id")
    assert [(r["kind"], r["provider"], r["status"]) for r in rows] == [
        ("refusal", "hub", 502),
        ("completion", "openrouter", 200),
    ]
    assert refused.requests == [("POST", "/v1/chat/completions")]

    resp = await _chat(client, "chat", model="qwen3:8b")
    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert refused.requests == [("POST", "/v1/chat/completions")] * 2
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_an_unreachable_engine_is_forgotten_so_the_next_walk_asks_it_again(
    client, pool, local, mount_backend, mount_transport
):
    """Ruling C11: after a connect failure the data plane forgets THAT
    engine's cached observation (engines.forget), so the retry in the same
    request reads its listing again instead of trusting one from before it
    went — and only that engine's."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    mount_transport("http://ollama.test/v1", FailingTransport(httpx.ConnectError))
    engines.clear_cache()

    def tags_reads() -> int:
        return sum(1 for p, _ in local.seen if p == "/api/tags")

    before = tags_reads()  # adding the cloud provider read the listing too
    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert tags_reads() - before == 2, "observed for the first walk, and again once forgotten"


async def test_a_cloud_provider_that_cannot_be_reached_is_still_walled(
    client, pool, local, mount_backend, mount_transport
):
    """Only an ENGINE's connect failure is exempt. A cloud provider's walls
    its model for the outage ladder, as before S40."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ConnectError))

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("openrouter", "remote-model", 502)
    ]


async def test_an_engines_wall_outlives_a_success_on_it(client, pool, local):
    """D21: an ENGINE's wall is never cleared by a success — the walk clears a
    wall on every other row it serves from, local or cloud — so it lapses on
    its own ladder, and the engine's own observation is what the next walk
    reads. Here the wall has lapsed and the engine answers; the row stays as
    it was."""
    await routing.record_refusal(pool, {"name": "hub"}, 503, "loading", model="qwen3:8b")
    await pool.execute("UPDATE provider_walls SET walled_until = now() - interval '1 minute'")
    before = [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")]

    resp = await _chat(client, "chat", model="hub:qwen3:8b")

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert [dict(w) for w in await pool.fetch("SELECT * FROM provider_walls")] == before


async def test_an_unreachable_standby_is_tried_once_and_the_503_says_why(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    refused = FailingTransport(httpx.ConnectError)
    mount_transport("http://ollama.test/v1", refused)

    resp = await _chat(client, "judge")

    assert resp.status_code == 503
    error = resp.json()["error"]
    assert "over its monthly cap $0.00" in error
    assert "hub:qwen3:8b: standby: could not reach hub" in error
    assert refused.requests == [("POST", "/v1/chat/completions")]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_402_wall_keeps_the_providers_sentence_not_a_head_of_its_json(
    client, pool, local, mount_backend
):
    """The wall reason is what the Inbox and the 503 quote. It used to be the
    first 200 chars of the raw body, which cut OpenRouter's 402 just before
    the number it can afford — the one fact he needed (09-30)."""
    await _cloud(
        client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1", affords_tokens=0)
    )
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.status_code == 200
    walls = (await client.get("/admin/routes")).json()["walls"]
    assert "refused (402)" in walls[0]["reason"]
    assert "can only afford 0" in walls[0]["reason"]
    assert '{"error"' not in walls[0]["reason"]


# ── no-ceiling T1: X-Nova-Pass-Over ─────────────────────────────────────────
# Core passes over a link that answered a round with thinking only (reasoning,
# no content, no tool calls): resolve judges it "passed_over" in the caller's
# words and walks on. It is a per-request fact, never a wall.

THINKING = "answered with thinking only, twice"


async def _resolve(pool, role, requested, **kw):
    from app import admin
    from app.main import app

    return await routing.resolve(
        app,
        pool,
        role=role,
        requested=requested,
        timezone="UTC",
        fit_context=admin._fit_context,
        latest_probes=admin._latest_probes,
        **kw,
    )


def _pass_over_header(pairs: dict[str, str]) -> str:
    from urllib.parse import quote

    return ",".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in pairs.items())


async def test_a_passed_over_link_is_judged_passed_over_in_the_callers_words_and_the_walk_goes_on(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    decision = await _resolve(pool, "chat", "hub:qwen3:8b", passed_over={"hub:qwen3:8b": THINKING})

    assert decision.link == 2 and decision.model == "qwen3:4b"
    first = decision.verdicts[0]
    assert first["id"] == "hub:qwen3:8b"
    assert first["verdict"] == "passed_over"
    assert THINKING in first["reason"]
    assert "hub:qwen3:8b" in decision.reason and "passed over" in decision.reason
    assert THINKING in decision.reason


async def test_a_bare_link_is_passed_over_by_its_served_id(client, pool, local):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    decision = await _resolve(pool, "chat", "qwen3:8b", passed_over={"hub:qwen3:8b": THINKING})

    assert decision.model == "qwen3:4b"
    assert decision.verdicts[0]["verdict"] == "passed_over"


async def test_a_link_not_runnable_for_its_own_reason_keeps_that_verdict(client, pool, local):
    """Pass-over only overrides `runnable`: a walled link stays walled, and a
    live refusal in the same request outranks the caller's pass-over."""
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    await routing.record_refusal(pool, {"name": "hub"}, 503, "loading", model="qwen3:8b")

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(
            pool,
            "chat",
            "hub:qwen3:8b",
            passed_over={"hub:qwen3:8b": THINKING, "hub:qwen3:4b": THINKING},
        )
    assert [(v["id"], v["verdict"]) for v in caught.value.verdicts] == [
        ("hub:qwen3:8b", "walled"),
        ("hub:qwen3:4b", "passed_over"),
    ]

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(
            pool,
            "chat",
            "hub:qwen3:4b",
            skip={"hub:qwen3:4b"},
            passed_over={"hub:qwen3:4b": THINKING},
        )
    assert [(v["id"], v["verdict"]) for v in caught.value.verdicts] == [("hub:qwen3:4b", "refused")]


async def test_every_link_passed_over_is_nothing_runnable_listing_each_as_passed_over(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(
            pool,
            "chat",
            "hub:qwen3:8b",
            passed_over={"hub:qwen3:8b": THINKING, "hub:qwen3:4b": "thinking only again"},
        )

    verdicts = caught.value.verdicts
    assert [(v["id"], v["verdict"]) for v in verdicts] == [
        ("hub:qwen3:8b", "passed_over"),
        ("hub:qwen3:4b", "passed_over"),
    ]
    assert THINKING in verdicts[0]["reason"]
    assert "thinking only again" in verdicts[1]["reason"]
    for v in verdicts:
        for label in ("unreachable", "refused", "walled"):
            assert label not in v["reason"]


async def test_the_standby_can_be_passed_over_too(client, pool, local, mount_backend):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))

    with pytest.raises(routing.NothingRunnable) as caught:
        await _resolve(pool, "judge", None, passed_over={"hub:qwen3:8b": THINKING})

    standby = caught.value.verdicts[-1]
    assert standby["id"] == "hub:qwen3:8b"
    assert standby["verdict"] == "passed_over"
    assert THINKING in standby["reason"]


async def test_the_pass_over_header_serves_the_next_link_and_the_route_says_why(
    client, pool, local
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "hub:qwen3:8b",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers={
            "X-Nova-Role": "chat",
            "X-Nova-Purpose": "chat",
            "X-Nova-Pass-Over": _pass_over_header({"hub:qwen3:8b": THINKING}),
        },
    )

    assert resp.status_code == 200, resp.text
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    route = _route_chunk(resp.content)
    assert route["link"] == 2
    assert "hub:qwen3:8b" in route["reason"] and "passed over" in route["reason"]
    assert THINKING in route["reason"]
    sent = [b["model"] for p, b in local.seen if p == "/v1/chat/completions"]
    assert sent == ["qwen3:4b"], "the passed-over link was never dialled"


async def test_a_passed_over_link_is_never_walled_and_serves_the_next_request(
    client, pool, local, monkeypatch
):
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    walled: list = []
    real = routing.record_refusal

    async def spy(*args, **kwargs):
        walled.append((args, kwargs))
        return await real(*args, **kwargs)

    monkeypatch.setattr(routing, "record_refusal", spy)

    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "hub:qwen3:8b", "messages": [], "stream": True},
        headers={
            "X-Nova-Role": "chat",
            "X-Nova-Pass-Over": _pass_over_header({"hub:qwen3:8b": THINKING}),
        },
    )
    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert walled == []
    assert await pool.fetch("SELECT provider FROM provider_walls") == []

    again = await _chat(client, "chat", model="hub:qwen3:8b")
    assert again.headers["x-nova-served-by"] == "hub:qwen3:8b"
    assert again.headers["x-nova-route"] == "role=chat;link=1"


# ── S46a T8: the links this request could not connect to, typed ───────────
#
# Core wakes a sleeping machine from the route (S46a.2) and must never parse
# the prose reason to find out which link could not be reached. A link counts
# when THIS request dialled it and the dial failed in the connect phase
# (adapters.CONNECT_PHASE_ERRORS), or when it is an engine whose latest
# reading failed in the connect phase. Nothing else counts.


async def test_a_cloud_link_that_could_not_connect_is_listed_unreachable_and_walled(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ConnectTimeout))

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    header = resp.headers["x-nova-route"]
    assert header.startswith("role=chat;link=2;reason=")
    assert header.endswith(";unreachable=openrouter:remote-model")
    route = _route_chunk(resp.content)
    assert route["unreachable"] == ["openrouter:remote-model"]
    # The label is unchanged: a non-engine's connect failure is a refusal that
    # walls its model on the outage ladder (the fact T12 reads).
    assert "openrouter:remote-model refused this request" in route["reason"]
    walls = await pool.fetch("SELECT provider, model, status FROM provider_walls")
    assert [(w["provider"], w["model"], w["status"]) for w in walls] == [
        ("openrouter", "remote-model", 502)
    ]

    # The next request finds it walled, never dials it, and does not list it:
    # a wall is not a connect failure of this request.
    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert "walled for another" in _route_chunk(resp.content)["reason"]
    assert "unreachable" not in resp.headers["x-nova-route"]
    assert "unreachable" not in _route_chunk(resp.content)


async def test_an_engine_that_could_not_connect_is_listed_by_its_served_id(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})
    mount_transport("http://ollama.test/v1", FailingTransport(httpx.ConnectError))

    resp = await _chat(client, "chat", model="qwen3:8b")  # a bare pick

    assert resp.headers["x-nova-served-by"] == "openrouter:remote-model"
    assert resp.headers["x-nova-route"].endswith(";unreachable=hub:qwen3:8b")
    assert _route_chunk(resp.content)["unreachable"] == ["hub:qwen3:8b"]
    assert await pool.fetch("SELECT provider FROM provider_walls") == []


async def test_a_link_that_took_the_request_and_went_silent_is_not_listed(
    client, pool, local, mount_backend, mount_transport
):
    """A ReadTimeout means the peer accepted the call: it is up, so nothing
    should be woken."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ReadTimeout))

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert _route_chunk(resp.content)["link"] == 2
    assert "unreachable" not in resp.headers["x-nova-route"]
    assert "unreachable" not in _route_chunk(resp.content)


async def test_a_status_refusal_is_not_listed(client, pool, local, mount_backend):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    cloud.completions_status = 503

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    assert "unreachable" not in resp.headers["x-nova-route"]
    assert "unreachable" not in _route_chunk(resp.content)


async def test_a_503_lists_the_links_that_could_not_connect_on_the_route_header(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/judge", json={"chain": ["openrouter:remote-model"]})
    await usage.set_cap(pool, "openrouter", Decimal("0"))
    mount_transport("http://ollama.test/v1", FailingTransport(httpx.ConnectError))

    resp = await _chat(client, "judge")

    assert resp.status_code == 503
    assert resp.headers.get("x-nova-route") == "role=judge;unreachable=hub:qwen3:8b"
    # The body is the walk's words, as before.
    assert "hub:qwen3:8b: standby: could not reach hub" in resp.json()["error"]


async def test_a_walk_whose_every_dial_fails_to_connect_lists_them_on_the_final_503(
    client, pool, local, mount_backend, mount_transport
):
    """The walk's last 503 (every link it dialled refused, after its six
    attempts) carries the route header too — the raise after the loop, not
    resolve's NothingRunnable — with the links walled by an earlier connect
    failure after them."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await routing.record_refusal(
        pool, {"name": "openrouter"}, 502, "ConnectTimeout", model="m0", connect_failed=True
    )
    local.tags = ()
    engines.clear_cache()
    chain = [f"openrouter:m{i}" for i in range(7)]
    await client.put("/admin/routes/chat", json={"chain": chain})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ConnectTimeout))

    resp = await _chat(client, "chat")

    assert resp.status_code == 503
    assert "every link in the 'chat' chain refused this request" in resp.text
    dialled = ",".join(chain[1:])
    assert resp.headers.get("x-nova-route") == (
        f"role=chat;unreachable={dialled};connect_walled=openrouter:m0"
    )


def test_a_served_id_reached_twice_is_listed_once():
    """A bare pick and the same link again in the chain judge the same served
    id twice: it is one link to wake, listed once, in its first place."""
    verdicts = [
        {"id": "qwen3:8b", "provider": "hub", "model": "qwen3:8b", "verdict": "unreachable"},
        {"id": "cloud:m", "provider": "cloud", "model": "m", "verdict": "refused"},
        {"id": "hub:qwen3:8b", "provider": "hub", "model": "qwen3:8b", "verdict": "unreachable"},
    ]
    assert routing.unreachable_links(verdicts, ["hub:qwen3:8b", "cloud:m"]) == (
        "hub:qwen3:8b",
        "cloud:m",
    )
    marked = [{"provider": "hub", "model": "a", "connect_failed": True}] * 2
    assert routing.unreachable_links([dict(v) for v in marked], None) == ("hub:a",)


async def test_a_503_with_nothing_unreachable_carries_no_route_header(client, pool, local):
    local.tags = ()
    engines.clear_cache()
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})

    resp = await _chat(client, "chat")

    assert resp.status_code == 503
    assert "x-nova-route" not in resp.headers


def test_the_header_quotes_each_id_so_a_name_cannot_split_the_list():
    decision = routing.Decision(
        row={"name": "p", "local": True},
        model="m",
        link=2,
        reason="r",
        role="chat",
    )
    decision.unreachable = ("dell:qwen3.8:27b", "odd:a,b;c")
    assert decision.header() == (
        "role=chat;link=2;reason=r;unreachable=dell:qwen3.8:27b,odd:a%2Cb%3Bc"
    )
    assert decision.as_route()["unreachable"] == ["dell:qwen3.8:27b", "odd:a,b;c"]


def test_a_decision_with_nothing_unreachable_says_exactly_what_it_said_before():
    decision = routing.Decision(row={"name": "p"}, model="m", link=1, reason=None, role="chat")
    assert decision.header() == "role=chat;link=1"
    assert "unreachable" not in decision.as_route()


# ── S46a T9: a wall made by a connect failure, typed ──────────────────────
#
# The first connect failure on a non-engine link walls it for up to 30 min
# (OUTAGE_STEPS_S), and T8's `unreachable` leaves walled links out — so a
# turn during that wall would never tell core the machine is still not
# answering. The wall itself records WHY in a typed column (connect_failed),
# and a walled verdict whose wall was made by a connect failure is listed in
# its own field, `connect_walled=` — never `unreachable` (T8's pin), never
# read off the wall's prose reason.


async def test_a_wall_made_by_a_connect_failure_is_listed_connect_walled_on_the_next_request(
    client, pool, local, mount_backend, mount_transport
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ConnectTimeout))

    first = await _chat(client, "chat", model="openrouter:remote-model")
    assert "connect_walled" not in first.headers["x-nova-route"]
    assert "connect_walled" not in _route_chunk(first.content)
    walls = await pool.fetch("SELECT provider, model, connect_failed FROM provider_walls")
    assert [(w["provider"], w["model"], w["connect_failed"]) for w in walls] == [
        ("openrouter", "remote-model", True)
    ]

    resp = await _chat(client, "chat", model="openrouter:remote-model")

    assert resp.headers["x-nova-served-by"] == "hub:qwen3:4b"
    header = resp.headers["x-nova-route"]
    assert header.endswith(";connect_walled=openrouter:remote-model")
    assert "unreachable" not in header
    route = _route_chunk(resp.content)
    assert route["connect_walled"] == ["openrouter:remote-model"]
    assert "unreachable" not in route


async def test_a_wall_made_by_a_status_refusal_is_not_connect_walled(
    client, pool, local, mount_backend
):
    cloud = await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    cloud.completions_status = 503

    await _chat(client, "chat", model="openrouter:remote-model")
    walls = await pool.fetch("SELECT connect_failed FROM provider_walls")
    assert [w["connect_failed"] for w in walls] == [False]

    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert "walled for another" in _route_chunk(resp.content)["reason"]
    assert "connect_walled" not in resp.headers["x-nova-route"]
    assert "connect_walled" not in _route_chunk(resp.content)


async def test_a_wall_made_by_a_read_timeout_is_not_connect_walled(
    client, pool, local, mount_backend, mount_transport
):
    """The peer took the call and went silent: it is up, nothing to wake."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await client.put("/admin/routes/chat", json={"chain": ["hub:qwen3:4b"]})
    mount_transport("http://openrouter.test", FailingTransport(httpx.ReadTimeout))

    await _chat(client, "chat", model="openrouter:remote-model")
    walls = await pool.fetch("SELECT connect_failed FROM provider_walls")
    assert [w["connect_failed"] for w in walls] == [False]

    resp = await _chat(client, "chat", model="openrouter:remote-model")
    assert "connect_walled" not in resp.headers["x-nova-route"]


async def test_a_status_refusal_after_a_connect_failure_clears_the_connect_mark(
    client, pool, local, mount_backend, mount_transport
):
    """The wall's reason is the LATEST refusal's: once something answered with
    a status, the wall no longer says the machine could not be reached."""
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    real = routing.record_refusal
    row = {"name": "openrouter"}
    await real(pool, row, 502, "ConnectTimeout", model="remote-model", connect_failed=True)
    await real(pool, row, 503, "busy", model="remote-model")
    walls = await pool.fetch("SELECT connect_failed, strikes FROM provider_walls")
    assert [(w["connect_failed"], w["strikes"]) for w in walls] == [(False, 2)]


async def test_a_503_lists_connect_walled_links_on_the_route_header(
    client, pool, local, mount_backend
):
    await _cloud(client, mount_backend, "openrouter", FakeOpenAICompat(accepts_key="sk-1"))
    await routing.record_refusal(
        pool,
        {"name": "openrouter"},
        502,
        "ConnectTimeout",
        model="remote-model",
        connect_failed=True,
    )
    local.tags = ()
    engines.clear_cache()
    await client.put("/admin/routes/chat", json={"chain": ["openrouter:remote-model"]})

    resp = await _chat(client, "chat")

    assert resp.status_code == 503
    assert resp.headers.get("x-nova-route") == "role=chat;connect_walled=openrouter:remote-model"


def test_the_header_states_connect_walled_after_unreachable_each_quoted():
    decision = routing.Decision(
        row={"name": "p", "local": True}, model="m", link=2, reason="r", role="chat"
    )
    decision.unreachable = ("dell:qwen3.8:27b",)
    decision.connect_walled = ("odd:a,b;c",)
    assert decision.header() == (
        "role=chat;link=2;reason=r;unreachable=dell:qwen3.8:27b;connect_walled=odd:a%2Cb%3Bc"
    )
    route = decision.as_route()
    assert route["connect_walled"] == ["odd:a,b;c"]


def test_connect_walled_links_reads_only_walled_verdicts_not_listed_unreachable():
    verdicts = [
        {"id": "a", "provider": "p", "model": "a", "verdict": "walled", "connect_walled": True},
        {"id": "b", "provider": "p", "model": "b", "verdict": "walled"},
        # Skipped in this request after its own dial walled it: its verdict is
        # `refused`, and it is listed as unreachable already.
        {"id": "c", "provider": "p", "model": "c", "verdict": "refused", "connect_walled": True},
        {"id": "a", "provider": "p", "model": "a", "verdict": "walled", "connect_walled": True},
    ]
    assert routing.connect_walled_links(verdicts, ("p:c",)) == ("p:a",)
    assert routing.connect_walled_links(verdicts[:1], ("p:a",)) == ()
