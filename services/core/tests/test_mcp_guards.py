"""The two MCP server claims (S37a): a denial of a connected server, and a
claim about one with no call to it this turn. Pure, precision-first and
append-only (said-not-done's shape); derived from the live server list.

The span names are mcp_server_denial and mcp_server_claim (ruling F16) — the
names Task 11's four eval cases already score with guard_absent. #90's rules
hold here too (ruling F5): a turn whose delegation may have run an agent is
left alone, an agent not given mcp_call may say it cannot reach a server, and
a call refused before its executor established nothing. The spans below are
shaped as chat records them: arguments through chat._span_arguments, the
facts tools/mcp.py files, and dispatch's reached_executor."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import chat, guards, tools
from app.evals import cases as cases_mod
from app.evals import runner
from app.main import app
from app.mcp import servers
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import (
    MODEL,
    _agent_turn,
    _create,
    _nova_turn,
    _owner,
    _parsed,
    _reply,
    _spans,
)
from tests.test_chat_tools import text, whole_call

GITHUB = guards.McpServerRef(name="github", words=("github",))
HA = guards.McpServerRef(name="homeassistant", words=("home assistant", "homeassistant"))
DENIED = "(github is connected: mcp_call can reach it.)"
NO_CALL = "(No call to github ran this turn.)"
NONE_SUCCEEDED = "(No call to github succeeded this turn.)"
NAMES = tools.tool_names()


def _span(name: str, ok: bool = True, **meta):
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, **meta})


def _mcp(
    server: str,
    ok: bool = True,
    reachable: bool = True,
    *,
    tool: str = "mcp_call",
    reached: bool = True,
    is_error: bool | None = None,
):
    """A span of one of her MCP tools, as chat records it: its arguments
    through the span writer, the fact the tool filed (tools/mcp.py's call
    shape), and dispatch's own reached_executor. A call refused before its
    executor filed no fact."""
    args = {"server": server, "tool": "actions_list", "arguments": {}}
    meta: dict = {
        "args_redacted": chat._span_arguments(args, tool),
        "reached_executor": reached,
    }
    if reached:
        meta["facts"] = [
            {
                "mcp_server": server,
                "tool": "actions_list",
                "origin": f"http://{server}.mcp.invalid",
                "protocol": "2025-11-25",
                "reachable": reachable,
                "is_error": is_error,
                "bytes": 0 if is_error is None else 120,
            }
        ]
    if not ok:
        meta["error"] = f"Error: could not reach {server} — ConnectError"
    return _span(tool, ok=ok, **meta)


def _delegated(*, refused: bool = False):
    """A delegate_to_agent span: one that may have run an agent, or one
    refused before any run (agents.delegation_refused's fact)."""
    if refused:
        return _span("delegate_to_agent", ok=False, facts=[{"agent": "ops", "status": "refused"}])
    return _span("delegate_to_agent", ok=True, facts=[{"agent": "ops", "status": "done"}])


# -- the denial ----------------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "I don't have access to GitHub.",
        "I can't access your GitHub.",
        "I'm unable to connect to GitHub.",
        "GitHub isn't available to me.",
    ],
)
def test_a_denial_of_a_connected_server_is_corrected(reply):
    found = guards.server_denial_check(reply, [], [GITHUB])
    assert found is not None and found.server == "github"
    assert found.text == DENIED


@pytest.mark.parametrize(
    "reply",
    [
        "I can’t access your GitHub.",
        "I don’t have access to GitHub.",
        "I’m unable to connect to GitHub.",
        "GitHub isn’t available to me.",
    ],
)
def test_a_denial_with_a_curly_apostrophe_is_corrected_like_a_straight_one(reply):
    """Ruling F18: models write U+2019 as often as an apostrophe."""
    found = guards.server_denial_check(reply, [], [GITHUB])
    assert found is not None and found.text == DENIED


@pytest.mark.parametrize(
    "reply",
    [
        "I can't find that workflow on GitHub.",
        "I couldn't reach GitHub.",
        "Can you check GitHub?",
        "I might not be able to access GitHub.",
        "You can't access GitHub from there.",
        "I can't access GitLab.",
        "I can’t access GitLab.",
    ],
)
def test_what_is_not_a_denial_of_the_server_is_left_alone(reply):
    assert guards.server_denial_check(reply, [], [GITHUB]) is None


