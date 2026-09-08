"""Her spend_report: every number with its basis in words (S10)."""

from __future__ import annotations

from app.main import app
from app.tools import spend
from app.tools.base import ToolContext, ToolFailure
from tests.conftest import requires_db
from tests.fakes import FakeGateway
from tests.test_spend_api import REPORT

pytestmark = requires_db


def test_describe_reads_every_number_out_with_its_basis():
    text = spend.describe(
        {
            **REPORT,
            "by_provider": [
                *REPORT["by_provider"],
                {
                    "provider": "ollama",
                    "local": True,
                    "usd": 0.0,
                    "calls": 9,
                    "unmetered": 0,
                    "refusals": 0,
                    "gpu_seconds": 12.0,
                    "month_usd": None,
                    "cap_usd": None,
                    "remaining_usd": None,
                },
            ],
            "by_model": [
                {
                    "key": "openrouter:openai/gpt-x",
                    "local": False,
                    "usd": 3.5,
                    "calls": 3,
                    "unmetered": 1,
                    "prompt_tokens": 1200,
                    "completion_tokens": 300,
                    "gpu_seconds": 0,
                },
                {
                    "key": "ollama:qwen3:8b",
                    "local": True,
                    "usd": 0.0,
                    "calls": 9,
                    "unmetered": 0,
                    "prompt_tokens": 900,
                    "completion_tokens": 400,
                    "gpu_seconds": 12.0,
                },
            ],
            "by_purpose": [
                {"key": "chat", "local": False, "usd": 3.0, "calls": 3},
                {"key": "judge", "local": False, "usd": 0.5, "calls": 1},
            ],
            "by_person": [
                {
                    "key": "x",
                    "person": {"name": "jeremy", "role": "owner"},
                    "local": False,
                    "usd": 3.5,
                    "calls": 4,
                }
            ],
            "unpriced": [{"provider": "openrouter", "model": "gpt-free", "calls": 1}],
        }
    )
    assert text.startswith(
        "Spend for month (2026-09-01 to 2026-09-08, America/Denver): $3.5000 across 4 calls; 0.2 GPU-minutes (local time, not money)."
    )
    assert "$3.5000 reported by the provider itself" in text
    assert "1 call(s) were unmetered" in text
    assert "Monthly total cap $20.00: spent $3.5000 this month." in text
    assert "- openrouter: $3.5000 over 3 calls, 1 unmetered; cap $10.00/month, $6.50 left" in text
    assert "- ollama: 9 calls, 0.2 GPU-minutes (local time, not money)" in text
    assert "- openrouter:openai/gpt-x: $3.5000, 3 calls, 1,200 in / 300 out" in text
    assert "By purpose: chat $3.0000 (3 calls); judge $0.5000 (1 calls)." in text
    assert "By person: jeremy $3.5000 (4 calls)." in text
    assert "Metered but unpriced" in text and "openrouter:gpt-free (1 calls)" in text


async def test_the_tool_reads_the_same_report_the_page_reads(pool, mount_peers, tmp_path):
    mount_peers(gateway=FakeGateway(spend_body={**REPORT, "by_person": []}))
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    text = await spend.spend_report({"window": "7d"}, ctx)
    assert text.startswith(
        "Spend for month (2026-09-01 to 2026-09-08, America/Denver): $3.5000 across 4 calls; "
        "0.2 GPU-minutes (local time, not money)."
    )
    try:
        await spend.spend_report({"window": "year"}, ctx)
    except ToolFailure as exc:
        assert "window must be one of" in str(exc)
    else:
        raise AssertionError("a bad window must be refused")


async def test_an_unreachable_gateway_is_a_stated_failure(pool, monkeypatch, tmp_path):
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "t")
    app.state.peer_transports = {}
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    try:
        await spend.spend_report({}, ctx)
    except ToolFailure as exc:
        assert "could not reach the gateway" in str(exc)
    else:
        raise AssertionError("must fail loudly")
