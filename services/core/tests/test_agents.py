"""app/agents.py — the agent row, its run-time identity, the one writer (S12).

What these pin, and why each is a pin and not a wish:
  * identity is DERIVED (role from the name, a Person value from the row),
    and Nova's own persona is the LIVE registry — the reachability pin that
    catches a persona site fed a stale list;
  * a persona advertises only the agent's subset and SAYS what is gone (a
    vanished tool, a missing skill file) instead of dropping it; its shared
    memory scope is DERIVED from the row (the owner only when the row says
    so, a refusal when the row says so and no owner was given) and its
    listing tools are the subset's own listers, never the registry's;
  * every refusal in validate_spec names its rule and the live set;
  * create/update/delete read back what they claim, in one transaction
    with the ledger event, and state the gateway's answer as it was given;
  * the log conversation is inactive, so the owner's chat can never pick it;
  * delete keeps the pause a timer already had (its reason is the record of
    why it stopped) and names both groups in its sentence and its event;
  * the cap is read from the ledger and an unreadable ledger is stated,
    never a refusal and never quiet; the persisted sentence says "reached"
    at equality and "over" only past it;
  * the roster RAISES when the table cannot be read — chat records it on
    the turn — and is None only when there are no agents;
  * the module imports without chat (chat imports it at module top).
"""

from __future__ import annotations

import subprocess
import sys
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import asyncpg
import pytest

from app import agents, conversations, governance, timers, tools
from app.agents import Agent, AgentError, AgentSpec
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext, ToolFailure
from app.tools.workspace import root_from_env
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

SPEC_TOOLS = ("get_time", "workspace_read_file", "workspace_write_file")


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _owner(pool) -> Person:
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    return Person(id=pid, name="jeremy", role="owner")


def _agent(**over) -> Agent:
    """An Agent VALUE for the pure tests (no row)."""
    now = datetime.now(UTC)
    fields = dict(
        id=uuid.uuid4(),
        name="coder",
        purpose="writes code",
        instructions="Write small, tested changes.",
        tools=("get_time", "workspace_read_file"),
        skills=(),
        monthly_cap_usd=None,
        max_tool_rounds=8,
        read_shared_memory=False,
        log_conversation_id=None,
        created_via="page",
        created_turn_id=None,
        created_at=now,
        updated_at=now,
    )
    fields.update(over)
    return Agent(**fields)


def _spec(**over) -> AgentSpec:
    fields = dict(
        name="coder",
        purpose="writes code",
        instructions="Write small, tested changes.",
        tools=SPEC_TOOLS,
    )
    fields.update(over)
    return AgentSpec(**fields)


def _explain(role: str = "agent_coder", *, reason: str | None = None) -> dict:
    return {
        "role": role,
        "chain": [{"link": 1, "id": "ollama:qwen3:8b", "verdict": "runnable", "reason": None}],
        "would_serve": {
            "role": role,
            "link": 1,
            "reason": reason,
            "served_by": "ollama:qwen3:8b",
            "standby": False,
        },
        "reason": reason,
    }


def _gateway(chain=(), **over) -> FakeGateway:
    """A gateway that echoes the PUT the way the real one does ({role, chain})
    and explains the role as served by the local model."""
    return FakeGateway(
        admin_body={"role": "agent_coder", "chain": list(chain)},
        explain_body=_explain(),
        **over,
    )


async def _create(pool, spec=None, **over):
    return await agents.create(
        pool,
        app,
        spec or _spec(),
        created_via=over.pop("created_via", "page"),
        created_turn_id=over.pop("created_turn_id", None),
        actor=over.pop("actor", "jeremy"),
    )


async def _events(pool, kind: str) -> list[asyncpg.Record]:
    return [e for e in await governance.recent_events(pool) if e["kind"] == kind]


# ── identity ───────────────────────────────────────────────────────────────


def test_role_and_person_are_derived_from_the_row():
    agent = _agent(name="reviewer")
    assert agent.role == "agent_reviewer"
    person = agent.person()
    assert isinstance(person, Person)
    assert (person.id, person.name, person.role) == (agent.id, "reviewer", "agent")
    # 'agent_' + the 26-char cap stays inside the gateway's ROLE_RE (32).
    assert len(agents.ROLE_PREFIX + "a" * 26) == 32


def test_nova_persona_is_the_live_registry_and_the_env_root(root):
    """The registry-reachability pin: Nova's own turns advertise exactly what
    is registered, read at the call, so a tool added later is advertised by
    that fact and a persona site can never be fed a stale list."""
    persona = agents.nova_persona()
    assert persona.agent is None and persona.instructions_block is None
    assert persona.shared_person_id is None
    assert persona.tool_names == tuple(sorted(tools.REGISTRY))
    assert persona.workspace_root == root_from_env() == root
    # Every listing-kind tool, read from the registry at the call.
    assert persona.listing_tools == tuple(
        tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    )
    assert persona.listing_tools and set(persona.listing_tools) <= set(persona.tool_names)


