"""Run every test script in this directory and summarise.

The suites here are standalone scripts, not pytest cases — each owns its own
fixtures, prints PASS/FAIL lines, and exits non-zero on failure. That format
is deliberate (they read as a description of the behaviour being defended),
but it meant there was no single command to run them, so nothing did:
`pytest` has been declared in pyproject.toml the whole time and never used,
and there was no CI at all.

This is that command. It works in the container and in CI alike:

    docker compose exec backend python tests/run_all.py
    PYTHONPATH=backend python backend/tests/run_all.py

COVERAGE, when asked (NOVA_COVERAGE=1). Each script runs under
`coverage run -p` and the results are combined and measured against the
floor in coverage_floor.json. The floor is a RATCHET, not a target: it
records the best total this suite has honestly reached, the run fails if a
change drops below it, and it only ever moves up — by editing the file in
the same commit as the tests that earned it. A floor someone can quietly
lower is a floor that reads as green while eroding, so the number lives in
git where lowering it is a visible diff.

If coverage mode is requested and the `coverage` package is missing, that is
a FAILURE, not a fallback to running without measurement — a coverage gate
that silently measures nothing is this repo's most-documented defect shape.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
FLOOR_FILE = HERE / "coverage_floor.json"
#: Combined data lands outside the repo: scattered .coverage.* files in a
#: bind-mounted backend/ would litter every `git status` on the host.
COV_FILE = "/tmp/nova-coverage/.coverage"


def _coverage_prefix() -> list[str]:
    """The interpreter invocation for one suite, with or without coverage."""
    if os.environ.get("NOVA_COVERAGE") != "1":
        return [sys.executable]
    try:
        import coverage  # noqa: F401
    except ImportError:
        print("NOVA_COVERAGE=1 but the `coverage` package is not installed.\n"
              "Refusing to run WITHOUT measurement — that would report a\n"
              "green gate that gated nothing. Fix:  pip install coverage")
        sys.exit(2)
    return [sys.executable, "-m", "coverage", "run", "-p",
            "--source=app", "--omit=*/migrations/*"]


def _coverage_close() -> int:
    """Combine the per-suite data, report, and enforce the ratchet."""
    if os.environ.get("NOVA_COVERAGE") != "1":
        return 0
    env = {**os.environ, "COVERAGE_FILE": COV_FILE}
    subprocess.run([sys.executable, "-m", "coverage", "combine"],
                   cwd=str(HERE.parent), env=env, capture_output=True)
    subprocess.run([sys.executable, "-m", "coverage", "report",
                    "--skip-covered", "--sort=cover"],
                   cwd=str(HERE.parent), env=env)
    total = subprocess.run(
        [sys.executable, "-m", "coverage", "report", "--format=total"],
        cwd=str(HERE.parent), env=env, capture_output=True, text=True)
    try:
        pct = float(total.stdout.strip())
    except ValueError:
        print(f"could not read the coverage total: {total.stdout!r} "
              f"{total.stderr!r}")
        return 1

    floor = json.loads(FLOOR_FILE.read_text())["total_percent"]
    print(f"\ncoverage: {pct:.1f}% (floor {floor}%)")
    if pct < floor:
        print(f"COVERAGE FELL BELOW THE FLOOR: {pct:.1f}% < {floor}%.\n"
              f"New code shipped without tests. Write the tests — or, if a\n"
              f"deletion legitimately moved the total, lower the floor in\n"
              f"{FLOOR_FILE.name} in the same commit and say why.")
        return 1
    return 0


def main() -> int:
    scripts = sorted(p for p in HERE.glob("test_*.py"))
    if not scripts:
        print("no test scripts found")
        return 1

    if os.environ.get("NOVA_COVERAGE") == "1":
        Path(COV_FILE).parent.mkdir(parents=True, exist_ok=True)
        for old in Path(COV_FILE).parent.glob(".coverage*"):
            old.unlink()

    env_path = str(HERE.parent)
    runner = _coverage_prefix()
    failed: list[str] = []
    # SKIPPED IS ITS OWN OUTCOME, neither pass nor fail. A suite that asks
    # about the LIVE install ("do the operator's agent grants still match the
    # snapshot?") has no meaningful answer inside the sandbox boot gate, and
    # a red result that does not mean "your change is wrong" teaches everyone
    # to click past the gate — which is worse than having no gate.
    #
    # Reported with the reason, and counted apart from passes so a run cannot
    # look green by skipping everything. `_env.SKIP` is 77.
    skipped: list[tuple[str, str]] = []
    for script in scripts:
        print(f"\n{'=' * 70}\n{script.name}\n{'=' * 70}")
        r = subprocess.run(runner + [str(script)], cwd=str(HERE.parent),
                           env={**os.environ, "COVERAGE_FILE": COV_FILE},
                           capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        sys.stderr.write(r.stderr)
        if r.returncode == 77:
            why = next((ln.split("SKIPPED:", 1)[1].strip()
                        for ln in r.stdout.splitlines() if "SKIPPED:" in ln),
                       "no reason given")
            skipped.append((script.name, why))
        elif r.returncode != 0:
            failed.append(script.name)

    ran = len(scripts) - len(skipped)
    print(f"\n{'=' * 70}")
    print(f"{ran - len(failed)}/{ran} suites passed"
          + (f" — FAILED: {', '.join(failed)}" if failed else "")
          + (f"  ({len(skipped)} skipped)" if skipped else ""))
    for name, why in skipped:
        print(f"  SKIPPED {name}: {why}")
    print(f"(python path root: {env_path})")

    cov_rc = _coverage_close()
    return 1 if failed else cov_rc


if __name__ == "__main__":
    sys.exit(main())
