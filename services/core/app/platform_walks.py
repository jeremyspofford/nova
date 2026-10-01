"""Where Nova's agent has been walked on real hardware — the walk ledger
(hub-topology; S42b P22). One row per (os, arch, mode, role): the slice that
walked it and when, or null. show_setup_qr and machine_status read it, so
"not walked on a Mac" is said from a record. Each slice's definition of done
updates it (Task 32).

A walked OS is said with the arch and the mode it was walked as, so the line
is never read as more than was walked: Linux was walked on amd64 under its
systemd user unit, not on arm64; Windows on amd64 started by hand, not yet
under the Run key `install` writes."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

LEDGER = Path(__file__).with_name("platform_walks.json")
_NAMES = {"linux": "Linux", "darwin": "macOS", "windows": "Windows"}


@lru_cache(maxsize=1)
def rows() -> tuple[dict, ...]:
    return tuple(json.loads(LEDGER.read_text(encoding="utf-8"))["rows"])


def status(goos: str) -> str:
    """One OS (Go's GOOS) in the ledger's words. KeyError for an OS that is
    not one of the agent's targets: the ledger cannot speak for it."""
    name = _NAMES[goos]
    walked = sorted(
        (r for r in rows() if r["os"] == goos and r["walked_at"]), key=lambda r: r["walked_at"]
    )
    if walked:
        last = walked[-1]
        return (
            f"{name}: walked on real hardware ({last['slice']}, {last['walked_at']}, "
            f"{last['arch']} as {last['mode']})"
        )
    return f"{name}: built and tested in CI, not walked on {'a Mac' if goos == 'darwin' else name}"


def statuses() -> dict[str, str]:
    return {"linux": status("linux"), "macos": status("darwin"), "windows": status("windows")}
