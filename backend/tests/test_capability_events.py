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
