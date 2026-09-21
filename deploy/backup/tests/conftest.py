"""Shared helpers: where the fixtures are, and how to drive the real shell
readers from python.

No docker, no live stack. `bash` is the only external binary these tests use,
and it is used to run the SHIPPED deploy/compose_read.sh rather than a second
python copy of it — one implementation of "what the YAML render says", not
two that can drift.
"""

import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE.parent / "fixtures"
DEPLOY = HERE.parent.parent
COMPOSE_READ = DEPLOY / "compose_read.sh"
COMPOSE_FILE = DEPLOY / "docker-compose.yml"


def compose_read(script: str, stdin: str = "") -> str:
    """Run `script` with deploy/compose_read.sh sourced, and return stdout."""
    proc = subprocess.run(
        ["bash", "-c", f'set -uo pipefail\n. "{COMPOSE_READ}"\n{script}'],
        input=stdin,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise AssertionError(f"compose_read.sh failed ({proc.returncode}): {proc.stderr}")
    return proc.stdout
