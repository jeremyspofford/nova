"""Loads the curated model catalog — a static, in-repo JSON file.

Every slug in the file was checked against the live ollama library on
2026-08-28 (base page and exact tag), so `verify_at_walk` is false on every
row and each carries the `verified_url` it was checked against. The field
stays in the schema because the debt it marks recurs: a slug added later
starts life unverified, and test_curated.py refuses to let one ship that way.
"""
from __future__ import annotations

import json
from pathlib import Path

CURATED_PATH = Path(__file__).resolve().parent / "curated_models.json"


def load_curated(path: Path | None = None) -> list[dict]:
    """The curated catalog, as a list of entry dicts."""
    target = path or CURATED_PATH
    return json.loads(target.read_text())
