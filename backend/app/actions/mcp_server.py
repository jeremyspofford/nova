"""The mcp_server.add action: describe it, preflight it, execute it.

ONE CLICK. Approve registers the server, connects it, grants its tools to the
agents the plan named, and then verifies that those tools actually reached
the model. No pause, no second button.

That is only honest because of what happens BEFORE the click. `preflight()`
connects anonymously and stores the tool list on the card, so the operator
reads the real tool names and descriptions — the same text that will land in
the granted agent's prompt — as part of the plan. `execute()` then registers
the server with `tools_hash` ALREADY SET to the hash of what he read. A
server that changed its tools in between fails `mcp_servers.refresh()`'s
existing hash check on first connect and the run rolls back.

Without that binding, one click would mean installing a stranger's tool
descriptions unread, because `refresh()` accepts the first tool list it ever
sees as the approved baseline. With it, "the first list" is the one on the
card.

Every step reports through `step()` so a failure is visible in the card
rather than only in a log nobody opens.
"""

import logging
from typing import Optional

from app import capability_events, mcp_client, mcp_servers, net_guard
from app.actions.schemas import McpServerAdd

log = logging.getLogger(__name__)


def describe(doc: McpServerAdd) -> str:
    lines = [f'Register MCP server "{doc.name}"',
             f"    URL         {doc.url}",
             "    Transport   streamable HTTP"]
    if doc.headers:
        lines.append("    Headers     " + ", ".join(
            f"{k}: {v}" for k, v in sorted(doc.headers.items())))
    # SAY WHAT READ-ONLY BUYS. It reads like a description of the server and
    # it is a permission: read-only tools are the one MCP class allowed to run
    # on a turn that already carries fetched text, so approving this is the
    # decision that lets them. The operator was agreeing to a word.
    lines.append(f"    Read-only   {'yes' if doc.read_only else 'no'}"
                 + ("  — its tools may then run on turns that have already "
                    "read a web page or a transcript"
                    if doc.read_only else
                    "  — its tools are refused on turns that have already "
                    "read a web page or a transcript"))
    lines.append("    Grants      " + (
        "then grant its tools to " + ", ".join(doc.grant_to)
        if doc.grant_to else
        "none — tools are registered, not granted to any agent"))
    return "\n".join(lines)


async def preflight(doc: McpServerAdd, *, operator: bool
                    ) -> tuple[str, str, Optional[list[dict]]]:
    """Resolve, then actually speak MCP to the thing and see what answers.

    Returns (state, detail, tools). The tools come back so the card can show
    the operator what he is about to put in an agent's prompt.

    HEADERS ARE DROPPED unless the operator triggered this by hand. A model
    choosing both a URL and the credentials sent to it is an exfiltration
    primitive, and `fetch_url` does not hand her one. A server that needs a
    credential therefore comes back 'blocked' with its own 401, and the
    operator's `Test` button is the path that sends the real headers.
    """
    err = await net_guard.validate_target(doc.url)
    if err:
        return "blocked", err, None

    probe = {"name": doc.name, "transport": "http", "url": doc.url,
             "headers": doc.headers if operator else {},
             "created_by": "action"}
    status, tools, detail = await mcp_client.connect_and_list(probe)
    if status != "connected":
        return "blocked", detail or "could not connect", None
    if not tools:
        return "blocked", "connected, but the server exposes no tools", None
    shown = ", ".join(t["name"] for t in tools[:10])
    more = f" (+{len(tools) - 10} more)" if len(tools) > 10 else ""
    lean = [{"name": t["name"], "description": t["description"]} for t in tools]
    return "ready", f"{len(tools)} tools: {shown}{more}", lean


