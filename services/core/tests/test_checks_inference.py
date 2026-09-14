"""The `inference_degraded` check: the sentence that was missing on
2026-09-12.

Every number in this file is the real one from that day. A video game held
~7 GB of the card and pinned the shader cores for six hours; the 27B
generated at 0.25 tok/s where it normally does 67.5, two chat turns walled
at the gateway's 300 s read limit, an eval suite scored zero of twenty-three
cases, and nothing in the product said a word about it.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import model_speed
from app.checks import CannotCheck, inference
from app.main import app as core_app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db


async def _rounds(pool, *, model: str, rate: float, count: int, hours_ago: float) -> None:
    for _ in range(count):
        turn_id = uuid.uuid4()
        when = datetime.now(UTC) - timedelta(hours=hours_ago)
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
            turn_id,
            when,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', $2, $3, 1000, $4)",
            turn_id,
            model,
            when,
            {"model": model, "tok_per_s": rate},
        )


async def _healthy_history(pool, model="qwen3.8:27b", rate=67.5) -> None:
    await _rounds(pool, model=model, rate=rate, count=20, hours_ago=48)


@pytest.fixture
def card(monkeypatch):
    """Set what the gateway would say about the card."""

    def _set(free_gb: float | None, reason: str | None = None, others_gb: float | None = None):
        facts: dict = {}
        if free_gb is not None:
            facts["free_vram_gb"] = round(free_gb, 1)
        if others_gb is not None:
            facts["non_ollama_vram_gb"] = round(others_gb, 1)

        async def _read(_app):
            return {
                "free_gb": free_gb,
                "others_gb": others_gb,
                "reason": reason,
                "facts": facts,
            }

        monkeypatch.setattr(inference, "_card_facts", _read)

    _set(21.4)
    return _set


async def test_the_collapse_is_reported_with_both_numbers(pool, card):
    """THE 2026-09-12 CASE. Not the word 'slow' — 0.25 against 67.5, and
    what the card had free while it happened."""
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
    card(14.4)

    findings = await inference.degraded(core_app, pool)

    assert len(findings) == 1
    finding = findings[0]
    assert finding.key == "inference_degraded:qwen3.8:27b"
    assert "0.25 tok/s" in finding.title
    assert "67.5" in finding.title
    assert "14.4 GB free" in finding.title
    assert finding.facts["recent_tok_per_s"] == 0.25
    assert finding.facts["baseline_tok_per_s"] == 67.5
    assert finding.facts["free_vram_gb"] == 14.4


async def test_a_healthy_card_finds_nothing(pool, card):
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=65.0, count=5, hours_ago=0.5)

    assert await inference.degraded(core_app, pool) == []


async def test_a_model_that_has_always_been_slow_here_is_never_reported(pool, card):
    """The reason the baseline is derived from history rather than declared.
    Three tokens a second is this model's normal, and normal is not news."""
    await _healthy_history(pool, model="slow:2b", rate=3.0)
    await _rounds(pool, model="slow:2b", rate=3.0, count=5, hours_ago=0.5)

    assert await inference.degraded(core_app, pool) == []


async def test_a_slowdown_under_the_factor_is_not_a_finding(pool, card):
    """4x slower on a 5x setting. Real, and not worth a notice — the knob is
    the owner's, and the check reads it live."""
    await _healthy_history(pool, rate=40.0)
    await _rounds(pool, model="qwen3.8:27b", rate=10.0, count=5, hours_ago=0.5)

    assert await inference.degraded(core_app, pool) == []


async def test_the_owners_own_factor_is_what_decides(pool, card, owner_client):
    await _healthy_history(pool, rate=40.0)
    await _rounds(pool, model="qwen3.8:27b", rate=10.0, count=5, hours_ago=0.5)
    await owner_client.put(
        "/api/v1/settings", json={"key": "inference.degraded_factor", "value": 3}
    )

    findings = await inference.degraded(core_app, pool)

    assert [f.facts["model"] for f in findings] == ["qwen3.8:27b"]