def test_persona_for_advertises_the_subset_and_states_what_is_gone(root):
    agent = _agent(tools=("get_time", "vanished_tool"))
    persona = agents.persona_for(agent, owner_id=None, root=root)
    assert persona.agent is agent
    assert persona.tool_names == ("get_time",)
    assert persona.listing_tools == ()
    assert persona.workspace_root == root / "agents" / "coder"
    assert persona.workspace_root == agents.folder_for(agent, root)
    assert persona.shared_person_id is None
    block = persona.instructions_block
    assert block is not None
    assert block.startswith(
        "You are coder, an agent working for the household; Nova is the assistant that "
        "hands you tasks and relays your reports."
    )
    assert "Purpose: writes code" in block
    assert "Write small, tested changes." in block
    assert (
        "Your workspace folder is agents/coder/ — every path you read or write is inside it."
        in block
    )
    assert "You have 8 tool rounds per task." in block
    assert (
        "memory_search searches your own notes; you cannot read the household's shared notes."
        in block
    )
    assert "The owner may address you directly as @coder at the start of a message." in block
    assert "To remove an agent, ask the owner or Nova." in block
    assert "[tool vanished_tool: no longer exists]" in block
    assert agents.unknown_tools(agent) == ["vanished_tool"]

    shared = _agent(read_shared_memory=True)
    owner_id = uuid.uuid4()
    persona = agents.persona_for(shared, owner_id=owner_id, root=root)
    assert persona.shared_person_id == owner_id
    assert (
        "memory_search searches your own notes; shared household notes are recalled for "
        "you automatically." in persona.instructions_block
    )
    assert "no longer exists" not in persona.instructions_block


def test_persona_embeds_a_skill_file_and_states_a_missing_one(root):
    skills = root / "skills"
    skills.mkdir(parents=True)
    (skills / "review.md").write_text("Check every branch has a test.", encoding="utf-8")
    long_body = "x" * (agents.SKILL_CHARS + 50)
    (skills / "long.md").write_text(long_body, encoding="utf-8")
    agent = _agent(skills=("review", "long", "gone"))

    block = agents.persona_for(agent, owner_id=None, root=root).instructions_block
    assert "## Skill: review\nCheck every branch has a test." in block
    assert "[skill gone: file missing]" in block
    assert "## Skill: long\n" + "x" * agents.SKILL_CHARS in block
    assert long_body not in block  # cut, and the cut is stated
    assert (
        f"[skill long: cut here — the first {agents.SKILL_CHARS} of {len(long_body)} characters]"
        in block
    )
    assert agents.skills_status(agent, root) == [
        {"name": "review", "present": True},
        {"name": "long", "present": True},
        {"name": "gone", "present": False},
    ]
    listed = agents.list_skills(root)
    assert [s["name"] for s in listed] == ["long", "review"]
    assert listed[1]["size"] == len("Check every branch has a test.")
    assert listed[1]["modified"]
    # A name that fails the rule never becomes a path (a hand-edited row
    # cannot turn "../x" into a file read); the env root is the default.
    assert agents.skill_text("../review", root) is None
    assert agents.skill_text("review") == "Check every branch has a test."
    assert agents.list_skills(root / "nowhere") == []


def test_persona_shared_scope_is_derived_from_the_row_never_the_caller(root):
    """read_shared_memory False: no scope even when an owner id is offered
    (a call site cannot widen what the row says); True: the owner id; True
    with no owner id: a stated refusal — a turn that quietly recalled
    nothing would be a lie about what the agent may read."""
    owner_id = uuid.uuid4()
    closed = agents.persona_for(_agent(read_shared_memory=False), owner_id=owner_id, root=root)
    assert closed.shared_person_id is None
    opened = agents.persona_for(_agent(read_shared_memory=True), owner_id=owner_id, root=root)
    assert opened.shared_person_id == owner_id
    with pytest.raises(
        AgentError,
        match="agent coder reads shared notes but no owner id was given — the scope cannot be "
        "derived",
    ):
        agents.persona_for(_agent(read_shared_memory=True), owner_id=None, root=root)
    # owner_id is required, not defaulted: a call site cannot forget to say
    # what it knows and get a persona anyway.
    with pytest.raises(TypeError):
        agents.persona_for(_agent(), root=root)  # type: ignore[call-arg]


def test_persona_listing_tools_are_the_subsets_own_listers(root):
    """The presented-listing guard asks "could a lister have run?": for an
    agent the answer is its subset's listers, in the registry's order, and
    a lister that vanished from the registry is not one (it is not
    advertised either)."""
    every = tuple(tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING))
    assert {"list_timers", "workspace_list_files"} <= set(every)
    subset = _agent(tools=("workspace_list_files", "get_time", "list_timers", "vanished_lister"))
    persona = agents.persona_for(subset, owner_id=None, root=root)
    assert persona.listing_tools == ("list_timers", "workspace_list_files")
    assert persona.listing_tools == tuple(name for name in every if name in persona.tool_names)
    assert "vanished_lister" not in persona.listing_tools
    plain = agents.persona_for(_agent(tools=("get_time",)), owner_id=None, root=root)
    assert plain.listing_tools == ()


# ── validate_spec ──────────────────────────────────────────────────────────


