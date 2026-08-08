"""A guest link is a time box, a sandbox, and nothing else.

    docker compose exec backend python tests/test_guest_sessions.py

THE INCIDENT THIS DEFENDS IS THE ONE THE PLAN PREDICTED, verbatim
(docs/plans/public-access-and-guests.md §3):

    "The middleware today is all-or-nothing by design. A guest branch added
     without simultaneous route-role gating hands guests /api/v1/auth/token —
     which returns the *admin* token — and /api/v1/secrets/{name}/reveal. A
     guest token that reaches those routes is an admin token."

So the first and largest section here enumerates the app's ACTUAL routing
table and asserts that a guest is refused on every route nobody deliberately
opened — including, by name, the two the plan calls out. It is default-deny
by construction: a route added next month is guest-denied until someone marks
it, and if that ever stops being true, the "unmarked routes" count moves and
this suite says so.

The rest defends the other four properties, each of which is a sentence
Jeremy said and none of which a prompt could hold:

  * the time box lives in a WHERE clause, so an expired token matches no row;
  * the model allowlist is checked against the model that will ACTUALLY carry
    the round, after fallbacks — not against the one nobody objected to;
  * a guest's memory is a namespace outside data/memory, so the operator's
    store is unreachable rather than merely not asked for;
  * revocation WIPES, and the wipe re-reads the directory and raises if the
    files survived. CLAUDE.md names `rmtree(ignore_errors=True)` as a real
    defect from this repo: a wipe that cannot prove it happened must fail
    loudly. There is a check below that breaks rmtree on purpose to prove the
    proof works.

Everything runs against a THROWAWAY database and a THROWAWAY memory root.
The DB is created and DATABASE_URL repointed BEFORE the first app import —
pydantic reads the environment once, at import, and a suite that gets this
wrong writes into the operator's live data (a sibling suite did exactly
that). The memory root is repointed for the same reason: nothing here may go
near ./data/memory.
"""

import asyncio
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_guest_{uuid.uuid4().hex[:8]}"
SCRATCH = tempfile.mkdtemp(prefix="nova-guest-suite-")
# The whole memory tree for this run lives under SCRATCH, so `guests.
# memory_root` derives its guest namespaces as siblings of THAT and the
# operator's real ./data/memory is never on any path this suite touches.
os.environ["OKF_MEMORY_DIR"] = str(Path(SCRATCH) / "memory")


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


def _scope(method: str, path: str) -> dict:
    """The minimum Starlette needs to resolve a route."""
    return {"type": "http", "method": method, "path": path,
            "path_params": {}, "root_path": "", "headers": []}