async def test_nothing_to_compare_is_could_not_check_never_all_clear(pool, card):
    """A machine with no history cannot say the card is fine. Saying so
    would be the exact lie the beat's `quiet` computation exists to
    prevent — CannotCheck makes the hour incomplete and names why."""
    await _rounds(pool, model="fresh:8b", rate=20.0, count=3, hours_ago=0.5)

    with pytest.raises(CannotCheck) as exc:
        await inference.degraded(core_app, pool)
    assert "nothing to measure" in str(exc.value)


async def test_a_single_recent_round_is_not_a_measurement(pool, card):
    """One sample is not a measurement (the corpus runs taught this). A lone
    slow round after a timeout must not raise a notice on its own."""
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=1, hours_ago=0.5)

    with pytest.raises(CannotCheck):
        await inference.degraded(core_app, pool)


async def test_the_finding_survives_a_gateway_that_cannot_read_the_card(pool, card):
    """The throughput collapse IS the finding; free VRAM is context for it.
    A gateway that cannot answer costs the finding a fact, not its
    existence — and the missing fact is stated rather than dropped."""
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
    card(None, "nvidia-smi could not be run — no GPU passthrough")

    finding = (await inference.degraded(core_app, pool))[0]

    assert "free_vram_gb" not in finding.facts
    assert "no GPU passthrough" in finding.facts["free_vram_reason"]
    assert "Free VRAM is unknown" in finding.title


async def test_the_live_rate_is_not_in_the_fingerprint(pool, card):
    """v3 hashed a model's own sentence and one re-wording became fourteen
    phone pushes in eight hours. A rate that moves every round would do the
    same thing here, so the facts carry a coarse bucket and the moving
    figure lives in the title, which is never hashed."""
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
    first = (await inference.degraded(core_app, pool))[0]

    assert first.facts["slowdown_bucket"] == 100


async def test_every_degraded_model_gets_its_own_finding_worst_first(pool, card):
    await _healthy_history(pool, model="qwen3.8:27b", rate=67.5)
    await _healthy_history(pool, model="qwen3:8b", rate=100.0)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
    await _rounds(pool, model="qwen3:8b", rate=10.0, count=5, hours_ago=0.5)

    findings = await inference.degraded(core_app, pool)

    assert [f.facts["model"] for f in findings] == ["qwen3.8:27b", "qwen3:8b"]


async def test_the_check_decides_nothing_and_writes_nothing(pool, card, mount_peers):
    """Owner ruling 2026-09-03. It says what is true, loudly, and that is
    all: no fallback model, no paused run, no row written anywhere."""
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    await _healthy_history(pool)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)
    before = await pool.fetchval("SELECT count(*) FROM notices")

    await inference.degraded(core_app, pool)

    assert await pool.fetchval("SELECT count(*) FROM notices") == before
    assert not inference.CHECKS[0].urgent


def test_the_bucket_is_coarse_enough_to_fold():
    """Adjacent measurements of the same situation must land in the same
    bucket, or the notice re-raises every beat."""
    assert inference._bucket(260) == inference._bucket(300) == 100
    assert inference._bucket(5.1) == inference._bucket(9.9) == 5
    assert inference._bucket(12) != inference._bucket(25)


def test_the_windows_are_the_ones_model_speed_states():
    """The CannotCheck sentence quotes the thresholds, so it must quote the
    module that actually enforces them."""
    assert model_speed.MIN_ROUNDS_RECENT and model_speed.MIN_ROUNDS_BASELINE
    assert model_speed.RECENT_HOURS < model_speed.BASELINE_HOURS


# -- the half the walk found (2026-09-14) ----------------------------------


async def _walled(pool, *, model: str, count: int, hours_ago: float = 0.5) -> None:
    """A round that waited out the gateway's read timeout and received
    nothing — exactly the span chat.py filed when the owner asked "what's
    the GPU doing" and his turn errored five minutes later."""
    for _ in range(count):
        turn_id = uuid.uuid4()
        when = datetime.now(UTC) - timedelta(hours=hours_ago)
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'error', 'chat')",
            turn_id,
            when,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', $2, $3, 300009, $4)",
            turn_id,
            model,
            when,
            {
                "model": model,
                "error": "nothing arrived from the gateway for 300 s",
                "error_class": "ReadTimeout",
                "timeout_phase": "read",
                "timeout_s": 300.0,
                "completion_chars": 0,
            },
        )


