"""Tests for _map_source_type_to_kind in engram/ingestion.py.

Rewritten in MEM-001 Task 5.7 to import the function directly instead of
loading ingestion.py via importlib with mock stubs. The original approach
left a mock-contaminated app.engram.ingestion in sys.modules, which broke
test_clustering.py tests that ran after this file.

The function is pure (dict lookup), so a direct import works fine.
"""

from __future__ import annotations

from app.engram.ingestion import _map_source_type_to_kind


def test_screenpipe_source_type_maps_to_screenpipe_source_kind():
    assert _map_source_type_to_kind("screenpipe") == "screenpipe"


def test_unknown_source_type_falls_back_to_manual_paste():
    # The default fallback is "manual_paste" per the mapping.get(...) call
    # at the end of _map_source_type_to_kind.
    result = _map_source_type_to_kind("nonexistent_kind_for_testing_xyz123")
    assert result == "manual_paste"