def test_delegate_tool_is_named_once():
    """chat and the validator both read agents.DELEGATE_TOOL; the module has
    no second spelling of it to drift from."""
    assert agents.DELEGATE_TOOL == "delegate_to_agent"
    source = Path(agents.__file__).read_text(encoding="utf-8")
    assert source.count('"delegate_to_agent"') == 1


def test_validate_spec_refuses_each_by_name(root):
    with pytest.raises(AgentError, match=r"must match \^\[a-z\]\[a-z_\]\{0,25\}\$"):
        agents.validate_spec(_spec(name="Coder-1"))
    with pytest.raises(AgentError, match="reserved"):
        agents.validate_spec(_spec(name="nova"))
    with pytest.raises(AgentError, match="no tool named 'nope'") as refused:
        agents.validate_spec(_spec(tools=("get_time", "nope")))
    # The live registry is quoted, derived at the call.
    assert ", ".join(tools.tool_names()) in str(refused.value)
    with pytest.raises(
        AgentError,
        match="delegate_to_agent cannot be in an agent's tools — agents do not delegate in this "
        "version",
    ):
        agents.validate_spec(_spec(tools=(agents.DELEGATE_TOOL,)))
    (root / "skills").mkdir(parents=True)
    (root / "skills" / "review.md").write_text("r", encoding="utf-8")
    with pytest.raises(AgentError, match="no skill named 'missing' — files under skills/: review"):
        agents.validate_spec(_spec(skills=("missing",)), root=root)
    with pytest.raises(AgentError, match="skill name"):
        agents.validate_spec(_spec(skills=("../etc",)), root=root)
    with pytest.raises(AgentError, match="0 or more"):
        agents.validate_spec(_spec(monthly_cap_usd=Decimal("-1")))
    with pytest.raises(AgentError, match="between 1 and 50"):
        agents.validate_spec(_spec(max_tool_rounds=0))
    with pytest.raises(AgentError, match="between 1 and 50"):
        agents.validate_spec(_spec(max_tool_rounds=51))
    # And the good one passes as-is: valid name, live tools, present skill,
    # a zero cap (a real cap, not "uncapped"), rounds at the edge.
    agents.validate_spec(
        _spec(skills=("review",), monthly_cap_usd=0, max_tool_rounds=50), root=root
    )


# ── the eval harness's reserved prefix (2026-09-09) ────────────────────────
#
# The eval runner CREATES the agents a case declares and DELETES them by name
# afterwards, and rests that teardown on the premise that its prefix is a name
# the owner's roster cannot hold. Until this rule the premise was simply false:
# validate_spec accepted "eval_helper" from the Agents page and from her
# create_agent tool, so an agent the owner made under that name would have been
# destroyed — with its log conversation — by the next suite run. These pin the
# rule that makes the premise TRUE, both of the owner's doors, the ONE constant
# behind it, and the single door the harness keeps.


def test_the_reserved_prefix_is_refused_and_the_refusal_says_why(root):
    with pytest.raises(AgentError, match="reserved") as refused:
        agents.validate_spec(_spec(name="eval_helper"), root=root)
    message = str(refused.value)
    assert agents.EVAL_FIXTURE_PREFIX in message
    # It names the CONSEQUENCE, not just the rule: what would happen to the
    # agent if the roster were allowed to hold the name.
    assert "eval harness" in message and "DELETES" in message
    # The rule is the PREFIX, not one name — and it stops at the prefix.
    with pytest.raises(AgentError, match="reserved"):
        agents.validate_spec(_spec(name="eval_x"), root=root)
    agents.validate_spec(_spec(name="evaluator"), root=root)  # not the prefix
    # The harness's own door is the single exception, and it is a Python
    # keyword — no field of a spec, so no tool argument or request body reaches
    # it (the two owner doors below are refused by that construction).
    agents.validate_spec(_spec(name="eval_helper"), root=root, allow_reserved_prefix=True)


def test_the_harness_and_the_roster_read_ONE_prefix():
    """Not two literals with the same value: the loader reads the roster's
    constant, so the day the prefix moves it moves in both places at once."""
    from app.evals import cases as eval_cases

    assert eval_cases.FIXTURE_AGENT_PREFIX == agents.EVAL_FIXTURE_PREFIX
    assert agents.EVAL_FIXTURE_PREFIX in agents.RESERVED_PREFIXES
    loader = Path(eval_cases.__file__).read_text(encoding="utf-8")
    assert "FIXTURE_AGENT_PREFIX = agents.EVAL_FIXTURE_PREFIX" in loader
    # The dependency runs ONE way — evals reads the roster's rule; app.agents
    # never imports app.evals — so the rule cannot be circular. Cold, in a
    # subprocess, for the same reason the chat-import pin is.
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, app.agents; print([m for m in sys.modules if m.startswith('app.evals')])",
        ],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "[]"


