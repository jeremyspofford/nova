"""The pinned browser engine's own answers, for tests (S38).

Captured 2026-09-30 from mcr.microsoft.com/playwright/mcp v0.0.82 (by digest)
by tests/fixtures/browser_engine/capture.py, against the throwaway site in
tests/fixtures/browser_engine/site/. A test reads the engine's real words here
rather than a shape someone remembered: a fixture that accepts what the
product never sees proves nothing.
"""

from __future__ import annotations

import contextlib
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


ORIGIN = "http://browser:8931"


def engine_tool(name: str, *steps: str, error: bool | None = None):
    """A fake engine tool answering with the captured texts of `steps`, in
    order (the last repeats). `error` defaults to what the capture says."""
    from app.mcp import fake

    results = tuple(
        {"text": answer_text(step), "is_error": is_error(step) if error is None else error}
        for step in steps
    )
    return fake.FakeTool(name, results=results)


@contextlib.contextmanager
def fake_engine(*tools):
    """Plant a strict 2025-era fake engine at http://browser:8931 for the body
    of a `with` — the real engine's era, answering as an event stream as it
    does (both measured). A context manager inside the test, because a
    ContextVar token is reset only where it was set."""
    from app.mcp import client, fake

    server = fake.FakeServer(
        fake.FakeSpec(
            title="Playwright",
            era="legacy",
            legacy_refusal="playwright",
            respond="sse",
            tools=tools,
        )
    )
    handle = client.plant({ORIGIN: fake.transport(server)})
    try:
        yield server
    finally:
        client.unplant(handle)
