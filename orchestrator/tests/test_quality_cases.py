"""Tests for quality_loop/cases.py — YAML fixture loader."""
from __future__ import annotations

from pathlib import Path

import pytest
from app.quality_loop.cases import load_cases


def test_load_cases_finds_all_seven_categories():
    """Loader walks the cases dir and returns one list per category."""
    cases_dir = Path(__file__).resolve().parents[2] / "benchmarks" / "quality" / "cases"
    cases = load_cases(cases_dir)
    categories = {c.category for c in cases}
    expected = {
        "factual_recall", "contradiction", "tool_selection",
        "hallucination", "temporal", "instruction_adherence",
        "safety_compliance",
    }
    assert categories == expected


def test_case_has_required_fields():
    """Every case has name, category, conversation, scoring."""
    cases_dir = Path(__file__).resolve().parents[2] / "benchmarks" / "quality" / "cases"
    cases = load_cases(cases_dir)
    for c in cases:
        assert c.name, f"case missing name in {c.category}"
        assert c.category
        assert c.conversation
        assert c.scoring


def test_load_cases_filter_by_category():
    """Optional category filter narrows the result."""
    cases_dir = Path(__file__).resolve().parents[2] / "benchmarks" / "quality" / "cases"
    cases = load_cases(cases_dir, category="factual_recall")
    assert all(c.category == "factual_recall" for c in cases)
    assert len(cases) >= 2


def test_invalid_yaml_raises(tmp_path):
    """A malformed case file raises a clear error, not silent skip."""
    bad = tmp_path / "broken.yaml"
    bad.write_text("- name: missing_required_fields\n")
    with pytest.raises((ValueError, KeyError)):
        load_cases(tmp_path)


def test_dict_yaml_raises_clear_error(tmp_path):
    """Top-level dict (instead of list) raises a clear error."""
    bad = tmp_path / "bad.yaml"
    bad.write_text("name: lone_case\ncategory: factual_recall\nconversation: []\nscoring: {}\n")
    with pytest.raises(ValueError, match="expected a YAML list of cases"):
        load_cases(tmp_path)