def test_the_harness_door_has_exactly_one_caller():
    """allow_reserved_prefix is the harness's door and nothing else's. This
    goes red the day it is plumbed into a route, a tool or the page — which is
    the only way an owner could reach the name again."""
    core = Path(agents.__file__).resolve().parent
    callers = sorted(
        str(path.relative_to(core))
        for path in core.rglob("*.py")
        if "allow_reserved_prefix=True" in path.read_text(encoding="utf-8")
    )
    assert callers == ["agents.py", "evals/runner.py"]
    # agents.py's own use is `update`, whose spec carries the EXISTING row's
    # name — never a name a caller chose.
    source = Path(agents.__file__).read_text(encoding="utf-8")
    assert source.count("allow_reserved_prefix=True") == 1
    assert "validate_spec(merged, allow_reserved_prefix=True)" in source


async def test_both_owner_doors_refuse_the_reserved_prefix(owner_client, pool, mount_peers, root):
    """Her create_agent tool and the Agents page — the only two ways an agent
    comes to exist — both refuse, and neither leaves anything behind."""
    mount_peers(gateway=_gateway())
    row = await pool.fetchrow("SELECT id, name, role FROM people WHERE role = 'owner'")
    owner = Person(id=row["id"], name=row["name"], role=row["role"])
    body = {
        "name": "eval_helper",
        "purpose": "writes notes",
        "instructions": "Be brief.",
        "tools": ["workspace_write_file"],
    }

    result, ok = await tools.dispatch("create_agent", dict(body), tools.context_for(app, owner))
    assert not ok and "reserved" in result and agents.EVAL_FIXTURE_PREFIX in result

    resp = await owner_client.post("/api/v1/agents", json=dict(body))
    assert resp.status_code == 400, resp.text
    assert "reserved" in resp.text

    assert await agents.list_all(pool) == []
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 0


async def test_a_row_under_the_reserved_prefix_still_lives_its_whole_life(pool, mount_peers, root):
    """The rule guards WRITES OF A NAME, never rows: a row that predates it
    (stood in for here by the harness's own door — the same row either way) is
    still read, still listed, still editable and still deletable. A rule that
    reached back into the table would be the data loss it exists to prevent."""
    await _owner(pool)
    mount_peers(gateway=_gateway())

    created = await agents.create(
        pool,
        app,
        _spec(name="eval_helper"),
        created_via="page",
        created_turn_id=None,
        actor="jeremy",
        allow_reserved_prefix=True,
    )
    assert created.agent.name == "eval_helper"
    assert (await agents.by_name(pool, "eval_helper")) is not None
    assert "eval_helper" in await agents.names(pool)

    updated = await agents.update(
        pool, app, "eval_helper", {"purpose": "still the owner's"}, actor="jeremy"
    )
    assert updated.agent.purpose == "still the owner's"

    await agents.delete(pool, app, "eval_helper", actor="jeremy")
    assert (await agents.by_name(pool, "eval_helper")) is None


# ── create ─────────────────────────────────────────────────────────────────


async def test_create_makes_the_row_the_log_conversation_and_the_folder(pool, mount_peers, root):
    owner = await _owner(pool)
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('agents.max_tool_rounds', '9'::jsonb)"
    )
    gateway = _gateway()
    mount_peers(gateway=gateway)

    result = await _create(pool, _spec(monthly_cap_usd=20))

    agent = result.agent
    assert agent.name == "coder" and agent.tools == SPEC_TOOLS and agent.skills == ()
    assert agent.monthly_cap_usd == Decimal("20.00")
    assert agent.max_tool_rounds == 9  # the setting, COPIED into the row
    assert agent.read_shared_memory is False and agent.created_via == "page"
    assert result.folder == root / "agents" / "coder" and result.folder.is_dir()
    # The log conversation: the owner's, INACTIVE, titled after the agent.
    log = await pool.fetchrow(
        "SELECT person_id, active, title FROM conversations WHERE id = $1",
        agent.log_conversation_id,
    )
    assert log["person_id"] == owner.id and log["active"] is False
    assert log["title"] == "agent:coder"
    assert await agents.log_conversation(pool, agent) == agent.log_conversation_id
    # ...and the owner's active conversation is never it.
    active = await conversations.active_conversation(pool, owner)
    assert active["id"] != agent.log_conversation_id
    # The ledger event shares the transaction and carries the spec.
    (event,) = await _events(pool, governance.AGENT_CREATED)
    assert event["actor"] == "jeremy" and event["subject_ref"] == agent.id
    assert event["meta"]["name"] == "coder" and event["meta"]["tools"] == list(SPEC_TOOLS)
    assert event["meta"]["monthly_cap_usd"] == 20.0 and event["meta"]["max_tool_rounds"] == 9
    # The gateway was told the role and its chain, then asked what serves it.
    assert ("/admin/routes/agent_coder", {"chain": []}) in gateway.seen
    assert b"role=agent_coder&model=" in gateway.queries
    assert result.route.registered is True
    assert result.route.detail == (
        "route agent_coder registered, chain [] — would be served by ollama:qwen3:8b "
        "(the chat chain)"
    )
    # The sentence is composed from what was READ back.
    assert result.text == (
        f"created agent coder — purpose: writes code; tools: 3 of {len(tools.REGISTRY)} "
        "(get_time, workspace_read_file, workspace_write_file); folder agents/coder/ exists; "
        "rounds 9; cap $20.00/month; memory: own notes only; " + result.route.detail + "; "
        f"log conversation {agent.log_conversation_id}"
    )
    # The reads agree with the row.
    assert await agents.by_name(pool, "coder") == agent
    assert await agents.by_id(pool, agent.id) == agent
    assert await agents.list_all(pool) == [agent]
    assert await agents.names(pool) == ["coder"]