def test_a_present_state_denial_stands():
    assert guards.server_denial_check("I can't reach GitHub right now.", [], [GITHUB]) is None
    assert guards.server_denial_check("At the moment I can't reach GitHub.", [], [GITHUB]) is None
    reply = "I can’t access GitHub because the token was revoked."
    assert guards.server_denial_check(reply, [], [GITHUB]) is None


def test_a_denial_after_the_call_failed_this_turn_stands():
    failed = [_mcp("github", ok=False, reachable=False)]
    assert guards.server_denial_check("I can't reach GitHub.", failed, [GITHUB]) is None


def test_a_denial_after_the_server_answered_with_an_error_stands():
    """The tool's own isError (ruling T7-E) is a failed call on the span: "I
    can't access GitHub" beside "Resource not accessible" may well be true."""
    answered = [_mcp("github", ok=False, is_error=True)]
    assert guards.server_denial_check("I can't access GitHub.", answered, [GITHUB]) is None


def test_a_call_refused_before_its_executor_does_not_make_the_denial_true():
    """Ruling F5: a call dispatch refused (unreadable arguments, no such tool)
    reached nothing, so it says nothing about the server."""
    refused = [_mcp("github", ok=False, reached=False)]
    found = guards.server_denial_check("I can't reach GitHub.", refused, [GITHUB])
    assert found is not None and found.text == DENIED


def test_a_denial_of_a_server_whose_last_call_failed_stands():
    failing = guards.McpServerRef(name="github", words=("github",), failing=True)
    assert guards.server_denial_check("I can't access GitHub.", [], [failing]) is None


def test_nothing_connected_means_nothing_to_correct():
    assert guards.server_denial_check("I don't have access to GitHub.", [], []) is None
    assert guards.server_claim_check("GitHub shows the run failed.", [], []) is None


def test_a_server_is_named_by_any_of_its_words():
    """The words are the turn's derivation from the row (chat._mcp_server_refs):
    the connection name, its separators as spaces, and its title."""
    eval_github = guards.McpServerRef(
        name="eval_github", words=("eval github", "eval_github", "github")
    )
    found = guards.server_denial_check("I can't access GitHub.", [], [GITHUB, HA, eval_github])
    assert found is not None and found.server == "github"
    found = guards.server_denial_check("I can't reach Home Assistant.", [], [GITHUB, HA])
    assert (
        found is not None and found.text == "(homeassistant is connected: mcp_call can reach it.)"
    )
    found = guards.server_denial_check("I can't access GitHub.", [], [eval_github])
    assert found is not None and found.text == "(eval_github is connected: mcp_call can reach it.)"


# -- the claim -----------------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "I checked GitHub and the run failed.",
        "According to GitHub, the run failed.",
        "GitHub shows the last run failed.",
        "I've looked at GitHub: two runs failed.",
        "I’ve looked at GitHub: two runs failed.",
        "GitHub’s API says the run failed.",
    ],
)
def test_a_claim_with_no_call_to_the_server_is_corrected(reply):
    found = guards.server_claim_check(reply, [], [GITHUB])
    assert found is not None and found.server == "github"
    assert found.text == NO_CALL


def test_a_claim_backed_by_a_call_stands():
    reply = "GitHub shows the last run failed."
    assert guards.server_claim_check(reply, [_mcp("github")], [GITHUB]) is None
    assert guards.server_claim_check(reply, [_mcp("github", tool="mcp_tools")], [GITHUB]) is None


def test_a_claim_backed_by_the_servers_own_error_answer_stands():
    """The server ANSWERED (ruling T7-E: isError is the tool's answer, never
    a failing server), so "GitHub says that run does not exist" relays what
    it said — the span is ok=False only because dispatch reads a ToolFailure."""
    answered = [_mcp("github", ok=False, is_error=True)]
    reply = "GitHub says that run does not exist."
    assert guards.server_claim_check(reply, answered, [GITHUB]) is None


def test_a_claim_after_a_call_that_failed_says_none_succeeded():
    """A call ran, so "(No call to github ran this turn.)" would be the
    guard's own false sentence; the record says no call SUCCEEDED (#90's T3:
    the sentence says only what the record shows)."""
    failed = [_mcp("github", ok=False, reachable=False)]
    found = guards.server_claim_check("GitHub shows the last run passed.", failed, [GITHUB])
    assert found is not None and found.text == NONE_SUCCEEDED


