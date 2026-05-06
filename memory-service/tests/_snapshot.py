"""Lightweight JSON snapshot assertion helper.

Usage:
    assert_snapshot(actual_dict_or_list, path=Path("fixtures/snapshots/foo.json"))

Replay (default): compares actual to file content, raises on mismatch.
Update: when UPDATE_SNAPSHOTS=1 is set, writes the new value (creating the
file if absent). Used to seed initial snapshots and refresh after intended
behavior changes.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def _normalize(value: Any) -> Any:
    """Round-trip through JSON to normalize tuple→list, set→list (sorted), datetime→str."""
    return json.loads(json.dumps(value, default=str, sort_keys=True))


def assert_snapshot(actual: Any, *, path: Path) -> None:
    update = os.environ.get("UPDATE_SNAPSHOTS") == "1"
    normalized = _normalize(actual)

    if update:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(normalized, indent=2, sort_keys=True))
        return

    if not path.exists():
        raise FileNotFoundError(
            f"Snapshot {path} does not exist. Run with UPDATE_SNAPSHOTS=1 to create it."
        )

    expected = json.loads(path.read_text())
    if expected != normalized:
        diff = (
            f"snapshot mismatch at {path}\n"
            f"--- expected\n{json.dumps(expected, indent=2, sort_keys=True)}\n"
            f"+++ actual\n{json.dumps(normalized, indent=2, sort_keys=True)}"
        )
        raise AssertionError(diff)