async def test_create_states_a_gateway_that_refuses_the_route(pool, mount_peers, root):
    await _owner(pool)
    mount_peers(
        gateway=FakeGateway(
            admin_status=400,
            admin_body={"error": "link 'nope:x' does not name a registered provider"},
        )
    )
    result = await _create(pool, _spec(model_chain=("nope:x",)))
    assert result.route.registered is False
    assert result.route.detail == (
        "the gateway did not register its route: link 'nope:x' does not name a registered "
        "provider — it routes on the chat chain until Settings → Routing sets one"
    )
    assert result.route.detail in result.text
    # The row stands: a route the gateway refused is not a reason to lose the agent.
    assert await agents.by_name(pool, "coder") is not None


async def test_create_states_a_gateway_that_is_not_configured(pool, monkeypatch, root):
    await _owner(pool)
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    result = await _create(pool)
    assert result.route.registered is False
    assert "GATEWAY_URL is unset" in result.route.detail
    assert result.route.detail.startswith("the gateway did not register its route:")


async def test_create_refuses_a_200_that_did_not_echo_the_chain(pool, mount_peers, root):
    """A 200 alone is not "registered" — the answer is read for the chain the
    gateway says it stored."""
    await _owner(pool)
    mount_peers(gateway=FakeGateway(admin_body={"gpus": []}))
    result = await _create(pool)
    assert result.route.registered is False
    assert "did not echo the chain" in result.route.detail


async def test_a_duplicate_name_is_refused_and_leaves_nothing_behind(pool, mount_peers, root):
    await _owner(pool)
    mount_peers(gateway=_gateway())
    await _create(pool)
    conversations_before = await pool.fetchval("SELECT count(*) FROM conversations")
    with pytest.raises(AgentError, match="an agent named coder already exists"):
        await _create(pool, _spec(purpose="another"))
    assert await pool.fetchval("SELECT count(*) FROM agents") == 1
    assert await pool.fetchval("SELECT count(*) FROM conversations") == conversations_before
    assert len(await _events(pool, governance.AGENT_CREATED)) == 1


async def test_a_folder_that_cannot_be_made_rolls_the_row_back(pool, mount_peers, root):
    """The folder is made INSIDE the transaction: an OSError there is a
    stated refusal and the row, its conversation and its event all vanish."""
    await _owner(pool)
    mount_peers(gateway=_gateway())
    root.mkdir(parents=True)
    (root / "agents").write_text("a file where the folder should be", encoding="utf-8")
    with pytest.raises(AgentError, match="could not create the folder agents/coder/"):
        await _create(pool)
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 0
    assert await _events(pool, governance.AGENT_CREATED) == []


