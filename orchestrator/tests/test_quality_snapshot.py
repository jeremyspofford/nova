"""Tests for quality_loop/snapshot.py — config snapshot capture and dedup."""
from __future__ import annotations

from app.quality_loop.snapshot import hash_config, normalize_config


def test_normalize_config_sorts_keys_recursively():
    """Two configs that differ only in key order produce the same normalized form."""
    a = {"models": {"fast": "haiku", "balanced": "sonnet"}, "retrieval": {"top_k": 5}}
    b = {"retrieval": {"top_k": 5}, "models": {"balanced": "sonnet", "fast": "haiku"}}
    assert normalize_config(a) == normalize_config(b)


def test_hash_config_stable_across_orderings():
    """Same content, different ordering -> same hash."""
    a = {"a": 1, "b": {"c": 2, "d": 3}}
    b = {"b": {"d": 3, "c": 2}, "a": 1}
    assert hash_config(a) == hash_config(b)


def test_hash_config_different_content():
    """Different content -> different hash."""
    a = {"retrieval": {"top_k": 5}}
    b = {"retrieval": {"top_k": 7}}
    assert hash_config(a) != hash_config(b)


def test_hash_config_returns_64_char_hex():
    """SHA-256 hex digest is 64 chars."""
    h = hash_config({"x": 1})
    assert len(h) == 64
    assert all(c in "0123456789abcdef" for c in h)
