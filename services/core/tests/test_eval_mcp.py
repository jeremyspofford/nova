"""Declared MCP servers in eval cases (S37a, plan decision P11): a case's
servers ARE her connections for its turn — the owner's never answer an eval
turn — and nothing the turn does reaches the table."""

from __future__ import annotations

import pytest

from app.evals import cases as cases_mod
from app.evals import runner
from app.evals.cases import Case, CaseError, FixtureMcpServer, FixtureMcpTool, PredicateSpec
from app.main import app
from app.mcp import client as mcp_client
from app.mcp import servers as mcp_servers
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import MODEL
from tests.test_chat_tools import text, whole_call

RUNS = FixtureMcpTool("actions_list", "List runs", results=({"text": "job frontend-unit failed"},))


def test_a_declared_server_must_carry_the_fixture_prefix():
    with pytest.raises(CaseError):
        FixtureMcpServer(name="github")


def test_a_declared_server_round_trips_through_a_case():
    raw = {
        "name": "eval_github",
        "title": "GitHub",
        "era": "legacy",
        "respond": "sse",
        "reachable": True,
        "listed": True,
        "url": None,
        "tools": [
            {
                "name": "actions_list",
                "description": "List runs",
                "inputSchema": {"type": "object", "properties": {}},
                "results": [{"text": "ok"}],
            }
        ],
    }
    case = cases_mod.case_from_dict(
        {
            "id": "m",
            "suite": "s",
            "suite_version": 1,
            "message": "m",
            "contract": [{"predicate": "tool_called", "arg": "mcp_call"}],
            "mcp_servers": [raw],
        }
    )
    [declared] = case.mcp_servers
    assert declared.endpoint_url == "http://eval-github.mcp.invalid/mcp"
    assert case.as_json()["mcp_servers"] == [raw]


def _case(*declared: FixtureMcpServer) -> Case:
    return Case(
        id="mcp-overlay",
        suite="s",
        suite_version=1,
        message="What failed on CI?",
        contract=(PredicateSpec("tool_succeeded_with", 'mcp_call {"server": "eval_github"}'),),
        mcp_servers=declared,
    )


@requires_db
async def test_a_case_sees_only_its_declared_servers_and_writes_nothing(pool, mount_peers):
    await pool.execute(
        "INSERT INTO mcp_servers (name, url, added_by) "
        "VALUES ('github', 'https://real.invalid/mcp', 'owner')"
    )
    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "c1",
                    "mcp_call",
                    {"server": "eval_github", "tool": "actions_list", "arguments": {}},
                ),
            ),
            (text("The frontend-unit job failed."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    run = await runner.run_case(
        app, pool, _case(FixtureMcpServer(name="eval_github", title="GitHub", tools=(RUNS,))), MODEL
    )
    assert run.passed is True, run.detail
    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "eval_github (GitHub): actions_list" in volatile
    assert "github: no tools listed" not in volatile
    assert await pool.fetchval("SELECT count(*) FROM mcp_servers") == 1
    assert mcp_servers.OVERLAY.get() is None
    assert not (mcp_client.TRANSPORTS.get() or {})


@requires_db
async def test_a_declared_unreachable_server_fails_in_words(pool, mount_peers):
    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "c1",
                    "mcp_call",
                    {"server": "eval_github", "tool": "actions_list", "arguments": {}},
                ),
            ),
            (text("I could not reach GitHub."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        FixtureMcpServer(name="eval_github", title="GitHub", reachable=False, tools=(RUNS,))
    )
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is False  # the call failed, so tool_succeeded_with cannot hold
    [span] = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'tool' AND name = 'mcp_call'",
        run.turn_id,
    )
    assert span["meta"]["ok"] is False and "could not reach eval_github" in span["meta"]["error"]
    assert span["meta"]["facts"][0]["reachable"] is False
