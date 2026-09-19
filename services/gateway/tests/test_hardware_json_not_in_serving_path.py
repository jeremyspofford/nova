"""hardware.json may not decide anything live. The tripwire for S22.

Owner ruling 2026-09-14, in his own words: "Nova should do the work ad-hoc
to get the resources live, not read stale shit."

The file install.sh writes is a record of a machine as it was at install
time. For the two years of this codebase's history it was ALSO the source
of total VRAM in every live fit decision, and free VRAM was computed from a
flag nothing ever set — so free VRAM was identically total VRAM and could
not move. On 2026-09-12 a video game held 7 GB of this card for six hours
and the product reported the full 24 GB free the entire time.

Deleting the reader was not enough on its own: the file is still there, it
still parses, and it is exactly the convenient thing to reach for the next
time some surface needs a VRAM number. These tests are the line of code
that refuses.

What the file MAY still do: suggest a tier during install, and only when
the card cannot be read at all — the one situation it is genuinely better
than nothing, on a container without GPU passthrough during the install
that wrote it.
"""

from __future__ import annotations

import ast
import pathlib

from app import admin, catalog, engines, fit, routing, suggest

APP_DIR = pathlib.Path(admin.__file__).parent

# Every module that answers a question about the card WHILE SERVING. None of
# them may name the file or the function that reads it.
# S40: engines states what the hub's card is while serving (EngineView.facts).
SERVING_MODULES = (fit, catalog, engines, routing, suggest)


def _reads_hardware(module) -> bool:
    source = pathlib.Path(module.__file__).read_text()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in {"HARDWARE_PATH", "_read_hardware"}:
            return True
        if isinstance(node, ast.Attribute) and node.attr in {"HARDWARE_PATH", "_read_hardware"}:
            return True
    return False


def test_no_serving_module_reads_the_install_time_file():
    offenders = [m.__name__ for m in SERVING_MODULES if _reads_hardware(m)]
    assert offenders == [], (
        f"{offenders} read hardware.json. A serving decision must read the card live "
        "(app/devices_vram.read_vram) — the file says what the machine looked like when "
        "install.sh ran, which is not an answer to a question asked now."
    )


def test_the_fit_path_asks_the_card_and_nothing_else():
    """`_free_and_total_vram_gb` is where every fit verdict's numbers come
    from. It must call the live reader, and it must not take a hardware
    dict — a parameter it cannot use is a parameter someone will fill in."""
    source = pathlib.Path(admin.__file__).read_text()
    tree = ast.parse(source)
    func = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_free_and_total_vram_gb"
    )
    body = ast.unparse(func)
    assert "devices_vram.read_vram()" in body
    assert "hardware" not in {a.arg for a in func.args.args}
    assert "HARDWARE_PATH" not in body
    assert "_read_hardware" not in body


def test_the_only_remaining_reader_is_the_install_time_tier():
    """admin.py may still read the file — for GET /admin/hardware (which
    reports it as what it is) and as the tier FALLBACK. Pinning the call
    sites means a third one has to be argued for, not just added."""
    source = pathlib.Path(admin.__file__).read_text()
    tree = ast.parse(source)
    callers = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef):
            continue
        if node.name == "_read_hardware":
            continue
        if "_read_hardware()" in ast.unparse(node):
            callers.append(node.name)
    assert sorted(callers) == ["hardware", "suggest_route"], sorted(callers)


def test_the_tier_prefers_the_live_card_over_the_file():
    """Pure, so it is checkable without a route: a live reading wins, and
    the file is consulted only when there is no live reading at all."""
    stale = {"gpus": [{"name": "an old card", "vram_mb": 6144}]}
    assert suggest.suggest(stale, [], 24.0)["tier"] == suggest.TIER_27B
    assert suggest.suggest(stale, [], None)["tier"] == suggest.TIER_4B
