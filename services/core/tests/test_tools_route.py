"""Her route_explain: the gateway's walk, in words (S10-2)."""

from __future__ import annotations

from urllib.parse import parse_qs

import pytest

from app import settings_store
from app.main import app
from app.tools import route
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

FALLBACK = (
    "fell back to link 2 (ollama:qwen3:8b) — openrouter:gpt-x: "
    "openrouter over its monthly cap $10.00 (spent $10.20)"
)
EXPLAIN = {
    "role": "chat",
    "chain": [
        {
            "link": 1,
            "id": "openrouter:gpt-x",
            "verdict": "over_cap",
            "reason": "openrouter over its monthly cap $10.00 (spent $10.20)",
        },
        {"link": 2, "id": "ollama:qwen3:8b", "verdict": "runnable", "reason": None},
    ],
    "would_serve": {
        "role": "chat",
        "link": 2,
        "reason": FALLBACK,
        "served_by": "ollama:qwen3:8b",
        "standby": False,
    },
    "reason": FALLBACK,
}


def test_describe_reads_every_link_and_quotes_the_gateways_reason():
    text = route.describe(EXPLAIN)
    # The answer first: a small model reads the top line and stops.
    assert text.splitlines()[0] == (
        "Answer: ollama:qwen3:8b serves the chat role right now because it " + FALLBACK + "."
    )
    assert text.splitlines()[1] == "The chat chain, link by link:"
    assert (
        "1. openrouter:gpt-x: skipped — over its cap "
        "(openrouter over its monthly cap $10.00 (spent $10.20))" in text
    )
    assert "2. ollama:qwen3:8b: would serve" in text
    assert route.describe(
        {"role": "judge", "chain": [], "would_serve": None, "reason": "no chain"}
    ).startswith("Answer: nothing can serve the judge role right now — no chain.")


async def test_the_tool_asks_the_gateway_with_the_role_and_model(pool, mount_peers, tmp_path):
    gateway = FakeGateway(explain_body=EXPLAIN)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    text = await route.route_explain({"role": "chat", "model": "openrouter:gpt-x"}, ctx)
    assert "Answer: ollama:qwen3:8b serves the chat role" in text
    assert gateway.queries[-1] == b"role=chat&model=openrouter%3Agpt-x"
    # No model named for chat: the tool reads chat.model itself — link 1 is
    # the owner's pick, never left for her to remember.
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', '\"openrouter:gpt-y\"'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    await route.route_explain({"role": "chat"}, ctx)
    assert gateway.queries[-1] == b"role=chat&model=openrouter%3Agpt-y"
    # S12-2: roles are the gateway's one rule (built-ins plus an agent's
    # `agent_<name>`); the tool keeps no list of its own and quotes the 400.
    refusing = FakeGateway(
        admin_status=400,
        admin_body={
            "error": (
                "role must be a built-in (chat, scheduled, judge, decisions, coding, "
                "vision) or a lowercase [a-z_] name of at most 32 chars — got 'Vibes-1'"
            )
        },
    )
    mount_peers(gateway=refusing)
    try:
        await route.route_explain({"role": "Vibes-1"}, ctx)
    except ToolFailure as exc:
        assert "the routing check was refused — role must be a built-in" in str(exc)
    else:
        raise AssertionError("a role the gateway refuses must be refused in its words")


def test_a_machine_switched_off_is_said_in_words():
    body = {
        "role": "chat",
        "chain": [
            {
                "link": 1,
                "id": "hub:qwen3.8:27b",
                "verdict": "switched_off",
                "reason": "hub is switched off for models",
            },
            {"link": 2, "id": "openrouter:gpt-x", "verdict": "runnable", "reason": None},
        ],
        "would_serve": {"served_by": "openrouter:gpt-x", "reason": "fell back to link 2"},
        "reason": "fell back to link 2",
    }
    text = route.describe(body)
    assert (
        "1. hub:qwen3.8:27b: skipped — its machine is switched off for models "
        "(hub is switched off for models)"
    ) in text
    unreachable = {**body, "chain": [{**body["chain"][0], "verdict": "unreachable"}]}
    said = route.describe(unreachable)
    assert "skipped — its machine did not answer" in said
    assert "ollama" not in said  # the builtin is `hub` now; no engine is named by its adapter


