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
    granted = ["manage_automations", "search_memory", "get_weather"]
    clean = {"granted": granted, "untrusted_context": False}
    tainted = {"granted": granted, "untrusted_context": True}

    out = await r.execute_tool("manage_automations", {"action": "list"}, clean)
    check("an actor runs on a clean turn", not out.startswith("Error:"), out[:60])

    out = await r.execute_tool("manage_automations", {"action": "list"}, tainted)
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
