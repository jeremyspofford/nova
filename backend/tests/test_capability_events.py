"""Capability changes — Nova notices what she gained and lost.

    docker compose exec backend python tests/test_capability_events.py

The platform-state block tells her what exists NOW and says so emphatically:
"anything not on it does not exist". That is state, and state cannot answer
"why can't I do X any more". Losses are the half that matters and a deleted
row leaves nothing to diff, which is why this is an event log and not a
comparison.

Everything here runs against a THROWAWAY database. The DB is created and
DATABASE_URL repointed BEFORE the first app import — pydantic reads the
environment once, at import, so doing it later silently runs the whole suite
against the operator's live data. That is not hypothetical: the sibling
suite did exactly that on its first run and wrote five rows into the real
conversation.
"""

import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_capev_{uuid.uuid4().hex[:8]}"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/postgres"


async def _make_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    await admin.close()
    os.environ["DATABASE_URL"] = (
        os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/" + DB_NAME)


async def _drop_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
    await admin.close()


async def _settle():
    """record() is fire-and-forget; let the spawned writes land."""
    for _ in range(40):
        await asyncio.sleep(0.05)


async def run() -> None:
    from app import capability_events as ce, db, settings_store
    from app.agents import registry as agent_registry
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()

    print("1. the grant diff — the fact worth keeping")
    check("a granted tool is named",
          ce.diff_grants(["a"], ["a", "b"]) == {"granted": ["b"]})
    check("a revoked tool is named",
          ce.diff_grants(["a", "b"], ["a"]) == {"revoked": ["b"]})
    check("both directions at once",
          ce.diff_grants(["a"], ["b"]) == {"granted": ["b"], "revoked": ["a"]})
    check("no change is silent", ce.diff_grants(["a"], ["a"]) == {})
    check("unrestricted (None) is not a change", ce.diff_grants(None, None) == {})

    print("2. agent lifecycle is recorded at the choke point")
    aid = await agent_registry.create_agent(
        name="probe-agent", description="d", system_prompt="s",
        model="openrouter:test", allowed_tools=["search_memory"])
    await agent_registry.update_agent(
        aid, operator=True, allowed_tools=["search_memory", "web_search"])
    await agent_registry.update_agent(aid, operator=True, enabled=False)
    await _settle()

    events = await ce.recent(limit=20)
    kinds = [(e["subject"], e["action"]) for e in events]
    check("creation recorded", ("probe-agent", "created") in kinds, str(kinds))
    check("a grant change recorded", ("probe-agent", "updated") in kinds, str(kinds))
    check("DISABLED is its own verb, not buried in 'updated'",
          ("probe-agent", "disabled") in kinds, str(kinds))

    upd = next(e for e in events if e["action"] == "updated")
    check("the delta says WHICH tool was granted",
          upd["detail"].get("granted") == ["web_search"], str(upd["detail"]))
    check("the operator is attributed", upd["actor"] == "operator", upd["actor"])

    print("3. a model's change is attributed to the model, not the operator")
    await agent_registry.update_agent(
        aid, operator=False, actor="agent-manager",
        allowed_tools=["search_memory"])
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("the acting agent is named", ev["actor"] == "agent-manager", ev["actor"])
    check("...and the revocation is explicit",
          ev["detail"].get("revoked") == ["web_search"], str(ev["detail"]))

    print("4. deletion — the half a diff could never see")
    await agent_registry.delete_agent(aid, actor="operator")
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("deletion is recorded after the row is gone",
          (ev["subject"], ev["action"]) == ("probe-agent", "deleted"), str(ev))

    print("5. the prompt block")
    block = await ce.prompt_block()
    check("it names the subject", "probe-agent" in block, block[:80])
    check("it attributes the actor", "operator" in block, block[:80])
    check("it points at the tool for more",
          "list_capability_changes" in block, block[-90:])
    check("it is bounded", len(block.splitlines()) <= ce.PROMPT_LIMIT + 4,
          str(len(block.splitlines())))

    print("6. logging never breaks the thing it logs")
    ce.record("agent", "x", "updated", detail={"weird": {1, 2}})   # unserialisable
    await _settle()
    check("an unserialisable detail does not raise", True)
    still = await ce.recent(limit=1)
    check("...and the log is still readable", isinstance(still, list))

    print("7. an automation flip names WHO flipped it")
    # The motivating case: review-memory-usage was seeded disabled and found
    # enabled, and nothing in the system could say who did it. `updated_at`
    # could not answer either — the scheduler stamps it again on every run.
    from app import automations
    await agent_registry.create_agent(
        name="probe-auto-agent", description="d", system_prompt="s",
        model="openrouter:test")
    auto = await automations.create(
        name="probe-auto", instruction="do a thing", agent_name="probe-auto-agent",
        interval_minutes=60, description="d")
    await automations.update(auto["id"], operator=True, enabled=False)
    await automations.update(auto["id"], actor="main", enabled=True)
    await _settle()

    evs = await ce.recent(limit=4)
    seen = [(e["action"], e["actor"]) for e in evs]
    check("creation is recorded", ("created", "operator") in seen, str(seen))
    check("the operator's disable is attributed to the operator",
          ("disabled", "operator") in seen, str(seen))
    check("an agent's enable is attributed to the agent, not the operator",
          ("enabled", "main") in seen, str(seen))
    check("ENABLED is its own verb, not buried in 'updated'",
          all(a != "updated" for a, _ in seen), str(seen))

    print("8. a save that changes nothing records nothing")
    before = len(await ce.recent(limit=50))
    await automations.update(auto["id"], operator=True, enabled=True)  # already true
    await _settle()
    check("re-posting an unchanged toggle mints no event",
          len(await ce.recent(limit=50)) == before, str(before))
    await automations.update(auto["id"], operator=True, interval_minutes=120)
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("a real edit is 'updated', carrying the new value",
          (ev["action"], ev["detail"].get("every")) == ("updated", "120m"), str(ev))

    print("8b. update refuses what create refuses")
    # An automation pointed at an agent that does not exist keeps running on
    # schedule, fails, and is auto-disabled five runs later — so the operator
    # finds out a week after the typo. create() has always checked this;
    # update() did not, which is how review-memory-usage ended up pointed at
    # "operator" during the live verification of this very change.
    for bad, label in (({"agent_name": "no-such-agent"}, "a nonexistent agent"),
                       ({"interval_minutes": 1}, "an interval under the floor"),
                       ({"timeout_seconds": 5}, "a timeout under the floor")):
        try:
            await automations.update(auto["id"], operator=True, **bad)
            check(f"{label} is refused", False, "it was accepted")
        except ValueError:
            check(f"{label} is refused", True)
    check("the agent it already had survived the refusals",
          (await automations.get_by_name("probe-auto"))["agent_name"]
          == "probe-auto-agent")

    print("9. the scheduler's own kill switch is a change she can explain")
    before = len(await ce.recent(limit=50))
    outcome = None
    for _ in range(5):
        outcome = await automations.record_run(
            auto["id"], "error", "boom", 120, failed=True)
    await _settle()
    check("five failures trip it", outcome == "auto_disabled", str(outcome))
    after = await ce.recent(limit=50)
    # The whole reason record_run is not instrumented wholesale: five runs
    # every tick would push the toggle you are looking for off a block that
    # holds eight lines.
    check("five runs produced exactly ONE event — bookkeeping is not a change",
          len(after) == before + 1, f"{before} -> {len(after)}")
    ev = after[0]
    check("the disable is recorded", ev["action"] == "disabled", str(ev))
    check("...attributed to nobody human", ev["actor"] == "the scheduler", ev["actor"])
    check("...carrying WHY, which is the whole answer",
          ev["detail"].get("reason") == "5 consecutive failures", str(ev["detail"]))

    print("10. a detail key the renderer has never seen still reaches her")
    block = await ce.prompt_block()
    check("the reason survives into the prompt block",
          "5 consecutive failures" in block, block[:200])
    ce.record(ce.AUTOMATION, "probe-auto", "updated", detail={"invented": "kept"})
    await _settle()
    check("...and so does a key nobody added to the renderer",
          "invented kept" in await ce.prompt_block(), (await ce.prompt_block())[:200])

    await db.close_pool()


def main() -> int:
    asyncio.run(_make_db())
    try:
        asyncio.run(run())
    finally:
        asyncio.run(_drop_db())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
