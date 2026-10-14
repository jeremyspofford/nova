"""S32.3 T3 — which suites a landing runs, from main's suites.toml (pure)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from app import landing_plan
from app.landing_plan import glob_match, parse_suites, plan

ROOT = Path(__file__).resolve().parents[3]
MAIN_SUITES = (ROOT / "deploy" / "devbox" / "suites.toml").read_text()

SMALL = """
protected = ["services/*/tests/**", "tests/**", "services/core/app/guards.py"]

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

[[suite]]
name = "installer"
dir = "."
commands = [["./deploy/install_test.sh"], ["./deploy/backup_test.sh"]]
paths = ["deploy/**", "install"]
"""


def _names(p: landing_plan.Plan) -> list[str]:
    return [s.name for s in p.suites]


# --- C1 strict parse --------------------------------------------------------


def test_c1_mains_real_suites_toml_parses():
    s = parse_suites(MAIN_SUITES)
    assert [x.name for x in s.suites] == ["core", "gateway", "memory", "web", "novad", "installer"]
    web = next(x for x in s.suites if x.name == "web")
    assert web.dir == "apps/web"
    assert web.commands == (("npm", "test"), ("npx", "tsc", "--noEmit"))
    assert web.paths == ("apps/web/**",)
    inst = next(x for x in s.suites if x.name == "installer")
    assert inst.dir == "."
    assert inst.paths == ("deploy/**", "install")
    assert len(inst.commands) == 4
    assert "services/core/app/guards.py" in s.protected
    assert "services/core/tests/test_no_approvals.py" in s.protected
    assert s.protected[0] == "services/*/tests/**"


_SUITE = (
    '[[suite]]\nname = "core"\ndir = "services/core"\n'
    'commands = [["uv", "run", "pytest"]]\npaths = ["services/core/**"]\n'
)


def _one(**fields: str | None) -> str:
    """A one-suite file with protected = []; a field set to None is left out."""
    base = {"name": '"x"', "dir": '"x"', "commands": '[["a"]]', "paths": '["x/**"]'}
    base.update(fields)
    body = "".join(f"{k} = {v}\n" for k, v in base.items() if v is not None)
    return "protected = []\n[[suite]]\n" + body


@pytest.mark.parametrize(
    "text, words",
    [
        ("this is [not toml", "parse"),
        ("protected = []\nsurprise = 1\n" + _SUITE, "surprise"),
        ("protected = []\n" + _SUITE + "timeout = 5\n", "timeout"),
        ("protected = []\n", "no suites"),
        ("protected = []\nsuite = []\n", "no suites"),
        (_one(name=None), "name"),
        (_one(dir=None), "dir"),
        (_one(commands=None), "commands"),
        (_one(commands="[]"), "commands"),
        (_one(paths=None), "paths"),
        (_one(paths="[]"), "paths"),
        (_one(commands="[[]]"), "empty command"),
        (_one(commands='[["a", ""]]'), "empty word"),
        (_one(dir='"/abs"'), "/abs"),
        (_one(dir='"a/../b"'), "a/../b"),
        (_one(dir='"../up"'), "../up"),
        (_one(dir='".."'), ".."),
        (_one(dir='"a/"'), "a/"),
        ("protected = []\n" + _SUITE + _SUITE, "core"),
        (_one(name="3"), "name"),
        (_one(commands='["a"]'), "commands"),
        (_one(commands='[["a", 1]]'), "command"),
        (_one(paths='"x/**"'), "paths"),
        (_SUITE, "protected"),
        ('protected = "tests/**"\n' + _SUITE, "protected"),
        ('protected = [""]\n' + _SUITE, "pattern"),
        ('protected = ["/etc/**"]\n' + _SUITE, "/etc/**"),
        (_one(paths='["x//y"]'), "x//y"),
        ('protected = []\nsuite = "core"\n', "suite"),
    ],
)
def test_c1_a_broken_suites_toml_is_refused_naming_the_fault(text, words):
    with pytest.raises(ValueError) as exc:
        parse_suites(text)
    assert words in str(exc.value)
    assert "suites.toml" in str(exc.value)


def test_c1_plan_refuses_a_broken_file_rather_than_planning_nothing():
    with pytest.raises(ValueError):
        plan("protected = []\n", ["services/core/app/x.py"])


def test_c1_an_explicitly_empty_protected_list_is_accepted():
    s = parse_suites("protected = []\n" + _SUITE)
    assert s.protected == ()
    assert [x.name for x in s.suites] == ["core"]


# --- C2 glob ----------------------------------------------------------------


@pytest.mark.parametrize(
    "pattern, path, hit",
    [
        ("services/core/**", "services/core/app/chat.py", True),
        ("services/core/**", "services/core/pyproject.toml", True),
        ("services/core/**", "services/core/a/b/c/d.py", True),
        ("services/core/**", "services/coreish/x.py", False),
        ("services/core/**", "services/gateway/x.py", False),
        ("services/core/**", "xservices/core/x.py", False),
        ("services/*/tests/**", "services/core/tests/test_a.py", True),
        ("services/*/tests/**", "services/memory/tests/sub/test_b.py", True),
        ("services/*/tests/**", "services/core/app/tests.py", False),
        ("services/*/tests/**", "services/core/x/tests/y.py", False),
        ("services/*/tests/**", "services/tests/y.py", False),
        ("**/tests/**", "tests/x.py", True),
        ("**/tests/**", "a/b/tests/x.py", True),
        ("**/tests/**", "a/b/testsx/x.py", False),
        ("a/**/b", "a/b", True),
        ("a/**/b", "a/x/y/b", True),
        ("a/**/b", "a/x/y/bc", False),
        ("tests/**", "tests/test_e2e.py", True),
        ("tests/**", "services/core/tests/test_x.py", False),
        ("install", "install", True),
        ("install", "install.sh", False),
        ("install", "deploy/install", False),
        ("install", "xinstall", False),
        ("services/core/app/guards.py", "services/core/app/guards.py", True),
        ("services/core/app/guards.py", "services/core/app/guards.pyc", False),
        ("services/core/app/guards.py", "services/core/app/guards_py", False),
        ("*.py", "x.py", True),
        ("*.py", "a/x.py", False),
        ("services/core/app/evals/cases/**", "services/core/app/evals/cases/c1.yaml", True),
        ("deploy/*.sh", "deploy/install_test.sh", True),
        ("deploy/*.sh", "deploy/devbox/x.sh", False),
    ],
)
def test_c2_glob_match(pattern, path, hit):
    assert glob_match(pattern, path) is hit


def test_c2_star_never_crosses_a_slash():
    assert glob_match("services/*", "services/core") is True
    assert glob_match("services/*", "services/core/app.py") is False
    assert glob_match("a*b", "a/b") is False


def test_c2_many_double_stars_on_a_long_path_stay_quick():
    pattern = "/".join(["**"] * 25) + "/zz"
    path = "/".join(["a"] * 400) + "/b"
    t0 = time.perf_counter()
    assert glob_match(pattern, path) is False
    assert glob_match(pattern, "/".join(["a"] * 400) + "/zz") is True
    assert time.perf_counter() - t0 < 0.5


# --- C3 suite selection -----------------------------------------------------


def test_c3_each_path_selects_its_suite_with_mains_dir_and_commands():
    p = plan(SMALL, ["apps/web/src/App.tsx"])
    assert _names(p) == ["web"]
    assert p.suites[0].dir == "apps/web"
    assert p.suites[0].commands == (("npm", "test"), ("npx", "tsc", "--noEmit"))
    assert p.uncovered == ()


def test_c3_suites_keep_the_files_order_and_appear_once():
    p = plan(
        SMALL,
        [
            "install",
            "apps/web/a.ts",
            "services/core/app/x.py",
            "apps/web/b.ts",
            "deploy/install.sh",
        ],
    )
    assert _names(p) == ["core", "web", "installer"]
    inst = p.suites[2]
    assert inst.dir == "."
    assert inst.commands == (("./deploy/install_test.sh",), ("./deploy/backup_test.sh",))


def test_c3_a_path_two_suites_cover_selects_both():
    text = (
        SMALL
        + '\n[[suite]]\nname = "e2e"\ndir = "."\n'
        + 'commands = [["./e2e.sh"]]\npaths = ["apps/web/**"]\n'
    )
    assert _names(plan(text, ["apps/web/x.ts"])) == ["web", "e2e"]


def test_c3_a_deleted_file_selects_its_suite():
    p = plan(SMALL, [], deleted=["apps/web/old.ts"])
    assert _names(p) == ["web"]


def test_c3_against_mains_real_file():
    p = plan(
        MAIN_SUITES,
        ["apps/novad/internal/box/box.go", "services/gateway/app/x.py", "install"],
    )
    assert _names(p) == ["gateway", "novad", "installer"]
    assert p.suites[1].commands == (("go", "test", "./..."),)
    assert p.suites[0].dir == "services/gateway"


# --- C4 uncovered -> core ---------------------------------------------------


def test_c4_a_path_no_suite_covers_runs_core():
    p = plan(SMALL, ["README.md"])
    assert _names(p) == ["core"]
    assert p.suites[0].dir == "services/core"
    assert p.uncovered == ("README.md",)


def test_c4_core_is_added_once_and_in_its_file_position():
    p = plan(SMALL, ["apps/web/x.ts", "docs/a.md", "services/core/app/y.py", "docs/b.md"])
    assert _names(p) == ["core", "web"]
    assert p.uncovered == ("docs/a.md", "docs/b.md")


def test_c4_a_covered_path_is_never_uncovered():
    p = plan(SMALL, ["apps/web/x.ts", "install"])
    assert p.uncovered == ()
    assert "core" not in _names(p)


def test_c4_no_core_suite_to_fall_back_on_is_refused():
    text = _one(
        name='"web"', dir='"apps/web"', commands='[["npm", "test"]]', paths='["apps/web/**"]'
    )
    assert _names(plan(text, ["apps/web/x.ts"])) == ["web"]
    with pytest.raises(ValueError) as exc:
        plan(text, ["docs/x.md"])
    assert "core" in str(exc.value)
    assert "docs/x.md" in str(exc.value)


# --- C5 ruff ----------------------------------------------------------------


def test_c5_ruff_takes_the_changed_python_files_that_still_exist():
    p = plan(
        SMALL,
        [
            "services/core/app/b.py",
            "apps/web/x.ts",
            "services/core/app/a.py",
            "scripts/tool.py",
            "a.pyi",
            "x.py.txt",
        ],
        deleted=["services/core/app/gone.py"],
    )
    assert p.ruff_files == ("scripts/tool.py", "services/core/app/a.py", "services/core/app/b.py")
    assert p.ruff_command == (
        "ruff",
        "check",
        "--",
        "scripts/tool.py",
        "services/core/app/a.py",
        "services/core/app/b.py",
    )


def test_c5_a_deleted_file_listed_in_changed_too_is_still_dropped():
    p = plan(
        SMALL,
        ["services/core/app/gone.py", "services/core/app/kept.py"],
        deleted=["services/core/app/gone.py"],
    )
    assert p.ruff_files == ("services/core/app/kept.py",)


def test_c5_a_repeated_path_is_linted_once():
    p = plan(SMALL, ["services/core/app/a.py", "services/core/app/a.py"])
    assert p.ruff_files == ("services/core/app/a.py",)


def test_c5_no_python_file_no_ruff():
    p = plan(SMALL, ["apps/web/x.ts"])
    assert p.ruff_files == ()
    assert p.ruff_command is None


def test_c5_a_dash_named_file_is_never_read_as_a_flag():
    p = plan(SMALL, ["-fix.py"])
    cmd = p.ruff_command
    assert cmd is not None
    assert cmd.index("--") < cmd.index("-fix.py")


# --- C6 protected -----------------------------------------------------------


def test_c6_protected_lists_the_touched_grading_files():
    p = plan(
        SMALL,
        [
            "services/core/app/guards.py",
            "services/core/tests/test_a.py",
            "services/core/app/chat.py",
            "tests/e2e.py",
        ],
    )
    assert p.protected == (
        "services/core/app/guards.py",
        "services/core/tests/test_a.py",
        "tests/e2e.py",
    )


def test_c6_deleting_a_protected_file_is_flagged():
    p = plan(SMALL, ["services/core/app/x.py"], deleted=["services/memory/tests/test_m.py"])
    assert p.protected == ("services/memory/tests/test_m.py",)


def test_c6_a_path_matching_two_patterns_is_listed_once():
    text = SMALL.replace("protected = [", 'protected = ["services/core/**", ')
    p = plan(text, ["services/core/tests/t.py"])
    assert p.protected == ("services/core/tests/t.py",)


def test_c6_protected_comes_only_from_the_text_given():
    p = plan(
        "protected = []\n" + _SUITE,
        ["services/core/app/guards.py", "deploy/devbox/suites.toml"],
    )
    assert p.protected == ()


def test_c6_mains_real_protected_list():
    p = plan(
        MAIN_SUITES,
        [
            "services/core/app/guards.py",
            "services/core/app/evals/cases/c.yaml",
            "services/core/tests/test_eval_corpus.py",
            "services/gateway/tests/test_x.py",
            "services/core/app/chat.py",
        ],
    )
    assert p.protected == (
        "services/core/app/evals/cases/c.yaml",
        "services/core/app/guards.py",
        "services/core/tests/test_eval_corpus.py",
        "services/gateway/tests/test_x.py",
    )
    assert "services/core/app/chat.py" not in p.protected


# --- C7 empty ---------------------------------------------------------------


def test_c7_no_changed_paths_is_an_empty_plan():
    p = plan(MAIN_SUITES, [])
    assert p.suites == ()
    assert p.ruff_files == ()
    assert p.ruff_command is None
    assert p.protected == ()
    assert p.uncovered == ()
