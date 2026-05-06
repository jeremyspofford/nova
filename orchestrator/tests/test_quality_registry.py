"""Tests for the loop registry."""
from __future__ import annotations

import pytest
from app.quality_loop.registry import LoopRegistry


class _DummyLoop:
    name = "test_loop"
    watches = ["memory_relevance"]
    agency = "alert_only"


def test_register_and_get():
    reg = LoopRegistry()
    reg.register(_DummyLoop())
    assert reg.get("test_loop").name == "test_loop"


def test_register_duplicate_raises():
    reg = LoopRegistry()
    reg.register(_DummyLoop())
    with pytest.raises(ValueError):
        reg.register(_DummyLoop())


def test_set_agency():
    reg = LoopRegistry()
    reg.register(_DummyLoop())
    reg.set_agency("test_loop", "auto_apply")
    assert reg.get("test_loop").agency == "auto_apply"


def test_set_agency_invalid_mode():
    reg = LoopRegistry()
    reg.register(_DummyLoop())
    with pytest.raises(ValueError):
        reg.set_agency("test_loop", "yolo")
