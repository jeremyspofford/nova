"""S30b T5: the agent's admin_path section, as core records and states it.

Pure — no database. The section's shape is the agent's (apps/novad/internal/
admin/path.go PathState): {installed, kind sudoers|task|none, state, said?,
pending?}. A malformed one is dropped with the reason, never guessed, and
never takes the rest of the frame down with it."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app import device_facts as df
from app import devices

AT = "2026-10-11T09:00:00Z"
INSTALLED_SUDOERS = {"installed": True, "kind": "sudoers", "state": "ready"}
INSTALLED_TASK = {"installed": True, "kind": "task", "state": "ready"}
ABSENT = {"installed": False, "kind": "none", "state": "absent"}
ELEVATION = {"elevated": False, "sudo": "no_password"}


def _frame(admin_path=None, **extra) -> dict:
    frame = {"type": "facts", "elevation": ELEVATION, "unreadable": [], "probed_at": AT, **extra}
    if admin_path is not None:
        frame["admin_path"] = admin_path
    return frame


def _said(facts, platform: str) -> str:
    line = df.admin_path_line(facts, platform)
    assert isinstance(line, str), f"no line: {line!r}"
    return line


def _facts(admin_path=None, **extra) -> dict:
    return df.merge_frame(None, df.validate_frame(_frame(admin_path, **extra)))


# -- C1: the section as the agent sends it -------------------------------------


def test_admin_path_is_a_frame_section_and_a_probe_section():
    assert "admin_path" in df.FRAME_SECTIONS
    assert "admin_path" in df.PROBE_SECTIONS
    assert df.probe_owned({"item": "admin_path", "reason": "x"}) is True


@pytest.mark.parametrize(
    "section",
    [
        INSTALLED_SUDOERS,
        INSTALLED_TASK,
        {"installed": True, "kind": "task", "state": "running"},
        {"installed": True, "kind": "task", "state": "disabled"},
        ABSENT,
        {
            "installed": False,
            "kind": "none",
            "state": "incomplete",
            "said": "the root copy is there but sudo does not allow it: a password is required",
        },
        {"installed": False, "kind": "none", "state": "unknown", "said": "sudo did not answer"},
        {
            "installed": False,
            "kind": "none",
            "state": "pending_restart",
            "said": "the agent copy is moved aside to C:\\x.exe and is deleted at the next restart",
            "pending": ["C:\\Program Files\\Nova\\novad-admin-removed-0a1b2c3d.exe"],
        },
    ],
)
def test_each_shape_the_agent_sends_is_recorded(section):
    got = df.validate_frame(_frame(section))
    want = {"said": "", "pending": [], **section}
    assert got.get("admin_path") == want
    assert got["unreadable"] == []


def test_a_null_pending_reads_as_none_pending():
    got = df.validate_frame(_frame({**ABSENT, "pending": None}))
    assert (got.get("admin_path") or {}).get("pending") == []


def test_unknown_keys_in_the_section_are_not_stored():
    got = df.validate_frame(_frame({**INSTALLED_SUDOERS, "build": "abc", "left": ["x"]}))
    assert set(got.get("admin_path") or {}) == {"installed", "kind", "state", "said", "pending"}


def test_a_frame_without_probed_at_does_not_record_admin_path():
    frame = {"type": "facts", "admin_path": INSTALLED_SUDOERS, "unreadable": []}
    merged = df.merge_frame({"admin_path": ABSENT, "probed_at": AT}, df.validate_frame(frame))
    assert merged["admin_path"] == ABSENT


def test_a_probe_that_omits_admin_path_removes_the_older_one():
    older = _facts(INSTALLED_SUDOERS)
    newer = df.validate_frame({**_frame(), "probed_at": "2026-10-11T10:00:00Z"})
    assert "admin_path" not in df.merge_frame(older, newer)


# -- C2: malformed is dropped, with the reason, never guessed ------------------


@pytest.mark.parametrize(
    "section,why",
    [
        ("installed", "must be an object"),
        ({**INSTALLED_SUDOERS, "installed": "yes"}, "installed"),
        ({**INSTALLED_SUDOERS, "kind": "service"}, "kind"),
        ({**INSTALLED_SUDOERS, "state": "maybe"}, "state"),
        ({**INSTALLED_SUDOERS, "kind": "none"}, "installed"),
        ({**ABSENT, "kind": "sudoers"}, "installed"),
        ({**ABSENT, "said": "line one\nline two"}, "said"),
        ({**ABSENT, "pending": "C:\\x.exe"}, "pending"),
        ({**ABSENT, "pending": ["C:\\a\n.exe"]}, "pending"),
        ({**ABSENT, "pending": ["C:\\x.exe"] * 33}, "pending"),
        ({"kind": "none", "state": "absent"}, "installed"),
    ],
)
def test_a_malformed_admin_path_is_dropped_with_the_reason_and_the_frame_kept(section, why):
    got = df.validate_frame(_frame(section))
    assert "admin_path" not in got
    assert got["elevation"]["sudo"] == "no_password" and got["probed_at"] == AT
    dropped = [u for u in got["unreadable"] if u["item"] == "admin_path"]
    assert len(dropped) == 1
    assert dropped[0]["reason"].startswith("core dropped the admin_path section: ")
    assert why in dropped[0]["reason"]


def test_the_drop_reason_joins_what_the_agent_said_unreadable():
    frame = _frame({**INSTALLED_SUDOERS, "kind": 7})
    frame["unreadable"] = [{"item": "folders.desktop", "reason": "no desktop"}]
    got = df.validate_frame(frame)
    assert [u["item"] for u in got["unreadable"]] == ["folders.desktop", "admin_path"]


def test_a_frame_with_only_a_malformed_admin_path_still_says_why():
    got = df.validate_frame({"type": "facts", "admin_path": [], "probed_at": AT})
    assert "admin_path" not in got
    assert [u["item"] for u in got.get("unreadable", [])] == ["admin_path"]


# -- C3: the one line ---------------------------------------------------------


def test_an_installed_sudoers_rule_is_said():
    line = _said(_facts(INSTALLED_SUDOERS), "linux")
    assert line.startswith("admin path: installed (sudoers rule)")
    assert "root" in line


def test_an_installed_scheduled_task_is_said():
    line = _said(_facts(INSTALLED_TASK), "windows")
    assert line.startswith("admin path: installed (scheduled task)")
    assert "elevated" in line


def test_a_running_task_reads_as_installed_and_a_disabled_one_says_so():
    running = _said(_facts({**INSTALLED_TASK, "state": "running"}), "windows")
    assert running.startswith("admin path: installed (scheduled task)")
    assert "disabled" not in running
    disabled = _said(_facts({**INSTALLED_TASK, "state": "disabled"}), "windows")
    assert disabled.startswith("admin path: installed (scheduled task)")
    assert "disabled" in disabled


def test_an_absent_path_is_not_installed():
    assert _said(_facts(ABSENT), "linux") == "admin path: not installed"


def test_an_incomplete_path_states_what_the_agent_said():
    said = "the task is absent but the request directory is still there"
    line = _said(_facts({**ABSENT, "state": "incomplete", "said": said}), "windows")
    assert line.startswith("admin path: not installed")
    assert said in line


def test_an_unreadable_path_is_unknown_in_the_agents_words():
    said = "sudo did not answer whether the rule allows the root copy: timeout"
    line = _said(_facts({**ABSENT, "state": "unknown", "said": said}), "linux")
    assert line.startswith("admin path: unknown")
    assert said in line
    assert "not installed" not in line


def test_a_moved_aside_copy_is_said_to_go_at_the_next_restart():
    aside = "C:\\Program Files\\Nova\\novad-admin-removed-0a1b2c3d.exe"
    section = {
        **ABSENT,
        "state": "pending_restart",
        "said": "anything",
        "pending": [aside],
    }
    line = _said(_facts(section), "windows")
    assert line.startswith("admin path: not installed")
    assert aside in line and "deleted at the next restart" in line


def test_a_pending_aside_beside_an_installed_task_is_said_too():
    aside = "C:\\Program Files\\Nova\\novad-admin-removed-0a1b2c3d.exe"
    line = _said(_facts({**INSTALLED_TASK, "pending": [aside]}), "windows")
    assert line.startswith("admin path: installed (scheduled task)")
    assert aside in line and "deleted at the next restart" in line


@pytest.mark.parametrize(
    "section,platform",
    [(INSTALLED_TASK, "linux"), (INSTALLED_TASK, "darwin"), (INSTALLED_SUDOERS, "windows")],
)
def test_a_kind_foreign_to_the_platform_is_unknown_never_installed(section, platform):
    line = _said(_facts(section), platform)
    assert line.startswith("admin path: unknown")
    assert section["kind"] in line and platform in line


def test_a_probed_agent_without_the_section_predates_the_admin_path():
    assert _said(_facts(), "linux") == ("admin path: unknown — this agent predates the admin path")


def test_a_dropped_section_is_unknown_with_cores_reason_never_predates():
    line = _said(_facts({**INSTALLED_SUDOERS, "kind": "service"}), "linux")
    assert line.startswith("admin path: unknown")
    assert "core dropped the admin_path section" in line and "predates" not in line


def test_an_agent_that_never_probed_gets_no_admin_path_line():
    assert df.admin_path_line(None, "linux") is None
    assert df.admin_path_line({"v": 2, "hostname": "h"}, "linux") is None


def test_the_line_is_one_line_whatever_the_agent_stored():
    # Stored facts from before a stricter check: rendered as one line anyway.
    facts = {"probed_at": AT, "admin_path": {**ABSENT, "state": "unknown", "said": "a\nb"}}
    line = _said(facts, "linux")
    assert "\n" not in line


# -- C4: where it is shown ------------------------------------------------------


def test_the_acting_lines_carry_it_right_after_the_elevation_line():
    lines = df.acting_lines(_facts(INSTALLED_SUDOERS), "linux")
    at = next(i for i, line in enumerate(lines) if line.startswith("elevation:"))
    assert at + 1 < len(lines), lines
    assert lines[at + 1].startswith("admin path: installed (sudoers rule)")


def test_the_acting_lines_of_a_never_probed_agent_have_no_admin_path_line():
    assert not any(line.startswith("admin path") for line in df.acting_lines(None, "linux"))


def _row(facts) -> dict:
    return {
        "id": "00000000-0000-4000-8000-000000000001",
        "name": "Beelink Mini S",
        "platform": "linux",
        "hostname": "mini",
        "enrolled_at": datetime(2026, 10, 1, tzinfo=UTC),
        "last_seen": None,
        "revoked_at": None,
        "facts": facts,
        "facts_at": None,
    }


def _spec(facts, platform: str = "linux") -> object:
    return devices.device_spec({**_row(facts), "platform": platform}).get("admin_path", "missing")


def test_device_spec_says_the_admin_path_installed_and_kind_in_cores_words():
    # T8 G1: the payload carries core's own line, so the tile and Nova can't
    # disagree; `installed` is core's platform-checked verdict.
    assert _spec(_facts(INSTALLED_SUDOERS)) == {
        "installed": True,
        "kind": "sudoers",
        "line": _said(_facts(INSTALLED_SUDOERS), "linux"),
    }
    assert _spec(_facts(INSTALLED_TASK), "windows") == {
        "installed": True,
        "kind": "task",
        "line": _said(_facts(INSTALLED_TASK), "windows"),
    }
    assert _spec(_facts(ABSENT)) == {
        "installed": False,
        "kind": "none",
        "line": "admin path: not installed",
    }


@pytest.mark.parametrize(
    "section,platform,starts,has",
    [
        (
            {**ABSENT, "state": "unknown", "said": "sudo -n -l failed: exit 1"},
            "linux",
            "admin path: unknown",
            "sudo -n -l failed: exit 1",
        ),
        (
            {**ABSENT, "state": "incomplete", "said": "the task is absent but the copy is left"},
            "windows",
            "admin path: not installed — part of it is left",
            "the copy is left",
        ),
        (
            {
                **ABSENT,
                "state": "pending_restart",
                "pending": ["C:\\Nova\\novad-admin-removed-1.exe"],
            },
            "windows",
            "admin path: not installed",
            "C:\\Nova\\novad-admin-removed-1.exe is deleted at the next restart",
        ),
    ],
)
def test_device_spec_carries_cores_words_for_a_path_that_is_not_plainly_absent(
    section, platform, starts, has
):
    spec = _spec(_facts(section), platform)
    assert isinstance(spec, dict) and spec["installed"] is False
    assert spec.get("line") == _said(_facts(section), platform)
    line = spec.get("line") or ""
    assert line.startswith(starts) and has in line


def test_device_spec_never_says_installed_for_a_kind_foreign_to_the_platform():
    spec = _spec(_facts(INSTALLED_TASK), "linux")
    assert isinstance(spec, dict) and spec["installed"] is False
    assert (spec.get("line") or "").startswith("admin path: unknown")


def test_device_spec_says_unknown_for_a_probed_agent_without_the_section_or_a_dropped_one():
    assert _spec(_facts()) == {
        "installed": False,
        "kind": None,
        "line": "admin path: unknown — this agent predates the admin path",
    }
    dropped = _spec(_facts({**INSTALLED_SUDOERS, "kind": "service"}))
    assert isinstance(dropped, dict) and dropped["installed"] is False
    assert "core dropped the admin_path section" in (dropped.get("line") or "")


def test_device_spec_says_none_when_the_agent_never_probed():
    assert _spec(None) is None
    assert _spec({"v": 2, "hostname": "h"}) is None
