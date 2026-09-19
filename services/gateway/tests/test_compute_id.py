"""app/compute_id.py — D10, the one grammar for which hardware produced a number.

Every shared case lives in docs/contracts/compute_id_vectors.json, the file the
Go agent's tests read from S44: both implementations are pinned by the SAME
cases, so neither can drift without a red test. bundled_accelerators is the
gateway's own reading (one nvidia-smi call), so its cases live here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import compute_id, devices_vram

VECTORS_PATH = (
    Path(__file__).resolve().parents[3] / "docs" / "contracts" / "compute_id_vectors.json"
)
VECTORS = json.loads(VECTORS_PATH.read_text())
UUID_A = "GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"
UUID_B = "GPU-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def _named(cases: list[dict]) -> list[str]:
    return [case["name"] for case in cases]


def test_the_vectors_are_the_version_this_code_implements():
    assert VECTORS["version"] == 1
    assert VECTORS["max_devices"] == compute_id.MAX_DEVICES == 4


@pytest.mark.parametrize("case", VECTORS["cpu_slug"], ids=_named(VECTORS["cpu_slug"]))
def test_cpu_slug(case):
    got = compute_id.cpu_slug(case["cpuinfo"], case["meminfo"], case["nproc"])
    assert got == case["expect"]
    assert compute_id.CPU_RE.fullmatch(got)


@pytest.mark.parametrize("case", VECTORS["cpu_slug_errors"], ids=_named(VECTORS["cpu_slug_errors"]))
def test_a_cpu_it_cannot_name_is_refused_never_guessed(case):
    with pytest.raises(ValueError):
        compute_id.cpu_slug(case["cpuinfo"], case["meminfo"], case["nproc"])


@pytest.mark.parametrize("case", VECTORS["gpu_cuda"], ids=_named(VECTORS["gpu_cuda"]))
def test_gpu_cuda(case):
    assert compute_id.gpu_cuda(case["uuid"]) == case["expect"]


@pytest.mark.parametrize("uuid", VECTORS["gpu_cuda_errors"])
def test_a_uuid_that_is_not_one_is_refused(uuid):
    with pytest.raises(ValueError):
        compute_id.gpu_cuda(uuid)


@pytest.mark.parametrize("case", VECTORS["served_on"], ids=_named(VECTORS["served_on"]))
def test_the_stamp_rule(case):
    got = compute_id.served_on(case["size"], case["size_vram"], case["accelerators"], case["cpu"])
    assert got == case["expect"]
    if got is not None:
        assert "+".join(compute_id.parse(got)) == got


@pytest.mark.parametrize(
    "case", VECTORS["parse_valid"], ids=[c["value"][:40] for c in VECTORS["parse_valid"]]
)
def test_parse(case):
    assert compute_id.parse(case["value"]) == case["expect"]


@pytest.mark.parametrize("value", VECTORS["parse_invalid"])
def test_parse_refuses_what_the_grammar_does_not_say(value):
    with pytest.raises(ValueError):
        compute_id.parse(value)


def test_served_on_refuses_a_device_outside_the_grammar():
    """Its inputs come from gpu_cuda/cpu_slug; anything else is a bug, and a
    bug must not become a row that means something new."""
    with pytest.raises(ValueError):
        compute_id.served_on(5, 5, ["gpu:GPU-x"], None)
    with pytest.raises(ValueError):
        compute_id.served_on(5, 0, [], "intel-n150")


def test_one_card_is_one_accelerator():
    reading = devices_vram.parse(f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n")
    assert compute_id.bundled_accelerators(reading.as_dict()) == [f"gpu:cuda:{UUID_A}"]


def test_two_cards_are_two_accelerators_and_so_no_model_is_stamped_on_either():
    reading = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n"
        f"8192, 100, 8092, 0, {UUID_B}, NVIDIA GeForce RTX 3060 Ti\n"
    ).as_dict()
    accelerators = compute_id.bundled_accelerators(reading)
    assert accelerators == sorted([f"gpu:cuda:{UUID_A}", f"gpu:cuda:{UUID_B}"])
    assert compute_id.served_on(5, 5, accelerators, "cpu:intel-n150|4c|15g") is None


def test_a_card_that_printed_no_uuid_makes_the_set_unnameable():
    """Naming only the card that did print one would stamp a model that may
    have run on the other: omitted, never guessed."""
    mixed = devices_vram.parse(
        f"24576, 2662, 21914, 3, {UUID_A}, NVIDIA GeForce RTX 3090\n8192, 100, 8092, 0, [N/A], X\n"
    )
    assert compute_id.bundled_accelerators(mixed.as_dict()) == []
    old_driver = devices_vram.parse("24576, 2662, 21914\n")
    assert compute_id.bundled_accelerators(old_driver.as_dict()) == []


def test_no_gpu_passed_through_is_no_accelerator():
    none = devices_vram.Vram(reason="nvidia-smi could not be run", absent=True)
    assert compute_id.bundled_accelerators(none.as_dict()) == []
