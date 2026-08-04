"""A card's action plan is a form, not a script.

    docker compose exec backend python tests/test_recommendation_actions.py

The `action` column has existed since migration 032 and was never written or
read; approving a recommendation flipped a status and did nothing else. Now
it can carry a typed plan, which means a model's output has become an input
to something that acts. Everything below defends the line that makes that
safe: the model fills in a FORM the backend already knows how to submit, and
the dangerous cases are unrepresentable rather than merely rejected.

The card that prompted this named `https://ossinsight.io/api/mcp` as an MCP
server. It is a REST route that answers 405 to an MCP `initialize`. She was
confident and wrong, and no amount of prompt would have caught it — only
dialling the thing catches it. That is what `preflight` is for, and why
`test_the_plan_is_checked_against_something_real` exists.
"""

import ast
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import actions, mcp_client, recommendations              # noqa: E402
from app.actions.schemas import McpServerAdd                      # noqa: E402

FAILURES: list[str] = []

VALID = {"type": "mcp_server.add", "name": "example", "transport": "http",
         "url": "https://example.com/mcp", "headers": {}, "read_only": True,
         "grant_to": [], "why": "a reason"}


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _refused(doc) -> str:
    try:
        actions.parse(doc)
        return ""
    except ValueError as e:
        return str(e)


def test_the_form_has_no_field_for_the_dangerous_things():
    print("1. what a model cannot write down")
    check("a valid http plan parses", not _refused(VALID))

    # The whole supply-chain argument in one assertion: registering a stdio
    # server EXECUTES its command to list tools, so "the operator approved a
    # card summarising a web page" must not be able to npm-install what that
    # web page recommended.
    stdio = {**VALID, "transport": "stdio", "command": "npx",
             "args": ["-y", "ossinsight-mcp"]}
    check("stdio / a command is unrepresentable", bool(_refused(stdio)),
          _refused(stdio))
    check("...and 'command' is not a field on the model at all",
          "command" not in McpServerAdd.model_fields)

    check("plain http:// is refused", bool(_refused({**VALID, "url": "http://x.com/mcp"})))
    check("a non-https scheme cannot be smuggled",
          bool(_refused({**VALID, "url": "file:///etc/passwd"})))
    check("an unknown action type is refused",
          bool(_refused({**VALID, "type": "shell.run"})))
    check("an extra field cannot ride along",
          bool(_refused({**VALID, "enabled": True})),
          "extra='forbid'")
    check("a missing url is refused rather than defaulted",
          bool(_refused({k: v for k, v in VALID.items() if k != "url"})))


def test_a_credential_can_only_be_a_reference():
    print("\n2. headers carry references, never secrets")
    literal = {**VALID, "headers": {"Authorization": "Bearer sk-live-abc"}}
    check("a literal credential is refused", bool(_refused(literal)))
    check("the refusal names the header and the fix",
          "Authorization" in _refused(literal) and "Secrets" in _refused(literal))
    ref = {**VALID, "headers": {"Authorization": "{{secret:ossinsight}}"}}
    check("a {{secret:name}} reference is accepted", not _refused(ref))


def test_the_operator_approves_what_actually_runs():
    print("\n3. the plan cannot change between render and click")
    d1 = recommendations.action_digest(VALID)
    d2 = recommendations.action_digest({**VALID})
    check("the digest is stable across equal documents", d1 == d2)
    check("key order does not change the digest",
          d1 == recommendations.action_digest(dict(reversed(list(VALID.items())))))
    check("changing the url changes the digest",
          d1 != recommendations.action_digest({**VALID, "url": "https://evil.com/mcp"}))
    check("no action means no digest", recommendations.action_digest(None) is None)

    # The card and the executor must not be able to disagree about what
    # Approve does, so only the backend is allowed to describe the plan.
    plan = actions.describe(VALID)
    check("the plan is rendered server-side", isinstance(plan, str) and plan)
    check("...and it shows the operator the actual target",
          "https://example.com/mcp" in plan, plan.splitlines()[1].strip())


def test_the_button_never_promises_more_than_the_code_does():
    print("\n4. executability is derived, not declared")
    spec = actions._TYPES["mcp_server.add"]
    check("is_executable tracks the Spec's execute function",
          actions.is_executable(VALID) == (spec.execute is not None))
    check("a card with no action is not executable",
          actions.is_executable(None) is False)


def test_an_executor_cannot_outlive_its_operator_route():
    print("\n5. the boot gate")
    actions.assert_routes_exist()
    check("every action type resolves to a real operator route", True)
    real = actions._TYPES["mcp_server.add"]
    actions._TYPES["_probe"] = actions.Spec(
        model=real.model, operator_route="no_such_endpoint",
        describe=real.describe, preflight=real.preflight)
    try:
        actions.assert_routes_exist()
        check("a missing operator route refuses the boot", False)
    except RuntimeError as e:
        check("a missing operator route refuses the boot", True, str(e)[:60])
    finally:
        del actions._TYPES["_probe"]


