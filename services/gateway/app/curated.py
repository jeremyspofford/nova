"""Loads the curated model catalog — a static, in-repo JSON file.

Every entry's slug needs live verification against the ollama library
(Task 7's DoD walk); `verify_at_walk` marks that debt on each row rather
than presenting a guess as a fact.
"""
from __future__ import annotations

import json
from pathlib import Path

CURATED_PATH = Path(__file__).resolve().parent / "curated_models.json"


def load_curated(path: Path | None = None) -> list[dict]:
    """The curated catalog, as a list of entry dicts."""
    target = path or CURATED_PATH
    return json.loads(target.read_text())
