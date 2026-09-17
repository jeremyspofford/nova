"""app/devices_vram.py — the card, read at the moment of the question.

The parsing is pure and tested without a GPU; the subprocess wrapper is
tested for its degrade paths, because "the card could not be read" has to
be a sentence and never an exception: a fit verdict, a beat check and a
health tool all call it.
"""

from __future__ import annotations

import asyncio

import pytest

from app import devices_vram


def test_parses_one_cards_three_numbers():
    vram = devices_vram.parse("24576, 2662, 21914\n")
    assert vram.total_mb == 24576
    assert vram.used_mb == 2662
    assert vram.free_mb == 21914
    assert vram.reason is None
    assert vram.known


def test_picks_the_biggest_single_card_never_the_sum():
    """ollama does not shard a model across cards, so summing VRAM would
    promise room that the one card actually running the model does not
    have — the same assumption suggest.largest_single_gpu_vram_gb makes."""
    vram = devices_vram.parse("8192, 1024, 7168\n24576, 2662, 21914\n")
    assert vram.total_mb == 24576
    assert vram.free_mb == 21914


def test_a_line_the_driver_could_not_fill_in_is_skipped_not_fatal():
    """A card reporting [N/A] for one field must not take out the reading
    for a card that answered properly."""
    vram = devices_vram.parse("[N/A], [N/A], [N/A]\n24576, 2662, 21914\n")
    assert vram.total_mb == 24576


def test_no_usable_line_is_a_reason_not_a_zero():
    vram = devices_vram.parse("\n")
    assert not vram.known
    assert vram.total_mb is None
    assert vram.reason
    # Not zeros: a zero total would read as "a card with no memory", and
    # every fit verdict computed against it would be a confident lie.
    assert vram.free_mb is None


def test_a_zero_total_card_is_not_a_card():
    vram = devices_vram.parse("0, 0, 0\n")
    assert not vram.known


async def test_a_missing_binary_degrades_to_a_stated_reason(monkeypatch):
    """No GPU passthrough on this container, or no NVIDIA driver at all."""

    async def _boom(*args, **kwargs):
        raise OSError(2, "No such file or directory")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _boom)
    vram = await devices_vram.read_vram()
    assert not vram.known
    assert "nvidia-smi could not be run" in vram.reason


async def test_a_wedged_driver_times_out_rather_than_hanging_the_caller(monkeypatch):
    class _Never:
        async def communicate(self):
            await asyncio.sleep(3600)

    async def _slow(*args, **kwargs):
        return _Never()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _slow)
    monkeypatch.setattr(devices_vram, "NVIDIA_SMI_TIMEOUT_S", 0.01)
    vram = await devices_vram.read_vram()
    assert not vram.known
    assert vram.reason


async def test_a_nonzero_exit_carries_the_drivers_own_words(monkeypatch):
    class _Failed:
        returncode = 9

        async def communicate(self):
            return b"", b"Failed to initialize NVML: Driver/library version mismatch"

    async def _fail(*args, **kwargs):
        return _Failed()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fail)
    vram = await devices_vram.read_vram()
    assert not vram.known
    assert "NVML" in vram.reason


async def test_a_good_read_answers_the_cards_numbers(monkeypatch):
    class _Ok:
        returncode = 0

        async def communicate(self):
            return b"24576, 9662, 14914\n", b""

    async def _ok(*args, **kwargs):
        return _Ok()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _ok)
    vram = await devices_vram.read_vram()
    assert vram.as_dict() == {
        "total_mb": 24576,
        "used_mb": 9662,
        "free_mb": 14914,
        # A driver too old to report utilisation, or one printing [N/A],
        # still yields a complete memory reading — None, not 0, because a
        # missing reading is not an idle card.
        "util_pct": None,
        "reason": None,
    }


@pytest.mark.parametrize("field", ["total_mb", "used_mb", "free_mb"])
def test_a_fresh_reading_carries_no_stale_number(field):
    """A degraded read is None WITH a reason — never a number kept warm
    from a previous call. Free VRAM that cannot move is the whole failure
    this module exists to end."""
    vram = devices_vram.Vram(reason="nvidia-smi could not be run")
    assert getattr(vram, field) is None


# ── Utilisation (2026-09-15) ─────────────────────────────────────────────
#
# Memory alone answers the wrong question. The card had 6.9 GB free —
# comfortable — and sat at 99% against a process outside every container on
# the machine, so ollama was timesharing the shader cores and chat turns
# took 100-400 s. A reading that says only "6.9 GB free" describes that card
# as healthy, and `inference_degraded` reports what this reading says.


def test_utilisation_is_read_when_the_driver_reports_it():
    vram = devices_vram.parse("24576, 17663, 6913, 99\n")
    assert vram.util_pct == 99
    assert vram.free_mb == 6913


def test_a_driver_that_reports_no_utilisation_still_gives_its_memory():
    """It is the LAST field for exactly this reason: an old driver, or one
    printing [N/A], must cost the utilisation and not the whole line."""
    assert devices_vram.parse("24576, 9662, 14914\n").util_pct is None
    partial = devices_vram.parse("24576, 9662, 14914, [N/A]\n")
    assert partial.util_pct is None
    assert partial.free_mb == 14914


def test_the_biggest_card_still_wins_and_brings_its_own_utilisation():
    vram = devices_vram.parse("8192, 1000, 7192, 5\n24576, 17663, 6913, 99\n")
    assert vram.total_mb == 24576
    assert vram.util_pct == 99


def test_a_percent_sign_does_not_defeat_the_reading():
    """nounits is asked for, but a driver that prints one anyway must not
    turn a busy card into an unknown one."""
    assert devices_vram.parse("24576, 17663, 6913, 99 %\n").util_pct == 99