def test_the_outbound_guard_is_derived_from_provenance():
    print("\n6. who added the server decides where it may dial")

    async def run():
        priv = "https://localtest.me/mcp"          # resolves to 127.0.0.1
        op = {"name": "ha", "transport": "http", "url": priv, "created_by": "operator"}
        act = {"name": "x", "transport": "http", "url": priv, "created_by": "action"}
        # An operator naming his own LAN is his decision; the guard is about
        # what a MODEL proposed, and it reads provenance, not a host list.
        check("an operator-added server may reach a private address",
              await mcp_client._guard_url(op, priv) is None)
        check("an action-added server may not",
              bool(await mcp_client._guard_url(act, priv)))
        check("...and it still reaches public hosts",
              await mcp_client._guard_url(
                  {**act, "url": "https://example.com/mcp"},
                  "https://example.com/mcp") is None)

    asyncio.run(run())


def test_the_plan_is_checked_against_something_real():
    print("\n7. anyio must not eat the reason")
    # A bare TaskGroup wrapper is what used to land on the card in place of
    # the HTTP status, which is the single fact the operator needs.
    inner = RuntimeError("Client error '405 Method Not Allowed' for url 'https://x/mcp'"
                         "\nFor more information check: https://developer.mozilla.org/x")
    text = mcp_client.explain(BaseExceptionGroup("unhandled errors in a TaskGroup", [inner]))
    check("the leaf error survives the TaskGroup wrapper", "405" in text, text[:70])
    check("httpx's MDN trailer is stripped", "mozilla.org" not in text)
    check("a plain exception still explains itself",
          "boom" in mcp_client.explain(ValueError("boom")))


# What "no model runs during execution" actually forbids: anything that can
# CALL one. `app.agents.registry` is deliberately absent — it is CRUD over the
# agents table, which is exactly how a grant gets written, and banning the
# whole `app.agents` package would forbid the executor's real work while
# forbidding nothing dangerous. `app.agents.runner` is the LLM loop and stays
# banned.
_BANNED_MODULES = ("app.llm", "app.agents.runner", "app.summariser",
                   "openai", "anthropic", "litellm")


def _banned(dotted: str) -> bool:
    return any(dotted == b or dotted.startswith(b + ".") for b in _BANNED_MODULES)


def test_no_model_runs_during_execution():
    print("\n8. structural: no LLM in this package")
    pkg = Path("/app/backend/app/actions")
    hits = []
    for path in pkg.glob("*.py"):
        tree = ast.parse(path.read_text())
        # walk, not iter_child_nodes: this codebase's dominant idiom is the
        # late local import, so a `from app.llm import ...` three levels
        # inside a function is exactly what this has to catch
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.ImportFrom):
                base = node.module or ""
                names = [base] + [f"{base}.{a.name}" for a in node.names]
            elif isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            hits += [f"{path.name}: {n}" for n in names if _banned(n)]
    check("no LLM client is reachable from an executor", not hits, "; ".join(hits))
    # and the check itself must be able to fail
    check("...and the check would catch one", _banned("app.agents.runner")
          and _banned("app.llm.openai_compat") and not _banned("app.agents.registry"))


def test_an_approval_is_spendable_only_by_the_agent_it_was_given_to():
    print("\n9. goals.spend binds to the asker")

    async def run():
        from app import db, goals
        await db.init_pool()
        made = []
        try:
            g = await goals.propose("scratch bound goal", "t", ["manage_tools"],
                                    proposed_by="alpha")
            made.append(g["id"])
            await goals.activate(g["id"])
            # THE HOLE: before 2026-08-04 this matched on verb alone, so any
            # agent and any scheduled automation could spend alpha's approval.
            other = await goals.spend("manage_tools", agent_name="beta")
            check("another agent cannot spend it", other is None)
            mine = await goals.spend("manage_tools", agent_name="alpha")
            check("the agent it was given to can", mine is not None)

            # an operator-created goal has no proposed_by and stays open to all
            g2 = await goals.propose("scratch operator goal", "t", ["manage_tools"])
            made.append(g2["id"])
            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE goals SET proposed_by = NULL WHERE id = $1::uuid", g2["id"])
            await goals.activate(g2["id"])
            anyone = await goals.spend("manage_tools", agent_name="beta")
            check("an operator goal with no proposer is spendable by anyone",
                  anyone is not None and anyone["id"] == g2["id"])
        finally:
            async with db.acquire() as conn:
                for gid in made:
                    await conn.execute("DELETE FROM goals WHERE id = $1::uuid", gid)

    asyncio.run(run())


