"""S32.3 T4 — what each suite's run says, and the landing's verdict (pure).

Spec §5.2 step 6: green only when every suite ran and passed with no skip
caused by the environment; red when a suite failed; could_not_measure when
the box could not measure — never green by default.
"""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

from app import landing_plan
from app.landing_plan import (
    RUFF_SUITE,
    TAIL_BYTES,
    parse_counts,
    plan,
    planned_commands,
    suite_result,
    tail,
    verdict,
)

ROOT = Path(__file__).resolve().parents[3]
MAIN_SUITES = (ROOT / "deploy" / "devbox" / "suites.toml").read_text()

SMALL = """
protected = []

[[suite]]
name = "core"
dir = "services/core"
commands = [["uv", "run", "pytest"]]
paths = ["services/core/**"]

[[suite]]
name = "web"
dir = "apps/web"
commands = [["npm", "test"], ["npx", "tsc", "--noEmit"]]
paths = ["apps/web/**"]
"""

PYTEST = ("uv", "run", "pytest")
DB_REASON = "TEST_DATABASE_URL not set — no dockerized postgres available for this run"

PYTEST_GREEN = """\
............................................................ [ 50%]
............................................................ [100%]
============================= 120 passed in 12.34s =============================
"""

PYTEST_WITH_OK_SKIP = """\
..s.. [100%]
=========================== short test summary info ============================
SKIPPED [1] tests/test_agent_dist.py:488: this test runs as a user who can read a mode-0 file (root)
======================== 4 passed, 1 skipped in 0.50s =========================
"""

PYTEST_DB_SKIPPED = f"""\
..sss [100%]
=========================== short test summary info ============================
SKIPPED [2] tests/test_landings_record.py:30: {DB_REASON}
SKIPPED [1] tests/test_device_jobs.py:12: {DB_REASON}
======================== 2 passed, 3 skipped in 0.50s =========================
"""


def _r(suite, command, outcome="passed", exit_code=0, state="done"):
    return {
        "suite": suite,
        "command": list(command),
        "state": state,
        "exit": exit_code,
        "outcome": outcome,
        "why": "" if outcome == "passed" else f"{suite} {outcome}",
    }


def _all_passed(p):
    return [_r(s, c) for s, _d, c in planned_commands(p)]


# ---------------------------------------------------------------- C1 counts


@pytest.mark.parametrize(
    ("line", "passed", "failed", "skipped"),
    [
        ("===== 120 passed in 12.34s =====", 120, 0, 0),
        ("==== 1 failed, 2 passed, 3 skipped in 0.02s ====", 2, 1, 3),
        ("==== 2 passed, 1 error in 0.02s ====", 2, 1, 0),
        ("==== 1 failed, 2 passed, 3 errors in 0.02s ====", 2, 4, 0),
        ("==== 5 passed, 2 warnings in 1.00s ====", 5, 0, 0),
        ("==== 5 passed, 1 xfailed, 2 deselected in 1.00s ====", 5, 0, 0),
        ("==== 1234 passed, 9 skipped in 345.67s (0:05:45) ====", 1234, 0, 9),
        ("============ no tests ran in 0.01s ============", 0, 0, 0),
        ("3 passed, 1 skipped in 0.12s", 3, 0, 1),
    ],
)
def test_c1_pytest_summary(line, passed, failed, skipped):
    c = parse_counts("collected things\n" + line + "\n")
    assert (c.kind, c.passed, c.failed, c.skipped) == ("pytest", passed, failed, skipped)


def test_c1_ansi_colour_is_stripped():
    line = "\x1b[32m==== \x1b[1m7 passed\x1b[0m, \x1b[33m2 skipped\x1b[0m in 1.00s ====\x1b[0m"
    c = parse_counts(line)
    assert (c.kind, c.passed, c.failed, c.skipped) == ("pytest", 7, 0, 2)