def test_a_claim_after_a_call_refused_before_its_executor_says_none_ran():
    """Ruling F5: a refused call reached nothing — no call ran."""
    refused = [_mcp("github", ok=False, reached=False)]
    found = guards.server_claim_check("GitHub shows the last run passed.", refused, [GITHUB])
    assert found is not None and found.text == NO_CALL


def test_a_claim_backed_by_a_web_read_of_the_server_stands():
    fetched = _span(
        "fetch_url",
        args_redacted=chat._span_arguments(
            {"url": "https://github.com/jeremyspofford/nova/actions"}, "fetch_url"
        ),
    )
    assert (
        guards.server_claim_check("GitHub shows the last run failed.", [fetched], [GITHUB]) is None
    )


def test_a_call_to_one_server_does_not_back_a_claim_about_another():
    reply = "Home Assistant shows the porch light is on."
    found = guards.server_claim_check(reply, [_mcp("github")], [GITHUB, HA])
    assert found is not None and found.server == "homeassistant"
    assert found.text == "(No call to homeassistant ran this turn.)"


@pytest.mark.parametrize(
    "reply",
    [
        "Earlier I checked GitHub and it was green.",
        "Should I check GitHub?",
        "I haven't checked GitHub yet.",
        "You checked GitHub yesterday.",
        "I'll check GitHub next.",
        "I checked GitLab and the run failed.",
    ],
)
def test_a_recap_a_question_or_a_negation_is_left_alone(reply):
    assert guards.server_claim_check(reply, [], [GITHUB]) is None


# -- #90's rules (ruling F5) -----------------------------------------------------


def test_a_turn_whose_delegation_may_have_run_is_left_alone():
    """The agent's calls are on ITS turn: this turn's record cannot say what
    was read, so neither guard says anything about it."""
    spans = [_delegated()]
    assert guards.server_denial_check("I can't access GitHub.", spans, [GITHUB]) is None
    assert guards.server_claim_check("GitHub shows the run failed.", spans, [GITHUB]) is None


def test_a_delegation_refused_before_any_run_leaves_both_guards_on():
    spans = [_delegated(refused=True)]
    denial = guards.server_denial_check("I can't access GitHub.", spans, [GITHUB])
    claim = guards.server_claim_check("GitHub shows the run failed.", spans, [GITHUB])
    assert denial is not None and denial.text == DENIED
    assert claim is not None and claim.text == NO_CALL


# -- the sentences ---------------------------------------------------------------


def test_every_sentence_is_clean_under_the_whole_guard_family():
    """Backend text the turn appends must never itself trip a guard — the
    family's pinned property (said-not-done), the two server guards
    included."""
    for said in (DENIED, NO_CALL, NONE_SUCCEEDED):
        assert guards.server_denial_check(said, [], [GITHUB, HA]) is None, said
        assert guards.server_claim_check(said, [], [GITHUB, HA]) is None, said
        assert guards.written_call_check(said, [], NAMES) is None, said
        assert guards.device_completion_check(said, [], NAMES, ["DELL-XPS-8950"]) is None, said
        for instruction in ("", "is CI green on main?"):
            assert guards.deferral_check(said, [], NAMES, user_message=instruction) is None, said
        assert guards.bare_intent_check(said, []) is None, said
        assert guards.narration_check(said, []) is None, said
        assert guards.consent_claim_check(said) is None, said
        assert guards.capability_claim_check(said, NAMES) is None, said
        assert guards.state_claim_check(said, [], ["DELL-XPS-8950"], purpose="chat") is None, said
        assert guards.presented_listing_check(said, [], []) is None, said


def test_the_sentences_invite_nothing():
    for said in (DENIED, NO_CALL, NONE_SUCCEEDED):
        lowered = said.lower()
        for invitation in ("ask me", "again", "i'll", "want", "?", "please"):
            assert invitation not in lowered, (invitation, said)


# -- the turn ------------------------------------------------------------------


