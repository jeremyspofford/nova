"""The mcp-runner's launcher allow-list must not drift from the backend's.

    docker compose exec backend python tests/test_mcp_runner_guard.py
    PYTHONPATH=backend python backend/tests/test_mcp_runner_guard.py   (CI)

Until 2026-07-31 there was only ONE copy, in the backend, checked when an
MCP server was REGISTERED. The runner — the process that calls exec — took
`command` from the request body and ran it. Measured from `nova-searxng-1`:
a plain POST with `{"command":"sh","args":["-c",...]}` spawned the
subprocess, and `sh` has never been an allowed launcher.

The fix put the check where the exec is, which means two copies of the set.
`tools/scopes.py:1-17` is this codebase's own account of what happens next:
a duplicated list drifted within an hour and the control and its description
stopped agreeing. So the copies get a test.

The runner lives outside the backend's container mount, so this enforces
wherever the repo root is reachable (CI runs `run_all.py` from it on every
push) and says so loudly when it is not.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import mcp_servers                                  # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _runner_source() -> Path | None:
    """backend/tests/ -> repo root -> mcp-runner/server.py, if reachable."""
    for base in (Path(__file__).resolve().parents[2], Path.cwd()):
        p = base / "mcp-runner" / "server.py"
        if p.is_file():
            return p
    return None


def test_allowlists_match():
    print("1. the runner's allow-list matches the backend's")
    src = _runner_source()
    if src is None:
        print("  NOTE  mcp-runner/server.py is not reachable from this "
              "container — this check enforces in CI, which runs run_all.py "
              "from the repo root on every push.")
        return

    text = src.read_text()
    m = re.search(r"_ALLOWED_LAUNCHERS\s*=\s*\{(.*?)\}", text, re.S)
    check("_ALLOWED_LAUNCHERS is present in the runner", m is not None)
    if not m:
        return
    runner_set = set(re.findall(r'"([^"]+)"', m.group(1)))
    backend_set = set(mcp_servers._STDIO_COMMANDS)

    check("the two sets are identical", runner_set == backend_set,
          f"runner-only={sorted(runner_set - backend_set)} "
          f"backend-only={sorted(backend_set - runner_set)}")


def test_runner_refuses_what_the_backend_refuses():
    print("2. the shapes the backend refuses are refused by the same rules")
    # These are the two rules _require_command re-applies. Asserting them
    # against the backend's checker keeps the INTENT pinned even when the
    # runner source cannot be read from here.
    for bad in ("sh", "bash", "curl", "/usr/bin/npx", "npx; sh"):
        try:
            mcp_servers._check_stdio_command(bad)
            ok = False
        except ValueError:
            ok = True
        check(f"{bad!r} is refused as a launcher", ok, bad)
    for good in sorted(mcp_servers._STDIO_COMMANDS):
        try:
            mcp_servers._check_stdio_command(good)
            ok = True
        except ValueError:
            ok = False
        check(f"{good!r} is still allowed", ok, good)


def test_backend_sends_a_token():
    print("3. the backend presents a bearer token to the runner")
    from app import mcp_client
    from app.config import settings

    saved = settings.nova_mcp_runner_token
    try:
        settings.nova_mcp_runner_token = "abc123"
        check("a configured token becomes an Authorization header",
              mcp_client._runner_auth() == {"Authorization": "Bearer abc123"},
              str(mcp_client._runner_auth()))
        settings.nova_mcp_runner_token = ""
        check("an unset token sends NO header (the runner 503s, "
              "rather than the backend inventing one)",
              mcp_client._runner_auth() == {})
    finally:
        settings.nova_mcp_runner_token = saved


def main() -> int:
    for t in (test_allowlists_match,
              test_runner_refuses_what_the_backend_refuses,
              test_backend_sends_a_token):
        t()
        print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
