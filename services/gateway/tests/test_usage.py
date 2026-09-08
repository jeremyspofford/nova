"""S10-1: the spend ledger.

Pins: the SSE parser relays every byte and holds back only [DONE]; one
ledger row per completion with the provider's own counts; a refusal is a
row with NULL tokens; a probe is a row; a local call never carries dollars
(the CHECK refuses); unmetered is NULL, never zero; price precedence
provider-reported > owner > listing > curated > nothing; the cache formula;
usage is asked for and a provider that rejects the field is retried once
and remembered; Anthropic's cache counts and breakpoints; the spend
report, caps and owner prices over the admin routes."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from app import backends, providers, usage
from tests.conftest import requires_db
from tests.fakes import FakeAnthropic, FakeOllama, FakeOpenAICompat

pytestmark = requires_db


def _sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


def _frames(body: bytes) -> list:
    out = []
    for block in body.decode().strip().split("\n\n"):
        if block.startswith("data:"):
            payload = block[len("data:") :].strip()
            out.append(payload if payload == "[DONE]" else json.loads(payload))
    return out


async def _rows(pool, **where) -> list[dict]:
    clauses = " AND ".join(f"{k} = ${i + 1}" for i, k in enumerate(where)) or "true"
    rows = await pool.fetch(
        f"SELECT * FROM usage_events WHERE {clauses} ORDER BY id", *where.values()
    )
    return [dict(r) for r in rows]


# ── the parser, pure ─────────────────────────────────────────────────────


def test_parser_relays_every_byte_and_holds_back_only_done():
    p = usage.SseUsageParser()
    first = _sse({"choices": [{"delta": {"content": "Hel"}}]})
    second = _sse({"choices": [{"delta": {"content": "lo"}}]})
    # Bytes arrive in arbitrary pieces; what comes out is byte-identical.
    out = p.feed(first[:5]) + p.feed(first[5:] + second[:3]) + p.feed(second[3:])
    assert out == first + second
    usage_frame = _sse({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 5}})
    assert p.feed(usage_frame) == usage_frame
    assert p.feed(b"data: [DONE]\n\n") == b""  # held
    rest, held = p.finish()
    assert rest == b"" and held == b"data: [DONE]\n\n"
    assert p.captured.prompt_tokens == 12 and p.captured.completion_tokens == 5
    assert p.captured.metered and p.captured.saw_done


def test_parser_reads_openrouters_cost_and_cached_tokens_and_counts_malformed_frames():
    p = usage.SseUsageParser()
    p.feed(
        _sse(
            {
                "choices": [],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 20,
                    "cost": 0.00042,
                    "prompt_tokens_details": {"cached_tokens": 60},
                },
            }
        )
    )
    p.feed(b"data: {not json}\n\n")
    p.feed(_sse({"error": {"message": "quota exceeded"}}))
    c = p.captured
    assert c.cost == Decimal("0.00042") and c.cache_read_tokens == 60
    assert c.malformed == 1 and c.error == "quota exceeded"


def test_parser_never_writes_a_zero_for_a_provider_that_stated_nothing():
    p = usage.SseUsageParser()
    p.feed(_sse({"choices": [{"delta": {"content": "hi"}}]}))
    rest, held = p.finish()
    assert p.captured.prompt_tokens is None and not p.captured.metered


def test_parser_releases_a_held_done_when_the_provider_keeps_talking():
    p = usage.SseUsageParser()
    p.feed(b"data: [DONE]\n\n")
    late = _sse({"choices": [{"delta": {"content": "late"}}]})
    assert p.feed(late) == b"data: [DONE]\n\n" + late


# ── pricing, pure ─────────────────────────────────────────────────────────


def test_cost_from_price_bills_prompt_completion_and_cache_at_their_rates():
    price = usage.Price(
        prompt=Decimal("0.000003"),
        completion=Decimal("0.000015"),
        cache_read=Decimal("0.1"),
        cache_write=Decimal("1.25"),
        basis="curated",
    )
    captured = usage.Captured(
        prompt_tokens=1000, completion_tokens=100, cache_read_tokens=2000, cache_write_tokens=500
    )
    # 1000*3e-6 + 100*15e-6 + 2000*3e-6*0.1 + 500*3e-6*1.25 = 0.003+0.0015+0.0006+0.001875
    assert usage.cost_from_price(price, captured) == Decimal("0.006975")
    assert usage.cost_from_price(price, usage.Captured(prompt_tokens=10)) is None


def test_month_start_is_the_first_of_the_month_in_the_owners_zone():
    now = datetime(2026, 9, 1, 3, 0, tzinfo=UTC)  # still 31 August in Denver
    assert usage.month_start(now, "America/Denver").isoformat() == "2026-08-01T00:00:00-06:00"
    assert usage.month_start(now, "UTC").isoformat() == "2026-09-01T00:00:00+00:00"
    assert usage.valid_timezone("Mars/Olympus") == "UTC"


def test_curated_prices_file_is_dated_and_positive():
    data = usage.load_curated_prices()
    assert data["adapter"] == "anthropic-messages" and data["models"]
    assert all(m["prompt"] > 0 and m["completion"] > 0 for m in data["models"])


# ── the ledger over the data plane ──────────────────────────────────────────


@pytest.fixture
async def local(pool, monkeypatch, mount_backend):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(deltas=("Hel", "lo"))
    mount_backend("http://ollama.test", fake.app)
    await backends.save_config(pool, {"kind": "ollama", "model": "qwen3:8b"})
    return fake


ATTRIBUTION = {
    "X-Nova-Purpose": "chat",
    "X-Nova-Role": "chat",
    "X-Nova-Turn-Id": "0d5f7b2e-2b2c-4d0c-9c8e-8b3d6f1a2c3d",
    "X-Nova-Person": "f9b751cb-f010-4a6b-8260-6a6255593a70",
    "X-Nova-Timezone": "America/Denver",
}


async def test_a_local_completion_is_one_row_with_ollamas_counts_and_no_dollars(
    client, pool, local
):
    resp = await client.post(
        "/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}], "stream": True},
        headers=ATTRIBUTION,
    )
    assert resp.status_code == 200
    frames = _frames(resp.content)
    usage_frame = [f for f in frames if f != "[DONE]" and f.get("usage")][-1]["usage"]
    assert usage_frame == {
        **usage_frame,
        "prompt_tokens": 12,
        "completion_tokens": 5,
        "cost_usd": None,
        "cost_basis": None,
        "local": True,
        "metered": True,
        "recorded": True,
        "provider": "ollama",
    }
    # ollama was ASKED for its counts.
    assert local.seen[0][1]["stream_options"] == {"include_usage": True}
    rows = await _rows(pool)
    assert len(rows) == 1
    row = rows[0]
    assert row["kind"] == "completion" and row["purpose"] == "chat" and row["role"] == "chat"
    assert str(row["turn_id"]) == ATTRIBUTION["X-Nova-Turn-Id"]
    assert str(row["person_id"]) == ATTRIBUTION["X-Nova-Person"]
    assert row["local"] is True and row["cost_usd"] is None and row["metered"] is True
    assert row["prompt_tokens"] == 12 and row["duration_ms"] >= 0


async def test_an_unattributed_call_is_still_a_row_and_unstated_counts_stay_null(
    client, pool, local
):
    local.prompt_tokens = None  # a provider that states nothing
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})
    assert resp.status_code == 200
    (row,) = await _rows(pool)
    assert row["purpose"] == "unattributed" and row["turn_id"] is None
    assert row["prompt_tokens"] is None and row["metered"] is False


async def test_a_refusal_is_a_row_with_no_tokens_and_the_providers_words(client, pool, local):
    local.probe_status = 503
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": False})
    assert resp.status_code == 503
    (row,) = await _rows(pool)
    assert row["kind"] == "refusal" and row["status"] == 503 and row["metered"] is False
    assert "probe refused" in row["error"]


async def test_the_check_constraint_refuses_dollars_on_a_local_row(pool):
    with pytest.raises(Exception, match="usage_local_has_no_usd"):
        await pool.execute(
            "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
            "local, cost_usd, cost_basis, status) VALUES ('ollama', 'm', 'ollama:m', 'completion', "
            "'chat', 1, true, 0.01, 'owner-price', 200)"
        )
    with pytest.raises(Exception, match="usage_cost_has_basis"):
        await pool.execute(
            "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
            "local, cost_usd, status) VALUES ('x', 'm', 'x:m', 'completion', 'chat', 1, false, "
            "0.01, 200)"
        )


async def test_a_failed_ledger_write_is_counted_and_said_in_the_stream(
    client, pool, local, monkeypatch
):
    async def broken(pool, event):
        usage.WRITE_FAILURES += 1
        return False

    monkeypatch.setattr(usage, "record", broken)
    before = usage.WRITE_FAILURES
    resp = await client.post("/v1/chat/completions", json={"messages": [], "stream": True})
    usage_frame = [f for f in _frames(resp.content) if f != "[DONE]" and f.get("usage")][-1]
    assert usage_frame["usage"]["recorded"] is False
    assert usage.WRITE_FAILURES == before + 1


# ── cloud: prices and their precedence ──────────────────────────────────────


async def _cloud(client, mount_backend, fake, name="openrouter", host="openrouter.test"):
    mount_backend(f"http://{host}", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": name,
            "adapter": "openai-chat",
            "base_url": f"http://{host}/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text


async def test_a_listed_price_bills_the_call_and_the_row_names_the_basis(
    client, pool, mount_backend, local
):
    fake = FakeOpenAICompat(
        models_body={
            "object": "list",
            "data": [{"id": "gpt-x", "pricing": {"prompt": "0.000001", "completion": "0.000002"}}],
        },
        accepts_key="sk-1",
        prompt_tokens=1000,
        completion_tokens=500,
    )
    await _cloud(client, mount_backend, fake)
    # The listing fetch at save time recorded the price rows.
    prices = await usage.prices(pool)
    assert [(p["provider"], p["model"], p["basis"]) for p in prices] == [
        ("openrouter", "gpt-x", "listing")
    ]

    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:gpt-x", "messages": [], "stream": True},
        headers={"X-Nova-Purpose": "chat"},
    )
    assert resp.status_code == 200
    rows = await _rows(pool, kind="completion")
    (row,) = rows
    assert row["cost_usd"] == Decimal("0.002000") and row["cost_basis"] == "listing-price"
    assert row["local"] is False and row["served_by"] == "openrouter:gpt-x"


async def test_the_providers_own_reported_cost_wins_over_every_price(
    client, pool, mount_backend, local
):
    fake = FakeOpenAICompat(
        models_body={
            "object": "list",
            "data": [{"id": "gpt-x", "pricing": {"prompt": "1", "completion": "1"}}],
        },
        accepts_key="sk-1",
        prompt_tokens=10,
        completion_tokens=10,
        cost=0.0007,
    )
    await _cloud(client, mount_backend, fake, host="openrouter.ai")
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "openrouter:gpt-x", "messages": [], "stream": True},
    )
    assert resp.status_code == 200
    sent = fake.seen[-1][1]
    assert sent["usage"] == {"include": True} and sent["stream_options"] == {"include_usage": True}
    (row,) = await _rows(pool, kind="completion")
    assert row["cost_usd"] == Decimal("0.000700") and row["cost_basis"] == "provider-reported"


async def test_an_owner_price_beats_the_listing_and_no_price_means_no_dollars(
    client, pool, mount_backend, local
):
    fake = FakeOpenAICompat(
        models_body={
            "object": "list",
            "data": [
                {"id": "gpt-x"},
                {"id": "gpt-free", "pricing": {"prompt": "0", "completion": "0"}},
            ],
        },
        accepts_key="sk-1",
        prompt_tokens=100,
        completion_tokens=100,
    )
    await _cloud(client, mount_backend, fake)
    resp = await client.post(
        "/v1/chat/completions", json={"model": "openrouter:gpt-x", "messages": [], "stream": True}
    )
    assert resp.status_code == 200
    (row,) = await _rows(pool, kind="completion")
    assert row["cost_usd"] is None and row["cost_basis"] is None and row["metered"] is True
    report = (await client.get("/admin/spend?window=today")).json()
    assert report["unpriced"] == [{"provider": "openrouter", "model": "gpt-x", "calls": 1}]

    put = await client.put(
        "/admin/spend/prices",
        json={
            "provider": "openrouter",
            "model": "gpt-x",
            "prompt_usd_per_token": 0.00001,
            "completion_usd_per_token": 0.00002,
        },
    )
    assert put.status_code == 200
    resp = await client.post(
        "/v1/chat/completions", json={"model": "openrouter:gpt-x", "messages": [], "stream": True}
    )
    rows = await _rows(pool, kind="completion")
    assert rows[-1]["cost_usd"] == Decimal("0.003000") and rows[-1]["cost_basis"] == "owner-price"
    gone = await client.delete("/admin/spend/prices?provider=openrouter&model=gpt-x")
    assert gone.status_code == 200
    # A 0 listing price is not a price: gpt-free stays unpriced.
    assert not any(p["model"] == "gpt-free" for p in await usage.prices(pool))


async def test_a_provider_that_rejects_the_usage_field_is_retried_once_and_remembered(
    client, pool, mount_backend, local
):
    fake = FakeOpenAICompat(accepts_key="sk-1", rejects_usage_fields=True)
    await _cloud(client, mount_backend, fake, name="strict", host="strict.test")
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": "strict:remote-model", "messages": [], "stream": True},
    )
    assert resp.status_code == 200
    calls = [b for p, b in fake.seen if p.endswith("/chat/completions")]
    assert len(calls) == 2 and "stream_options" in calls[0] and "stream_options" not in calls[1]
    row = await providers.get_row(pool, "strict")
    assert row["usage_supported"] is False
    # The next call does not ask again.
    await client.post(
        "/v1/chat/completions",
        json={"model": "strict:remote-model", "messages": [], "stream": True},
    )
    calls = [b for p, b in fake.seen if p.endswith("/chat/completions")]
    assert len(calls) == 3 and "stream_options" not in calls[2]
    (a, b) = await _rows(pool, kind="completion")
    assert a["metered"] is False  # the strict fake states nothing without the field


async def test_a_provider_that_honours_the_field_is_remembered_too(
    client, pool, mount_backend, local
):
    fake = FakeOpenAICompat(accepts_key="sk-1")
    await _cloud(client, mount_backend, fake, name="kind", host="kind.test")
    assert (await providers.get_row(pool, "kind"))["usage_supported"] is None
    await client.post(
        "/v1/chat/completions", json={"model": "kind:remote-model", "messages": [], "stream": True}
    )
    assert (await providers.get_row(pool, "kind"))["usage_supported"] is True


# ── Anthropic: cache counts and the curated price ───────────────────────────


async def test_anthropic_cache_counts_are_read_and_priced_from_the_curated_list(
    client, pool, mount_backend, local
):
    fake = FakeAnthropic(
        input_tokens=100,
        output_tokens=50,
        cache_read_input_tokens=2000,
        cache_creation_input_tokens=0,
        accepts_key="sk-ant",
    )
    mount_backend("http://anthropic.test", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test/v1",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant",
        },
    )
    assert resp.status_code == 200, resp.text
    # Creating an Anthropic provider seeds the curated prices for it.
    assert any(
        p["basis"] == "curated" and p["model"] == "claude-opus-5" for p in await usage.prices(pool)
    )

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )
    assert resp.status_code == 200
    (row,) = await _rows(pool, kind="completion")
    assert row["prompt_tokens"] == 100 and row["cache_read_tokens"] == 2000
    # 100*5e-6 + 50*2.5e-5 + 2000*5e-6*0.1 = 0.0005 + 0.00125 + 0.001
    assert row["cost_usd"] == Decimal("0.002750") and row["cost_basis"] == "curated-price"


# ── the report and the caps ─────────────────────────────────────────────────


async def test_the_report_rolls_up_by_provider_model_purpose_person_and_day(client, pool, local):
    for purpose in ("chat", "chat", "scheduled"):
        await client.post(
            "/v1/chat/completions",
            json={"messages": [], "stream": True},
            headers={**ATTRIBUTION, "X-Nova-Purpose": purpose},
        )
    report = (await client.get("/admin/spend?window=7d", headers=ATTRIBUTION)).json()
    assert report["timezone"] == "America/Denver" and report["window"] == "7d"
    assert report["totals"] == {
        **report["totals"],
        "usd": 0.0,
        "calls": 3,
        "unmetered": 0,
        "refusals": 0,
        "month_cap_usd": None,
    }
    assert report["totals"]["gpu_seconds"] >= 0
    (provider,) = report["by_provider"]
    assert provider["provider"] == "ollama" and provider["local"] is True
    assert provider["month_usd"] is None and provider["gpu_seconds"] is not None
    assert {p["key"]: p["calls"] for p in report["by_purpose"]} == {"chat": 2, "scheduled": 1}
    assert report["by_person"][0]["key"] == ATTRIBUTION["X-Nova-Person"]
    assert report["by_model"][0]["key"] == "ollama:qwen3:8b"
    assert len(report["by_day"]) == 1 and report["by_day"][0]["calls"] == 3
    bad = await client.get("/admin/spend?window=year")
    assert bad.status_code == 400
    events = (await client.get("/admin/spend/events?limit=2")).json()["events"]
    assert len(events) == 2 and events[0]["purpose"] == "scheduled"


async def test_caps_are_per_provider_plus_a_total_and_never_on_a_local_provider(
    client, pool, local
):
    caps = (await client.get("/admin/spend/caps")).json()
    assert caps["caps"] == [
        {"provider": "*", "monthly_usd": None, "spent_usd": 0.0, "remaining_usd": None}
    ]
    assert (
        await client.put("/admin/spend/caps", json={"provider": "*", "monthly_usd": 25})
    ).status_code == 200
    assert (
        await client.put("/admin/spend/caps", json={"provider": "ollama", "monthly_usd": 5})
    ).status_code == 400
    assert (
        await client.put("/admin/spend/caps", json={"provider": "nope", "monthly_usd": 5})
    ).status_code == 404
    assert (
        await client.put("/admin/spend/caps", json={"provider": "*", "monthly_usd": -1})
    ).status_code == 400
    caps = (await client.get("/admin/spend/caps")).json()["caps"]
    assert caps[0]["monthly_usd"] == 25.0 and caps[0]["remaining_usd"] == 25.0
    # Read live, before the act.
    builtin = await providers.get_row(pool, "ollama")
    assert await usage.over_cap(pool, builtin, "UTC") is None
    cloud = {"name": "openrouter", "local": False}
    await usage.set_cap(pool, "openrouter", Decimal("1"))
    await pool.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, local, "
        "cost_usd, cost_basis, status, prompt_tokens, completion_tokens) VALUES "
        "('openrouter', 'm', 'openrouter:m', 'completion', 'chat', 1, false, 1.02, "
        "'provider-reported', 200, 1, 1)"
    )
    assert (
        await usage.over_cap(pool, cloud, "UTC")
        == "openrouter over its monthly cap $1.00 (spent $1.02)"
    )
    await usage.set_cap(pool, "openrouter", None)
    await usage.set_cap(pool, "*", Decimal("0.5"))
    assert "monthly total cap $0.50" in (await usage.over_cap(pool, cloud, "UTC") or "")


async def test_the_admin_probe_is_a_ledger_row_too(client, pool, local):
    resp = await client.post("/admin/probe", json={"model": "qwen3:8b"})
    assert resp.status_code == 200, resp.text
    rows = await _rows(pool)
    assert [r["kind"] for r in rows] == ["probe"] and rows[0]["purpose"] == "probe"
    assert rows[0]["prompt_tokens"] == 12 and rows[0]["local"] is True