async def _connect(pool, name: str = "github", title: str = "GitHub") -> None:
    tools_ = [{"name": "actions_list", "description": "", "inputSchema": {}, "annotations": {}}]
    await pool.execute(
        "INSERT INTO mcp_servers (name, url, added_by, title, tools, tools_hash) "
        "VALUES ($1, $2, 'owner', $3, $4, $5)",
        name,
        f"http://{name}.mcp.invalid/mcp",
        title,
        tools_,
        servers.tools_hash(tools_),
    )


def _corrections(frames: list) -> list[str]:
    return [f["correction"] for f in _parsed(frames) if isinstance(f, dict) and "correction" in f]


async def _guard_spans(pool, turn_id) -> list:
    return [s for s in await _spans(pool, turn_id) if s["kind"] == "guard"]


@requires_db
async def test_a_turn_that_disowns_a_connected_server_gets_one_sentence(pool, mount_peers):
    owner = await _owner(pool)
    await _connect(pool)
    memory = FakeMemory()
    said = "I don't have access to GitHub."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=memory)

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    assert await _reply(pool, turn.id) == f"{said}\n\n{DENIED}"
    assert _corrections(frames) == [DENIED]
    [guard] = await _guard_spans(pool, turn.id)
    assert guard["name"] == "mcp_server_denial"
    assert guard["meta"] == {
        "detected": True,
        "server": "github",
        "phrase": said,
        "sentence": DENIED,
    }
    await chat.drain_background()
    assert memory.ingests == []  # a corrected turn is plumbing, never knowledge


@requires_db
async def test_a_turn_that_claims_a_reading_it_never_made_gets_one_sentence(pool, mount_peers):
    owner = await _owner(pool)
    await _connect(pool)
    memory = FakeMemory()
    said = "GitHub shows the last run on main failed."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=memory)

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    assert await _reply(pool, turn.id) == f"{said}\n\n{NO_CALL}"
    assert _corrections(frames) == [NO_CALL]
    [guard] = await _guard_spans(pool, turn.id)
    assert guard["name"] == "mcp_server_claim"
    assert guard["meta"] == {
        "detected": True,
        "server": "github",
        "phrase": "GitHub shows",
        "sentence": NO_CALL,
    }
    await chat.drain_background()
    assert memory.ingests == []


@requires_db
async def test_with_nothing_connected_the_same_words_are_left_alone(pool, mount_peers):
    owner = await _owner(pool)
    memory = FakeMemory()
    said = "I don't have access to GitHub. GitHub shows the last run on main failed."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=memory)

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    assert await _reply(pool, turn.id) == said
    assert _corrections(frames) == []
    assert await _guard_spans(pool, turn.id) == []
    await chat.drain_background()
    assert len(memory.ingests) == 1