async def _undo(server_id: str, added: dict[str, list[str]], step) -> None:
    """Put everything back after a failure past registration.

    Grants first, then the server, and each on its own try: a rollback that
    itself raises would replace the real error with its own, and the operator
    needs to read WHY it failed more than he needs a tidy stack trace. What
    could not be undone is said out loud rather than swallowed.

    Only the names THIS run introduced are removed, so a tool the agent
    already held before the run keeps its grant.
    """
    from app.agents import registry as agent_registry
    stuck = []
    for agent_name, names in added.items():
        if not names:
            continue
        try:
            agent = await agent_registry.get_agent_by_name(agent_name)
            if agent and agent.get("allowed_tools") is not None:
                await agent_registry.update_agent(
                    agent["id"], operator=True,
                    actor="rollback of a failed recommendation action",
                    allowed_tools=sorted(set(agent["allowed_tools"]) - set(names)))
        except Exception:
            log.exception("could not revoke %s from %s", names, agent_name)
            stuck.append(agent_name)
    try:
        await mcp_servers.delete(server_id)
    except Exception:
        log.exception("could not remove server %s during rollback", server_id)
        stuck.append("the server registration")
    await step("rollback", "ok" if not stuck else "error",
               "registration and grants removed" if not stuck
               else f"could not undo: {', '.join(stuck)} — clean up by hand")


