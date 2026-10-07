"""Her browsing agent, made once (S38).

The slice ships an agent named `browser`: her five browser tools, web search,
fetch_url and the workspace, 30 rounds, and no model of its own — until the
owner sets one on Settings → Models → Routing, its role (agent_browser) walks
the chat chain. She hands it heavy browsing with delegate_to_agent; it reads in
a context of its own, so a huge page never fills hers.

Made through app/agents.py's own writer once an owner exists: at startup, and
from the scheduler's loop until it settles (the beats' shape — a fresh install
has no owner until the wizard). Made ONCE: a governance event `agent.seeded`
records it, so an agent the owner deletes stays deleted, and one the owner
already named `browser` is left exactly as it is.
"""

from __future__ import annotations

import logging

import asyncpg

from app import agents, governance, identity

logger = logging.getLogger("core")

NAME = "browser"
# Who the ledger says made it: not the owner, and not her (migration 021's
# CHECK admits only 'chat' and 'page' as created_via, so the honest field is the
# actor, as the eval harness's fixtures do — evals/runner.py).
SEED_ACTOR = "seed (S38)"
SPEC = agents.AgentSpec(
    name=NAME,
    purpose="Browses the web for Nova and reports back what it found and did.",
    instructions=(
        "You are Nova's browser. Open a page with browser_open, then read it with "
        "browser_read a part at a time, or search it with browser_read(query=...) — never "
        "assume what a part you have not read says. Act with browser_act using the refs "
        "browser_read shows; refs change when the page changes, so read again after the page "
        "moves. Report what each tool said happened, in its own words, and which parts you "
        "read. Files you download land in your downloads folder; name them in your report."
    ),
    tools=(
        "browser_open",
        "browser_read",
        "browser_act",
        "browser_back",
        "browser_screenshot",
        "web_search",
        "fetch_url",
        "workspace_read_file",
        "workspace_write_file",
        "workspace_list_files",
    ),
    max_tool_rounds=30,
)


async def ensure_browser_agent(pool: asyncpg.Pool, app) -> bool:
    """True once the seed is settled — made now, made before, or left alone
    because the owner already has a `browser` or deleted the one made for
    him. False only while it cannot be settled yet (no owner): a caller that
    keeps asking makes it the moment there is one."""
    seeded = await pool.fetchval(
        "SELECT EXISTS (SELECT 1 FROM governance_events WHERE kind = $1 AND meta->>'name' = $2)",
        governance.AGENT_SEEDED,
        NAME,
    )
    if seeded:
        return True
    if await identity.owner(pool) is None:
        return False
    made = False
    if await agents.by_name(pool, NAME) is None:
        try:
            result = await agents.create(
                pool, app, SPEC, created_via="page", created_turn_id=None, actor=SEED_ACTOR
            )
        except agents.AgentError as exc:
            if "already exists" not in str(exc):
                raise
        else:
            made = True
            logger.info("the %s agent was made: %s", NAME, result.text)
    async with pool.acquire() as conn, conn.transaction():
        await governance.record_event(
            conn, kind=governance.AGENT_SEEDED, actor=SEED_ACTOR, meta={"name": NAME, "made": made}
        )
    return True
