"""The compose file's safety contract, pinned.

    docker compose exec backend python tests/test_compose_contract.py

Three properties that hold today and have each either bitten this install or
sit one typo away from it:

1. EVERY published port binds 127.0.0.1. The stack's entire exposure story —
   "reach it over tailscale serve or not at all" — rests on this prefix. A
   `"8080:80"` shorthand on `web` would publish the app (and its API, one
   origin) to every interface on the machine, and nothing else would notice:
   the app works identically either way.

2. EVERY service declares a restart policy, except the ones that are runs
   rather than services. The comment on `postgres` records the day the
   database simply did not come back after a reboot. New sidecars keep
   arriving (five this summer); each one added without `restart:` is that
   morning again.

3. NO NEW single-file bind mounts. A WSL restart replaces the file's inode
   and the mount dies with Exited(127) — measured here, twice (memory:
   single-file-bindmount-death). The current set is grandfathered below
   because each has a reason and a watcher; anything beyond it should be a
   directory mount or a copy.
"""

import sys
from pathlib import Path

import yaml

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
ROOT = next((p for p in (Path("/app/project"), Path("/app"))
             if (p / "docker-compose.yml").exists()), None)

#: Run-once containers, not services: `run --rm` with an exit code. A restart
#: policy here would LOOP the test suite.
RUN_ONCE = {"e2e"}

#: The single-file mounts that exist today, each with a reason to be a file:
#: the compose trio is read by inference-control to start siblings, and
#: mcp-runner serves the three root docs read-only. GRANDFATHERED, not
#: endorsed — grow this list only with the same eyes-open reasoning, because
#: every entry is a container that dies on the next WSL restart.
KNOWN_FILE_MOUNTS = {
    ("inference-control", "./docker-compose.yml"),
    ("inference-control", "./docker-compose.gpu.yml"),
    ("inference-control", "./docker-compose.models.yml"),
    ("mcp-runner", "./ROADMAP.md"),
    ("mcp-runner", "./CLAUDE.md"),
    ("mcp-runner", "./README.md"),
    ("mcp-runner", "./docker-compose.yml"),
}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def main() -> None:
    if ROOT is None:
        # A bare image with no checkout mounted has no compose file to hold
        # to its own contract — and nothing to hide. Loud, and its own
        # outcome, per run_all's skip rule.
        print("SKIPPED: no checkout mounted, so there is no compose file "
              "to check")
        sys.exit(77)

    doc = yaml.safe_load((ROOT / "docker-compose.yml").read_text())
    services = doc.get("services") or {}
    check("the compose file parses and declares services", bool(services),
          f"{len(services)} services")

    print("1. every published port binds 127.0.0.1")
    for name, svc in services.items():
        for entry in svc.get("ports") or []:
            check(f"{name}: {entry}", str(entry).startswith("127.0.0.1:"),
                  "" if str(entry).startswith("127.0.0.1:")
                  else "published on ALL interfaces")

    print("2. every long-running service has a restart policy")
    for name, svc in services.items():
        if name in RUN_ONCE:
            continue
        check(f"{name} declares restart",
              svc.get("restart") in ("unless-stopped", "always"),
              str(svc.get("restart")))

    print("3. no single-file bind mounts beyond the grandfathered set")
    for name, svc in services.items():
        for v in svc.get("volumes") or []:
            host = str(v).split(":")[0]
            if not host.startswith("./"):
                continue
            p = ROOT / host[2:]
            if p.exists() and p.is_file():
                ok = (name, host) in KNOWN_FILE_MOUNTS
                check(f"{name}: {host} single-file mount", ok,
                      "" if ok else "dies with Exited(127) on the next WSL "
                      "restart — mount the directory or copy the file in")


main()
print(f"\n{'all checks passed' if not FAILURES else 'FAILED (%d): %s' % (len(FAILURES), '; '.join(FAILURES))}")
sys.exit(1 if FAILURES else 0)
