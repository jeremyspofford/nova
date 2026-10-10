"""S29b T3 — every registered tool is classified: covered, excused, or inside.

A capability row (guards._CAPABILITY_TOOLS) is what corrects "I can't search
the web" while web_search is registered. A tool that acts on a device or the
web with no row lets that denial stand. This tripwire makes every new tool
somebody's decision the day it lands — the same shape as test_live_facts'
AUTO_RUN / NOT_AUTO_RUN classification.

Criteria:
  C1 exhaustive: every tool in tools.REGISTRY is in exactly one of
       (a) covered — the tool of some _CAPABILITY_TOOLS row, read live;
       (b) EXCUSED — acts on a device or the web, no row, with a reason;
       (c) NO_OUTSIDE_ACTION — acts only inside Nova, with a reason.
     A monkeypatched new tool in none of them is red, and the message tells
     the author to classify it.
  C2 a name in EXCUSED or NO_OUTSIDE_ACTION that is not registered is red
     (stale); a blank reason is red.
  C3 a tool in two buckets is red (covered+excused, covered+inside,
     excused+inside).
  C4 the tools a module-based derivation missed are classified honestly:
     start_change / list_changes (shell.exec / fs.read on a device through
     devices._command) and nova_update (the hub's agent runs ./install
     update) are EXCUSED; machine_update is covered, and dropping its row
     turns C1 red (it would otherwise slip).

Assumptions (design calls, orchestrator ruling 10-09):
  - No derivation of "acts outside" from where a tool is defined: the module
    leaks (changes.py and about.py act on a device). The classification is
    exhaustive and hand-held here, like live_facts' — a snapshot that reddens.
  - Covered = {tool for _, tool in guards._CAPABILITY_TOOLS}, read live.
"""

from __future__ import annotations

import pytest

from app import guards, tools
from app.tools.base import Tool

# (b) acts on a device or the web, has no capability row.
EXCUSED: dict[str, str] = {
    "browser_back": (
        "navigation inside an open browser session; a denial of browsing is "
        "fetch_url's and browser_open's rows"
    ),
    "browser_read": (
        "reads the page browser_open already opened; a denial of browsing is "
        "fetch_url's and browser_open's rows"
    ),
    "device_list": (
        "reads the device roster; 'I can't see your devices' is a state "
        "claim, machine_status's territory, not a capability row"
    ),
    "device_info": ("reads one device's roster entry; same territory as device_list"),
    "device_list_apps": (
        "an inventory read; the capability denial is 'open apps', which "
        "device_launch_app's row corrects"
    ),
    "start_change": (
        "runs git on the machine holding her repository through devices._command; "
        "the honest denial shape ('I can't change my own code') has no row yet — "
        "self-coding lane (S30+)"
    ),
    "list_changes": (
        "reads her worktrees on the repository machine through devices._command; "
        "an inventory read like device_list_apps, no denial shape of its own"
    ),
    "nova_update": (
        "the hub's agent runs ./install update via devices_ws.hub.command; "
        "'I can't update myself' has no row yet"
    ),
    "inference_health": (
        "reads every model machine's GPU through the gateway; a state read — "
        "'the GPU is busy' is a fact, not a capability denial"
    ),
    "mcp_tools": (
        "may refresh a connected MCP server's tool list over the network; a "
        "lookup before mcp_call, whose row covers the denial"
    ),
    "nova_about": (
        "reads GitHub's default branch for newer commits; a state read of "
        "this instance, no capability denial shape"
    ),
    "nova_address": (
        "reads the tailnet for this hub's address; a state read — 'there is "
        "no address' is a fact, not a capability denial"
    ),
    # S30a T5 (2026-10-09): no row reads "I can't edit files on your computer"
    # today (capability_claim_check returns None on it). A row belongs with
    # paired negatives in test_capability_guard.py — a stated follow-up.
    "device_edit_file": (
        "replaces one snippet in a file on a device; 'I can't edit files on your "
        "computer' has no row yet — device_write_file's row covers writing files"
    ),
    # S30a T7 (2026-10-10): capability_claim_check returns None on "I can't
    # search files on your computer" / "I can't search your code" today. A row
    # belongs with paired negatives in test_capability_guard.py — follow-up.
    "device_search": (
        "searches a directory tree on a device for a pattern; 'I can't search "
        "your code' has no row yet — device_read_file's and device_list_files' "
        "rows cover reading and listing"
    ),
    "run_skill": (
        "acts only through the registered tools its steps call, each of which "
        "is classified here on its own"
    ),
}