async def test_create_needs_an_owner_and_a_known_origin(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    with pytest.raises(AgentError, match="no owner account exists yet"):
        await _create(pool)
    await _owner(pool)
    with pytest.raises(AgentError, match="created_via must be one of chat, page"):
        await _create(pool, created_via="system")


# ── update ─────────────────────────────────────────────────────────────────


async def test_update_refuses_rename_and_stores_a_change(pool, mount_peers, root):
    await _owner(pool)
    gateway = _gateway()
    mount_peers(gateway=gateway)
    created = await _create(pool)

    with pytest.raises(AgentError, match="cannot be renamed"):
        await agents.update(pool, app, "coder", {"name": "hacker"}, actor="jeremy")
    with pytest.raises(AgentError, match="has no field\\(s\\) colour"):
        await agents.update(pool, app, "coder", {"colour": "blue"}, actor="jeremy")
    with pytest.raises(AgentError, match="no agent named 'ghost' — the agents are: coder"):
        await agents.update(pool, app, "ghost", {"purpose": "x"}, actor="jeremy")
    # The merged spec is validated like a new one.
    with pytest.raises(AgentError, match="no tool named 'nope'"):
        await agents.update(pool, app, "coder", {"tools": ["nope"]}, actor="jeremy")
    # An explicit None (or a bare string) is refused in words — never read
    # as "clear the list", an assertion the caller did not make.
    for field in ("tools", "skills", "model_chain"):
        with pytest.raises(AgentError, match=f"{field} must be a list of names"):
            await agents.update(pool, app, "coder", {field: None}, actor="jeremy")
    with pytest.raises(AgentError, match="tools must be a list of names"):
        await agents.update(pool, app, "coder", {"tools": "get_time"}, actor="jeremy")
    untouched = await agents.by_name(pool, "coder")
    assert untouched.tools == SPEC_TOOLS and untouched.skills == ()
    assert await _events(pool, governance.AGENT_UPDATED) == []

    puts_before = len([p for p, _ in gateway.seen if p == "/admin/routes/agent_coder"])
    result = await agents.update(
        pool, app, "coder", {"purpose": "reviews code", "read_shared_memory": True}, actor="jeremy"
    )
    assert result.agent.purpose == "reviews code" and result.agent.read_shared_memory is True
    assert result.agent.updated_at > created.agent.updated_at
    assert result.agent.tools == SPEC_TOOLS  # untouched fields stay
    assert result.text.startswith("updated agent coder — purpose: reviews code;")
    assert "memory: own notes + shared read" in result.text
    # No chain in the change: nothing was PUT, and the route is said to be as it was.
    assert len([p for p, _ in gateway.seen if p == "/admin/routes/agent_coder"]) == puts_before
    assert result.route.registered is False
    assert result.route.detail == "route agent_coder unchanged — would be served by ollama:qwen3:8b"
    (event,) = await _events(pool, governance.AGENT_UPDATED)
    assert event["subject_ref"] == created.agent.id
    assert event["meta"]["changed"] == ["purpose", "read_shared_memory"]
    assert event["meta"]["after"]["purpose"] == "reviews code"
    # The chain is not a column: an update that carried none wrote nothing
    # about it, so the ledger records nothing about it (not an empty list).
    assert "model_chain" not in event["meta"]["after"]

    # A chain in the change is PUT and its outcome stated.
    gateway.admin_body = {"role": "agent_coder", "chain": ["ollama:qwen3:8b"]}
    result = await agents.update(
        pool, app, "coder", {"model_chain": ["ollama:qwen3:8b"]}, actor="jeremy"
    )
    assert ("/admin/routes/agent_coder", {"chain": ["ollama:qwen3:8b"]}) in gateway.seen
    assert result.route.registered is True
    assert result.route.detail == (
        'route agent_coder registered, chain ["ollama:qwen3:8b"] — would be served by '
        "ollama:qwen3:8b"
    )
    newest, _earlier = await _events(pool, governance.AGENT_UPDATED)  # newest first
    assert newest["meta"]["changed"] == ["model_chain"]
    assert newest["meta"]["after"]["model_chain"] == ["ollama:qwen3:8b"]


# ── delete ─────────────────────────────────────────────────────────────────


async def _bound_timer(pool, owner, agent, title: str) -> asyncpg.Record:
    conversation = await conversations.active_conversation(pool, owner)
    timer = await timers.create(
        pool,
        person=owner,
        kind="scheduled",
        title=title,
        payload={"instruction": "review the day's commits"},
        spec={"kind": "day", "at": "07:00"},
        tz="America/New_York",
        conversation_id=conversation["id"],
        created_via="chat",
    )
    await pool.execute("UPDATE timers SET agent_id = $1 WHERE id = $2", agent.id, timer["id"])
    return timer


async def test_delete_pauses_bound_timers_and_states_what_remains(pool, mount_peers, root):
    """Two bound timers: one running, one the owner had already paused. The
    running one is paused with the delete's reason; the paused one KEEPS its
    own paused_at and reason (the record of why it stopped) and is only
    unbound — and the result, its sentence and the ledger event name both."""
    owner = await _owner(pool)
    gateway = _gateway()
    mount_peers(gateway=gateway)
    created = await _create(pool)
    running = await _bound_timer(pool, owner, created.agent, "nightly review")
    parked = await _bound_timer(pool, owner, created.agent, "weekly digest")
    before = await timers.pause(pool, parked["id"], reason="paused by the owner")
    assert before["paused_at"] is not None
    assert await agents.bound_timers(pool, created.agent.id) == [
        {"id": str(running["id"]), "title": "nightly review"},
        {"id": str(parked["id"]), "title": "weekly digest"},
    ]
    # The RESTRICT key is the backstop: a delete that forgets the pause is refused.
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await pool.execute("DELETE FROM agents WHERE id = $1", created.agent.id)

    result = await agents.delete(pool, app, "coder", actor="jeremy")

    assert result.name == "coder"
    assert result.paused_timers == [
        {"id": str(running["id"]), "title": "nightly review", "already_paused": None},
        {
            "id": str(parked["id"]),
            "title": "weekly digest",
            "already_paused": "paused by the owner",
        },
    ]
    row = await pool.fetchrow(
        "SELECT paused_at, paused_reason, agent_id FROM timers WHERE id = $1", running["id"]
    )
    assert row["paused_at"] is not None and row["agent_id"] is None
    assert row["paused_reason"] == "paused: agent coder was deleted"
    kept = await pool.fetchrow(
        "SELECT paused_at, paused_reason, agent_id FROM timers WHERE id = $1", parked["id"]
    )
    assert kept["paused_at"] == before["paused_at"]  # not re-stamped
    assert kept["paused_reason"] == "paused by the owner" and kept["agent_id"] is None
    assert await agents.by_name(pool, "coder") is None
    assert await agents.bound_timers(pool, created.agent.id) == []
    (event,) = await _events(pool, governance.AGENT_DELETED)
    assert event["subject_ref"] == created.agent.id
    assert event["meta"] == {"name": "coder", "paused_timers": result.paused_timers}
    # The gateway route is dropped, and what stays is said.
    assert ("/admin/routes/agent_coder", None) in gateway.seen
    assert result.route.registered is True and result.route.detail == "route agent_coder removed"
    assert result.remains == (
        "its folder agents/coder/, its memory notes and its log conversation were left in place"
    )
    assert result.text == (
        "deleted agent coder — paused 1 timer: nightly review; 1 timer was already paused "
        "(weekly digest: paused by the owner) and is now unbound; route agent_coder removed; "
        "its folder agents/coder/, its memory notes and its log conversation were left in place"
    )
    assert created.folder.is_dir()
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM conversations WHERE id = $1", created.agent.log_conversation_id
        )
        == 1
    )


