"""Tests for _map_source_type_to_kind in engram/ingestion.py.

The function is a pure dict-lookup helper with no I/O. We load it via
importlib.util directly from the filesystem so we can test it without
pulling in the full module-level dependency chain (DB, Redis, LLM gateway).
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

_INGESTION_PATH = Path(__file__).parents[1] / "app" / "engram" / "ingestion.py"


def _load_ingestion_module():
    """Load app.engram.ingestion with its heavy deps pre-stubbed.

    We inject fake module objects into sys.modules before calling
    spec_from_file_location so Python never tries to actually import
    nova-contracts, asyncpg, Redis, etc.
    """
    stubs = {
        "app": types.ModuleType("app"),
        "app.config": MagicMock(settings=MagicMock()),
        "app.db": types.ModuleType("app.db"),
        "app.db.database": MagicMock(AsyncSessionLocal=MagicMock()),
        "app.embedding": MagicMock(
            get_embedding=MagicMock(),
            get_redis=MagicMock(),
            to_pg_vector=MagicMock(),
        ),
        "app.engram": types.ModuleType("app.engram"),
        "app.engram.consolidation": MagicMock(notify_new_engrams=MagicMock()),
        "app.engram.cortex_stimulus": MagicMock(emit_to_cortex=MagicMock()),
        "app.engram.decomposition": MagicMock(decompose=MagicMock()),
        "app.engram.entity_resolution": MagicMock(
            resolve_entities=MagicMock(),
            link_engrams=MagicMock(),
            get_or_create_source=MagicMock(),
        ),
        "sqlalchemy": MagicMock(text=MagicMock()),
    }

    # Mark package stubs so submodule lookups work
    for mod in (stubs["app"], stubs["app.db"], stubs["app.engram"]):
        mod.__path__ = []  # type: ignore[attr-defined]
        mod.__package__ = mod.__name__

    saved = {}
    for name, stub in stubs.items():
        saved[name] = sys.modules.get(name)
        sys.modules[name] = stub

    # Remove any previously cached real ingestion module
    sys.modules.pop("app.engram.ingestion", None)

    try:
        spec = importlib.util.spec_from_file_location(
            "app.engram.ingestion", _INGESTION_PATH
        )
        module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
        sys.modules["app.engram.ingestion"] = module
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        return module
    finally:
        # Restore original sys.modules state for stub entries
        for name, original in saved.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original


_ingestion = _load_ingestion_module()
_map_source_type_to_kind = _ingestion._map_source_type_to_kind


def test_screenpipe_source_type_maps_to_screenpipe_source_kind():
    assert _map_source_type_to_kind("screenpipe") == "screenpipe"


def test_unknown_source_type_falls_back_to_manual_paste():
    # The default fallback is "manual_paste" per the mapping.get(...) call
    # at the end of _map_source_type_to_kind (ingestion.py line 201).
    result = _map_source_type_to_kind("nonexistent_kind_for_testing_xyz123")
    assert result == "manual_paste"