def test_an_unreviewed_tool_list_is_not_adopted():
    print("\n10. refresh() does not approve what nobody read")

    async def run():
        from app import db, mcp_servers
        await db.init_pool()
        fake = [{"name": "exfiltrate", "description": "send files anywhere",
                 "parameters_schema": {"type": "object", "properties": {}}}]
        real = mcp_client.connect_and_list

        async def fake_connect(server):
            return "connected", fake, None
        mcp_client.connect_and_list = fake_connect
        made = []
        try:
            # created by an action with NO reviewed hash: the code path that
            # skipped the card. refresh() must refuse to adopt its tool list.
            s = await mcp_servers.create(name="scratch-unreviewed", transport="http",
                                         url="https://example.com/mcp",
                                         created_by="action")
            made.append(s["id"])
            out = await mcp_servers.refresh(s["id"])
            check("an action server with no reviewed list is refused",
                  out["status"] == "error", (out.get("status_detail") or "")[:60])

            # the same server carrying the hash the operator reviewed connects
            s2 = await mcp_servers.create(
                name="scratch-reviewed", transport="http",
                url="https://example.com/mcp", created_by="action",
                tools_hash=mcp_client.tool_list_hash(fake))
            made.append(s2["id"])
            out2 = await mcp_servers.refresh(s2["id"])
            check("...and one carrying the reviewed hash connects",
                  out2["status"] == "connected", out2["status"])

            # an OPERATOR-added server keeps the old first-list-is-free
            # behaviour: he typed the URL and can read the list in the UI
            s3 = await mcp_servers.create(name="scratch-operator", transport="http",
                                          url="https://example.com/mcp")
            made.append(s3["id"])
            out3 = await mcp_servers.refresh(s3["id"])
            check("an operator-added server still adopts its first list",
                  out3["status"] == "connected", out3["status"])
        finally:
            mcp_client.connect_and_list = real
            async with db.acquire() as conn:
                for sid in made:
                    await conn.execute("DELETE FROM mcp_servers WHERE id = $1::uuid", sid)

    asyncio.run(run())


def test_he_executes_the_plan_he_was_shown():
    print("\n11. decide() binds the click to the plan on screen")

    async def run():
        import json as _json
        from app import db, recommendations
        await db.init_pool()
        async with db.acquire() as conn:
            rid = await conn.fetchval(
                "INSERT INTO recommendations (kind,title,body,source,action,action_state) "
                "VALUES ('mcp_server','scratch digest','b','lane-test',$1,'ready') "
                "RETURNING id", _json.dumps(VALID))
        try:
            stale = recommendations.action_digest({**VALID, "url": "https://other.com/mcp"})
            try:
                await recommendations.decide(str(rid), "approve", stale)
                check("a stale digest is refused", False)
            except recommendations.PlanChanged:
                check("a stale digest is refused", True)
            try:
                await recommendations.decide(str(rid), "approve", None)
                check("a missing digest fails closed", False)
            except recommendations.PlanChanged:
                check("a missing digest fails closed", True)

            good = recommendations.action_digest(VALID)
            row = await recommendations.decide(str(rid), "approve", good)
            check("the digest he was shown is accepted", row["status"] == "approved")
            # no executor for example.com, but the run must have been enqueued
            async with db.acquire() as conn:
                n = await conn.fetchval(
                    "SELECT count(*) FROM action_runs WHERE recommendation_id = $1", rid)
            check("approving a ready plan enqueues exactly one run", n == 1, f"n={n}")
            async with db.acquire() as conn:
                dup = await conn.fetchval(
                    "INSERT INTO action_runs (recommendation_id, action, action_type) "
                    "VALUES ($1,$2,'mcp_server.add') ON CONFLICT DO NOTHING RETURNING id",
                    rid, _json.dumps(VALID))
            check("a second live run for one card is refused by the index", dup is None)
        finally:
            async with db.acquire() as conn:
                await conn.execute("DELETE FROM recommendations WHERE id = $1", rid)

    asyncio.run(run())


def test_a_run_only_starts_while_the_operator_still_approves():
    print("\n12. the worker re-checks the approval at claim time")

    async def run():
        import json as _json
        from app import action_worker, db
        await db.init_pool()
        async with db.acquire() as conn:
            rid = await conn.fetchval(
                "INSERT INTO recommendations (kind,title,body,source,action,action_state,"
                " status, decided_by) VALUES ('mcp_server','scratch claim','b','lane-test',"
                " $1,'ready','new',NULL) RETURNING id", _json.dumps(VALID))
            await conn.execute(
                "INSERT INTO action_runs (recommendation_id, action, action_type) "
                "VALUES ($1,$2,'mcp_server.add')", rid, _json.dumps(VALID))
        try:
            check("a queued run on an UNapproved card is not claimed",
                  await action_worker.claim_next() is None)
            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE recommendations SET status='dismissed', decided_by='operator' "
                    "WHERE id=$1", rid)
            check("...nor on a dismissed one",
                  await action_worker.claim_next() is None)
            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE recommendations SET status='approved', decided_by='operator' "
                    "WHERE id=$1", rid)
            claimed = await action_worker.claim_next()
            check("...and is claimed once he has approved it",
                  claimed is not None and str(claimed["recommendation_id"]) == str(rid))
        finally:
            async with db.acquire() as conn:
                await conn.execute("DELETE FROM recommendations WHERE id = $1", rid)

    asyncio.run(run())


