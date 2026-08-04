"""The containment invariant — phase 2 of capability-and-containment.

    docker compose exec backend python tests/test_containment.py

    No agent turn may both hold untrusted-origin text in its context and
    execute a tool classified as ACTOR.

Checked at execute_tool, the single dispatch point, and mechanically —
because the alternative, telling the model in its prompt to be careful, is
the control that failed twice in one week.

THE INVERSION is the property worth protecting: "search memory, then act on
what you find" is the move that defeats a prompt warning, because the
warning is in the prompt and the instruction arrives in the result. Pulling
untrusted text into a turn is now the very act that disarms the tools that
could act on it.

TWO CALIBRATIONS, both found by the thing breaking rather than by reasoning:

  * ACTOR is NOT "anything that writes". `ingestion` exists to turn fetched
    web pages into topics and therefore always holds untrusted context; a
    write-blocking rule would have broken the one agent designed for the
    job. ACTOR is the verbs whose effect ESCAPES memory.
  * The fence keys on THIRD_PARTY, not on "not first-party". Journals are
    retrieved on nearly every turn, so the broader rule tainted everything
    and Nova could not list her own automations. A control that fires always
    is the same as no control, except it also breaks the product.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, settings_store
    from app.memory import provenance as pv
    from app.tools import registry as r
    await db.init_pool()
    await settings_store.warm()

    print("1. what counts as an ACTOR")
    for name in ("manage_agents", "manage_tools", "manage_rules",
                 "manage_automations", "pull_model", "delete_memory_item"):
        check(f"{name} is an actor", r.is_actor(name))
    print("   ...and what deliberately is not")
    for name in ("search_memory", "read_memory_item", "get_weather",
                 "list_agents", "list_skills"):
        check(f"{name} is a reader", not r.is_actor(name))
    check("write_memory is NOT an actor — ingestion's whole job is turning "
          "fetched pages into topics, and it always holds untrusted context",
          not r.is_actor("write_memory"))
    check("ingest_media is not an actor, for the same reason",
          not r.is_actor("ingest_media"))

    print("2. unknown tools fail CLOSED")
    check("an MCP tool could do anything its server implements",
          r.is_actor("mcp:whatever/anything"))
    check("an unrecognised name is an actor", r.is_actor("not_a_real_tool"))
    check("a non-GET db tool is an actor",
          r.is_actor("poster", {"poster": {"execution_spec": {"method": "POST"}}}))
    check("a GET-only db tool is a reader — treating it as an actor would "
          "block 'what is the weather' for no safety gained",
          not r.is_actor("getter", {"getter": {"execution_spec": {"method": "GET"}}}))

    print("2b. an operator-declared read-only MCP server is a READER")
    check("undeclared MCP is an actor — fail closed",
          r.is_actor("mcp:fs/read_file", None, set()))
    check("declared read-only, the same tool is a reader",
          not r.is_actor("mcp:fs/read_file", None, {"fs"}))
    check("the declaration is per SERVER, not global",
          r.is_actor("mcp:other/write_file", None, {"fs"}))
    check("a tool NAME proves nothing — 'read_file' on an undeclared server "
          "is still an actor", r.is_actor("mcp:sneaky/read_file", None, {"fs"}))

    print("2c. wire names — providers reject ':' and '/' in a tool name")
    import re as _re
    pat = _re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
    canonical = "mcp:nova-src/read_text_file"
    wire = r.wire_name(canonical)
    check("the wire form satisfies the provider pattern", bool(pat.match(wire)), wire)
    check("...and round-trips exactly", r.canonical_name(wire) == canonical, wire)
    check("a builtin name is untouched", r.wire_name("search_memory") == "search_memory")
    check("canonicalising a builtin is a no-op",
          r.canonical_name("search_memory") == "search_memory")
    check("the ACTOR check runs on the CANONICAL name — a wire name would "
          "fall through to the unknown-tool default and refuse everything",
          not r.is_actor(r.canonical_name(wire), None, {"nova-src"}))

    print("3. the refusal at the dispatch point")
    # `delete_memory_item` rather than `manage_automations`, and the choice
    # matters: since goal-scoped autonomy shipped, the capability-CREATING
    # verbs also need an approved goal, so a clean turn calling one is
    # refused for a reason that has nothing to do with containment. This
    # check exists to prove the untrusted-context fence lets clean turns
    # through, so it has to use an ACTOR verb no other gate touches —
    # deletion is ACTOR and deliberately outside GOAL_SCOPED_TOOLS.
    granted = ["delete_memory_item", "search_memory", "get_weather"]
    clean = {"granted": granted, "untrusted_context": False}
    tainted = {"granted": granted, "untrusted_context": True}

    out = await r.execute_tool("delete_memory_item",
                               {"item_id": "topics/does-not-exist.md"}, clean)
    check("an actor runs on a clean turn — reaching its own not-found is a "
          "PASS here; what matters is that the fence did not stop it",
          "changes what this system can do" not in out, out[:70])

    out = await r.execute_tool("delete_memory_item",
                               {"item_id": "topics/does-not-exist.md"}, tainted)
    check("the SAME call is refused on a tainted turn",
          out.startswith("Error:"), out[:60])
    check("...and the refusal says why, in the operator's terms",
          "outside source" in out, out[:120])

    out = await r.execute_tool("search_memory", {"query": "x"}, tainted)
    check("readers still work on a tainted turn — the fence is on acting, "
          "not on knowing", not out.startswith("Error: 'search_memory'"), out[:60])

    print("4. the grant check still comes first")
    out = await r.execute_tool("manage_agents", {"action": "list"},
                               {"granted": ["search_memory"], "untrusted_context": False})
    check("an ungranted tool is refused regardless of taint",
          "not granted" in out, out[:60])

    print("5. what taints a turn")
    check("third-party blocks actors", pv.blocks_actors(pv.THIRD_PARTY))
    check("unknown blocks actors — fail closed", pv.blocks_actors(None))
    check("a conversation transcript does NOT block actors, or Nova could "
          "never manage anything", not pv.blocks_actors(pv.CONVERSATION))
    check("first-party does not block actors", not pv.blocks_actors(pv.FIRST_PARTY))

    # ── 6-8: IN-TURN taint (2026-07-31) ──────────────────────────────────
    # Until now the flag came only from memory provenance and was fixed
    # before round 1, so "fetch in round 1, act in round 2" walked straight
    # through. Migration 075 gave main the web and made that reachable.
    print("6. which tools bring untrusted text IN")
    for name in ("web_search", "fetch_url", "ingest_media", "poll_sources",
                 "follow_source", "workload_logs", "get_weather"):
        check(f"{name} taints the turn", r.returns_untrusted(name))
    for name in ("search_memory", "read_memory_item", "list_agents",
                 "write_memory", "manage_agents", "propose_goal"):
        check(f"{name} does not taint", not r.returns_untrusted(name))
    check("a db tool taints — an http_call reaches somebody else's host by "
          "construction, GET or not",
          r.returns_untrusted("github-profile-fetch"))
    check("an MCP tool taints — fail closed, a server returns what it likes",
          r.returns_untrusted("mcp:nova-src/read_text_file"))
    check("an unknown name taints — fail closed",
          r.returns_untrusted("something-nobody-registered"))

    print("7. the fence fires once a turn has been tainted mid-flight")
    # manage_automations is BOTH actor and goal-scoped, so a MUTATING call is
    # refused on a clean turn too — by the goal gate, with different wording.
    # The point here is WHICH refusal fires, not that one does.
    _FENCE = "outside source"
    _GOAL = "goal the operator has approved"
    ctx = {"granted": ["manage_automations", "fetch_url"],
           "untrusted_context": False}
    # a name that does not exist, so if the gate ever stopped firing this
    # probe still cannot change anything
    write = {"action": "disable", "name": "__no-such-automation__"}
    clean = await r.execute_tool("manage_automations", write, ctx)
    check("on a CLEAN turn the fence stays silent (the goal gate answers)",
          _FENCE not in clean and _GOAL in clean, clean[:70])
    # ...and a READ is not capability creation, so NEITHER rail speaks. The
    # gate matched on the tool name alone until 2026-08-04, which refused
    # `list` exactly like `create` AND raised an approval card — so asking
    # her what was scheduled put a decision in front of the operator.
    read = await r.execute_tool("manage_automations", {"action": "list"}, ctx)
    check("a READ action passes both rails on a clean turn — answering "
          "'what do I have scheduled?' is not a capability change",
          _FENCE not in read and _GOAL not in read, read[:70])
    # exactly what _run_tool now does after fetch_url returns
    ctx["untrusted_context"] = True
    tainted = await r.execute_tool("manage_automations", {"action": "list"}, ctx)
    check("...but the fence refuses even that READ once the turn is tainted — "
          "containment is about the actor tool, not about the action",
          _FENCE in tainted, tainted[:80])
    # Ordering is load-bearing: were the goal gate first, an operator-approved
    # goal would let a poisoned page spend it. The fence has to win.
    check("the fence is checked BEFORE the goal gate, so an approved goal "
          "cannot be spent on a tainted turn", _GOAL not in tainted,
          tainted[:80])

    print("8. a dispatch cannot launder the taint")
    # dispatch_to_agent is runner-inlined and never reaches execute_tool, so
    # the fence cannot refuse it. run_agent must inherit the flag instead.
    import inspect
    from app.agents import runner as rn
    check("run_agent accepts parent_untrusted",
          "parent_untrusted" in inspect.signature(rn.run_agent).parameters)
    check("_run_dispatch accepts parent_untrusted",
          "parent_untrusted" in inspect.signature(rn._run_dispatch).parameters)
    check("_run_dispatch_group accepts parent_untrusted",
          "parent_untrusted" in inspect.signature(rn._run_dispatch_group).parameters)
    src = inspect.getsource(rn.run_agent)
    check("the sub-agent's ctx ORs the parent's flag in",
          "or parent_untrusted" in src)
    check("the group is passed the flag read from the LIVE ctx, so a fetch "
          "in an earlier round of this turn counts",
          'parent_untrusted=bool(ctx.get("untrusted_context"))' in src)

    print("9. taint travels BOTH ways across a dispatch")
    check("the taint event is forwarded out of a sub-agent",
          "taint" in rn._FORWARDED_FROM_SUB, str(rn._FORWARDED_FROM_SUB))
    src_all = inspect.getsource(rn)
    check("run_agent emits it when its own ctx ended up tainted",
          'yield {"type": "taint"' in src_all)
    check("the parent CONSUMES it and taints itself",
          'if ev.get("type") == "taint"' in src_all
          and 'ctx["untrusted_context"] = True' in src_all)
    check("...and does not forward it to the client — it is plumbing, "
          "not a display event", 'continue' in src_all.split(
              'if ev.get("type") == "taint"')[1][:800])

    print("10. consent cards can find their conversation")
    # request_operator_confirmation passes ctx.get("conversation_id") into
    # consents.create, and list_pending filters on it. It was never in ctx,
    # so every card an agent raised was written with NULL and no UI could
    # ever show it.
    check("run_agent takes a conversation_id",
          "conversation_id" in inspect.signature(rn.run_agent).parameters)
    check("it reaches the tool ctx", '"conversation_id": conversation_id' in src_all)
    check("and rides down the dispatch, so a specialist's card lands in the "
          "operator's chat rather than nowhere",
          'conversation_id=ctx.get("conversation_id")' in src_all)

    await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