async def run() -> None:
    from app import db, guests, settings_store
    from app.main import app
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()

    # ── 1. route gating: default-deny over the REAL routing table ─────────
    print("1. a guest reaches only what was deliberately opened")
    api_routes = [(p, r) for p, r in guests.iter_concrete_routes(app.router.routes)
                  if (p + r.path).startswith("/api/")]
    opened, closed = [], []
    for p, r in api_routes:
        for m in sorted(r.methods or {"GET"}):
            if m in ("HEAD", "OPTIONS"):
                continue
            (opened if guests.endpoint_is_guest_ok(r.endpoint) else closed).append(
                f"{m} {p}{r.path}")

    check("there are real routes to judge", len(api_routes) > 50, str(len(api_routes)))
    check("the opened set is small and deliberate", len(opened) <= 6, str(sorted(opened)))
    check("almost everything is closed by default",
          len(closed) > 100, f"{len(closed)} closed / {len(opened)} open")

    # The two the plan names. A guest reaching either one IS an admin.
    for method, path in (("GET", "/api/v1/auth/token"),
                         ("POST", "/api/v1/secrets/nova/reveal"),
                         ("GET", "/api/v1/secrets"),
                         ("POST", "/api/v1/guests"),
                         ("DELETE", "/api/v1/guests/" + str(uuid.uuid4())),
                         ("GET", "/api/v1/settings"),
                         ("POST", "/api/v1/commands/backup")):
        check(f"guest refused on {method} {path}",
              not guests.route_is_guest_ok(app.router.routes, _scope(method, path)))

    for method, path in (("POST", "/api/v1/chat/stream"),
                         ("GET", "/api/v1/guest/session"),
                         ("POST", "/api/v1/guest/model"),
                         ("GET", "/api/v1/conversations/active")):
        check(f"guest allowed on {method} {path}",
              guests.route_is_guest_ok(app.router.routes, _scope(method, path)))

    # A path that matches but with the wrong verb is a 405, not a permission.
    check("a marked path does not open its other verbs",
          not guests.route_is_guest_ok(
              app.router.routes, _scope("DELETE", "/api/v1/conversations/active")))
    check("an unknown path is denied, not defaulted open",
          not guests.route_is_guest_ok(
              app.router.routes, _scope("GET", "/api/v1/nothing/here")))

    # ── 2. the time box ──────────────────────────────────────────────────
    print("2. the time box is a WHERE clause, not a branch")
    session = await guests.mint("suite guest", minutes=60,
                                allowed_models=["ollama:qwen3:8b",
                                                "ollama:qwen2.5:3b"])
    raw = session["token"]
    check("mint returns the raw token exactly once", raw.startswith(guests.TOKEN_PREFIX))
    async with db.acquire() as conn:
        stored = await conn.fetchval(
            "SELECT token_hash FROM guest_sessions WHERE id = $1",
            uuid.UUID(session["id"]))
    check("the raw token is NOT stored", raw not in (stored or ""))
    check("only its hash is", stored == guests.hash_token(raw))

    live = await guests.resolve(raw)
    check("a live token resolves", live is not None and live["id"] == session["id"])
    check("a wrong token does not", await guests.resolve(
        guests.TOKEN_PREFIX + "not-a-real-token") is None)
    check("an admin-shaped token is not a guest token",
          not guests.looks_like_guest_token("some-admin-token"))

    # created_at moves too: the table's own CHECK forbids a session that is
    # born already dead, which is the point — so an expired one has to be
    # aged, not merely dated backwards.
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE guest_sessions SET created_at = now() - interval '2 hours', "
            "expires_at = now() - interval '1 second' WHERE id = $1",
            uuid.UUID(session["id"]))
    check("an EXPIRED token resolves to nothing", await guests.resolve(raw) is None)
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE guest_sessions SET expires_at = now() + interval '1 hour' "
            "WHERE id = $1", uuid.UUID(session["id"]))
    check("...and comes back when the box is widened",
          await guests.resolve(raw) is not None)

    try:
        await guests.mint("no expiry", minutes=0, allowed_models=["x"])
        check("a session with no time box is refused", False)
    except ValueError:
        check("a session with no time box is refused", True)
    try:
        await guests.mint("no models", minutes=10, allowed_models=[])
        check("a session naming no model is refused", False)
    except ValueError:
        check("a session naming no model is refused", True)

    # ── 3. the model allowlist ───────────────────────────────────────────
    print("3. the models are the session's, not the model's opinion")
    sess = await guests.resolve(raw)
    check("the session defaults to its first model",
          guests.session_model(sess) == "ollama:qwen3:8b", guests.session_model(sess))
    picked = await guests.select_model(sess["id"], "ollama:qwen2.5:3b")
    check("switching within the allowlist works",
          picked["selected_model"] == "ollama:qwen2.5:3b")
    try:
        await guests.select_model(sess["id"], "openrouter:anthropic/claude-opus-4")
        check("switching OUTSIDE the allowlist is refused", False)
    except guests.ModelNotAllowed:
        check("switching OUTSIDE the allowlist is refused", True)
    after = await guests.get(sess["id"])
    check("...and did not quietly fall back to an allowed one",
          after["selected_model"] == "ollama:qwen2.5:3b", str(after["selected_model"]))

    try:
        guests.enforce_model(["ollama:qwen3:8b"], "openrouter:x/y")
        check("enforce_model refuses a model off the list", False)
    except guests.ModelNotAllowed:
        check("enforce_model refuses a model off the list", True)
    guests.enforce_model(["ollama:qwen3:8b"], "ollama:qwen3:8b")
    guests.enforce_model(None, "anything-at-all")
    check("enforce_model is a no-op for the operator (None)", True)

    # The gate that matters is the one the RUNNER calls, one line before the
    # request is built. Proven by running the same call the runner makes.
    from app.agents import runner as agent_runner
    target = await agent_runner._fallback_target(
        {"name": "main", "model": "ollama:qwen3:8b"},
        "ollama:qwen3:8b", {"error_class": "connect_failed", "error": "x"},
        set(), allowed_models=["ollama:qwen3:8b"])
    check("a fallback outside the guest's allowlist is never offered",
          target is None or target == "ollama:qwen3:8b", str(target))

    # ── 4. the tool ceiling ──────────────────────────────────────────────
    print("4. safe tools means read-only, derived from the tools themselves")
    permits = agent_runner._http_guest_permits
    for name in ("web_search", "fetch_url", "search_memory", "read_memory_item"):
        check(f"a guest may {name}", permits(name))
    check("a guest may write to their OWN memory", permits("write_memory"))
    for name in ("dispatch_to_agent", "manage_automations", "manage_agents",
                 "manage_tools", "delete_memory_item", "redeploy_service",
                 "delegate_coding_task", "notify_operator", "run_command",
                 "manage_tool_hosts", "pull_model"):
        check(f"a guest may NOT {name}", not permits(name))
    check("an MCP tool is not a guest tool", not permits("mcp:anything/at-all"))
    check("a tool nobody has classified is refused by its own silence",
          not permits("some_tool_invented_next_month"))

    # ── 5. the sandbox namespace ─────────────────────────────────────────
    print("5. a guest's memory is theirs, and Jeremy's is unreachable from it")
    from app.config import settings
    from app.memory import memory as memory_mod

    real_root = Path(settings.okf_memory_dir).resolve()
    groot = guests.memory_root(sess["id"])
    check("the guest namespace is NOT inside the operator's memory dir",
          not groot.is_relative_to(real_root), f"{groot} vs {real_root}")
    check("...and does not contain it either", not real_root.is_relative_to(groot))
    try:
        guests.memory_root("../../etc")
        check("a path-shaped guest id is refused", False)
    except ValueError:
        check("a path-shaped guest id is refused", True)

    store = await guests.store_for(sess)
    check("the guest store is a sandbox instance", store.sandboxed)
    with memory_mod.sandbox(store):
        doc = await memory_mod.memory.write(
            "The guest said the sky was green.", type="topic",
            title="guest-only-note")
    check("a note written under the binding lands in the guest namespace",
          any(p.name.startswith("guest-only-note") for p in groot.rglob("*.md")),
          str(doc))
    check("...and NOT in the operator's memory dir",
          not any("guest-only-note" in p.name for p in real_root.rglob("*.md")))

    # the other direction: the operator's own store cannot see it
    hits = await memory_mod.real().context("sky was green")
    check("the operator's store cannot retrieve the guest's note",
          "sky was green" not in str(hits))

    # ── 6. the guest's chat is not the operator's chat ───────────────────
    print("6. a guest turn cannot capture the operator's conversation")
    from app import conversations
    operator_conv = await conversations.get_or_create_active_conversation()
    gconv = await guests.conversation_for(sess)
    check("a guest gets their own conversation", gconv["id"] != operator_conv["id"])
    still = await conversations.get_or_create_active_conversation()
    check("the operator's active conversation did not move",
          still["id"] == operator_conv["id"], f"{still['id']} vs {operator_conv['id']}")
    again = await guests.conversation_for(sess)
    check("a guest keeps the same conversation across turns",
          again["id"] == gconv["id"])
    check("a guest owns their own conversation",
          await guests.owns_conversation(sess, gconv["id"]))
    check("a guest does NOT own the operator's",
          not await guests.owns_conversation(sess, operator_conv["id"]))
    check("a garbage id is not owned either",
          not await guests.owns_conversation(sess, "not-a-uuid"))

    # ── 7. the wipe, and the proof that it happened ──────────────────────
    print("7. revocation wipes, and says so only when it did")
    check("the namespace exists before the wipe", groot.exists())
    revoked = await guests.revoke(sess["id"])
    check("the session is revoked", revoked["revoked_at"] is not None)
    check("a revoked token resolves to nothing", await guests.resolve(raw) is None)
    check("the namespace is GONE", not groot.exists())
    check("the wipe reports what it did", revoked["memory"]["wiped"] is True,
          str(revoked["memory"]))

    # A second revoke has nothing to delete and must SAY so rather than
    # reporting a wipe it did not perform.
    second = await guests.revoke(sess["id"])
    check("a second wipe does not claim a wipe it did not do",
          second["memory"]["wiped"] is False, str(second["memory"]))

    print("8. a wipe that did not happen FAILS — it never reads as success")
    victim = await guests.mint("wipe probe", minutes=10, allowed_models=["m"])
    vroot = guests.memory_root(victim["id"])
    vroot.mkdir(parents=True, exist_ok=True)
    (vroot / "note.md").write_text("still here")
    real_rmtree = shutil.rmtree
    shutil.rmtree = lambda *a, **k: None          # the silent-failure simulation
    try:
        guests.wipe_memory(victim["id"])
        check("a wipe that left the files behind RAISES", False)
    except guests.WipeFailed as e:
        check("a wipe that left the files behind RAISES", True)
        check("...and names the directory that survived", str(vroot) in str(e))
    finally:
        shutil.rmtree = real_rmtree
    check("the files really were still there (the probe was honest)",
          (vroot / "note.md").exists())
    out = guests.wipe_memory(victim["id"])
    check("the real wipe then removes them", out["wiped"] and not vroot.exists())

    print("9. run_agent really applies the clamp — the offered toolset, measured")
    # The two previous sections check the PREDICATES. This runs a real turn
    # through `run_agent` with the LLM stubbed, and reads the tool list that
    # was actually handed to the model. A predicate nobody calls is the shape
    # of every clamp bug in this file's history.
    from app.agents import registry as agent_registry
    from app.llm import router as llm_router

    offered: dict = {}

    def _flat_system(messages) -> str:
        """The system prompt as ONE string, both halves of the cache split."""
        msg = next((m for m in messages if m.get("role") == "system"), {})
        body = msg.get("content")
        if isinstance(body, list):
            return "\n\n".join(str(p.get("text", "")) for p in body)
        return str(body or "")

    async def fake_stream(messages, model, tools=None, **kw):
        offered["tools"] = [t["function"]["name"] for t in (tools or [])]
        offered["model"] = model
        offered["system"] = _flat_system(messages)
        yield {"type": "text", "text": "ok"}

    # REAL operator-private state to look for. Seeded rather than assumed: on
    # a throwaway database the rosters would otherwise be empty and every
    # "the guest cannot see it" check below would pass by having nothing to
    # see, which is the shape of a test that defends nothing.
    from app import automations as automations_store, goals as goals_store
    from app import rules as rules_store
    await automations_store.create(
        "guest-suite-secret-automation", "do a private thing", "main",
        interval_minutes=60, description="operator-only automation")
    await rules_store.create("guest-suite-secret-rule", "never-matches-xyzzy",
                             action="warn", description="operator-only rule")
    proposed = await goals_store.propose(
        "guest-suite-secret-goal", "a private target", ["manage_tools"])
    await goals_store.activate(proposed["id"])
    private = ["guest-suite-secret-automation", "guest-suite-secret-rule",
               "guest-suite-secret-goal"]

    main_agent = await agent_registry.get_agent_by_name("main")
    real_stream = llm_router.stream_chat
    llm_router.stream_chat = fake_stream
    try:
        gsess = await guests.mint("clamp probe", minutes=30,
                                  allowed_models=["ollama:qwen3:8b"])
        grow = await guests.get(gsess["id"])
        async for _ in agent_runner.run_agent(
                {**main_agent, "model": "ollama:qwen3:8b"},
                [{"role": "user", "content": "hello"}], guest=grow):
            pass
        guest_tools = set(offered.get("tools") or [])
        guest_prompt = offered.get("system") or ""

        offered.clear()
        async for _ in agent_runner.run_agent(
                {**main_agent, "model": "ollama:qwen3:8b"},
                [{"role": "user", "content": "hello"}]):
            pass
        operator_tools = set(offered.get("tools") or [])
        operator_prompt = offered.get("system") or ""
    finally:
        llm_router.stream_chat = real_stream

    check("the operator's turn is offered a real toolset",
          len(operator_tools) > 10, str(len(operator_tools)))
    check("the guest's turn is offered strictly fewer",
          guest_tools < operator_tools,
          f"{sorted(guest_tools)} vs {len(operator_tools)}")
    # Jeremy's sentence, checked as a list: "chat + a sandbox memory ... +
    # safe tools". The default `voice.family_tools` is "web_search" alone, so
    # without the guest floor the sandbox memory would have shipped with no
    # tool able to reach it.
    for name in ("web_search", "fetch_url", "search_memory", "write_memory"):
        check(f"a guest turn really is offered {name}", name in guest_tools,
              str(sorted(guest_tools)))
    banned = {"dispatch_to_agent", "manage_agents", "manage_automations",
              "manage_tools", "delete_memory_item", "notify_operator",
              "run_command", "delegate_coding_task", "redeploy_service"}
    check("...and none of the verbs that change something",
          not (guest_tools & banned), str(sorted(guest_tools & banned)))
    check("every tool the guest got passes the ceiling",
          all(agent_runner._http_guest_permits(
              __import__("app.tools.registry", fromlist=["x"]).canonical_name(n))
              for n in guest_tools), str(sorted(guest_tools)))
    check("...and the guest link's own allowlist, not someone else's dial",
          all(agent_runner._guest_permits(
              __import__("app.tools.registry", fromlist=["x"]).canonical_name(n))
              for n in guest_tools), str(sorted(guest_tools)))

    # ── 9b. the PROMPT is the other half of the disclosure surface ────────
    #
    # The route allowlist closes GET /api/v1/goals and GET /api/v1/automations
    # (section 1 asserts it) and `_build_system_prompt` used to assemble the
    # same content anyway, so a stranger read it by asking. MEASURED
    # 2026-08-07 through the real POST /api/v1/chat/stream on a minted guest
    # token: one turn enumerated all ten automations with their enabled state
    # and all four approved goals with their pre-approved verbs and remaining
    # budgets. Every check here is paired with the operator's prompt from the
    # same two turns, so none of them can pass by there being nothing to leak.
    print("9b. the guest's PROMPT carries none of the operator's platform state")
    for label, needle in (
            ("the automation roster", "## Platform state (live"),
            ("approved goals", "## Approved goals (live)"),
            ("the specialist roster", "## Available specialists")):
        check(f"the operator's prompt really does carry {label}",
              needle in operator_prompt, needle)
        check(f"...and the guest's does NOT", needle not in guest_prompt, needle)
    for needle in ("## Platform facts (live)", "## What changed about you recently",
                   "Background work failing right now", "## Not working right now",
                   "## A job of yours is waiting on him",
                   "## MCP servers (not loaded",
                   "## Getting a capability you do not have"):
        check(f"a guest is not told {needle!r}", needle not in guest_prompt)
    # the rows themselves, by name — a heading can be renamed, a leak cannot
    for name in private:
        check(f"the operator's prompt names {name} (so this check has teeth)",
              name in operator_prompt)
        check(f"...and the guest's prompt never says {name}",
              name not in guest_prompt)
    # every declared slot is answered for, so a block added tomorrow cannot
    # reach a public link by nobody having thought about it
    check("every prompt slot declares whether a guest may see it",
          all(isinstance(v, bool) for v in agent_runner._PROMPT_SLOTS.values()),
          str(agent_runner._PROMPT_SLOTS))
    try:
        agent_runner._PromptSlots(guest=True).add("a_slot_nobody_declared", "x")
        check("an undeclared slot RAISES rather than silently leaking", False)
    except KeyError:
        check("an undeclared slot RAISES rather than silently leaking", True)

    # and the register: a link guest is not "an enrolled household member"
    check("the guest is addressed as someone on a guest link",
          "## Speaking with someone on a guest link" in guest_prompt)
    check("...not as an enrolled household member",
          "enrolled household member" not in guest_prompt)
    check("the operator's own turn gets no speaker register at all",
          "## Speaking with" not in operator_prompt)

    # ── 9c. the household dial cannot widen a public link ────────────────
    #
    # `voice.family_tools` is the operator's dial for voices in his house. It
    # used to be UNION'd into the guest set, so setting it to "*" for his kids
    # handed every outstanding guest link service_logs (backend logs carry
    # masked auth forensics and X-Real-IP), diagnose, and list_secret_names —
    # with nothing in the UI to say so. The guest link has its own allowlist
    # now; this is the check that says it stayed its own.
    print("9c. widening voice.family_tools does not widen a guest link")
    before = settings_store.get("voice.family_tools")
    try:
        await settings_store.set_value("voice.family_tools", "*")
        llm_router.stream_chat = fake_stream
        offered.clear()
        try:
            async for _ in agent_runner.run_agent(
                    {**main_agent, "model": "ollama:qwen3:8b"},
                    [{"role": "user", "content": "hello"}], guest=grow):
                pass
        finally:
            llm_router.stream_chat = real_stream
        wide_tools = set(offered.get("tools") or [])
    finally:
        await settings_store.set_value("voice.family_tools", before or "web_search")
    check("family_tools='*' offers a guest exactly the same tools",
          wide_tools == guest_tools,
          str(sorted(wide_tools - guest_tools)) + " gained")
    for name in ("service_logs", "diagnose", "list_secret_names", "list_egress",
                 "service_status", "list_agents", "list_goals",
                 "check_service_reachable", "list_workloads"):
        check(f"a wide-open household dial still does not hand a guest {name}",
              name not in wide_tools)

    # and the model gate: the same turn on a model the session does not allow
    # must DIE saying so, not quietly answer.
    llm_router.stream_chat = fake_stream
    try:
        died = ""
        async for ev in agent_runner.run_agent(
                {**main_agent, "model": "ollama:qwen2.5:3b"},
                [{"role": "user", "content": "hello"}], guest=grow):
            pass
    except guests.ModelNotAllowed as e:
        died = str(e)
    finally:
        llm_router.stream_chat = real_stream
    check("a guest turn on a model off the allowlist REFUSES", bool(died), died)
    check("...and names what it would have run", "qwen2.5:3b" in died, died)

    print("10. delete takes the conversation with it")
    doomed = await guests.mint("doomed", minutes=10, allowed_models=["m"])
    dsess = await guests.get(doomed["id"])
    dconv = await guests.conversation_for(dsess)
    await guests.delete(doomed["id"])
    async with db.acquire() as conn:
        left = await conn.fetchval(
            "SELECT count(*) FROM conversations WHERE id = $1", uuid.UUID(dconv["id"]))
    check("the guest's conversation is deleted with the session", left == 0, str(left))
    check("the session row is gone", await guests.get(doomed["id"]) is None)

    await db.close_pool()


def main() -> int:
    asyncio.run(_make_db())
    try:
        asyncio.run(run())
    finally:
        asyncio.run(_drop_db())
        shutil.rmtree(SCRATCH, ignore_errors=True)
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
