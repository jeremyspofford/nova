"""Her route_explain: the gateway's walk, in words (S10-2)."""

from __future__ import annotations

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
    try:
        await route.route_explain({"role": "vibes"}, ctx)
    except ToolFailure as exc:
        assert "role must be one of" in str(exc)
    else:
        raise AssertionError("a bad role must be refused")
