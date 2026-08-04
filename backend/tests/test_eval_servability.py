"""Every tool an agent holds must have an answer during a replay run.

    docker compose exec backend python tests/test_eval_servability.py

A tool the agent is granted, that no task fixtures, that the suite does not
list as replay-only, and that is not in LIVE_OK, produces an UNSERVED CALL. The
run is marked invalid or the model eats a tool error, and either way the score
stops being about the model.

This is not hypothetical, it is the defect that wasted a day. `main` had TEN
such tools. Before they were covered, glm-5.2 made zero tool calls and FAILED
the service-outage task; after, both models passed it 3/3 across three
repeats. **The entire model difference was the suite's.** Then the same audit
found guardian's `diagnose` uncovered — which is very likely why every model
run against guardian scored 0/6.

`granted.json` is guarded by test_eval_grants.py so an agent's GRANTS cannot
drift from the eval's picture of them. Nothing guarded the other half: the
suite's ability to ANSWER those grants. So the replay list silently fell
behind every time an agent gained a tool, and a rotting suite looks exactly
like a failing model.

The fix for a failure here is one line in the suite's `replay_only_tools`, or
a fixture if the task needs a real answer — and a `suite_version` bump, since
making a previously-unserved call answerable changes what the suite measures.
"""

import asyncio
import json
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def audit() -> dict[str, list[str]]:
    from app import db, settings_store
    from app.agents import registry as agent_registry
    from app.evals import suites as suite_mod
    from app.tools import fixtures as fx
    from app.tools import registry as tool_registry

    await db.init_pool()
    await settings_store.warm()
    try:
        agents = {a["name"]: a for a in
                  await agent_registry.list_agents(enabled_only=False)}
        gaps: dict[str, list[str]] = {}
        for name in suite_mod.list_suites():
            suite = suite_mod.load_suite(name)
            agent = agents.get(suite.agent)
            if not agent:
                continue
            granted = sorted(
                tool_registry.canonical_name(d["function"]["name"])
                for d in await tool_registry.get_agent_tools(agent))
            # Three legitimate ways a call gets an answer.
            covered = (set(suite.replay_only_tools) | set(suite.exclude_tools)
                       | set(fx.LIVE_OK))
            for task in suite_mod.load_tasks(suite):
                for path in task.fixtures:
                    try:
                        covered.add(json.loads(open(path).read()).get("tool"))
                    except Exception:  # noqa: BLE001
                        pass
            missing = [g for g in granted if g not in covered]
            if missing:
                gaps[name] = missing
        return gaps
    finally:
        await db.close_pool()


def main() -> int:
    print("every granted tool has an answer during replay")
    gaps = asyncio.run(audit())
    for suite, missing in sorted(gaps.items()):
        check(f"{suite}: {len(missing)} granted tool(s) cannot be served",
              False, ", ".join(missing))
    if not gaps:
        print("  PASS  every suite can answer every tool its agent holds")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED — add each tool to that suite's "
              f"`replay_only_tools`, or author a fixture, and bump "
              f"`suite_version`. An unserved call makes the run about the "
              f"suite instead of the model.")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