def test_c1_the_last_summary_wins():
    log = "==== 1 failed in 0.1s ====\nlater output\n==== 9 passed in 2.0s ====\n"
    c = parse_counts(log)
    assert (c.passed, c.failed) == (9, 0)


def test_c1_a_test_printing_a_summary_like_line_earlier_does_not_win():
    log = "  printed 3 passed, 0 failed by a test\n==== 4 passed, 1 failed in 1.0s ====\n"
    c = parse_counts(log)
    assert (c.kind, c.passed, c.failed) == ("pytest", 4, 1)


@pytest.mark.parametrize(
    ("log", "passed", "failed", "skipped"),
    [
        (" Test Files  12 passed (12)\n      Tests  140 passed | 2 skipped (142)\n", 140, 0, 2),
        (
            " Test Files  1 failed | 11 passed (12)\n      Tests  2 failed | 138 passed (140)\n",
            138,
            2,
            0,
        ),
        ("      Tests  5 passed (5)\n   Start at  10:00:00\n   Duration  3.21s\n", 5, 0, 0),
        ("      Tests  1 failed | 3 passed | 1 todo (5)\n", 3, 1, 0),
    ],
)
def test_c1_vitest_tests_line(log, passed, failed, skipped):
    c = parse_counts(log)
    assert (c.kind, c.passed, c.failed, c.skipped) == ("vitest", passed, failed, skipped)


def test_c1_vitest_test_files_line_alone_is_not_a_test_count():
    c = parse_counts(" Test Files  12 passed (12)\n")
    assert (c.passed, c.failed, c.skipped) == (None, None, None)


@pytest.mark.parametrize(
    ("log", "passed", "failed", "skipped"),
    [
        ("ok  case one\n\n41 passed, 0 failed\n", 41, 0, None),
        ("FAIL case\n\n40 passed, 1 failed\n", 40, 1, None),
        ("\n2 block(s) SKIPPED — see the SKIP lines above\n\n10 passed, 0 failed\n", 10, 0, 2),
        ("\n300 passed, 0 failed — NOT RUN: the entry guard under zsh\n", 300, 0, None),
    ],
)
def test_c1_the_repos_shell_tests(log, passed, failed, skipped):
    c = parse_counts(log)
    assert (c.kind, c.passed, c.failed, c.skipped) == ("shell", passed, failed, skipped)


@pytest.mark.parametrize(
    "log",
    [
        "",
        "ok  \tnova/novad/internal/box\t0.512s\n?   \tnova/novad/cmd\t[no test files]\n",
        "src/x.ts(3,1): error TS2304: Cannot find name 'y'.\n",
        "All checks passed!\n",
    ],
)
def test_c1_no_summary_is_none_never_zero(log):
    c = parse_counts(log)
    assert c.kind is None
    assert (c.passed, c.failed, c.skipped) == (None, None, None)


def test_c1_real_pytest_rs_output_parses(tmp_path):
    (tmp_path / "test_sample.py").write_text(
        "import os, pytest\n"
        f"db = pytest.mark.skipif(True, reason={DB_REASON!r})\n"
        "@db\n"
        "def test_a(): pass\n"
        "def test_b(): pytest.skip('runs as root')\n"
        "def test_c(): pass\n"
        "def test_d(): assert 0\n"
    )
    out = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "no:cacheprovider",
            "--rootdir",
            str(tmp_path),
            str(tmp_path),
        ],
        cwd=tmp_path,
        env={"PYTEST_ADDOPTS": "-rs", "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    log = out.stdout + out.stderr
    c = parse_counts(log)
    assert (c.kind, c.passed, c.failed, c.skipped) == ("pytest", 1, 1, 2)
    r = suite_result("core", PYTEST, state="done", exit_code=out.returncode, log=log, seconds=1)
    assert r["outcome"] == "failed"  # a real failure is red, whatever the skips
    r0 = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert r0["outcome"] == "could_not_measure"
    assert "TEST_DATABASE_URL" in r0["why"]


# ---------------------------------------------------------------- C2 the stored result


def test_c2_the_result_carries_the_row_fields():
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=PYTEST_GREEN, seconds=12.3456)
    assert r["suite"] == "core"
    assert r["command"] == ["uv", "run", "pytest"]
    assert r["state"] == "done"
    assert r["exit"] == 0
    assert (r["passed"], r["failed"], r["skipped"]) == (120, 0, 0)
    assert r["seconds"] == 12.3
    assert r["tail"] == PYTEST_GREEN
    assert r["outcome"] == "passed"
    assert r["why"] == ""


