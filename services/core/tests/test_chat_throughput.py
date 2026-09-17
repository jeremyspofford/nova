"""S22: every round's own throughput, onto its llm_call span.

No new probe and no benchmark run — the gateway already states
`completion_tokens` on its usage chunk, and the round already knows its own
clock. What S22 adds is the SPLIT: the time before the model emits ANYTHING is
prompt processing (`prefill_ms`), and everything after it is generation
(`generation_ms`), so `tok_per_s` is a fact about how fast tokens come out
rather than a figure a very large prompt can drag down on its own.

"Anything" was "the first CONTENT delta" until 2026-09-15, and both ways
that was wrong are pinned below: a thinking model emits reasoning first,
and a tool round emits no content at all.

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
    assert meta["prefill_ms"] >= 50
    # ttft is still recorded, and for a model that does NOT think it is the
    # same wait: there is nothing between the prompt and the first word.
    assert meta["ttft_ms"] == meta["prefill_ms"]
    assert "thinking_ms" not in meta
    # The first delta's own wait belongs to prefill, never to generation.
    assert meta["generation_ms"] < meta["prefill_ms"] + meta["generation_ms"]


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
    assert meta["prefill_ms"] >= 0


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
    assert "prefill_ms" not in meta


# ── Thinking models (2026-09-15) ─────────────────────────────────────────
#
# qwen3 thinks by default. ollama streams that thinking in a `reasoning`
# field with `content` empty on every chunk, and core read only `content` —
# so a turn showed the owner nothing for the entire time she worked (146 s,
# measured, for "what is 2+2"), and the rate these tests exist to produce
# was computed over a window that excluded all of it while
# `completion_tokens` counted every token in it. Rounds were filed at
# 1 900 tok/s on a 24 GB card, and `inference_degraded` — which reads this
# field to notice a contended card — was reading a number that could only
# ever point upward.


async def test_thinking_time_is_generation_not_prompt_processing(owner_client, pool, mount_peers):
    gateway = FakeGateway(
        reasoning=("Okay", ", the", " user asks"),
        deltas=("four",),
        usage=USAGE,
        delta_delay_s=0.05,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "what is 2+2")

    meta = (await _round_span(pool))["meta"]
    # The owner waited through the thinking; prefill ended at its first token.
    assert meta["ttft_ms"] > meta["prefill_ms"]
    assert meta["thinking_ms"] >= 100
    assert meta["reasoning_chars"] == len("Okay, the user asks")
    # THE BUG: dividing 40 tokens by only the post-thinking window. The
    # generation window must contain the thinking, so the rate stays sane.
    assert meta["generation_ms"] >= meta["thinking_ms"]
    # `<=`, not `<` (2026-09-16). The bound IS 40 tokens over the thinking
    # window, and generation contains thinking — so the two are equal at the
    # boundary, which is correct behaviour rather than a violation. Under a
    # loaded machine the whole round can round to the same millisecond as the
    # thinking, and this failed at `263.16 < 263.157`: a green test turning
    # red on scheduling noise teaches everyone to ignore it. The bug it
    # guards against reported 1900 against a bound near 263, so nothing is
    # lost by admitting the edge.
    assert meta["tok_per_s"] <= 40 / (meta["thinking_ms"] / 1000)


async def test_the_other_spelling_of_reasoning_is_read_too(owner_client, pool, mount_peers):
    """vLLM and DeepSeek say `reasoning_content`. Neither spelling is ours to
    choose, so both are read; a backend using neither simply never matches."""
    gateway = FakeGateway(
        reasoning=("hmm",),
        reasoning_field="reasoning_content",
        deltas=("four",),
        usage=USAGE,
        delta_delay_s=0.05,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "what is 2+2")

    assert (await _round_span(pool))["meta"]["reasoning_chars"] == 3


async def test_thinking_is_streamed_to_the_watcher_and_never_persisted(
    owner_client, pool, mount_peers
):
    """It reaches the browser as its own frame so a long think reads as work,
    and it stays out of the transcript because it is not what she said —
    every honesty guard reads what she said."""
    gateway = FakeGateway(reasoning=("weighing it up",), deltas=("four",), usage=USAGE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    status, frames = await _say(owner_client, "what is 2+2")
    assert status == 200

    # Its OWN frame, not a content delta: a client that renders `t` as the
    # reply would otherwise put her thinking in the transcript.
    thinking = [f["think"] for f in frames if isinstance(f, dict) and "think" in f]
    assert "".join(thinking) == "weighing it up"
    said = [f["t"] for f in frames if isinstance(f, dict) and "t" in f]
    assert "".join(said) == "four"

    reply = await pool.fetchval(
        "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1"
    )
    assert reply == "four"
    assert "weighing it up" not in reply


async def test_a_round_that_only_thought_says_so(owner_client, pool, mount_peers):
    """THE 20:29 SHAPE. The model spends its whole budget reasoning and never
    answers. Before this the owner was told "no content" about a model that
    had just written four thousand characters — the same sentence a dead
    backend produces, wanting the opposite response."""
    gateway = FakeGateway(reasoning=("thinking and thinking",), deltas=(), usage=USAGE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "what is 2+2")

    meta = (await _round_span(pool))["meta"]
    assert "spent the whole round thinking" in meta["error"]
    assert str(len("thinking and thinking")) in meta["error"]


async def test_a_round_that_only_calls_tools_still_records_a_rate(owner_client, pool, mount_peers):
    """THE COVERAGE HOLE, and the reason `inference_degraded` reported
    "nothing to measure" through an evening of 100-400 s turns.

    A tool round emits no content at all, so measuring generation from the
    first CONTENT delta left `t_first_delta` None for the whole round —
    _note_throughput returned early and the span carried `completion_tokens`
    with no `tok_per_s` beside it. model_speed's query skips a span without
    a rate, and tool rounds are most of a working turn, so most of the
    evidence never reached the median. A tool-call fragment is a generated
    token; prefill ends there too.
    """
    from tests.fakes import ScriptedGateway
    from tests.test_chat_honesty import streamed_call

    gateway = ScriptedGateway(
        rounds=(
            (
                *streamed_call(0, "call_1", "list_timers", {}),
                {"usage": USAGE},
            ),
            ({"choices": [{"delta": {"content": "nothing scheduled"}}]},),
        ),
        chunk_delay_s=0.03,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")

    await _say(owner_client, "what is scheduled?")

    first = (await _round_span(pool))["meta"]
    assert first["tool_calls"] == 1
    assert "prefill_ms" in first
    assert "generation_ms" in first
    # The round that had no content at all is measured like any other.
    assert first["tok_per_s"] > 0