def test_a_link_that_cannot_answer_its_role_is_said_in_words():
    body = {
        "role": "decisions",
        "chain": [
            {
                "link": 1,
                "id": "hub:qwen3:8b",
                "verdict": "wrong_protocol",
                "reason": "hub answers chat — this role needs typed questions",
            }
        ],
        "would_serve": None,
        "reason": "no model in the 'decisions' chain can serve right now",
    }

    text = route.describe(body)

    assert text.startswith("Answer: nothing can serve the decisions role right now")
    assert (
        "  1. hub:qwen3:8b: skipped — it cannot answer this role (hub answers chat — "
        "this role needs typed questions)"
    ) in text


def test_her_routing_tool_names_the_decisions_role():
    (tool,) = [t for t in route.TOOLS if t.name == "route_explain"]
    assert "decisions" in tool.description
    assert "decisions" in tool.parameters["properties"]["role"]["description"]


async def test_every_role_whose_turns_send_chat_model_is_explained_with_it_as_link_one(
    pool, mount_peers, tmp_path
):
    """Scheduled and beat turns send chat.model as link 1, exactly as chat's
    do, so their walk is explained with it. A role whose turns send no model —
    the judge, the decision role, an agent — is explained with none (the
    decision role is explained with his two switches instead, below)."""
    gateway = FakeGateway(explain_body=EXPLAIN)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', '\"openrouter:gpt-y\"'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )

    for role in ("scheduled", "beat"):
        await route.route_explain({"role": role}, ctx)
        assert gateway.queries[-1] == f"role={role}&model=openrouter%3Agpt-y".encode()
    for role in ("judge", "agent_coder"):
        await route.route_explain({"role": role}, ctx)
        assert gateway.queries[-1] == f"role={role}".encode()
    await route.route_explain({"role": "decisions"}, ctx)
    assert gateway.queries[-1] == b"role=decisions&decision_kinds=cloud"


# -- the decision role's two switches (decision-role spec §6) ----------------

LOCAL_OFF = "local decision models are switched off in Settings (alpha)"
CLOUD_OFF = "cloud decision models are switched off in Settings (beta)"


async def test_the_decisions_walk_is_explained_with_the_kinds_he_switched_on(
    pool, mount_peers, tmp_path
):
    """Her answer about the decision role follows his switches: read here, as a
    decision call reads them, never left for her to remember."""
    gateway = FakeGateway(explain_body=EXPLAIN)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    await route.route_explain({"role": "decisions"}, ctx)
    assert parse_qs(gateway.queries[-1].decode()) == {
        "role": ["decisions"],
        "decision_kinds": ["cloud"],
    }
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('decisions.local', 'true'::jsonb)"
    )
    await route.route_explain({"role": "decisions"}, ctx)
    assert parse_qs(gateway.queries[-1].decode())["decision_kinds"] == ["cloud,local"]


def test_a_link_whose_kind_is_switched_off_is_said_in_words():
    body = {
        "role": "decisions",
        "chain": [
            {
                "link": 1,
                "id": "dell-kev:kev-latest",
                "verdict": "kind_off",
                "reason": LOCAL_OFF,
                "local": True,
            },
            {"link": 2, "id": "openrouter:~typesafe/jev-latest", "verdict": "runnable"},
        ],
        "would_serve": {
            "served_by": "openrouter:~typesafe/jev-latest",
            "reason": f"fell back to link 2 (openrouter:~typesafe/jev-latest) — "
            f"dell-kev:kev-latest: {LOCAL_OFF}",
        },
        "reason": None,
    }

    text = route.describe(body, kinds=frozenset({"cloud"}))

    assert text.splitlines()[0].startswith(
        "Answer: openrouter:~typesafe/jev-latest serves the decisions role right now"
    )
    assert (
        "  1. dell-kev:kev-latest: skipped — the owner switched this kind of decision model "
        f"off ({LOCAL_OFF})"
    ) in text


async def test_with_both_switched_off_her_answer_says_the_step_is_off(pool, mount_peers, tmp_path):
    """The top line is what a small model reads: with both off, the decision
    step does not run at all, and her answer says that first — not merely that
    no link can serve."""
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('decisions.cloud', 'false'::jsonb)"
    )
    off = {
        "role": "decisions",
        "chain": [
            {"link": 1, "id": "dell-kev:kev-latest", "verdict": "kind_off", "reason": LOCAL_OFF},
            {
                "link": 2,
                "id": "openrouter:~typesafe/jev-latest",
                "verdict": "kind_off",
                "reason": CLOUD_OFF,
            },
        ],
        "would_serve": None,
        "reason": "no model in the 'decisions' chain can serve right now",
    }
    gateway = FakeGateway(explain_body=off)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    text = await route.route_explain({"role": "decisions"}, ctx)

    assert gateway.queries[-1] == b"role=decisions&decision_kinds="
    assert text.splitlines()[0] == (
        "Answer: the decision step is switched off — both decision models, local and cloud, "
        "are switched off in Settings, so no decision model is asked before a reply and it "
        "costs nothing."
    )
    assert (
        f"  2. openrouter:~typesafe/jev-latest: skipped — the owner switched this kind of "
        f"decision model off ({CLOUD_OFF})" in text
    )