def test_c2_seconds_may_be_unknown():
    r = suite_result("core", PYTEST, state="lost", exit_code=None, log="", seconds=None)
    assert r["seconds"] is None


def test_c2_the_tail_is_the_last_bytes():
    log = "".join(f"line {i}\n" for i in range(5000))
    t = tail(log)
    assert len(t.encode()) <= TAIL_BYTES
    assert log.endswith(t)
    assert len(t.encode()) >= TAIL_BYTES - 16
    r = suite_result("core", PYTEST, state="done", exit_code=1, log=log, seconds=1)
    assert r["tail"] == t


def test_c2_the_tail_never_breaks_a_utf8_character():
    log = "é" * 5000  # two bytes each; an odd cut would split one
    t = tail(log, 4095)
    assert t and set(t) == {"é"}
    assert len(t.encode()) <= 4095
    assert log.endswith(t)


def test_c2_a_short_log_is_kept_whole():
    assert tail("short\n") == "short\n"
    assert tail("") == ""


def test_c2_counts_and_skip_reasons_read_the_whole_log_not_the_tail():
    # the env skip line sits far above the last 4 KiB; it must still count
    log = (
        f"SKIPPED [1] tests/test_x.py:3: {DB_REASON}\n"
        + "".join(f"noise line {i}\n" for i in range(2000))
        + "==== 5 passed, 1 skipped in 1.00s ====\n"
    )
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert DB_REASON not in r["tail"]
    assert r["outcome"] == "could_not_measure"
    assert "TEST_DATABASE_URL" in r["why"]


# ---------------------------------------------------------------- C3 environment skips


def test_c3_a_database_skip_is_could_not_measure_even_at_exit_0():
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=PYTEST_DB_SKIPPED, seconds=1)
    assert r["outcome"] == "could_not_measure"
    assert "TEST_DATABASE_URL" in r["why"]
    assert "3" in r["why"]  # how many skips the environment caused
    assert r["skipped"] == 3


def _skip_reasons() -> list[str]:
    found = []
    for svc in ("core", "gateway", "memory"):
        for f in sorted((ROOT / "services" / svc / "tests").glob("*.py")):
            tree = ast.parse(f.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id in ("SKIP_REASON", "_SKIP_REASON")
                    for t in node.targets
                ):
                    if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                        found.append(node.value.value)
    return found


def test_c3_every_services_real_database_skip_reason_is_recognised():
    reasons = _skip_reasons()
    assert len(reasons) >= 3  # core, gateway, memory conftests at least
    for reason in reasons:
        log = f"SKIPPED [4] tests/test_a.py:9: {reason}\n==== 1 passed, 4 skipped in 1.00s ====\n"
        r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
        assert r["outcome"] == "could_not_measure", reason


def test_c3_other_skips_are_counted_not_fatal():
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=PYTEST_WITH_OK_SKIP, seconds=1)
    assert r["outcome"] == "passed"
    assert r["skipped"] == 1


def test_c3_a_module_level_skip_without_a_line_number_is_explained():
    log = "SKIPPED [3] tests/test_win.py: windows only\n==== 2 passed, 3 skipped in 1.00s ====\n"
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert r["outcome"] == "passed"