@requires_db
async def test_an_agent_not_given_mcp_call_may_say_it_cannot_reach_a_server(
    pool, mount_peers, monkeypatch, tmp_path
):
    """Ruling F5, the capability guard's persona rule: an agent given no
    mcp_call truly cannot reach GitHub, so its denial is left alone — and the
    same words from Nova, who holds mcp_call, are corrected."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    owner = await _owner(pool)
    await _connect(pool)
    agent = await _create(pool, mount_peers)  # get_time and workspace_read_file only
    assert "mcp_call" not in agent.tools
    said = "I don't have access to GitHub."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "is CI green on main?")

    assert await _guard_spans(pool, turn.id) == []
    assert await _reply(pool, turn.id) == said
    assert _corrections(frames) == []

    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=FakeMemory())
    nova_turn, _ = await _nova_turn(pool, owner, "is CI green on main?")
    assert [s["name"] for s in await _guard_spans(pool, nova_turn.id)] == ["mcp_server_denial"]


@requires_db
@pytest.mark.parametrize("guard", ["server_denial_check", "server_claim_check"])
async def test_a_server_guard_that_raises_fails_open(guard, pool, mount_peers, monkeypatch):
    """Each on its own: a guard that raises appends nothing and files nothing,
    and the other still says its one thing."""

    def boom(*_args, **_kwargs):
        raise RuntimeError("detector blew up")

    monkeypatch.setattr(chat.guards, guard, boom)
    owner = await _owner(pool)
    await _connect(pool)
    said = "I don't have access to GitHub. GitHub shows the last run on main failed."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=FakeMemory())

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    left = NO_CALL if guard == "server_denial_check" else DENIED
    assert await _reply(pool, turn.id) == f"{said}\n\n{left}"
    assert _corrections(frames) == [left]
    assert len(await _guard_spans(pool, turn.id)) == 1


@requires_db
async def test_both_claims_in_one_reply_each_get_their_sentence_in_order(pool, mount_peers):
    owner = await _owner(pool)
    await _connect(pool)
    said = "I don't have access to GitHub. GitHub shows the last run on main failed."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=FakeMemory())

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    assert await _reply(pool, turn.id) == f"{said}\n\n{DENIED}\n\n{NO_CALL}"
    assert _corrections(frames) == [DENIED, NO_CALL]
    names = [s["name"] for s in await _guard_spans(pool, turn.id)]
    assert names == ["mcp_server_denial", "mcp_server_claim"]


@requires_db
async def test_a_server_list_that_cannot_be_read_keeps_both_guards_silent(
    pool, mount_peers, monkeypatch, caplog
):
    """FAIL-OPEN to no servers: a store read that blips must never turn an
    honest reply into a false correction."""
    owner = await _owner(pool)
    await _connect(pool)

    async def blip(_pool):
        raise RuntimeError("the store blipped")

    monkeypatch.setattr(servers, "list_servers", blip)
    said = "I don't have access to GitHub. GitHub shows the last run on main failed."
    mount_peers(gateway=ScriptedGateway(rounds=((text(said),),)), memory=FakeMemory())

    turn, frames = await _nova_turn(pool, owner, "is CI green on main?")

    assert await _reply(pool, turn.id) == said
    assert _corrections(frames) == []
    assert await _guard_spans(pool, turn.id) == []
    assert "mcp server list failed" in caplog.text


@requires_db
async def test_the_refs_are_derived_from_the_rows(pool):
    """The connection name, its separators as spaces, a title up to 40
    characters, and the row's own failing() — read from the table."""
    await _connect(pool, name="home-assistant", title="Home Assistant")
    await _connect(pool, name="gh", title="GitHub")
    await _connect(
        pool, name="big", title="A title much longer than forty characters, never a name"
    )
    row = await servers.get(pool, "gh")
    await servers.record_call(pool, row, ok=False, reason="could not reach gh — ConnectError")

    refs = {ref.name: ref for ref in await chat._mcp_server_refs(pool)}

    assert refs["home-assistant"] == guards.McpServerRef(
        name="home-assistant", words=("home assistant", "home-assistant"), failing=False
    )
    assert refs["gh"] == guards.McpServerRef(name="gh", words=("github",), failing=True)
    assert refs["big"].words == ("big",)


@requires_db
async def test_the_eval_cases_guard_half_now_bites(pool, mount_peers):
    """Task 11's does-not-disown-a-connected-server scores guard_absent
    ('mcp_server_denial'), vacuous until now. Armed, a reply that disowns the
    case's declared server fails that half — the overlay is the server list
    the guard reads, and the case file is unchanged — while a reply that used
    the server and attributes its answer to GitHub passes the whole case."""
    [case] = [c for c in cases_mod.load_cases() if c.id == "does-not-disown-a-connected-server"]
    disowned = ScriptedGateway(rounds=((text("I don't have access to GitHub."),),))
    mount_peers(gateway=disowned, memory=FakeMemory())

    run = await runner.run_case(app, pool, case, MODEL)

    verdicts = {result["predicate"]: result["passed"] for result in run.detail["predicates"]}
    assert verdicts["guard_absent"] is False
    [guard] = await _guard_spans(pool, run.turn_id)
    assert guard["name"] == "mcp_server_denial"
    assert guard["meta"]["server"] == "eval_github"

    listing = {"method": "list_workflows", "owner": "jeremyspofford", "repo": "nova"}
    used = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "c1",
                    "mcp_call",
                    {"server": "eval_github", "tool": "actions_list", "arguments": listing},
                ),
            ),
            (
                text(
                    "GitHub lists two workflows for jeremyspofford/nova: rebuild-ci and "
                    "nightly-backup-drill."
                ),
            ),
        )
    )
    mount_peers(gateway=used, memory=FakeMemory())

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    assert await _guard_spans(pool, run.turn_id) == []
