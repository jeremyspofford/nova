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

import _env

sys.path.insert(0, "/app/backend")

from app.evals import suites  # noqa: E402

SNAPSHOT = Path("/app/backend/app/evals/tasks/granted.json")
REGENERATE = (
    "docker compose exec -T backend python -c \"...\" "
    "— see the generator in tests/test_eval_grants.py:live_grants()")

FAILURES: list[str] = []

# THIS SUITE IS ABOUT THE OPERATOR'S INSTALL, not about any branch. It asks
# whether the live agent toolsets still match the snapshot the eval suites
# were authored against — which is a real and important question, and one
# with no meaning against the sandbox's fresh database, where the grants are
# simply whatever the migrations created. Failing there would report drift
# that does not exist and would say nothing about the code under test.
if _env.in_sandbox():
    _env.skip("compares the LIVE install's agent grants against the eval "
              "snapshot; the sandbox has a fresh database, so there is no "
              "live install to have drifted")


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


async def unreachable_mcp() -> list[str]:
    """MCP servers that are granted but not answering right now.

    Their tools — and the `find_mcp_tools` meta-tool, which `get_agent_tools`
    only offers when a granted server has lazily-loaded tools — vanish from
    the RESOLVED toolset when the server is down. That is connectivity, not a
    revoked grant, and the two must not read the same.

    This matters because `mcp-runner` sits behind a compose profile: a stack
    started without it puts every MCP server in `error`, and before this
    distinction existed the suite went red claiming `maintainer` had lost
    `find_mcp_tools`. A drift detector that cries wolf when an OPTIONAL
    sidecar is stopped teaches you to ignore it, which costs you the real
    drift it exists to catch.
    """
    # its own pool lifecycle: live_grants() closes the pool when it is done,
    # and this runs before it
    from app import db
    await db.init_pool()
    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                "SELECT name, status FROM mcp_servers WHERE enabled = true")
    finally:
        await db.close_pool()
    return sorted(r["name"] for r in rows if r["status"] != "ok")


def _explained_by_mcp(tool: str, down: list[str]) -> bool:
    """Is this tool's absence attributable to a server being unreachable?"""
    if not down:
        return False
    if tool == "find_mcp_tools":
        return True                      # offered only when a server answers
    return tool.startswith("mcp:") and any(
        tool.startswith(f"mcp:{name}/") for name in down)


async def run() -> None:
    down = await unreachable_mcp()
    live = await live_grants()
    if down:
        print(f"  NOTE  MCP server(s) not answering: {', '.join(down)} — their "
              f"tools are absent from the resolved toolset for that reason, "
              f"and are reported separately below rather than as revocations.")

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
    offline_only: list[str] = []
    for name in sorted(set(live) & set(stored)):
        # Grants that ARRIVED with an MCP server are not authoring drift.
        # This snapshot exists to catch a suite author and the database
        # disagreeing; an operator approving a server changes the live
        # toolset the same minute and no file can be ahead of that. Excluded
        # from BOTH sides, so a snapshot that still names a removed server's
        # tools does not read as a revocation either.
        dynamic = suites.dynamic_tools(set(live[name]) | set(stored[name]))
        added = sorted(set(live[name]) - set(stored[name]) - dynamic)
        removed = sorted(set(stored[name]) - set(live[name]) - dynamic)
        # split the absences: a REVOKED grant is drift and must fail; a tool
        # missing because its server is stopped is a fact about this stack
        # right now and is reported without failing.
        offline = [t for t in removed if _explained_by_mcp(t, down)]
        removed = [t for t in removed if t not in offline]
        if offline:
            offline_only.append(f"{name}: {offline}")
        check(f"{name}: {len(live[name])} tools, unchanged",
              not added and not removed,
              (f"granted since: {added} " if added else "")
              + (f"revoked since: {removed}" if removed else ""))
    if offline_only:
        print("  NOTE  absent only because an MCP server is unreachable, NOT "
              "revoked: " + "; ".join(offline_only))

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
