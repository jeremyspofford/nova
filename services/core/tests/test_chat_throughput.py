"""S22: every round's own throughput, onto its llm_call span.

No new probe and no benchmark run — the gateway already states
`completion_tokens` on its usage chunk, and the round already knows its own
clock. What S22 adds is the SPLIT: the time before the first content delta
is prompt processing (`ttft_ms`), and everything after it is generation
(`generation_ms`), so `tok_per_s` is a fact about how fast tokens come out
rather than a figure a very large prompt can drag down on its own.

This is the number that was missing on 2026-09-12. A video game held the
card for six hours; two chat turns timed out at the gateway's 300 s read
limit and the only thing the trace could say about it was that nothing had
arrived. With these fields the same turns say 0.25 tok/s against a machine
whose own history says 67.
"""

from __future__ import annotations

from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model

pytestmark = requires_db

USAGE = {
    "prompt_tokens": 120,
    "completion_tokens": 40,
    "local": True,
    "metered": False,
    "recorded": True,
}


async def _round_span(pool) -> dict:
    return await pool.fetchrow(
        "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at LIMIT 1"
    )


async def test_a_round_records_its_own_rate_against_generation_time(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(deltas=("one", "two", "three"), usage=USAGE, delta_delay_s=0.05)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    status, _ = await _say(owner_client, "hello")
    assert status == 200

    meta = (await _round_span(pool))["meta"]
    assert meta["completion_tokens"] == 40
    assert meta["generation_ms"] >= 100
    # 40 tokens over a tenth of a second or so — the exact figure depends on
    # the scheduler, so what is pinned is that it is a real positive rate
    # computed from the generation phase, not from the whole round.
    rate = meta["tok_per_s"]
    assert 0 < rate <= 40 / (meta["generation_ms"] / 1000) + 0.01


async def test_prompt_processing_is_its_own_field_not_folded_into_the_rate(
    owner_client, pool, mount_peers
):
    """A turn slowed only by a huge prompt must not read as a degraded card.
    The wait before the first token is time-to-first-token, and it is
    recorded as that."""
    gateway = FakeGateway(deltas=("a", "b"), usage=USAGE, delta_delay_s=0.05)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "hello")

    meta = (await _round_span(pool))["meta"]
    assert meta["ttft_ms"] >= 50
    # The first delta's own wait belongs to ttft, never to generation.
    assert meta["generation_ms"] < meta["ttft_ms"] + meta["generation_ms"]


async def test_a_round_the_gateway_stated_no_tokens_for_has_no_rate(
    owner_client, pool, mount_peers
):
    """A null is not a measurement. The timings are still recorded — they
    are facts — but no rate is invented from a token count nobody gave."""
    gateway = FakeGateway(deltas=("hi",), usage=None, delta_delay_s=0.02)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "hello")

    meta = (await _round_span(pool))["meta"]
    assert "tok_per_s" not in meta
    assert meta["ttft_ms"] >= 0


async def test_a_round_that_produced_nothing_has_no_timings_to_report(
    owner_client, pool, mount_peers
):
    """THE 2026-09-12 SHAPE: headers arrive, then the stream ends with no
    content at all. There is no generation phase, so there is nothing to
    divide by — absent, never a zero rate that would read as a dead card."""
    gateway = FakeGateway(deltas=(), usage=USAGE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "hello")

    meta = (await _round_span(pool))["meta"]
    assert "tok_per_s" not in meta
    assert "generation_ms" not in meta
    assert "ttft_ms" not in meta