def test_c3_skips_the_log_does_not_explain_are_could_not_measure():
    log = (
        "SKIPPED [1] tests/test_agent_dist.py:488: runs as root\n"
        "==== 4 passed, 3 skipped in 1.00s ====\n"
    )
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert r["outcome"] == "could_not_measure"
    assert "1 of 3" in r["why"]


def test_c3_skips_with_no_reasons_at_all_are_could_not_measure():
    log = "==== 4 passed, 3 skipped in 1.00s ====\n"
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert r["outcome"] == "could_not_measure"
    assert "0 of 3" in r["why"]


def test_c3_a_pytest_run_with_no_summary_is_could_not_measure():
    r = suite_result("core", PYTEST, state="done", exit_code=0, log="....\n", seconds=1)
    assert r["outcome"] == "could_not_measure"
    assert "summary" in r["why"]


def test_c3_vitest_skips_are_counted_not_fatal():
    log = "      Tests  140 passed | 2 skipped (142)\n"
    r = suite_result("web", ("npm", "test"), state="done", exit_code=0, log=log, seconds=1)
    assert r["outcome"] == "passed"
    assert r["skipped"] == 2


def test_c3_a_non_pytest_command_needs_no_summary():
    r = suite_result(
        "novad", ("go", "test", "./..."), state="done", exit_code=0, log="ok\n", seconds=1
    )
    assert r["outcome"] == "passed"
    assert (r["passed"], r["failed"], r["skipped"]) == (None, None, None)


def test_c3_a_db_reason_in_ordinary_output_is_not_a_skip():
    # a test that prints the words is not a skip line
    log = f"log: {DB_REASON}\n==== 5 passed in 1.00s ====\n"
    r = suite_result("core", PYTEST, state="done", exit_code=0, log=log, seconds=1)
    assert r["outcome"] == "passed"


# ---------------------------------------------------------------- C4 job outcome


def test_c4_done_and_nonzero_is_failed_with_its_counts():
    log = "==== 1 failed, 119 passed in 12.00s ====\n"
    r = suite_result("core", PYTEST, state="done", exit_code=1, log=log, seconds=12)
    assert r["outcome"] == "failed"
    assert r["exit"] == 1
    assert (r["passed"], r["failed"]) == (119, 1)
    assert "exit 1" in r["why"]


def test_c4_a_failure_with_db_skips_is_still_failed():
    log = PYTEST_DB_SKIPPED.replace("2 passed", "1 failed, 1 passed")
    r = suite_result("core", PYTEST, state="done", exit_code=1, log=log, seconds=1)
    assert r["outcome"] == "failed"


@pytest.mark.parametrize("state", ["failed_to_start", "stopped", "lost"])
def test_c4_a_job_that_did_not_finish_is_could_not_measure(state):
    r = suite_result(
        "core",
        PYTEST,
        state=state,
        exit_code=None,
        log="",
        seconds=None,
        reason="box limit: 2 boxes already running",
    )
    assert r["outcome"] == "could_not_measure"
    assert state in r["why"]
    assert "box limit: 2 boxes already running" in r["why"]
    assert r["exit"] is None


def test_c4_a_stopped_job_with_an_exit_is_still_could_not_measure():
    r = suite_result(
        "core", PYTEST, state="stopped", exit_code=143, log="", seconds=5, reason="timed out"
    )
    assert r["outcome"] == "could_not_measure"
    assert "timed out" in r["why"]


def test_c4_done_with_no_exit_is_could_not_measure():
    r = suite_result("core", PYTEST, state="done", exit_code=None, log=PYTEST_GREEN, seconds=1)
    assert r["outcome"] == "could_not_measure"
    assert "exit" in r["why"]


@pytest.mark.parametrize("code", [126, 127])
def test_c4_the_box_could_not_run_the_command(code):
    r = suite_result(
        "web",
        ("npx", "tsc", "--noEmit"),
        state="done",
        exit_code=code,
        log="sh: npx: not found\n",
        seconds=0,
    )
    assert r["outcome"] == "could_not_measure"
    assert str(code) in r["why"]
    assert "npx tsc --noEmit" in r["why"]


