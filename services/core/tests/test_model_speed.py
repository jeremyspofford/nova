"""app/model_speed.py — throughput read out of spans this system already
writes, and a baseline derived from history rather than declared.

The numbers in these tests are the real ones from 2026-09-12: a 27B
generating at 0.25 tok/s with a video game on the card, against the 67.5
tok/s the same model, same context, measured with the game closed.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import model_speed

pytestmark = pytest.mark.asyncio


class TestTokPerS:
    def test_a_rate_is_tokens_over_generation_seconds(self):
        assert model_speed.tok_per_s(675, 10_000) == 67.5

    def test_the_contended_card_reads_as_the_collapse_it_was(self):
        # 250 tokens in 1000 seconds: the 27B on 2026-09-12.
        assert model_speed.tok_per_s(250, 1_000_000) == 0.25

    @pytest.mark.parametrize(
        ("tokens", "ms"),
        [
            (None, 10_000),  # the gateway stated no count
            (0, 10_000),  # a round that produced nothing
            (4, 10_000),  # too few tokens to say anything
            (675, None),  # no generation phase timed
            (675, 0),  # a stream that ended at the first delta
            (675, -3),  # a clock that went backwards
        ],
    )
    def test_not_a_measurement_is_none_never_zero(self, tokens, ms):
        """A zero would read as 'the card is dead' and fire every check
        that looks at it. Absence is the honest answer."""
        assert model_speed.tok_per_s(tokens, ms) is None


class TestSpeed:
    def test_the_ratio_says_how_many_times_slower_than_usual(self):
        speed = model_speed.Speed("qwen3.8:27b", 0.25, 5, 67.5, 200)
        assert speed.ratio == 270.0

    @pytest.mark.parametrize(
        "speed",
        [
            model_speed.Speed("m", None, 0, 67.5, 200),  # nothing recent
            model_speed.Speed("m", 12.0, 5, None, 2),  # no baseline yet
            model_speed.Speed("m", 0.0, 5, 67.5, 200),  # a zero recent rate
        ],
    )
    def test_a_ratio_needs_both_halves(self, speed):
        assert speed.ratio is None


async def _span(pool, *, model: str, rate: float | None, hours_ago: float) -> None:
    """One llm_call span, exactly as chat.py files it."""
    turn_id = uuid.uuid4()
    await pool.execute(
        "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
        turn_id,
        datetime.now(UTC) - timedelta(hours=hours_ago),
    )
    meta = {"model": model}
    if rate is not None:
        meta["tok_per_s"] = rate
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
        "VALUES ($1, 'llm_call', $2, $3, 1000, $4)",
        turn_id,
        model,
        datetime.now(UTC) - timedelta(hours=hours_ago),
        meta,
    )


class TestSpeeds:
    async def test_the_baseline_is_this_machines_own_history(self, pool):
        """Nobody declares 67.5 anywhere. It is the median of what this
        machine has actually done with this model."""
        for _ in range(20):
            await _span(pool, model="qwen3.8:27b", rate=67.5, hours_ago=48)
        for _ in range(5):
            await _span(pool, model="qwen3.8:27b", rate=0.25, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "qwen3.8:27b")

        assert speed.recent == 0.25
        assert speed.baseline == 67.5
        assert speed.ratio == 270.0

    async def test_a_model_that_has_always_been_slow_here_is_not_libelled(self, pool):
        """The whole reason the baseline is derived. A small CPU-served
        model at 3 tok/s is normal for itself, and nothing about it is
        degraded."""
        for _ in range(20):
            await _span(pool, model="slow:2b", rate=3.0, hours_ago=48)
        for _ in range(5):
            await _span(pool, model="slow:2b", rate=3.0, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "slow:2b")

        assert speed.ratio == 1.0

    async def test_one_bad_round_does_not_move_the_median(self, pool):
        """A single 300 s timeout among healthy rounds would drag a MEAN
        below any threshold. The point is a contended card, not one bad
        round."""
        for _ in range(20):
            await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=48)
        for _ in range(4):
            await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=0.5)
        await _span(pool, model="qwen3:8b", rate=0.2, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "qwen3:8b")

        assert speed.recent == 40.0

    async def test_too_few_recent_rounds_is_no_recent_figure_at_all(self, pool):
        for _ in range(20):
            await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=48)
        await _span(pool, model="qwen3:8b", rate=0.2, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "qwen3:8b")

        assert speed.recent is None
        assert speed.recent_rounds == 1
        assert speed.ratio is None

    async def test_too_few_rounds_ever_is_no_baseline_to_compare_against(self, pool):
        """A model installed this morning has no normal yet, and inventing
        one would make its first slow round look like a failure."""
        for _ in range(4):
            await _span(pool, model="new:12b", rate=20.0, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "new:12b")

        assert speed.recent == 20.0
        assert speed.baseline is None
        assert speed.ratio is None

    async def test_a_span_with_no_rate_is_not_counted_as_a_slow_one(self, pool):
        """A round that errored, or one the gateway stated no token count
        for, files no tok_per_s. It must not read as zero."""
        for _ in range(20):
            await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=48)
        for _ in range(10):
            await _span(pool, model="qwen3:8b", rate=None, hours_ago=0.5)

        speed = await model_speed.speed_of(pool, "qwen3:8b")

        assert speed.recent is None
        assert speed.recent_rounds == 0

    async def test_rounds_older_than_the_baseline_window_are_not_history(self, pool):
        for _ in range(20):
            await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=24 * 90)

        speed = await model_speed.speed_of(pool, "qwen3:8b")

        assert speed.baseline is None
        assert speed.baseline_rounds == 0

    async def test_models_are_measured_separately(self, pool):
        for _ in range(20):
            await _span(pool, model="qwen3.8:27b", rate=67.5, hours_ago=48)
            await _span(pool, model="qwen3:8b", rate=120.0, hours_ago=48)

        every = await model_speed.speeds(pool)

        assert every["qwen3.8:27b"].baseline == 67.5
        assert every["qwen3:8b"].baseline == 120.0

    async def test_an_unknown_model_answers_with_nothing_rather_than_raising(self, pool):
        speed = await model_speed.speed_of(pool, "never-run:1b")
        assert speed.as_dict() == {
            "model": "never-run:1b",
            "recent_tok_per_s": None,
            "recent_rounds": 0,
            "baseline_tok_per_s": None,
            "baseline_rounds": 0,
            "ratio": None,
        }


class TestStalls:
    """The reading that survives a card nobody can get a token out of.

    Walked 2026-09-14: the owner asked "what's the GPU doing", his turn
    waited the gateway's full 300 s, received zero data lines and errored.
    No token means no rate, so every median above is blank — and the worst
    state of the machine was invisible to the measurement built for it.
    """

    async def _walled(self, pool, model: str, count: int, *, chars: int = 0) -> None:
        for _ in range(count):
            turn_id = uuid.uuid4()
            await pool.execute(
                "INSERT INTO turns (id, started_at, status, kind) "
                "VALUES ($1, now(), 'error', 'chat')",
                turn_id,
            )
            await pool.execute(
                "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
                "VALUES ($1, 'llm_call', $2, now(), 300009, $3)",
                turn_id,
                model,
                {"model": model, "timeout_phase": "read", "completion_chars": chars},
            )

    async def test_a_walled_round_is_counted_without_any_token(self, pool):
        await self._walled(pool, "qwen3.8:27b", 3)

        stalled = await model_speed.stalls(pool)

        assert stalled["qwen3.8:27b"].walled == 3
        assert stalled["qwen3.8:27b"].rounds == 3
        # And the token-based reading has nothing at all to say about it.
        assert (await model_speed.speed_of(pool, "qwen3.8:27b")).recent is None

    async def test_a_round_that_wrote_something_before_timing_out_is_not_walled(self, pool):
        await self._walled(pool, "qwen3.8:27b", 3, chars=812)

        stalled = await model_speed.stalls(pool)

        assert stalled["qwen3.8:27b"].walled == 0
        assert stalled["qwen3.8:27b"].rounds == 3

    async def test_healthy_rounds_count_in_the_denominator(self, pool):
        await _span(pool, model="qwen3:8b", rate=40.0, hours_ago=0.5)
        await self._walled(pool, "qwen3:8b", 2)

        stalled = await model_speed.stalls(pool)

        assert stalled["qwen3:8b"].walled == 2
        assert stalled["qwen3:8b"].rounds == 3