async def test_switches_that_cannot_be_read_are_said_never_guessed(
    pool, mount_peers, tmp_path, monkeypatch
):
    """A walk explained without them would name a link he switched off as the
    one that answers — so a failed read is a stated failure, and the gateway
    is never asked."""

    async def unreadable(pool):
        raise ConnectionError("the settings table is locked")

    monkeypatch.setattr(settings_store, "decision_kinds", unreadable)
    gateway = FakeGateway(explain_body=EXPLAIN)
    mount_peers(gateway=gateway)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    with pytest.raises(ToolFailure) as caught:
        await route.route_explain({"role": "decisions"}, ctx)

    assert str(caught.value) == (
        "the decision switches in Settings could not be read, so the decisions walk cannot be "
        "explained — ConnectionError: the settings table is locked"
    )
    assert gateway.queries == []


# -- set_chat_model: her own pick (2026-10-05) ------------------------------------
# The owner asked her to change chat's order and she could not ("I can't edit
# the settings page myself — I only get to read the routing outcome"); the
# change was made for him by hand. Her tool is the same write every page makes.

GEMINI = "openrouter:google/gemini-3.8-flash"
DELL = "dell:qwen3:8b"


async def _chat_model_is(pool, value: str) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', to_jsonb($1::text)) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        value,
    )


async def test_set_chat_model_puts_the_model_first_and_keeps_the_old_pick(
    pool, mount_peers, tmp_path
):
    from tests.test_proxies import RoutesGateway

    gateway = RoutesGateway([])
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, GEMINI)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    text = await route.set_chat_model({"model": DELL}, ctx)

    assert (
        text.splitlines()[0]
        == f"Answer: chat now answers with {DELL} first — stored and read back."
    )
    assert f"Chat's order now: 1. {DELL}; 2. {GEMINI}." in text
    assert f"{GEMINI}, the previous pick, is now the first fallback." in text
    assert gateway.puts == [[GEMINI]]
    assert await settings_store.read_value(pool, "chat.model") == DELL


async def test_set_chat_model_says_when_nothing_moved(pool, mount_peers, tmp_path):
    from tests.test_proxies import RoutesGateway

    gateway = RoutesGateway([GEMINI])
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, DELL)
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    text = await route.set_chat_model({"model": DELL}, ctx)

    assert text.splitlines()[0] == f"Answer: {DELL} was already chat's first choice."
    assert f"Chat's order now: 1. {DELL}; 2. {GEMINI}." in text
    assert gateway.puts == []


async def test_set_chat_model_states_a_refusal_in_the_gateways_words(pool, mount_peers, tmp_path):
    from tests.test_proxies import GLM, RoutesGateway

    gateway = RoutesGateway([GEMINI], router_when_stated={"on": True, "kept": GLM})
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, "openrouter:typesafe/jev-router")
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    with pytest.raises(ToolFailure, match="Jev Router is picking chat's cloud model"):
        await route.set_chat_model({"model": DELL}, ctx)
    assert await settings_store.read_value(pool, "chat.model") == "openrouter:typesafe/jev-router"


async def test_set_chat_model_names_what_it_could_not_keep(pool, mount_peers, tmp_path):
    from tests.test_proxies import RoutesGateway

    gateway = RoutesGateway([GEMINI])
    mount_peers(gateway=gateway)
    await _chat_model_is(pool, "gone:old-model")
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)

    text = await route.set_chat_model({"model": DELL}, ctx)

    assert "Not kept: gone:old-model names no registered provider" in text
    assert "the previous pick" not in text


async def test_set_chat_model_needs_a_model(tmp_path):
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    with pytest.raises(ToolFailure, match="name the model"):
        await route.set_chat_model({"model": "  "}, ctx)


def test_set_chat_model_is_registered_as_a_write_that_is_kept():
    from app import tools

    tool = tools.REGISTRY["set_chat_model"]
    # It changes something, and the turn is ordinary knowledge: "use the Dell
    # first" is a preference worth remembering, not a stale snapshot.
    assert tool.reads_only is False and tool.ephemeral is False
    assert tool.parameters["required"] == ["model"]
