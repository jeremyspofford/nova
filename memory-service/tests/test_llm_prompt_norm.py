"""Tests for the prompt-hash normalizer used by fake_llm."""

from __future__ import annotations

from ._llm_prompt_norm import hash_prompt, normalize_prompt


def test_strips_iso8601_timestamps():
    raw = "It is currently 2026-05-05T17:30:21Z. Continue."
    norm = normalize_prompt(raw)
    assert "2026-05-05T17:30:21Z" not in norm
    assert "<ISO8601>" in norm


def test_strips_iso8601_with_microseconds_and_offset():
    raw = "Time: 2026-05-05T17:30:21.123456+00:00"
    assert "<ISO8601>" in normalize_prompt(raw)


def test_strips_uuids():
    raw = "session_id=00000000-0000-0000-0000-000000000001 in this turn"
    norm = normalize_prompt(raw)
    assert "00000000-0000-0000-0000-000000000001" not in norm
    assert "<UUID>" in norm


def test_strips_session_id_value():
    raw = "session_id=abc123xyz"
    norm = normalize_prompt(raw)
    assert "session_id=<SID>" in norm


def test_hash_stable_across_normalized_inputs():
    a = "Time: 2026-05-05T17:30:21Z, session_id=abc"
    b = "Time: 2026-05-06T10:00:00Z, session_id=xyz"
    assert hash_prompt(a) == hash_prompt(b)


def test_hash_differs_on_substantive_change():
    a = "Time: 2026-05-05T17:30:21Z. Summarize this user message."
    b = "Time: 2026-05-05T17:30:21Z. Decompose this user message."
    assert hash_prompt(a) != hash_prompt(b)


def test_custom_normalizer_chains():
    """Tests can pass extra normalizers (e.g., strip a model version banner)."""
    extra = lambda s: s.replace("model=phi-3", "model=<MODEL>")  # noqa: E731
    raw = "model=phi-3, prompt=hello"
    norm = normalize_prompt(raw, extra_normalizers=[extra])
    assert "<MODEL>" in norm
