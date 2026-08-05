"""The two tools the runner executes itself are still gated.

    docker compose exec backend python tests/test_inlined_grants.py

`dispatch_to_agent` and `find_mcp_tools` never reach `registry.execute_tool`
— the registry says so out loud ("dispatch_to_agent is runner-inlined") —
because both mutate state the registry cannot see: a nested turn, and the
live round's toolset. The cost, until 2026-08-05, was that they became the
only two tools in the system whose grant was enforced by the model not
naming them.

WHY THAT MATTERED. `_family_allowed` narrows a kid/guest/unknown turn to the
operator's `voice.family_tools` allowlist, and `_FAMILY_HARD_EXCLUDE` drops
dispatch outright. runner.py promises this is "enforced mechanically below,
at the same layer as tool grants" and that recognition "can only ever NARROW,
never widen". It was enforced by FILTERING THE OFFERED LIST, and an offered
list is a suggestion:

  * a guest turn that emitted `dispatch_to_agent` anyway ran a full nested
    turn at operator tier, holding the specialist's own tools;
  * a guest turn that emitted `find_mcp_tools` had `ctx["granted"]` rebuilt
    from the extended toolset, so every lazy MCP tool on the agent ROW became
    callable for the rest of the turn — dispatch escaped the clamp,
    find_mcp_tools deleted it.

Operator rules went the same way: rules.py states enforcement lives in
`execute_tool`, so a block rule naming either tool never fired.

Three properties are defended here. The third is the one that matters in six
months: the SET of runner-inlined tools is read from the runner itself, so a
third one added later fails this test until it is gated too.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def entry(name: str, args: dict | None = None):
    """One parsed tool call, in the runner's (tc, args, malformed) shape."""
    return ({"id": "call_1", "name": name}, args or {}, False)


