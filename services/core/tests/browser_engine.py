"""The pinned browser engine's own answers, for tests (S38).

Captured 2026-09-30 from mcr.microsoft.com/playwright/mcp v0.0.82 (by digest)
by tests/fixtures/browser_engine/capture.py, against the throwaway site in
tests/fixtures/browser_engine/site/. A test reads the engine's real words here
rather than a shape someone remembered: a fixture that accepts what the
product never sees proves nothing.
"""

from __future__ import annotations

import json
from pathlib import Path

GOLDEN = Path(__file__).parent / "fixtures" / "browser_engine" / "v0.0.82"


def answer_text(step: str) -> str:
    """The text of the engine's answer to one captured step, e.g.
    "snapshot-index". The step name is matched exactly after its number, so
    "back" never finds "snapshot-after-back"."""
    (path,) = GOLDEN.glob(f"[0-9][0-9]-{step}.json")
    record = json.loads(path.read_text(encoding="utf-8"))
    return "\n".join(
        block.get("text", "")
        for message in record["messages"]
        for block in (message.get("result") or {}).get("content") or ()
        if block.get("type") == "text"
    )


def is_error(step: str) -> bool:
    """Whether the engine marked that answer isError."""
    (path,) = GOLDEN.glob(f"[0-9][0-9]-{step}.json")
    record = json.loads(path.read_text(encoding="utf-8"))
    return any(bool((m.get("result") or {}).get("isError")) for m in record["messages"])