async def execute(doc: McpServerAdd, rec: dict, *, step) -> dict:
    """Register -> connect -> grant -> verify. Raises to fail the run.

    Nothing is written until the probe succeeds, and anything written is
    removed if the connect fails: a half-registered dead server is worse than
    no server, because it looks installed.
    """
    approved = rec.get("action_tools") or []
    if not approved:
        raise RuntimeError(
            "this card has no preflighted tool list — re-run Test before "
            "approving, so the tools you are granting are the tools you saw")
    approved_hash = mcp_client.tool_list_hash(approved)

    # 1. the outbound guard, again, at execution time. Preflight ran minutes
    #    or days ago and DNS moves.
    err = await net_guard.validate_target(doc.url)
    if err:
        raise RuntimeError(err)
    await step("validate", "ok", doc.url)

    # 2. probe with the real headers before writing anything
    probe = {"name": doc.name, "transport": "http", "url": doc.url,
             "headers": doc.headers, "created_by": "action"}
    status, tools, detail = await mcp_client.connect_and_list(probe)
    if status != "connected":
        raise RuntimeError(f"could not connect: {detail}")
    live_hash = mcp_client.tool_list_hash(
        [{"name": t["name"], "description": t["description"]} for t in tools])
    if live_hash != approved_hash:
        # THE BINDING. What he read on the card is what gets installed.
        # The hash covers names AND descriptions, so an unchanged count is
        # not an unchanged tool list — say which it was, or the message
        # reads as a contradiction ("3 then, 3 now").
        what = (f"{len(approved)} tools then, {len(tools)} now"
                if len(approved) != len(tools)
                else f"still {len(tools)} tools, but their names or "
                     f"descriptions are not the ones shown")
        raise RuntimeError(
            f"this server's tools changed since you reviewed them "
            f"({what}) — nothing was registered. Press Test to see the "
            f"current list, then approve again.")
    await step("probe", "ok", f"{len(tools)} tools, unchanged since review")

    # 3. register, carrying the reviewed hash so refresh() has a baseline to
    #    check against rather than accepting whatever it finds
    server = await mcp_servers.create(
        name=doc.name, transport="http", url=doc.url,
        headers=doc.headers, read_only=doc.read_only,
        created_by="action", tools_hash=approved_hash,
        # The operator approved the card this is running from — the
        # worker only claims a run while the recommendation is still
        # `approved` by `operator`. That decision buys the read-only
        # taint exemption (mcp_servers.read_only_slugs) and nothing
        # else: `created_by` stays "action", so egress to private
        # addresses remains refused.
        operator_approved=True)
    server_id = server["id"]
    await step("register", "ok", f"server {doc.name} created")

    # Everything past registration is undone together. One click promised
    # "register, connect and grant"; a run that reports failure while a
    # server quietly exists — or while one of two agents kept its grants —
    # is the half-applied state that makes a receipt untrustworthy.
    added: dict[str, list[str]] = {}      # what THIS run introduced, per agent
    granted: dict[str, list[str]] = {}    # what each agent ends up holding
    try:
        # 4. enable and connect for real
        await mcp_servers.update(server_id, enabled=True)
        connected = await mcp_servers.refresh(server_id)
        if connected["status"] != "connected":
            raise RuntimeError(connected.get("status_detail")
                               or "server did not connect")
        await step("connect", "ok", "status connected")

        # 5. grant. The names are BUILT HERE from the live cache with a fixed
        #    prefix — no caller-supplied list reaches update_agent, so an
        #    action cannot name a non-MCP tool or another server's tool. The
        #    union is additive, so an approved plan can never revoke a grant.
        from app.agents import registry as agent_registry
        # ...and the tool registry, whose OWN predicates step 6 checks the
        # grant against. It was referenced there and never imported, so every
        # install that got as far as verifying raised NameError inside this
        # try, rolled back, and deleted the server it had just made — the
        # feature's whole point, failing on its last step. Thirteen tests
        # covered this executor; both that reach execute() are failure paths
        # that stop before step 6, so nothing ever evaluated the name.
        from app.tools import registry as tool_registry
        cached = await mcp_servers.list_tools_for(server_id)
        names = {f"mcp:{doc.name}/{t['name']}" for t in cached}
        for agent_name in doc.grant_to:
            agent = await agent_registry.get_agent_by_name(agent_name)
            if agent is None:
                raise RuntimeError(f"no agent named '{agent_name}'")
            if agent.get("allowed_tools") is None:
                # allowed_tools=None means "every builtin and every DB tool,
                # implicitly". Writing a list here would REPLACE that with
                # just these MCP names and silently strip the agent of every
                # other tool it has. Enumerating the builtins instead would
                # freeze its toolset at today's list. Neither is a thing to
                # do behind one click, so it refuses and says why.
                raise RuntimeError(
                    f"'{agent_name}' is unrestricted (allowed_tools is unset), "
                    f"and granting named MCP tools to it would replace that "
                    f"with only these {len(names)} tools. Give it an explicit "
                    f"tool list in Settings first, or grant to a different agent.")
            old = set(agent["allowed_tools"])
            await agent_registry.update_agent(
                agent["id"], operator=True,
                actor=f"operator (approved recommendation {rec['id']})",
                allowed_tools=sorted(old | names))
            added[agent_name] = sorted(names - old)
            granted[agent_name] = sorted(names)
            await step("grant", "ok", f"{len(names)} tools to {agent_name}")

        # 6. VERIFY. With no second click nobody else confirms the tools
        #    arrived, so this reads LIVE state rather than trusting step 5.
        #
        #    A new server is `always_inject = false` by default, so its tools
        #    are LAZY — reachable through the index plus find_mcp_tools rather
        #    than shipped as eager defs, which means asking get_agent_tools
        #    for them would report every one of them missing. So this asserts
        #    the two conditions that actually make a tool callable, using the
        #    registry's OWN predicates rather than a second copy of the rule
        #    that could drift from them: the tool loads (server enabled,
        #    connected, cache populated) and the agent's grants cover it.
        live = await mcp_servers.get(server_id)
        if not (live["enabled"] and live["status"] == "connected"):
            raise RuntimeError(
                f"registered but not usable: enabled={live['enabled']} "
                f"status={live['status']}")
        loaded = await tool_registry._load_mcp_tools()
        for agent_name, held in granted.items():
            agent = await agent_registry.get_agent_by_name(agent_name)
            _has, named_grants, wildcards = tool_registry._granted_mcp_tools(agent)
            missing = [n for n in held
                       if n not in loaded
                       or not tool_registry._mcp_granted(n, named_grants, wildcards)]
            if missing:
                # registered is not the same as reaching the model; say both
                raise RuntimeError(
                    f"granted {len(held)} tools to {agent_name} but "
                    f"{len(missing)} are not reachable by it: "
                    f"{', '.join(missing[:5])}")
            await step("verify", "ok",
                       f"{agent_name} can reach {len(held)} tools")
        if not granted:
            await step("verify", "ok",
                       "server connected; no agent grants requested")
    except Exception:
        await _undo(server_id, added, step)
        raise

    capability_events.record(
        capability_events.MCP_SERVER, doc.name, "registered",
        actor="operator (approved recommendation)",
        detail={"url": doc.url, "tools": len(tools),
                "granted_to": sorted(granted), "read_only": doc.read_only})

    return {"server_id": server_id, "name": doc.name,
            "tools": [t["name"] for t in tools], "granted": granted}