async def test_delete_states_a_route_the_gateway_never_had(pool, mount_peers, root):
    await _owner(pool)
    gateway = _gateway()
    mount_peers(gateway=gateway)
    await _create(pool)
    gateway.admin_status, gateway.admin_body = 404, {"error": "no route for role 'agent_coder'"}
    result = await agents.delete(pool, app, "coder", actor="jeremy")
    assert result.route.registered is True
    assert result.route.detail == "route agent_coder had no chain of its own"
    assert result.paused_timers == []
    assert result.text.startswith(
        "deleted agent coder — no timers were bound to it; route agent_coder had no chain of "
        "its own; its folder agents/coder/"
    )
    gateway.admin_status, gateway.admin_body = 500, {"error": "db down"}
    with pytest.raises(
        AgentError, match="no agent named 'coder' — the agents are: there are no agents"
    ):
        await agents.delete(pool, app, "coder", actor="jeremy")


def test_timers_sentence_names_both_groups_with_their_counts():
    fresh = [
        {"id": "1", "title": "a", "already_paused": None},
        {"id": "2", "title": "b", "already_paused": None},
    ]
    kept = [
        {"id": "3", "title": "c", "already_paused": "paused after 5 failures"},
        {"id": "4", "title": "d", "already_paused": "paused by the owner"},
    ]
    assert agents._timers_sentence([]) == "no timers were bound to it"
    assert agents._timers_sentence(fresh[:1]) == "paused 1 timer: a"
    assert agents._timers_sentence(kept[:1]) == (
        "1 timer was already paused (c: paused after 5 failures) and is now unbound"
    )
    assert agents._timers_sentence(fresh + kept) == (
        "paused 2 timers: a, b; 2 timers were already paused (c: paused after 5 failures, "
        "d: paused by the owner) and are now unbound"
    )


# ── the log conversation ───────────────────────────────────────────────────


async def test_a_lost_log_conversation_is_recreated_inactive(pool, mount_peers, root):
    owner = await _owner(pool)
    mount_peers(gateway=_gateway())
    created = await _create(pool)
    await pool.execute("DELETE FROM conversations WHERE id = $1", created.agent.log_conversation_id)
    agent = await agents.by_name(pool, "coder")
    assert agent.log_conversation_id is None  # ON DELETE SET NULL

    log_id = await agents.log_conversation(pool, agent)
    row = await pool.fetchrow(
        "SELECT person_id, active, title FROM conversations WHERE id = $1", log_id
    )
    assert row["person_id"] == owner.id and row["active"] is False and row["title"] == "agent:coder"
    assert (await agents.by_name(pool, "coder")).log_conversation_id == log_id
    # Idempotent: the second ask returns the same row, no new one.
    assert await agents.log_conversation(pool, agent) == log_id
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE title = 'agent:coder'") == 1
    )
    # And the owner's active conversation is never it — however many times asked.
    for _ in range(2):
        assert (await conversations.active_conversation(pool, owner))["id"] != log_id


# ── the cap ────────────────────────────────────────────────────────────────


def _spend(*rows: dict) -> dict:
    return {"window": "month", "timezone": "UTC", "totals": {"usd": 0}, "by_role": list(rows)}