def test_c4_pytest_exit_5_ran_no_tests():
    r = suite_result(
        "core",
        PYTEST,
        state="done",
        exit_code=5,
        log="==== no tests ran in 0.01s ====\n",
        seconds=0,
    )
    assert r["outcome"] == "could_not_measure"
    assert "no tests" in r["why"]


def test_c4_exit_5_from_something_else_is_failed():
    r = suite_result(
        "installer",
        ("./deploy/install_test.sh",),
        state="done",
        exit_code=5,
        log="1 passed, 5 failed\n",
        seconds=0,
    )
    assert r["outcome"] == "failed"


def test_c4_an_unknown_state_is_could_not_measure():
    r = suite_result("core", PYTEST, state="running", exit_code=None, log="", seconds=None)
    assert r["outcome"] == "could_not_measure"


# ---------------------------------------------------------------- C5 the verdict


def _p(changed):
    return plan(SMALL, changed)


def test_c5_green_only_when_every_planned_command_passed():
    p = _p(["services/core/app/x.py", "apps/web/src/a.ts"])
    v = verdict(p, _all_passed(p))
    assert v.verdict == "green"


def test_c5_a_missing_command_is_could_not_measure():
    p = _p(["services/core/app/x.py", "apps/web/src/a.ts"])
    results = [r for r in _all_passed(p) if r["command"] != ["npx", "tsc", "--noEmit"]]
    v = verdict(p, results)
    assert v.verdict == "could_not_measure"
    assert "did not run" in v.reason
    assert "npx tsc --noEmit" in v.reason


def test_c5_ruff_is_part_of_green():
    p = _p(["services/core/app/x.py"])
    results = [r for r in _all_passed(p) if r["suite"] != RUFF_SUITE]
    assert verdict(p, results).verdict == "could_not_measure"
    failed = [
        _r(s, c, "failed", 1) if s == RUFF_SUITE else _r(s, c) for s, _d, c in planned_commands(p)
    ]
    v = verdict(p, failed)
    assert v.verdict == "red"
    assert "ruff" in v.reason


def test_c5_a_failure_is_red_naming_suite_command_and_exit():
    p = _p(["apps/web/src/a.ts"])
    results = [
        _r("web", ("npm", "test")),
        _r("web", ("npx", "tsc", "--noEmit"), "failed", 2),
    ]
    v = verdict(p, results)
    assert v.verdict == "red"
    assert "web" in v.reason
    assert "npx tsc --noEmit" in v.reason
    assert "exit 2" in v.reason
    assert "npm test" not in v.reason  # the passing one is not blamed


def test_c5_red_wins_over_could_not_measure():
    p = _p(["services/core/app/x.py", "apps/web/src/a.ts"])
    results = []
    for s, _d, c in planned_commands(p):
        if c == PYTEST:
            results.append(_r(s, c, "could_not_measure", None, "lost"))
        elif c == ("npm", "test"):
            results.append(_r(s, c, "failed", 1))
        else:
            results.append(_r(s, c))
    assert verdict(p, results).verdict == "red"


def test_c5_could_not_measure_carries_each_reason():
    p = _p(["services/core/app/x.py", "apps/web/src/a.ts"])
    results = []
    for s, _d, c in planned_commands(p):
        if c in (PYTEST, ("npm", "test")):
            r = _r(s, c, "could_not_measure", None, "lost")
            r["why"] = f"{s} job lost: agent restarted"
            results.append(r)
        else:
            results.append(_r(s, c))
    v = verdict(p, results)
    assert v.verdict == "could_not_measure"
    assert "core job lost" in v.reason
    assert "web job lost" in v.reason


