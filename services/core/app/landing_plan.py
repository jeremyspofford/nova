"""What a landing runs (S32 spec §5.2 steps 4 and 6) — pure.

The caller hands in MAIN's `deploy/devbox/suites.toml` text (read with
`git show origin/<main>:deploy/devbox/suites.toml`, never the change's own
copy, so a change cannot shorten its own suites or its protected list) and
the paths the change touched. Nothing here reads a disk or runs a command.

The parse is at least as strict as novad's `box.ParseSuites`: a broken file
raises ValueError, which the landing records as could_not_measure — never
"no suites, so green".
"""

from __future__ import annotations

import posixpath
import re
import tomllib
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache

# The suite a path no rule covers runs (spec §5.2 step 4).
FALLBACK_SUITE = "core"

_TOP_KEYS = frozenset({"protected", "suite"})
_SUITE_KEYS = frozenset({"name", "dir", "commands", "paths"})


@dataclass(frozen=True)
class PlannedSuite:
    name: str
    dir: str
    commands: tuple[tuple[str, ...], ...]


@dataclass(frozen=True)
class Suite:
    name: str
    dir: str
    commands: tuple[tuple[str, ...], ...]
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Suites:
    suites: tuple[Suite, ...]
    protected: tuple[str, ...]


@dataclass(frozen=True)
class Plan:
    suites: tuple[PlannedSuite, ...]
    ruff_files: tuple[str, ...]
    protected: tuple[str, ...]
    uncovered: tuple[str, ...]

    @property
    def ruff_command(self) -> tuple[str, ...] | None:
        """`ruff check -- <files>`, run from the clean copy's root (the devbox
        image pins ruff; each service's pyproject applies to its files).
        `--` so a file named like a flag is never read as one."""
        if not self.ruff_files:
            return None
        return ("ruff", "check", "--", *self.ruff_files)


def _fail(msg: str) -> ValueError:
    return ValueError(f"suites.toml {msg}")


def _check_pattern(pattern: object, where: str) -> str:
    if not isinstance(pattern, str) or not pattern:
        raise _fail(f"{where}: pattern {pattern!r} is empty or not a string")
    segs = pattern.split("/")
    if pattern.startswith("/") or any(s in ("", ".", "..") for s in segs):
        raise _fail(f"{where}: pattern {pattern!r} is not a clean path inside the repo")
    return pattern


def _str_list(value: object, where: str) -> list:
    if not isinstance(value, list):
        raise _fail(f"{where} is not a list")
    return value


