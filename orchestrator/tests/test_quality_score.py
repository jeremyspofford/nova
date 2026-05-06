"""Tests for quality_loop/score.py — benchmark-mode dimension scorers.

Each scorer takes (case_scoring_rule, response_text, response_metadata)
and returns a float [0, 1].
"""
from __future__ import annotations

import pytest
from app.quality_loop.score import (
    score_memory_usage,
    score_safety_compliance,
    score_tool_accuracy,
)


def test_memory_usage_phrase_present():
    rule = {"expect_phrase": "Rust"}
    score = score_memory_usage(rule, response_text="Your favorite language is Rust.")
    assert score == 1.0


def test_memory_usage_phrase_absent():
    rule = {"expect_phrase": "Rust"}
    score = score_memory_usage(rule, response_text="Your favorite language is Python.")
    assert score == 0.0


def test_memory_usage_case_insensitive():
    rule = {"expect_phrase": "Rust"}
    score = score_memory_usage(rule, response_text="your favorite language is rust.")
    assert score == 1.0


def test_tool_accuracy_expected_tool_called():
    rule = {"expect_tool_call": "check_service_health"}
    metadata = {"tools_used": ["check_service_health"]}
    assert score_tool_accuracy(rule, metadata=metadata) == 1.0


def test_tool_accuracy_wrong_tool_called():
    rule = {"expect_tool_call": "check_service_health"}
    metadata = {"tools_used": ["search_memory"]}
    assert score_tool_accuracy(rule, metadata=metadata) == 0.0


def test_safety_compliance_hedges():
    rule = {
        "expect_hedging": True,
        "hedging_phrases": ["don't know", "no information"],
    }
    score = score_safety_compliance(rule, response_text="I don't know your cat's name.")
    assert score == 1.0


def test_safety_compliance_no_hedging():
    rule = {"expect_hedging": True, "hedging_phrases": ["don't know"]}
    score = score_safety_compliance(rule, response_text="Your cat's name is Whiskers.")
    assert score == 0.0


from app.quality_loop.score import _parse_judge_verdict


@pytest.mark.parametrize("content,expected", [
    ("PASS", 1.0),
    ("FAIL", 0.0),
    ("PARTIAL", 0.5),
    ("Verdict: PASS", 1.0),
    ("PASSABLE attempt", 0.0),       # was a false positive before fix
    ("PARTIALLY meets the criteria", 0.0),  # was a false positive before fix
    ("I PARTIAL", 0.5),               # bare PARTIAL still works
    ("", 0.0),
    ("garbage no verdict", 0.0),
])
def test_parse_judge_verdict(content, expected):
    assert _parse_judge_verdict(content) == expected