async def run() -> None:
    from app import db, settings_store
    from app.agents import runner
    from app.tools import registry as treg
    await db.init_pool()
    await settings_store.warm()

    print("1. every runner-inlined tool is covered")
    # DERIVED from the runner's own set. A third inlined tool added later
    # arrives here automatically rather than being remembered about.
    check("the inlined set is non-empty and named by the runner",
          bool(runner._RUNNER_INLINED), str(sorted(runner._RUNNER_INLINED)))
    for name in sorted(runner._RUNNER_INLINED):
        ungranted = {"granted": set(), "agent_name": "main"}
        refusal = runner._inlined_refusal(entry(name), ungranted, 0)
        check(f"{name} is refused when it is not granted", bool(refusal),
              str(refusal))
        # The string must be the one execute_tool returns, or the two paths
        # become distinguishable to the model — the failure the registry's
        # own lazy-MCP comment is about.
        same = await treg.execute_tool("web_search", {}, ungranted)
        check(f"...with the same sentence execute_tool uses for {name}",
              refusal.startswith("Error: tool '")
              and refusal.endswith("is not granted to this agent")
              and same.endswith("is not granted to this agent"),
              f"{refusal!r} vs {same!r}")

    print("2. a granted call is not refused")
    for name in sorted(runner._RUNNER_INLINED):
        ctx = {"granted": {name}, "agent_name": "main"}
        check(f"{name} runs when it IS granted",
              runner._inlined_refusal(entry(name), ctx, 0) is None)

    print("3. the depth limit keeps its own better sentence")
    # At the dispatch-depth limit the tool is excluded from `tools` and so is
    # absent from `granted` — but that is not a denial, and `_run_dispatch`
    # already answers it with "dispatch depth limit reached". A blanket grant
    # check here would have replaced a routing message with a permission one
    # on the common path.
    at_limit = {"granted": set(), "agent_name": "main"}
    check("dispatch at the depth limit falls through to its own message",
          runner._inlined_refusal(
              entry("dispatch_to_agent"), at_limit,
              runner.MAX_DISPATCH_DEPTH) is None)
    check("...and below the limit it is still refused",
          runner._inlined_refusal(entry("dispatch_to_agent"), at_limit, 0)
          is not None)

    print("4. granted=None still means unrestricted")
    # The registry's convention: a None grant set is "no restriction", not
    # "nothing allowed". Inverting it here would have refused every tool on
    # every path that does not build the set.
    check("an unrestricted ctx refuses nothing",
          all(runner._inlined_refusal(entry(n), {"agent_name": "main"}, 0) is None
              for n in runner._RUNNER_INLINED))

    print("5. a malformed call is left to the malformed path")
    bad = ({"id": "call_1", "name": "dispatch_to_agent"}, {}, True)
    check("a malformed call is not answered here",
          runner._inlined_refusal(bad, {"granted": set()}, 0) is None)

    print("6. the family clamp matches CANONICAL names")
    # The setting documents `mcp:*`, and a wire name is `mcp__server__tool` —
    # which no `mcp:`-prefixed pattern can ever match. So "let the guests use
    # one MCP server" was unconfigurable: the pattern matched nothing and read
    # to the operator as a working restriction, which is the worse failure.
    pats = ["web_search", "mcp:context7/*"]
    check("a plain builtin matches", runner._family_permits("web_search", pats))
    check("an mcp: pattern reaches an mcp: tool",
          runner._family_permits("mcp:context7/query-docs", pats))
    check("...and not another server's",
          not runner._family_permits("mcp:other/thing", pats))
    check("dispatch is excluded no matter what the allowlist says",
          not runner._family_permits("dispatch_to_agent",
                                     ["dispatch_to_agent", "*"]))
    # And the wire/canonical bridge itself: `_family_allowed` filters the
    # OFFERED list, whose names are wire-form, using patterns written in
    # canonical form. Before this it compared the two directly, so an
    # `mcp:`-prefixed pattern silently matched nothing.
    wire = treg.wire_name("mcp:context7/query-docs")
    saved_pats = runner._family_patterns
    try:
        runner._family_patterns = lambda: pats
        check("a wire-named mcp tool is admitted by its canonical pattern",
              runner._family_allowed({wire, "web_search", "delete_memory_item"})
              == {wire, "web_search"},
              str(runner._family_allowed({wire, "web_search",
                                          "delete_memory_item"})))
    finally:
        runner._family_patterns = saved_pats

    print("7. rules are evaluated for the inlined tools too")
    # rules.py states enforcement lives in execute_tool. These two never got
    # there, so a block rule naming either of them never fired.
    import app.rules as rules
    import re
    saved = list(rules._cache)
    try:
        rules._cache = [{
            "id": "00000000-0000-0000-0000-000000000000",
            "name": "no-dispatch-for-main", "description": "test rule",
            "action": "block", "target_tools": ["dispatch_to_agent"],
            "target_agents": ["main"], "regex": re.compile("."),
        }]
        ctx = {"granted": {"dispatch_to_agent"}, "agent_name": "main"}
        refusal = runner._inlined_refusal(entry("dispatch_to_agent"), ctx, 0)
        check("a block rule refuses an inlined call", bool(refusal), str(refusal))
        check("...in the words execute_tool uses",
              (refusal or "").startswith("Blocked by rule "), str(refusal))
        other = {"granted": {"dispatch_to_agent"}, "agent_name": "ingestion"}
        check("...and only for the agent it targets",
              runner._inlined_refusal(entry("dispatch_to_agent"), other, 0) is None)
    finally:
        rules._cache = saved

    print("8. the probe never spends the operator's hit counters")
    # gate_refusing is a REPORTER: the unattended derivation runs it against
    # every granted read-only tool on every turn, purely to build a sentence.
    # Recording those would make a rule that has caught nothing report
    # hundreds of hits, and the guardian suite reasons from hit_count == 0 as
    # proof a rule has matched no call by any agent.
    hits = []
    saved_record = rules._record_hit
    saved_cache = list(rules._cache)
    try:
        rules._record_hit = lambda rid: hits.append(rid)
        rules._cache = [{
            "id": "00000000-0000-0000-0000-000000000001",
            "name": "watch-everything", "description": "test rule",
            "action": "warn", "target_tools": [], "target_agents": [],
            "regex": re.compile("."),
        }]
        rules.check("fetch_url", {}, "main", record=False)
        check("record=False records nothing", hits == [], str(hits))
        rules.check("fetch_url", {}, "main")
        check("...and the enforcing call still does", len(hits) == 1, str(hits))
    finally:
        rules._record_hit = saved_record
        rules._cache = saved_cache


asyncio.run(run())
print(f"\n{'all checks passed' if not FAILURES else 'FAILED (%d): %s' % (len(FAILURES), '; '.join(FAILURES))}")
sys.exit(1 if FAILURES else 0)
