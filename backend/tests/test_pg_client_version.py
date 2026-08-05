"""The postgres client in this image must match the server it dumps.

    docker compose exec backend python tests/test_pg_client_version.py

A backup you cannot restore is not a backup, and this is the second of two
independent reasons every bundle on this install was unrestorable on
2026-08-05. The other one is recorded in migration 087's tombstone.

WHAT HAPPENED. backend/Dockerfile installed `postgresql-client` — Debian's
default, which on trixie is 17 — while docker-compose.yml pins
postgres:16-alpine. pg_dump 17 writes `SET transaction_timeout = 0;` into the
header of every dump. PG16 has no such parameter, so pg_restore stops on the
first statement:

    pg_restore: error: could not execute query: ERROR:  unrecognized
    configuration parameter "transaction_timeout"

Nothing caught it, because nothing ever restored a bundle. The snapshots were
green, `backup_snapshot.verify` checked their checksums and said so, and the
Settings card showed a tick. Every one of them was a tarball that could not be
put back.

WHY A TEST AND NOT A COMMENT. The Dockerfile now takes PG_MAJOR as a build
ARG, so the two versions have one source of truth — but an ARG's default and
a compose image tag are still two strings in two files. This is the line that
refuses when they drift: the day someone bumps postgres to 17 and does not
rebuild the backend with PG_MAJOR=17, the build that would go on producing
unrestorable dumps goes red instead. It reads the LIVE server version too, so
it fails against reality rather than against the file.
"""

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
# The repo root as the container sees it. `/app/project` is the compose bind
# mount of the checkout; `/app` alone holds only the copied backend, so a
# build-time comparison is possible in dev and simply absent in a bare image.
ROOT = next((p for p in (Path("/app/project"), Path("/app"))
             if (p / "docker-compose.yml").exists()), Path("/app/project"))


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def major(text: str) -> str:
    m = re.search(r"(\d+)", text or "")
    return m.group(1) if m else ""


def tool_major(tool: str) -> str:
    """The major version of a client binary, or "" if it is not installed."""
    try:
        out = subprocess.run([tool, "--version"], capture_output=True,
                             text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    # "pg_dump (PostgreSQL) 16.10 (Debian ...)" -> 16
    m = re.search(r"\(PostgreSQL\)\s+(\d+)", out.stdout)
    return m.group(1) if m else ""


def main() -> None:
    print("1. the client binaries the backup path actually shells out to")
    # backup_snapshot and backup_restore invoke these by name, so their
    # versions are the ones that decide whether a bundle round-trips.
    versions = {t: tool_major(t) for t in ("pg_dump", "pg_restore", "psql")}
    for tool, v in versions.items():
        check(f"{tool} is installed", bool(v), v or "not found")
    present = {v for v in versions.values() if v}
    check("...and they are all the same major version", len(present) <= 1,
          str(versions))

    print("2. the LIVE server they have to agree with")
    server = ""
    try:
        import asyncio

        from app import db

        async def ask():
            await db.init_pool()
            async with db.acquire() as conn:
                return await conn.fetchval("SHOW server_version")
        server = major(asyncio.run(ask()))
    except Exception as e:  # noqa: BLE001 — reported, never a silent skip
        check("the live server version could be read", False, str(e)[:120])
    if server:
        check("the client major matches the server major",
              present == {server},
              f"client={sorted(present)} server={server}")

    print("3. the compose file and the Dockerfile ARG agree")
    # Read as text: this runs inside the container, where the repo is mounted
    # but docker is not. Missing files are reported, never skipped — a check
    # that quietly does not run is the thing this suite exists to prevent.
    compose = ROOT / "docker-compose.yml"
    dockerfile = ROOT / "backend" / "Dockerfile"
    if not compose.exists() or not dockerfile.exists():
        # NOT a silent skip, and not a failure either: this section compares
        # two files, and section 2 already compared the binaries against the
        # running server, which is the stronger question and the one that
        # actually broke. In an image with no checkout mounted there is
        # nothing to compare and nothing to hide.
        print("     (no checkout mounted — sections 2 and 4 are the live "
              "control and already ran)")
    else:
        img = re.search(r"image:\s*postgres:(\d+)", compose.read_text())
        arg = re.search(r"ARG\s+PG_MAJOR=(\d+)", dockerfile.read_text())
        check("docker-compose.yml pins a postgres major", bool(img),
              img.group(1) if img else "no `image: postgres:<n>` found")
        check("backend/Dockerfile declares PG_MAJOR", bool(arg),
              arg.group(1) if arg else "no `ARG PG_MAJOR=<n>` found")
        if img and arg:
            check("...and they are the SAME major — bump one, bump both",
                  img.group(1) == arg.group(1),
                  f"compose={img.group(1)} Dockerfile={arg.group(1)}")
            if server:
                check("...and that is what the server is really running",
                      img.group(1) == server,
                      f"pinned={img.group(1)} running={server}")

    print("4. a dump made here carries nothing this server cannot read")
    # The end-to-end property, in one line and without a full bundle: dump the
    # schema only, and look for a SET the server would refuse. This is what
    # actually failed — the header, not the data.
    try:
        from app.config import settings
        dsn = settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
        out = subprocess.run(["pg_dump", "--schema-only", "--no-owner",
                              "--no-acl", dsn],
                             capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            check("pg_dump runs against the live database", False,
                  out.stderr.strip()[:160])
        else:
            sets = set(re.findall(r"^SET (\w+)", out.stdout, re.M))
            bad = []
            import asyncio

            from app import db

            async def probe():
                await db.init_pool()
                async with db.acquire() as conn:
                    for name in sorted(sets):
                        try:
                            await conn.fetchval(f"SHOW {name}")
                        except Exception:      # noqa: BLE001, PERF203
                            bad.append(name)
            asyncio.run(probe())
            check("every SET in the dump header is a parameter this server has",
                  not bad, f"unrecognised: {bad}" if bad else f"{len(sets)} checked")
    except Exception as e:  # noqa: BLE001
        check("the dump header could be inspected", False, str(e)[:160])


main()
print(f"\n{'all checks passed' if not FAILURES else 'FAILED (%d): %s' % (len(FAILURES), '; '.join(FAILURES))}")
sys.exit(1 if FAILURES else 0)