# (c) acts only inside Nova.
NO_OUTSIDE_ACTION: dict[str, str] = {
    "cancel_timer": "deletes one of this person's timers in Nova's database",
    "list_timers": "reads Nova's timers table",
    "get_time": "reads the clock",
    "load_skill": "reads a written procedure from Nova's store",
    "mcp_disconnect": "deletes the server row and its token in Nova; sends nothing to the server",
    "memory_backfill": "writes notes from stored conversation, inside Nova's memory service",
    "memory_forget": "deletes a note in Nova's memory service",
    "notices": "reads Nova's Inbox",
    "notice_mute": "a noise preference row in Nova",
    "notice_seen": "a read receipt row in Nova",
    "notice_seen_all": "read receipts in Nova",
    "route_explain": "reads Nova's routing config from her gateway",
    "set_chat_model": "writes the chat pick in Nova's settings",
    "spend_report": "reads Nova's spend ledger",
    "update_agent": "edits an agent row in Nova",
}


def _covered() -> set[str]:
    return {tool for _, tool in guards._CAPABILITY_TOOLS}


def _classification_problems(excused: dict[str, str], inside: dict[str, str]) -> list[str]:
    """Every way the classification is broken right now, [] when it holds."""
    registered = set(tools.REGISTRY)
    buckets = {
        "a capability row": _covered(),
        "EXCUSED": set(excused),
        "NO_OUTSIDE_ACTION": set(inside),
    }
    problems: list[str] = []
    for name in sorted(registered):
        found = [label for label, names in buckets.items() if name in names]
        if not found:
            problems.append(
                f"{name}: unclassified — add a capability row in guards._CAPABILITY_TOOLS, "
                "or classify it in tests/test_capability_coverage.py as EXCUSED (acts on a "
                "device or the web, no row) or NO_OUTSIDE_ACTION (acts only inside Nova), "
                "with a reason"
            )
        elif len(found) > 1:
            problems.append(f"{name}: in two buckets ({' and '.join(found)})")
    for label, table in (("EXCUSED", excused), ("NO_OUTSIDE_ACTION", inside)):
        for name in sorted(set(table) - registered):
            problems.append(f"{name}: in {label} but not registered (stale)")
        for name, reason in sorted(table.items()):
            if not reason.strip():
                problems.append(f"{name}: in {label} with no reason")
    return problems


def _probe_tool(name: str) -> Tool:
    async def executor(args: dict, ctx) -> str:  # pragma: no cover
        return "ok"

    return Tool(
        name=name,
        description="a tripwire probe",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=executor,
    )


# -- C1 ---------------------------------------------------------------------


def test_c1_every_registered_tool_is_classified_exactly_once():
    assert _classification_problems(EXCUSED, NO_OUTSIDE_ACTION) == []


def test_c1_a_new_unclassified_tool_is_red_and_says_how_to_fix_it(monkeypatch):
    monkeypatch.setitem(tools.REGISTRY, "probe_new_tool", _probe_tool("probe_new_tool"))
    problems = _classification_problems(EXCUSED, NO_OUTSIDE_ACTION)
    assert len(problems) == 1, problems
    assert problems[0].startswith("probe_new_tool: unclassified")
    assert "EXCUSED" in problems[0] and "NO_OUTSIDE_ACTION" in problems[0]


