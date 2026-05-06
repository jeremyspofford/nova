"""Aggregator combines (cmd_results, quartet_review, criteria_eval) → outcome string.

This test fails today (no aggregator module) and starts passing after Task 11.
"""
from cortex.app.maturation.aggregator import aggregate


def _r(*exit_codes):
    return [{"cmd": f"c{i}", "exit_code": e} for i, e in enumerate(exit_codes)]


def test_all_green_passes():
    assert aggregate(_r(0, 0), {"confidence": 0.9}, [{"pass": True}] * 3) == "pass"


def test_command_fail_with_quartet_agreement_fails():
    assert aggregate(_r(0, 1), {"confidence": 0.85}, [{"pass": True}] * 2) == "fail"


def test_command_fail_with_low_quartet_confidence_human_review():
    assert aggregate(_r(0, 1), {"confidence": 0.4}, [{"pass": True}] * 2) == "human-review"


def test_all_green_but_quartet_low_confidence_human_review():
    assert aggregate(_r(0, 0), {"confidence": 0.3}, [{"pass": True}] * 4) == "human-review"


def test_no_commands_passes_when_quartet_high():
    assert aggregate([], {"confidence": 0.9}, [{"pass": True}] * 2) == "pass"


def test_no_commands_human_review_when_quartet_low():
    assert aggregate([], {"confidence": 0.6}, [{"pass": True}]) == "human-review"


def test_majority_criteria_fail_blocks_pass():
    assert aggregate(
        _r(0),
        {"confidence": 0.9},
        [{"pass": True}, {"pass": False}, {"pass": False}, {"pass": False}],
    ) == "fail"
