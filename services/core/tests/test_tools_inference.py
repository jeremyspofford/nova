"""`inference_health` — her own look at the card.

CLAUDE.md: infrastructure in git is mine, operating the running system is
hers. On 2026-09-12 a video game held ~7 GB of this machine's GPU for six
hours. Nova could not see that the card was contended, could not say why
her turn had failed beyond quoting the 300 s timeout, and could not tell
the owner what to close. These tests are about whether she can now.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import tools
from app.identity import Person
from app.main import app as core_app
from app.tools.base import ToolFailure
from tests.conftest import requires_db

pytestmark = requires_db

CARD = {
    "total_mb": 24576.0,
    "used_mb": 2662.0,
    "free_mb": 21914.0,
    "reason": None,
    "total_gb": 24.0,
    "used_gb": 2.6,
    "free_gb": 21.4,
    "resident": [],
    "resident_reason": None,
    "free_after_switch_gb": 21.4,
}


def _owner() -> Person:
    """A tool never picks its own owner; every route resolves one first."""
    return Person(id=uuid.uuid4(), name="jeremy", role="owner")


class _Gateway:
    """The one route this tool reads, as a local ASGI stand-in. `mount_peers`
    takes an object carrying `.app`, the same shape tests/fakes.py uses."""

    def __init__(self, body: dict, status: int = 200) -> None:
        async def vram(_request):
            return JSONResponse(body, status_code=status)

        self.app = Starlette(routes=[Route("/admin/vram", vram, methods=["GET"])])


@pytest.fixture
def ask(mount_peers, pool):
    """Call the tool through the real funnel, against a gateway that says
    exactly this about the card."""

    async def _ask(body: dict, status: int = 200) -> str:
        mount_peers(gateway=_Gateway(body, status))
        ctx = tools.context_for(core_app, _owner())
        return await tools.REGISTRY["inference_health"].executor({}, ctx)

    return _ask


async def _rounds(pool, *, model: str, rate: float, count: int, hours_ago: float) -> None:
    for _ in range(count):
        turn_id = uuid.uuid4()
        when = datetime.now(UTC) - timedelta(hours=hours_ago)
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, $2, 'ok', 'chat')",
            turn_id,
            when,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', $2, $3, 1000, $4)",
            turn_id,
            model,
            when,
            {"model": model, "tok_per_s": rate},
        )


async def _set_model(pool, model: str) -> None:
    # The pool's jsonb codec does the encoding — handing it a pre-quoted
    # string stores the quotes as part of the value, which is a fixture that
    # writes something the product never writes (memory:
    # fixture-stamps-what-the-product-does-not).
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', $1) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        model,
    )


async def test_an_idle_card_is_reported_in_its_own_numbers(ask):
    said = await ask(CARD)

    assert "21.4 GB free of 24.0 GB" in said
    assert "ollama has no model resident" in said


async def test_what_ollama_is_holding_is_named_with_its_size(ask):
    said = await ask(
        {
            **CARD,
            "used_mb": 20_000.0,
            "free_mb": 4576.0,
            "resident": [{"model": "qwen3.8:27b", "vram_mb": 17_817.6}],
            "free_after_switch_gb": 21.4,
        }
    )

    assert "qwen3.8:27b (17.4 GB)" in said
    # And the eviction fact, because "4.5 GB free" alone reads as "nothing
    # else fits" when in truth a switch gives almost the whole card back.
    assert "21.4 GB to work with" in said


async def test_a_consumer_that_is_not_ollama_is_named_as_exactly_that(ask):
    """THE 2026-09-12 CASE. The card is holding 7 GB that ollama did not
    put there. Under WSL2 this container cannot name the process — so it
    says that, rather than inventing an explanation or staying silent."""
    said = await ask(
        {
            **CARD,
            "used_mb": 2662.0 + 7168.0,
            "free_mb": 14746.0,
            "resident": [],
            "free_after_switch_gb": 14.4,
        }
    )

    assert "9.6 GB is held by something other than ollama" in said
    assert "cannot see which process" in said


async def test_the_other_usage_is_stated_flatly_without_an_opinion_about_it(ask):
    """The desktop always holds a couple of gigabytes, and a game holds
    seven. No threshold can tell those apart, and a guessed one would either
    cry wolf every hour or miss the case this exists for — so the number is
    stated plainly and the throughput line carries the alarm."""
    said = await ask({**CARD, "used_mb": 2662.0, "resident": []})

    assert "2.6 GB is held by something other than ollama" in said
    assert "worth checking" not in said


async def test_an_unreadable_card_says_the_drivers_own_words(ask):
    said = await ask(
        {
            "total_mb": None,
            "used_mb": None,
            "free_mb": None,
            "reason": "nvidia-smi could not be run — [Errno 2] No such file or directory",
            "resident": None,
            "resident_reason": None,
            "free_after_switch_gb": None,
        }
    )

    assert "The GPU could not be read" in said
    assert "No such file or directory" in said


async def test_a_card_that_reads_while_ollama_is_down_reports_both_facts(ask):
    """The halves degrade independently: the card is a driver read, the
    resident table is an ollama read, and one being gone says nothing about
    the other."""
    said = await ask(
        {
            **CARD,
            "resident": None,
            "resident_reason": "could not reach ollama's /api/ps — connection refused",
            "free_after_switch_gb": None,
        }
    )

    assert "21.4 GB free of 24.0 GB" in said
    assert "connection refused" in said


async def test_the_collapse_is_reported_against_this_machines_own_history(ask, pool):
    await _set_model(pool, "qwen3.8:27b")
    await _rounds(pool, model="qwen3.8:27b", rate=67.5, count=20, hours_ago=48)
    await _rounds(pool, model="qwen3.8:27b", rate=0.25, count=5, hours_ago=0.5)

    said = await ask(CARD)

    assert "generating at 0.25 tok/s" in said
    assert "its usual on this machine is 67.5 tok/s" in said
    assert "something is contending for the GPU" in said


async def test_a_normal_rate_is_stated_without_an_alarm(ask, pool):
    await _set_model(pool, "qwen3.8:27b")
    await _rounds(pool, model="qwen3.8:27b", rate=67.5, count=20, hours_ago=48)
    await _rounds(pool, model="qwen3.8:27b", rate=65.0, count=5, hours_ago=0.5)

    said = await ask(CARD)

    assert "generating at 65 tok/s" in said
    assert "contending" not in said


async def test_a_model_with_no_history_says_so_rather_than_inventing_a_normal(ask, pool):
    await _set_model(pool, "new:12b")
    await _rounds(pool, model="new:12b", rate=20.0, count=4, hours_ago=0.5)

    said = await ask(CARD)

    assert "There is no baseline to compare that against yet" in said


async def test_a_model_with_nothing_recent_says_it_is_not_measured_yet(ask, pool):
    await _set_model(pool, "qwen3.8:27b")
    await _rounds(pool, model="qwen3.8:27b", rate=67.5, count=20, hours_ago=48)

    said = await ask(CARD)

    assert "is not measured yet" in said


async def test_a_gateway_that_cannot_be_asked_is_a_stated_refusal(mount_peers, pool):
    """Not a guess about the card and not a silent empty. `Error: <reason>`
    is the shape every tool uses when a call CANNOT run — and the state
    guard reads a stated refusal as a fact she may repeat."""

    async def boom(_request):
        raise httpx.ConnectError("connection refused")

    dead = _Gateway({})
    dead.app = Starlette(routes=[Route("/admin/vram", boom, methods=["GET"])])
    mount_peers(gateway=dead)
    ctx = tools.context_for(core_app, _owner())

    with pytest.raises(ToolFailure) as exc:
        await tools.REGISTRY["inference_health"].executor({}, ctx)
    assert "could not be asked about the GPU" in str(exc.value)


def test_the_tool_changes_nothing_and_goes_stale():
    tool = tools.REGISTRY["inference_health"]
    assert tool.reads_only is True
    # A live, point-in-time reading. Ingesting "the card had 21 GB free" and
    # re-narrating it three weeks later as the present is the exact lie
    # `ephemeral` exists to prevent.
    assert tool.ephemeral is True
    assert tool.parameters["properties"] == {}


async def test_walled_rounds_are_said_rather_than_reported_as_nothing_measured(ask, pool):
    """Walked 2026-09-14. Without this the tool said "not measured yet — 0
    rounds" on a machine where rounds had been running and dying: true about
    the median, and completely misleading about the machine."""
    await _set_model(pool, "qwen3.8:27b")
    for _ in range(2):
        turn_id = uuid.uuid4()
        await pool.execute(
            "INSERT INTO turns (id, started_at, status, kind) VALUES ($1, now(), 'error', 'chat')",
            turn_id,
        )
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
            "VALUES ($1, 'llm_call', 'qwen3.8:27b', now(), 300009, $2)",
            turn_id,
            {"model": "qwen3.8:27b", "timeout_phase": "read", "completion_chars": 0},
        )

    said = await ask({**CARD, "used_mb": 23927.0, "free_mb": 396.0})

    assert "produced nothing at all in 2 of its last 2 round(s)" in said
    assert "cannot currently serve this model" in said
    assert "not measured yet" not in said