@pytest.mark.parametrize("bucket", ["excused", "inside"])
def test_c1_classifying_the_new_tool_with_a_reason_clears_it(monkeypatch, bucket):
    monkeypatch.setitem(tools.REGISTRY, "probe_new_tool", _probe_tool("probe_new_tool"))
    excused, inside = dict(EXCUSED), dict(NO_OUTSIDE_ACTION)
    (excused if bucket == "excused" else inside)["probe_new_tool"] = "a probe"
    assert _classification_problems(excused, inside) == []


# -- C2 ---------------------------------------------------------------------


@pytest.mark.parametrize("bucket", ["excused", "inside"])
def test_c2_a_stale_name_is_red(bucket):
    excused, inside = dict(EXCUSED), dict(NO_OUTSIDE_ACTION)
    (excused if bucket == "excused" else inside)["no_such_tool"] = "gone"
    problems = _classification_problems(excused, inside)
    assert any(p.startswith("no_such_tool:") and "stale" in p for p in problems), problems


@pytest.mark.parametrize(("bucket", "name"), [("excused", "device_list"), ("inside", "get_time")])
def test_c2_a_blank_reason_is_red(bucket, name):
    excused, inside = dict(EXCUSED), dict(NO_OUTSIDE_ACTION)
    (excused if bucket == "excused" else inside)[name] = "  "
    problems = _classification_problems(excused, inside)
    assert any(p.startswith(f"{name}:") and "no reason" in p for p in problems), problems


# -- C3 ---------------------------------------------------------------------


@pytest.mark.parametrize("name", ["device_run", "web_search", "machine_update"])
def test_c3_covered_and_excused_is_red(name):
    assert name in _covered()
    problems = _classification_problems({**EXCUSED, name: "double"}, NO_OUTSIDE_ACTION)
    assert any(p.startswith(f"{name}: in two buckets") for p in problems), problems


def test_c3_covered_and_inside_is_red():
    problems = _classification_problems(EXCUSED, {**NO_OUTSIDE_ACTION, "fetch_url": "double"})
    assert any(p.startswith("fetch_url: in two buckets") for p in problems), problems


def test_c3_excused_and_inside_is_red():
    problems = _classification_problems(EXCUSED, {**NO_OUTSIDE_ACTION, "start_change": "double"})
    assert any(p.startswith("start_change: in two buckets") for p in problems), problems


# -- C4 ---------------------------------------------------------------------


@pytest.mark.parametrize("name", ["start_change", "list_changes", "nova_update"])
def test_c4_the_device_acting_tools_outside_the_device_module_are_excused(name):
    assert name in tools.REGISTRY
    assert name in EXCUSED and EXCUSED[name].strip()
    assert name not in NO_OUTSIDE_ACTION


def test_c4_machine_update_is_covered_and_dropping_its_row_is_red(monkeypatch):
    assert "machine_update" in _covered()
    rows = [row for row in guards._CAPABILITY_TOOLS if row[1] != "machine_update"]
    monkeypatch.setattr(guards, "_CAPABILITY_TOOLS", rows)
    problems = _classification_problems(EXCUSED, NO_OUTSIDE_ACTION)
    assert any(p.startswith("machine_update: unclassified") for p in problems), problems


def test_s30a_t5_device_edit_file_is_registered_and_excused_with_its_reason():
    assert "device_edit_file" in tools.REGISTRY
    assert EXCUSED["device_edit_file"].strip()
    assert "device_edit_file" not in _covered()
    assert "device_edit_file" not in NO_OUTSIDE_ACTION


def test_s30a_t7_device_search_is_registered_and_excused_with_its_reason():
    assert "device_search" in tools.REGISTRY
    assert EXCUSED["device_search"].strip()
    assert "device_search" not in _covered()
    assert "device_search" not in NO_OUTSIDE_ACTION
