"""The eval validator's picture of who can call what must match reality.

    docker compose exec backend python tests/test_eval_grants.py

`backend/app/evals/tasks/validate.py` rejects a task contract that names a
tool its agent cannot call. That check is only as good as its idea of the
grants — and it used to be a hardcoded dict of THREE agents, so when five
more suites were authored on 2026-07-27 the validator warned "no known
toolset, checks skipped" and passed them. A skipped check reads exactly like
a passing one in a summary line that says "0 errors".

So the grants now live in a generated snapshot, and this is the thing that
keeps the snapshot true. It is the other half of the codebase rule: state
what is true, then check it anyway. The validator stays stdlib-only — it must
run in a bare checkout with nothing up — so it reads a file; this test has a
database and does the comparing.

Drift here is not cosmetic. A grant added to an agent and not reflected here
means a contract naming that tool is rejected as invalid; a grant REMOVED and
not reflected means a contract can name a tool the agent can no longer call,
and the task silently grades nothing — which is how two `main` tasks came to
require a dispatch the harness never offers.
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

SNAPSHOT = Path("/app/backend/app/evals/tasks/granted.json")
REGENERATE = (
    "docker compose exec -T backend python -c \"...\" "
    "— see the generator in tests/test_eval_grants.py:live_grants()")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def live_grants() -> dict[str, list[str]]:
    """The resolved toolset of every agent, canonical names, from the DB."""
    from app import db, settings_store
    from app.agents import registry as agent_registry
    from app.tools import registry as tool_registry
    await db.init_pool()
    await settings_store.warm()
    out: dict[str, list[str]] = {}
    for agent in await agent_registry.list_agents(enabled_only=False):
        tools = await tool_registry.get_agent_tools(agent)
        out[agent["name"]] = sorted(
            tool_registry.canonical_name(t["function"]["name"]) for t in tools)
    await db.close_pool()
    return out


async def run() -> None:
    live = await live_grants()

    print("1. the snapshot exists and parses")
    check("granted.json is present — without it the validator silently skips "
          "every tool-name check", SNAPSHOT.exists(), str(SNAPSHOT))
    if not SNAPSHOT.exists():
        return
    stored = {k: sorted(v) for k, v in json.loads(SNAPSHOT.read_text()).items()}

    print("2. it describes the same agents the database does")
    missing = sorted(set(live) - set(stored))
    extra = sorted(set(stored) - set(live))
    check("no agent is missing from the snapshot — a missing agent is the "
          "'no known toolset, checks skipped' warning that let five suites "
          "through unchecked", not missing, str(missing))
    check("no agent in the snapshot has been deleted from the database",
          not extra, str(extra))

    print("3. every agent's toolset matches exactly")
    for name in sorted(set(live) & set(stored)):
        added = sorted(set(live[name]) - set(stored[name]))
        removed = sorted(set(stored[name]) - set(live[name]))
        check(f"{name}: {len(live[name])} tools, unchanged",
              not added and not removed,
              (f"granted since: {added} " if added else "")
              + (f"revoked since: {removed}" if removed else ""))

    if FAILURES:
        print("\nThe snapshot is stale. Regenerate it from the live database "
              "and re-run backend/app/evals/tasks/validate.py — a contract "
              "naming a tool an agent no longer holds grades NOTHING, "
              "silently.")


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
