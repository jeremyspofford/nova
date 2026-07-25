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
    for script in scripts:
        print(f"\n{'=' * 70}\n{script.name}\n{'=' * 70}")
        r = subprocess.run([sys.executable, str(script)], cwd=str(HERE.parent))
        if r.returncode != 0:
            failed.append(script.name)

    print(f"\n{'=' * 70}")
    print(f"{len(scripts) - len(failed)}/{len(scripts)} suites passed"
          + (f" — FAILED: {', '.join(failed)}" if failed else ""))
    print(f"(python path root: {env_path})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