def parse_suites(text: str) -> Suites:
    """Read suites.toml strictly; any fault raises ValueError naming it."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise _fail(f"does not parse: {exc}") from None
    extra = sorted(set(data) - _TOP_KEYS)
    if extra:
        raise _fail(f"has keys nothing reads: {', '.join(extra)}")
    if "protected" not in data:
        raise _fail("has no protected list (write `protected = []` for none)")
    protected = tuple(
        _check_pattern(p, "protected") for p in _str_list(data["protected"], "protected")
    )
    raw = data.get("suite", [])
    if not isinstance(raw, list):
        raise _fail("suite is not a list of [[suite]] tables")
    if not raw:
        raise _fail("lists no suites")
    suites: list[Suite] = []
    seen: set[str] = set()
    for i, su in enumerate(raw, 1):
        if not isinstance(su, dict):
            raise _fail(f"suite {i} is not a [[suite]] table")
        name = su.get("name")
        if not isinstance(name, str) or not name:
            raise _fail(f"suite {i} has no name")
        extra = sorted(set(su) - _SUITE_KEYS)
        if extra:
            raise _fail(f"suite {name} has keys nothing reads: {', '.join(extra)}")
        if name in seen:
            raise _fail(f"names suite {name} twice")
        seen.add(name)
        d = su.get("dir")
        if not isinstance(d, str) or not d:
            raise _fail(f"suite {name} has no dir")
        if d.startswith("/") or posixpath.normpath(d) != d or d == ".." or d.startswith("../"):
            raise _fail(f"suite {name}: dir {d!r} is not a clean path inside the repo")
        cmds = su.get("commands")
        if cmds is None or (isinstance(cmds, list) and not cmds):
            raise _fail(f"suite {name} has no commands")
        commands: list[tuple[str, ...]] = []
        for c in _str_list(cmds, f"suite {name} commands"):
            if not isinstance(c, list):
                raise _fail(f"suite {name}: commands holds {c!r}, not an argv list")
            if not c:
                raise _fail(f"suite {name} has an empty command")
            if not all(isinstance(w, str) for w in c):
                raise _fail(f"suite {name}: command {c!r} holds a word that is not a string")
            if "" in c:
                raise _fail(f"suite {name}: command {c!r} has an empty word")
            commands.append(tuple(c))
        paths = su.get("paths")
        if paths is None or (isinstance(paths, list) and not paths):
            raise _fail(f"suite {name} has no paths (no change would ever select it)")
        pats = tuple(
            _check_pattern(p, f"suite {name} paths")
            for p in _str_list(paths, f"suite {name} paths")
        )
        suites.append(Suite(name=name, dir=d, commands=tuple(commands), paths=pats))
    return Suites(suites=tuple(suites), protected=protected)


@lru_cache(maxsize=512)
def _segment_re(seg: str) -> re.Pattern[str]:
    # `*` is any run of characters inside ONE segment; nothing else is magic.
    return re.compile("[^/]*".join(re.escape(part) for part in seg.split("*")))


def _segment_match(seg: str, name: str) -> bool:
    if "*" not in seg:
        return seg == name
    return _segment_re(seg).fullmatch(name) is not None


def glob_match(pattern: str, path: str) -> bool:
    """`**` (a whole segment) matches any run of segments, including none;
    `*` matches within one segment and never crosses '/'; anything else is
    literal. Runs as a set of positions: O(pattern x path), no backtracking."""
    parts = path.split("/")
    n = len(parts)
    positions = {0}
    for seg in pattern.split("/"):
        if not positions:
            return False
        if seg == "**":
            positions = set(range(min(positions), n + 1))
        else:
            positions = {i + 1 for i in positions if i < n and _segment_match(seg, parts[i])}
    return n in positions


def plan(toml_text: str, changed: Iterable[str], deleted: Iterable[str] = ()) -> Plan:
    """The suites, ruff targets and protected hits for a change.

    `changed` is every path the change touched; `deleted` the ones gone at
    the judged SHA (they count as touched — deleting a test is touching it —
    but there is nothing left to lint)."""
    s = parse_suites(toml_text)
    gone = list(dict.fromkeys(deleted))
    touched = list(dict.fromkeys([*changed, *gone]))
    gone_set = set(gone)

    picked: set[str] = set()
    uncovered: list[str] = []
    for path in touched:
        hit = False
        for su in s.suites:
            if any(glob_match(p, path) for p in su.paths):
                picked.add(su.name)
                hit = True
        if not hit:
            uncovered.append(path)
    if uncovered:
        if not any(su.name == FALLBACK_SUITE for su in s.suites):
            raise _fail(
                f"has no {FALLBACK_SUITE} suite to run for paths no suite covers: "
                + ", ".join(uncovered)
            )
        picked.add(FALLBACK_SUITE)

    return Plan(
        suites=tuple(
            PlannedSuite(name=su.name, dir=su.dir, commands=su.commands)
            for su in s.suites
            if su.name in picked
        ),
        ruff_files=tuple(sorted(p for p in touched if p.endswith(".py") and p not in gone_set)),
        protected=tuple(sorted(p for p in touched if any(glob_match(g, p) for g in s.protected))),
        uncovered=tuple(uncovered),
    )


# --- T4: what each command's run says, and the verdict (spec §5.2 steps 5-6) ---

RUFF_SUITE = "ruff"
TAIL_BYTES = 4096


@dataclass(frozen=True)
class Counts:
    kind: str | None
    passed: int | None
    failed: int | None
    skipped: int | None


@dataclass(frozen=True)
class Verdict:
    verdict: str
    reason: str


def planned_commands(p: Plan) -> list[tuple[str, str, tuple[str, ...]]]:
    """Every command a landing runs, as (suite, dir, argv): ruff first (cheap,
    so a lint failure is known before a five-minute suite), then each planned
    suite's commands in the plan's order with main's argv exactly — box.Heavy
    takes the CPU lock only for that exact argv in that dir."""
    out: list[tuple[str, str, tuple[str, ...]]] = []
    if p.ruff_command is not None:
        out.append((RUFF_SUITE, ".", p.ruff_command))
    for su in p.suites:
        out.extend((su.name, su.dir, cmd) for cmd in su.commands)
    return out


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
# pytest's final line: "==== 1 failed, 2 passed in 0.12s (0:00:00) ====", or
# "no tests ran in 0.01s". Categories are listed only when non-zero.
_PYTEST_LINE = re.compile(
    r"^=*\s*((?:\d+ [a-z]+, )*\d+ [a-z]+|no tests ran) in \d+(?:\.\d+)?s"
    r"(?: \(\d+:\d\d:\d\d\))?\s*=*$"
)
_PYTEST_PART = re.compile(r"(\d+) ([a-z]+)")
# vitest: "      Tests  2 failed | 138 passed | 1 skipped (141)" (not "Test Files").
_VITEST_LINE = re.compile(r"^\s*Tests\s+(\d+ [a-z]+(?: \| \d+ [a-z]+)*) \(\d+\)\s*$")
# the repo's shell tests: "41 passed, 0 failed" (optionally "— NOT RUN: ...").
_SHELL_LINE = re.compile(r"^\s*(\d+) passed, (\d+) failed(?:\s.*)?$")
_SHELL_SKIP = re.compile(r"^\s*(\d+) block\(s\) SKIPPED\b")
# pytest -rs: "SKIPPED [3] tests/test_x.py:12: reason" (module skips: no line).
_SKIP_LINE = re.compile(r"^SKIPPED \[(\d+)\] (\S+): (.*)$")

# A skip naming these means the box's environment is broken, not her code:
# the suite could not measure (spec §5.2 step 6). Every service conftest's
# SKIP_REASON names TEST_DATABASE_URL (pinned by test_landing_verdict).
ENV_SKIP_MARKERS = ("TEST_DATABASE_URL",)

# The shell could not run the command at all: the box is missing it.
_CANNOT_RUN = {126: "cannot execute", 127: "command not found"}
_PYTEST_NO_TESTS = 5


def _lines(log: str) -> list[str]:
    return _ANSI.sub("", log).splitlines()


def parse_counts(log: str) -> Counts:
    """Passed/failed/skipped from the LAST summary line of any kind in the
    log. A pytest or vitest summary lists only non-zero categories, so once
    one is found an absent category is 0; with no summary every count is
    None — never 0, which would read as measured."""
    for line in reversed(_lines(log)):
        m = _PYTEST_LINE.match(line.strip())
        if m:
            got = {"passed": 0, "failed": 0, "skipped": 0}
            for n, word in _PYTEST_PART.findall(m.group(1)):
                if word == "passed":
                    got["passed"] += int(n)
                elif word in ("failed", "error", "errors"):
                    got["failed"] += int(n)
                elif word == "skipped":
                    got["skipped"] += int(n)
            return Counts("pytest", got["passed"], got["failed"], got["skipped"])
        m = _VITEST_LINE.match(line)
        if m:
            got = {"passed": 0, "failed": 0, "skipped": 0}
            for part in m.group(1).split(" | "):
                n, word = part.split(" ", 1)
                if word in got:
                    got[word] += int(n)
            return Counts("vitest", got["passed"], got["failed"], got["skipped"])
        m = _SHELL_LINE.match(line)
        if m:
            skipped = None
            for other in _lines(log):
                sk = _SHELL_SKIP.match(other)
                if sk:
                    skipped = (skipped or 0) + int(sk.group(1))
            return Counts("shell", int(m.group(1)), int(m.group(2)), skipped)
    return Counts(None, None, None, None)


def tail(log: str, limit: int = TAIL_BYTES) -> str:
    """The last `limit` bytes of the log as UTF-8, never splitting a char."""
    raw = log.encode("utf-8", "replace")
    if len(raw) <= limit:
        return log
    return raw[len(raw) - limit :].decode("utf-8", "ignore")


def _skips(log: str) -> tuple[int, list[tuple[int, str]]]:
    """(how many skips the -rs lines explain, the environment ones)."""
    explained = 0
    env: list[tuple[int, str]] = []
    for line in _lines(log):
        m = _SKIP_LINE.match(line)
        if not m:
            continue
        n, why = int(m.group(1)), m.group(3)
        explained += n
        if any(mark in why for mark in ENV_SKIP_MARKERS):
            env.append((n, why))
    return explained, env


def _shown(command: Iterable[str]) -> str:
    return " ".join(command)


def suite_result(
    suite: str,
    command: Iterable[str],
    *,
    state: str,
    exit_code: int | None,
    log: str,
    seconds: float | None,
    reason: str = "",
) -> dict:
    """One command's run as the row stores it: {suite, command, state, exit,
    passed, failed, skipped, seconds, tail, outcome, why}, outcome one of
    passed | failed | could_not_measure. Counts and skip reasons are read
    from the whole log handed in; only the stored tail is cut."""
    argv = list(command)
    shown = _shown(argv)
    counts = parse_counts(log)
    is_pytest = "pytest" in argv or counts.kind == "pytest"

    outcome, why = "passed", ""
    if state != "done":
        outcome = "could_not_measure"
        why = f"{suite} `{shown}` did not finish: {state}" + (f" — {reason}" if reason else "")
    elif exit_code is None:
        outcome = "could_not_measure"
        why = f"{suite} `{shown}` finished with no exit code recorded"
    elif exit_code in _CANNOT_RUN:
        outcome = "could_not_measure"
        why = (
            f"{suite} `{shown}` exit {exit_code}: the box could not run it "
            f"({_CANNOT_RUN[exit_code]})"
        )
    elif is_pytest and exit_code == _PYTEST_NO_TESTS:
        outcome = "could_not_measure"
        why = f"{suite} `{shown}` exit 5: pytest ran no tests"
    elif exit_code != 0:
        outcome = "failed"
        why = f"{suite} `{shown}` exit {exit_code}"
        if counts.failed is not None:
            why += f" ({counts.failed} failed)"
    elif is_pytest:
        explained, env = _skips(log)
        if counts.kind != "pytest":
            outcome = "could_not_measure"
            why = f"{suite} `{shown}`: pytest's summary line is not in the log"
        elif env:
            outcome = "could_not_measure"
            n = sum(k for k, _ in env)
            why = f"{suite} `{shown}`: {n} skipped because of the box's environment ({env[0][1]})"
        elif (counts.skipped or 0) > explained:
            outcome = "could_not_measure"
            why = (
                f"{suite} `{shown}`: the log shows reasons for {explained} of "
                f"{counts.skipped} skips; cannot tell the environment did not cause them"
            )

    return {
        "suite": suite,
        "command": argv,
        "state": state,
        "exit": exit_code,
        "passed": counts.passed,
        "failed": counts.failed,
        "skipped": counts.skipped,
        "seconds": None if seconds is None else round(float(seconds), 1),
        "tail": tail(log),
        "outcome": outcome,
        "why": why,
    }


def verdict(p: Plan, results: Iterable[dict], box_error: str = "") -> Verdict:
    """green only when every planned command (ruff included) has a passed
    result; any failed -> red (it wins: the change is wrong whatever else
    could not be measured); otherwise could_not_measure with the reasons.
    Matched by (suite, argv); a result nothing planned changes nothing."""
    if box_error:
        return Verdict("could_not_measure", box_error)
    planned = planned_commands(p)
    if not planned:
        return Verdict("could_not_measure", "the plan has no command to run")
    by_key: dict[tuple[str, tuple[str, ...]], dict] = {}
    for r in results:
        key = (r.get("suite"), tuple(r.get("command") or ()))
        by_key.setdefault(key, r)
    failed: list[str] = []
    unmeasured: list[str] = []
    for suite, _d, cmd in planned:
        r = by_key.get((suite, cmd))
        if r is None:
            unmeasured.append(f"{suite} `{_shown(cmd)}` did not run")
        elif r.get("outcome") == "failed":
            line = f"{suite} `{_shown(cmd)}` exit {r.get('exit')}"
            if r.get("failed") is not None:
                line += f" ({r['failed']} failed)"
            failed.append(line)
        elif r.get("outcome") != "passed":
            unmeasured.append(r.get("why") or f"{suite} `{_shown(cmd)}` could not measure")
    if failed:
        return Verdict("red", "; ".join(failed))
    if unmeasured:
        return Verdict("could_not_measure", "; ".join(unmeasured))
    return Verdict("green", "")