async def test_a_card_that_produces_no_tokens_at_all_is_still_reported(pool, card):
    """THE GAP THE WALK FOUND. A round that generates nothing generates no
    rate, so the throughput half is blind to the very worst state of the
    machine. Two walled rounds are a fact that needs no token to exist."""
    await _walled(pool, model="qwen3.8:27b", count=2)
    card(0.4, others_gb=6.8)

    findings = await inference.degraded(core_app, pool)

    assert [f.key for f in findings] == ["inference_stalled:qwen3.8:27b"]
    finding = findings[0]
    assert "produced nothing at all in 2 of its last 2 round(s)" in finding.title
    assert "0.4 GB free" in finding.title
    # The actionable half: what the owner can go and close.
    assert "6.8 GB of it is held by something that is not ollama" in finding.title
    assert finding.facts["walled_rounds"] == 2
    assert finding.facts["non_ollama_vram_gb"] == 6.8


async def test_one_walled_round_is_an_event_not_a_pattern(pool, card):
    """A model being pulled underneath a turn, a restart landing mid-stream.
    Stopping on one would make the check noise."""
    await _walled(pool, model="qwen3.8:27b", count=1)

    with pytest.raises(CannotCheck):
        await inference.degraded(core_app, pool)


async def test_a_stall_is_reported_even_with_no_history_to_compare_against(pool, card):
    """The stalled half must not be gated behind having a comparable rate —
    the whole reason it exists is that a stalled card has no rate. A machine
    that has never once measured a throughput can still say this."""
    await _walled(pool, model="fresh:27b", count=3)

    findings = await inference.degraded(core_app, pool)

    assert [f.key for f in findings] == ["inference_stalled:fresh:27b"]


async def test_a_round_that_errored_for_another_reason_is_not_a_stall(pool, card):
    """A gateway 502, a refused model, a malformed stream — real failures,
    and not evidence about the CARD. Only a read timeout that received
    nothing says the machine could not produce a token."""
    for _ in range(3):
        turn_id = uuid.uuid4()
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, now(), 'error', 'chat')",
            turn_id,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', 'm', now(), 1200, $2)",
            turn_id,
            {"model": "m", "error": "the gateway refused the request (502)", "gateway_status": 502},
        )

    with pytest.raises(CannotCheck):
        await inference.degraded(core_app, pool)


async def test_a_round_that_timed_out_after_writing_something_is_not_a_stall(pool, card):
    """A stream cut off mid-answer is a different fact from one that never
    started. The card was producing tokens; something else went wrong."""
    for _ in range(3):
        turn_id = uuid.uuid4()
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, now(), 'error', 'chat')",
            turn_id,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', 'm', now(), 300009, $2)",
            turn_id,
            {"model": "m", "timeout_phase": "read", "completion_chars": 812},
        )

    with pytest.raises(CannotCheck):
        await inference.degraded(core_app, pool)


async def test_both_conditions_can_be_reported_in_one_beat(pool, card):
    """One model stalled, another merely slow. They are different findings
    about different models and neither hides the other."""
    await _walled(pool, model="qwen3.8:27b", count=2)
    await _healthy_history(pool, model="qwen3:8b", rate=100.0)
    await _rounds(pool, model="qwen3:8b", rate=2.0, count=5, hours_ago=0.5)

    findings = await inference.degraded(core_app, pool)

    assert {f.key for f in findings} == {
        "inference_stalled:qwen3.8:27b",
        "inference_degraded:qwen3:8b",
    }


async def test_a_stall_says_so_even_when_the_card_cannot_be_read(pool, card):
    """The gateway is down too, say. The walled rounds are core's own rows
    and remain a fact; only the actionable half is missing, and it says so."""
    await _walled(pool, model="qwen3.8:27b", count=2)
    card(None, "the gateway could not be asked about the card — connection refused")

    finding = (await inference.degraded(core_app, pool))[0]

    assert "produced nothing at all" in finding.title
    assert "Free VRAM is unknown" in finding.title
