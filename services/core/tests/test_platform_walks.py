"""The walk ledger (S42b P22): every target has a row, and she reads walked or
not walked from it — never from a hope."""

from __future__ import annotations

import re

import pytest

from app import agent_dist, platform_walks


def test_every_target_has_a_row_of_the_right_shape():
    rows = platform_walks.rows()
    for goos, arch in agent_dist.TARGETS:
        assert any(r["os"] == goos and r["arch"] == arch for r in rows), (goos, arch)
    for r in rows:
        assert set(r) == {"os", "arch", "mode", "role", "slice", "walked_at"}
        assert r["mode"] in {"systemd-user", "launch-agent", "run-key", "foreground"}
        assert r["role"] == "hands" and re.fullmatch(r"S\d+[a-z]?", r["slice"])
        assert r["walked_at"] is None or re.fullmatch(r"\d{4}-\d{2}-\d{2}", r["walked_at"])
    # The walks on record, whole (fix round 1, a moved pin): S42a's Windows
    # walk alone. S5's 2026-09-03 walk ran inside WSL2 on the Dell, which
    # the card's Linux command cannot produce (since S42a an agent inside
    # WSL is "cannot" and `novad enroll` refuses there), so no native Linux
    # install has been walked; Task 32's mini PC walk dates the first.
    walked = {
        (r["os"], r["arch"], r["mode"], r["slice"], r["walked_at"]) for r in rows if r["walked_at"]
    }
    assert walked == {("windows", "amd64", "foreground", "S42a", "2026-09-28")}


def test_a_mac_is_said_not_walked_and_windows_walked():
    assert platform_walks.status("darwin") == "macOS: built and tested in CI, not walked on a Mac"
    assert platform_walks.status("windows").startswith("Windows: walked on real hardware")
    assert set(platform_walks.statuses()) == {"linux", "macos", "windows"}


def test_a_walked_os_names_the_walk_the_arch_and_the_mode():
    """What was walked is said exactly, so it is never read as more: Windows
    on amd64 started by hand (S42a's walk; the Run key is S42b's, not walked
    yet) — an arm64 machine reads the arch and knows it was not that one.
    Linux reads not walked (fix round 1, a moved pin): S5's walk ran inside
    WSL2, a configuration the card's Linux command cannot produce."""
    assert platform_walks.statuses() == {
        "linux": "Linux: built and tested in CI, not walked on Linux",
        "macos": "macOS: built and tested in CI, not walked on a Mac",
        "windows": "Windows: walked on real hardware (S42a, 2026-09-28, amd64 as foreground)",
    }


def test_the_latest_walk_of_an_os_is_the_one_said(monkeypatch):
    """When a slice walks an OS again (Task 32 records the Run key's walk on
    Windows), the newest walk is the one she reads, whatever the row order."""
    newer = {"os": "windows", "arch": "amd64", "mode": "run-key", "role": "hands"}
    older = {"os": "windows", "arch": "amd64", "mode": "foreground", "role": "hands"}
    monkeypatch.setattr(
        platform_walks,
        "rows",
        lambda: (
            {**newer, "slice": "S42b", "walked_at": "2026-10-05"},
            {**older, "slice": "S42a", "walked_at": "2026-09-28"},
        ),
    )
    assert platform_walks.status("windows") == (
        "Windows: walked on real hardware (S42b, 2026-10-05, amd64 as run-key)"
    )


def test_an_os_that_is_not_a_target_has_no_status():
    """A status is a statement from the ledger; an OS the ledger cannot speak
    for gets none, never a guessed "built and tested in CI"."""
    with pytest.raises(KeyError):
        platform_walks.status("plan9")