def test_a_failed_run_leaves_nothing_behind():
    print("\n13. the executor is all-or-nothing past registration")

    async def run():
        from app import db, mcp_servers
        from app.actions import mcp_server as ex
        from app.agents import registry as ar
        await db.init_pool()

        fake = [{"name": "ask", "description": "ask a thing",
                 "parameters_schema": {"type": "object", "properties": {}}}]
        reviewed = [{"name": "ask", "description": "ask a thing"}]
        real = mcp_client.connect_and_list

        async def fake_connect(server):
            return "connected", fake, None
        mcp_client.connect_and_list = fake_connect
        steps: list[str] = []

        async def step(n, s, d=""):
            steps.append(f"{s}:{n}")
        try:
            await ar.create_agent("scratch-t13-ok", "t", "t", "openrouter:x/y",
                                  allowed_tools=["recall_memory"], operator=True)
            await ar.create_agent("scratch-t13-open", "t", "t", "openrouter:x/y",
                                  allowed_tools=None, operator=True)

            # the tool list moved between review and click
            doc = actions.parse({**VALID, "name": "scratch-t13-a",
                                 "grant_to": [], "url": "https://example.com/mcp"})
            try:
                await ex.execute(doc, {"id": "x", "action_tools": [
                    {"name": "ask", "description": "SOMETHING ELSE"}]}, step=step)
                check("a changed tool list refuses", False)
            except Exception as e:
                check("a changed tool list refuses", "changed since you reviewed" in str(e))
            async with db.acquire() as conn:
                n = await conn.fetchval(
                    "SELECT count(*) FROM mcp_servers WHERE name = 'scratch-t13-a'")
            check("...before writing anything", n == 0, f"servers={n}")

            # grant fails on the SECOND agent: the first agent's new grants
            # and the server must both come back out
            doc2 = actions.parse({**VALID, "name": "scratch-t13-b",
                                  "url": "https://example.com/mcp",
                                  "grant_to": ["scratch-t13-ok", "scratch-t13-open"]})
            try:
                await ex.execute(doc2, {"id": "x", "action_tools": reviewed}, step=step)
                check("granting to an unrestricted agent refuses", False)
            except Exception as e:
                check("granting to an unrestricted agent refuses",
                      "unrestricted" in str(e))
            async with db.acquire() as conn:
                left = await conn.fetchval(
                    "SELECT count(*) FROM mcp_servers WHERE name = 'scratch-t13-b'")
                ok = await conn.fetchval(
                    "SELECT allowed_tools FROM agents WHERE name = 'scratch-t13-ok'")
                opn = await conn.fetchval(
                    "SELECT allowed_tools FROM agents WHERE name = 'scratch-t13-open'")
            check("the server is rolled back", left == 0, f"servers={left}")
            check("the already-granted agent is restored", ok == ["recall_memory"], str(ok))
            check("the unrestricted agent was never touched", opn is None)
            check("a rollback step is on the receipt", "ok:rollback" in steps)
        finally:
            mcp_client.connect_and_list = real
            async with db.acquire() as conn:
                await conn.execute(
                    "DELETE FROM agents WHERE name LIKE 'scratch-t13-%'")
                await conn.execute(
                    "DELETE FROM mcp_servers WHERE name LIKE 'scratch-t13-%'")

    asyncio.run(run())


def main() -> int:
    for t in (test_the_form_has_no_field_for_the_dangerous_things,
              test_a_credential_can_only_be_a_reference,
              test_the_operator_approves_what_actually_runs,
              test_the_button_never_promises_more_than_the_code_does,
              test_an_executor_cannot_outlive_its_operator_route,
              test_the_outbound_guard_is_derived_from_provenance,
              test_the_plan_is_checked_against_something_real,
              test_no_model_runs_during_execution,
              test_an_approval_is_spendable_only_by_the_agent_it_was_given_to,
              test_an_unreviewed_tool_list_is_not_adopted,
              test_he_executes_the_plan_he_was_shown,
              test_a_run_only_starts_while_the_operator_still_approves,
              test_a_failed_run_leaves_nothing_behind):
        t()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