async def test_cap_problem_over_under_unreadable_and_skipped(pool, mount_peers, monkeypatch):
    agent = _agent(monthly_cap_usd=Decimal("20.00"))
    role_row = {"key": "agent_coder", "local": False, "usd": 21.4, "calls": 3}
    mount_peers(gateway=FakeGateway(spend_body=_spend(role_row, {"key": "chat", "usd": 99.0})))
    problem, facts = await agents.cap_problem(app, pool, agent)
    assert problem == (
        "agent coder is over its monthly cap ($21.40 of $20.00 this month) — raise it on the "
        "Agents page"
    )
    assert facts == {"role": "agent_coder", "cap_usd": 20.0, "spent_usd": 21.4, "ledger": "read"}

    # AT the cap: refused too, but the persisted sentence says "reached" —
    # "over" would record a figure the ledger never showed.
    mount_peers(gateway=FakeGateway(spend_body=_spend({**role_row, "usd": 20.0})))
    problem, facts = await agents.cap_problem(app, pool, agent)
    assert problem == (
        "agent coder has reached its monthly cap ($20.00 of $20.00 this month) — raise it on "
        "the Agents page"
    )
    assert facts["spent_usd"] == 20.0 and facts["ledger"] == "read"

    mount_peers(gateway=FakeGateway(spend_body=_spend({**role_row, "usd": 3.0})))
    assert await agents.cap_problem(app, pool, agent) == (
        None,
        {"role": "agent_coder", "cap_usd": 20.0, "spent_usd": 3.0, "ledger": "read"},
    )
    # No row for the role at all: nothing spent, under the cap.
    mount_peers(gateway=FakeGateway(spend_body=_spend()))
    assert (await agents.cap_problem(app, pool, agent))[1]["spent_usd"] == 0.0
    # 0 is a real cap: the first paid round is already over it.
    mount_peers(gateway=FakeGateway(spend_body=_spend({**role_row, "usd": 0.0})))
    problem, _ = await agents.cap_problem(app, pool, _agent(monthly_cap_usd=Decimal("0")))
    assert problem == (
        "agent coder has reached its monthly cap ($0.00 of $0.00 this month) — raise it on "
        "the Agents page"
    )

    # A ledger that cannot be read: NOT a refusal, and never quiet.
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    problem, facts = await agents.cap_problem(app, pool, agent)
    assert problem is None
    assert facts["ledger"].startswith("unreadable: could not reach the gateway")
    assert facts["spent_usd"] is None and facts["cap_usd"] == 20.0

    # No cap: the ledger is not even read.
    assert await agents.cap_problem(app, pool, _agent(monthly_cap_usd=None)) == (
        None,
        {"role": "agent_coder", "cap_usd": None, "ledger": "skipped"},
    )


def test_money_matches_the_spend_page():
    assert agents.money(Decimal("20")) == "$20.00"
    assert agents.money(21.4) == "$21.40"
    assert agents.money(0.0005) == "$0.0005"
    assert agents.money(0) == "$0.00"


# ── the phantom-person guard ───────────────────────────────────────────────


def test_refuse_person_write_refuses_an_agent_and_not_the_owner(tmp_path):
    agent_ctx = ToolContext(app=None, person=_agent().person(), workspace_root=tmp_path)
    with pytest.raises(ToolFailure) as refused:
        agents.refuse_person_write(agent_ctx, "a timer")
    assert str(refused.value) == (
        "a timer belongs to a person and an agent is not one — put it in your report and "
        "Nova will do it"
    )
    owner_ctx = ToolContext(
        app=None,
        person=Person(id=uuid.uuid4(), name="jeremy", role="owner"),
        workspace_root=tmp_path,
    )
    agents.refuse_person_write(owner_ctx, "a timer")
    agents.refuse_person_write(ToolContext(app=None, person=None, workspace_root=tmp_path), "x")


# ── mentions and the roster ────────────────────────────────────────────────


async def test_mentioned_parses_a_leading_at_name_only(pool, mount_peers, root):
    await _owner(pool)
    mount_peers(gateway=_gateway())
    created = await _create(pool)
    assert (await agents.mentioned(pool, "@coder fix the build")) == created.agent
    assert (await agents.mentioned(pool, "  @coder, fix it")) == created.agent
    assert (await agents.mentioned(pool, "@coder")) == created.agent
    assert await agents.mentioned(pool, "email @coder about it") is None
    assert await agents.mentioned(pool, "@nobody fix it") is None
    assert await agents.mentioned(pool, "@coder1 fix it") is None
    assert await agents.mentioned(pool, "@Coder fix it") is None
    assert await agents.mentioned(pool, "") is None


async def test_roster_line_names_every_agent_and_is_none_when_empty(pool, mount_peers, root):
    await _owner(pool)
    mount_peers(gateway=_gateway())
    assert await agents.roster_line(pool) is None
    await _create(pool, _spec(name="reviewer", purpose="reviews\n  diffs", tools=("get_time",)))
    await _create(pool, _spec(tools=("workspace_read_file", "get_time")))
    await pool.execute(
        "UPDATE agents SET tools = tools || '{vanished_tool}' WHERE name = 'reviewer'"
    )
    assert await agents.roster_line(pool) == (
        "Agents you can delegate to: coder — writes code (tools: workspace_read_file, get_time); "
        "reviewer — reviews diffs (tools: get_time)"
    )


async def test_roster_line_raises_when_the_table_cannot_be_read():
    """No fail-open here: a None would read as "no agents" in the prompt, a
    claim nobody checked. It raises through the real query path and chat
    records the failure on the turn."""

    class BrokenPool:
        async def fetch(self, *_args):
            raise asyncpg.PostgresConnectionError("connection lost")

    with pytest.raises(asyncpg.PostgresConnectionError, match="connection lost"):
        await agents.roster_line(BrokenPool())


# ── import discipline ──────────────────────────────────────────────────────


def test_importing_agents_never_imports_chat():
    """chat.py imports this module at its top; if agents imported chat (or
    the scheduler/timers that import chat) the app would die half-built the
    first time something imported agents first. Cold, in a subprocess."""
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, app.agents; print(sorted(m for m in sys.modules "
            "if m in {'app.chat', 'app.scheduler', 'app.timers'}))",
        ],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "[]"
