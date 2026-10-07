"""`python -m app.updates_cli finish …` — the installer's report of an update.

deploy/install.sh cmd_update runs this in the core container it has just
brought up (or, for a refusal, the one still running), so `running_commit` is
read from THIS process's own NOVA_COMMIT: an installer that says "installed"
while its core runs something else is recorded as failed, by
nova_updates.finish. Prints the stored row as one JSON line; exit 1 with the
reason on stderr when it cannot be recorded.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from app import about, db, nova_updates


async def run(argv: list[str], *, pool=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.updates_cli")
    verbs = parser.add_subparsers(dest="verb", required=True)
    finish = verbs.add_parser("finish", help="record what ./install update did")
    finish.add_argument("--attempt", default="", help="the attempt id core opened, if any")
    finish.add_argument("--outcome", required=True, choices=nova_updates.REPORTED)
    finish.add_argument("--from", dest="from_commit", required=True)
    finish.add_argument("--to", dest="to_commit", default="")
    finish.add_argument("--reason", default="")
    args = parser.parse_args(argv)
    own = pool is None
    if own:
        pool = await db.get_pool()
    try:
        row = await nova_updates.finish(
            pool,
            attempt=args.attempt or None,
            outcome=args.outcome,
            from_commit=args.from_commit,
            to_commit=args.to_commit or None,
            reason=args.reason or None,
            running_commit=about.build_info()["commit"],
        )
    except nova_updates.CannotUpdate as exc:
        print(f"updates_cli: cannot: {exc.reason}", file=sys.stderr)
        return 1
    finally:
        if own:
            await db.close_pool()
    print(json.dumps(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run(sys.argv[1:])))
