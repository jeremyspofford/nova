"""Her browser in the eval world (S38): a case declares the fake engine at
http://browser:8931/mcp, listed nowhere, and her tools reach it there through
the same client and plant S37a's servers use."""

from __future__ import annotations

import httpx

from app.browser import engine as browser_engine
from app.evals import cases as cases_mod
from app.evals import runner
from app.evals.cases import Case, FixtureMcpServer, FixtureMcpTool, PredicateSpec
from app.main import app
from app.mcp import client as mcp_client
from app.mcp import fake as mcp_fake
from app.mcp import servers as mcp_servers
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import MODEL
from tests.test_chat_tools import text, whole_call

NAVIGATE = (
    "### Ran Playwright code\n```js\nawait page.goto('http://docs.example.invalid/start');\n```\n"
    "### Page\n- Page URL: http://docs.example.invalid/start\n- Page Title: Getting started"
)
SNAPSHOT = (
    "### Page\n- Page URL: http://docs.example.invalid/start\n- Page Title: Getting started\n"
    "### Snapshot\n```yaml\n- generic [active] [ref=e1]:\n"
    '  - heading "Getting started" [level=1] [ref=e2]\n'
    "  - list [ref=e3]:\n"
    '    - listitem [ref=e4]: "Step 1: install the hub agent with the code card."\n'
    '    - listitem [ref=e5]: "Step 2: pair the phone."\n```'
)


def _engine(**over) -> FixtureMcpServer:
    fields = dict(
        name="eval_browser_engine",
        title="Playwright",
        era="legacy",
        respond="sse",
        listed=False,
        url="http://browser:8931/mcp",
        tools=(
            FixtureMcpTool("browser_navigate", results=({"text": NAVIGATE},)),
            FixtureMcpTool("browser_snapshot", results=({"text": SNAPSHOT},)),
        ),
    )
    fields.update(over)
    return FixtureMcpServer(**fields)


def test_the_three_cases_declare_the_engine_listed_nowhere():
    by_id = {case.id: case for case in cases_mod.load_suite("agent_quality")}
    for case_id in (
        "reads-the-page-before-answering",
        "reports-what-a-click-changed",
        "reads-a-long-page-in-parts",
    ):
        [engine] = by_id[case_id].mcp_servers
        assert (engine.name, engine.era, engine.respond, engine.listed, engine.url) == (
            "eval_browser_engine",
            "legacy",
            "sse",
            False,
            "http://browser:8931/mcp",
        ), case_id


@requires_db
async def test_her_browser_reaches_the_declared_engine_and_nothing_is_written(pool, mount_peers):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "browser_open", {"url": "http://docs.example.invalid/start"}),),
            (whole_call("c2", "browser_read", {}),),
            (text("The first step is to install the hub agent with the code card."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="browser-overlay",
        suite="s",
        suite_version=1,
        message="What does the first step say on http://docs.example.invalid/start?",
        contract=(
            PredicateSpec("tool_succeeded", "browser_open"),
            PredicateSpec("tool_succeeded", "browser_read"),
            PredicateSpec("reply_matches", "hub agent"),
        ),
        mcp_servers=(_engine(),),
    )
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is True, run.detail
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "eval_browser_engine" not in volatile  # listed nowhere: not one of her connections
    assert await pool.fetchval("SELECT count(*) FROM mcp_servers") == 0
    assert not (mcp_client.TRANSPORTS.get() or {})
    [span] = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' "
        "AND name = 'browser_open'",
        run.turn_id,
    )
    assert span["meta"]["facts"][0] == {
        "browser": "page",
        "url": "http://docs.example.invalid/start",
        "title": "Getting started",
        "status": None,
    }


@requires_db
async def test_an_engine_that_is_down_fails_the_case_in_words(pool, mount_peers):
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "browser_open", {"url": "http://docs.example.invalid/start"}),),
            (text("My browser is not answering right now."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="browser-down",
        suite="s",
        suite_version=1,
        message="Open http://docs.example.invalid/start.",
        contract=(PredicateSpec("tool_succeeded", "browser_open"),),
        mcp_servers=(_engine(reachable=False),),
    )
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is False
    [span] = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' "
        "AND name = 'browser_open'",
        run.turn_id,
    )
    assert span["meta"]["ok"] is False
    assert "http://browser:8931" in span["meta"]["error"]


# ── ruling G5: no eval ever drives the real engine ──────────────────────────
#
# Her browser engine is never a declared MCP server — her tools call
# app.browser.engine directly, never mcp_call — so a case about something
# else entirely never declares it, and with no entry of its own at the
# engine's real origin, that address would otherwise be left free for the
# turn to actually reach. These two are plain, synchronous, no-DB checks of
# _install_fixture_mcp itself (never a full chat turn): a full-turn
# assertion on the error TEXT alone cannot tell "the plant refused the
# connection" apart from "this sandbox's own DNS has no host named
# `browser` either" — both raise the identical httpx.ConnectError, so the
# full-turn shape would read green before this ruling's code exists just as
# much as after it. Reading the planted transport directly is what actually
# proves the mechanism.


def test_a_case_with_no_declared_engine_still_gets_it_planted_unreachable():
    # message/contract are never read — this calls the installer directly,
    # never a turn — so they are inert placeholders; only mcp_servers (here,
    # absent) matters.
    case = Case(
        id="browser-undeclared",
        suite="s",
        suite_version=1,
        message="m",
        contract=(PredicateSpec("tool_called", "x"),),
    )
    overlay_token, plant_token = runner._install_fixture_mcp(case)
    try:
        planted = mcp_client.TRANSPORTS.get() or {}
        transport = planted[browser_engine.endpoint().origin].transport
        assert isinstance(transport, mcp_fake.Unreachable)
    finally:
        mcp_client.unplant(plant_token)
        mcp_servers.OVERLAY.reset(overlay_token)


def test_a_case_that_declares_the_engine_reachable_is_not_overridden_by_the_safety_net():
    # message/contract are inert placeholders here too (see above).
    case = Case(
        id="browser-declared",
        suite="s",
        suite_version=1,
        message="m",
        contract=(PredicateSpec("tool_called", "x"),),
        mcp_servers=(_engine(),),
    )
    overlay_token, plant_token = runner._install_fixture_mcp(case)
    try:
        planted = mcp_client.TRANSPORTS.get() or {}
        transport = planted[browser_engine.endpoint().origin].transport
        assert isinstance(transport, httpx.ASGITransport)
        # ruling G21: the real engine's own refusal shape, never the
        # generic 200 an unrelated legacy fake defaults to.
        assert transport.app.spec.legacy_refusal == "playwright"
    finally:
        mcp_client.unplant(plant_token)
        mcp_servers.OVERLAY.reset(overlay_token)
