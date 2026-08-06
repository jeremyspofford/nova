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
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


def main() -> int:
    scripts = sorted(p for p in HERE.glob("test_*.py"))
    if not scripts:
        print("no test scripts found")
        return 1

    env_path = str(HERE.parent)
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
        r = subprocess.run([sys.executable, str(script)], cwd=str(HERE.parent),
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
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
