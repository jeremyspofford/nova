"""Goal-scoped autonomy — approval given once, spent many times, bounded.

    docker compose exec backend python tests/test_goals.py

Jeremy, 2026-07-28, asked what it would take for Nova to manage his router —
"you figure it out, building out what you need" — and settled the policy in
the same conversation: research always allowed, everything else needs
approval, and a GOAL can carry that approval ahead of time "but only for the
goal".

Two things were wrong before this shipped, and the second is the worse one:

1. There was no standing-approval concept at all, so every step was either a
   separate question or nothing.
2. `manage_agents`, `manage_tools` and `manage_automations` were entirely
   UNGATED — and Nova told Jeremy in that same conversation that agent and
   tool creation "requires operator approval". She was describing restraints
   she did not have. A claimed capability has `capability_claims.py` to catch
   it; a claimed RESTRICTION had nothing, and it is the more dangerous
   direction because it reassures.

The property under test throughout: "only for the goal" is a set-membership
test against verbs the operator ticked, never a judgement about whether an
action serves the goal. A model asked to decide that will always be able to
argue yes.
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
    from app import consents, db, goals, settings_store
    from app.tools import builtin, registry as tr

    await db.init_pool()
    await settings_store.warm()
    made: list[str] = []

    try:
        print("1. the scope is a subset, and the exclusions are the point")
        check("guardrail changes can never be pre-approved by a goal — one "
              "approval covering every future weakening would turn the "
              "strictest gate in the system into the weakest",
              "manage_rules" not in tr.GOAL_SCOPED_TOOLS)
        check("neither can memory deletion — a goal buys permission to BUILD, "
              "never to erase the operator's own record",
              "delete_memory_item" not in tr.GOAL_SCOPED_TOOLS)
        check("...while both remain ACTOR verbs, still fenced from untrusted "
              "context and still consent-gated where they already were",
              {"manage_rules", "delete_memory_item"} <= tr.ACTOR_TOOLS)
        check("research is not in scope because research was never gated",
              not ({"web_search", "fetch_url", "search_memory"} & tr.GOAL_SCOPED_TOOLS))

        print("2. with no goal, a capability verb is refused — and ROUTED")
        ctx = {"agent_name": "agent-creator", "granted": {"manage_agents"}}
        out = await tr.execute_tool("manage_agents", {"action": "create"}, ctx)
        check("refused", out.startswith("Error"), out[:70])
        check("...naming propose_goal, so the refusal is a next step rather "
              "than a dead end — a gate that dead-ends gets switched off",
              "propose_goal" in out)

        print("3. a goal grants exactly the verbs it names")
        g = await goals.propose("Router management",
                                "a router-manager agent that lists VLANs",
                                ["manage_tools", "manage_tool_hosts"],
                                proposed_by="main")
        made.append(g["id"])
        check("proposing grants nothing on its own",
              (await goals.get(g["id"]))["status"] == "proposed"
              and not await goals.spend("manage_tools", agent_name="main"))
        await goals.activate(g["id"], max_actions=2)
        # The goal was proposed BY main, so main is who may spend it. Until
        # 2026-08-04 spend() matched on verb alone and `agent_name` reached
        # only the log line, so this same call succeeded for every other agent
        # and for every scheduled automation.
        check("another agent cannot spend main's approval",
              not await goals.spend("manage_tools", agent_name="ingestion"))
        check("an approved verb spends",
              bool(await goals.spend("manage_tools", agent_name="main")))
        check("a verb outside the goal does NOT, however related it sounds — "
              "'I need an agent to manage the router' is exactly the argument "
              "a model would make, and it is not a key",
              not await goals.spend("manage_agents", agent_name="main"))

        print("4. the bounds are columns, not heuristics")
        check("the action cap holds",
              bool(await goals.spend("manage_tool_hosts", agent_name="main"))
              and not await goals.spend("manage_tools", agent_name="main"))
        check("an exhausted goal leaves active()",
              all(x["id"] != g["id"] for x in await goals.active()))

        g2 = await goals.propose("race", "t", ["pull_model"], proposed_by="t")
        made.append(g2["id"])
        await goals.activate(g2["id"], max_actions=1)
        winners = sum(1 for x in await asyncio.gather(
            *[goals.spend("pull_model", agent_name="t") for _ in range(5)]) if x)
        check("five turns racing for one action produce exactly one winner — "
              "select-and-charge is a single statement for this reason",
              winners == 1, f"{winners} winners")

        g3 = await goals.propose("ttl", "t", ["manage_agents"], proposed_by="t")
        made.append(g3["id"])
        await goals.activate(g3["id"], ttl_hours=1)
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE goals SET expires_at = now() - interval '1 minute' "
                "WHERE id = $1::uuid", g3["id"])
        check("an expired goal cannot be spent even before any sweep runs — "
              "housekeeping that has not happened yet is not a control",
              not await goals.spend("manage_agents", agent_name="t"))

        print("5. untrusted context still wins, goal or no goal")
        g4 = await goals.propose("poisoned", "t", ["manage_agents"], proposed_by="t")
        made.append(g4["id"])
        await goals.activate(g4["id"], max_actions=5)
        tainted = {"agent_name": "agent-creator", "granted": {"manage_agents"},
                   "untrusted_context": True}
        out = await tr.execute_tool("manage_agents", {"action": "create"}, tainted)
        check("a turn holding fetched text cannot act on an approved goal — "
              "otherwise a web page describing a goal would be a way to spend "
              "one, and researching how to do a thing is how goals get built",
              out.startswith("Error") and "outside source" in out, out[:80])
        check("...and the refusal did NOT consume an action",
              (await goals.get(g4["id"]))["actions_used"] == 0)

        print("6. the operator's click is what activates, not an agent's")
        pctx = {"agent_name": "main", "granted": {"propose_goal"}}
        before = {g["id"] for g in await goals.list_all(limit=200)}
        await builtin._propose_goal(
            {"title": "click test", "target": "a checkable finish line",
             "verbs": ["manage_tools"]}, pctx)
        # MATCH THE CARD TO THE GOAL THIS TEST JUST MADE, by subject.
        #
        # The first version took `next(... if kind == "goal.activate")` from the
        # pending list — i.e. ANY operator card awaiting a decision. Run against
        # a live system that had a real proposal waiting, it approved that one
        # instead and then deleted it in cleanup. It ate a genuine pending
        # request, and reported PASS while doing it.
        #
        # A test that reaches into shared state must address its own rows
        # explicitly. Same rule the eval harness landed on for real memory.
        mine = [g["id"] for g in await goals.list_all(limit=200)
                if g["id"] not in before]
        check("proposing created exactly one goal", len(mine) == 1, str(mine))
        made.extend(mine)
        card = next(c for c in await consents.list_pending()
                    if c["kind"] == "goal.activate" and c["subject"] in mine)
        check("a card is raised for the operator", bool(card["question"]))
        check("still proposed before the click",
              (await goals.get(card["subject"]))["status"] == "proposed")
        await consents.decide(card["id"], "approve")
        check("the click activates it, in consents.decide — no agent has to "
              "notice the approval, so no agent can act on one that never came",
              (await goals.get(card["subject"]))["status"] == "active")
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM consents WHERE id = $1::uuid", card["id"])

        print("7. a proposal must name a finish line and real verbs")
        out = await builtin._propose_goal(
            {"title": "vague", "target": "", "verbs": ["manage_tools"]}, pctx)
        check("no target, no goal", out.startswith("Error"), out[:60])
        out = await builtin._propose_goal(
            {"title": "sneaky", "target": "t", "verbs": ["manage_rules"]}, pctx)
        check("a goal cannot smuggle in a verb outside the scope set",
              out.startswith("Error"), out[:70])
    finally:
        async with db.acquire() as conn:
            for gid in made:
                await conn.execute("DELETE FROM goals WHERE id = $1::uuid", gid)
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