@pytest.mark.parametrize("outcome", [None, "", "running", "PASSED"])
def test_c5_only_the_word_passed_counts_as_passed(outcome):
    p = _p(["apps/web/src/a.ts"])
    results = _all_passed(p)
    results[0]["outcome"] = outcome
    v = verdict(p, results)
    assert v.verdict == "could_not_measure"


def test_c5_a_box_error_is_could_not_measure():
    p = _p(["services/core/app/x.py"])
    v = verdict(p, _all_passed(p), box_error="the judge box did not start: limit")
    assert v.verdict == "could_not_measure"
    assert "the judge box did not start: limit" in v.reason


def test_c5_an_empty_plan_is_never_green():
    p = _p([])
    v = verdict(p, [])
    assert v.verdict == "could_not_measure"


def test_c5_results_for_unplanned_commands_change_nothing():
    p = _p(["services/core/app/x.py"])
    extra = _r("web", ("npm", "test"), "failed", 1)
    assert verdict(p, [*_all_passed(p), extra]).verdict == "green"
    # and an unplanned pass never stands in for a missing planned command
    results = [r for r in _all_passed(p) if r["suite"] != "core"]
    assert verdict(p, [*results, _r("gateway", PYTEST)]).verdict == "could_not_measure"


def test_c5_the_same_argv_in_another_suite_is_not_a_stand_in():
    p = plan(MAIN_SUITES, ["services/core/app/x.py", "services/gateway/app/y.py"])
    results = [r for r in _all_passed(p) if r["suite"] != "gateway"]
    v = verdict(p, results)
    assert v.verdict == "could_not_measure"
    assert "gateway" in v.reason


def test_c5_end_to_end_through_suite_result():
    p = _p(["services/core/app/x.py"])
    results = [
        suite_result(
            s,
            c,
            state="done",
            exit_code=0,
            log=PYTEST_GREEN if c == PYTEST else "All checks passed!\n",
            seconds=1,
        )
        for s, _d, c in planned_commands(p)
    ]
    assert verdict(p, results).verdict == "green"
    results[-1] = suite_result(
        "core", PYTEST, state="done", exit_code=0, log=PYTEST_DB_SKIPPED, seconds=1
    )
    v = verdict(p, results)
    assert v.verdict == "could_not_measure"
    assert "TEST_DATABASE_URL" in v.reason


# ---------------------------------------------------------------- C6 planned commands


def test_c6_ruff_first_then_each_suites_commands_in_plan_order():
    p = _p(["apps/web/src/a.ts", "services/core/app/x.py"])
    assert planned_commands(p) == [
        (RUFF_SUITE, ".", ("ruff", "check", "--", "services/core/app/x.py")),
        ("core", "services/core", ("uv", "run", "pytest")),
        ("web", "apps/web", ("npm", "test")),
        ("web", "apps/web", ("npx", "tsc", "--noEmit")),
    ]


def test_c6_no_python_file_no_ruff():
    p = _p(["apps/web/src/a.ts"])
    assert [s for s, _d, _c in planned_commands(p)] == ["web", "web"]


def test_c6_mains_real_installer_suite_runs_every_script_from_the_root():
    p = plan(MAIN_SUITES, ["deploy/install.sh"])
    cmds = planned_commands(p)
    assert [d for _s, d, _c in cmds] == ["."] * 4
    assert [c for _s, _d, c in cmds] == [
        ("./deploy/install_test.sh",),
        ("./deploy/backup_test.sh",),
        ("./deploy/agent_version_test.sh",),
        ("./deploy/build_identity_test.sh",),
    ]


def test_c6_the_argv_is_mains_exactly():
    # box.Heavy takes the CPU lock only for the exact argv (tracker Note)
    p = plan(MAIN_SUITES, ["services/core/app/x.py"])
    core = [c for s, _d, c in planned_commands(p) if s == "core"]
    assert core == [("uv", "run", "pytest")]


def test_module_exports():
    assert landing_plan.TAIL_BYTES == 4096
    assert landing_plan.RUFF_SUITE == "ruff"
