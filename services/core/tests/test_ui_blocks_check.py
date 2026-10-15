"""Core checks her component blocks and records the result on the turn (S54a T13).

ui_blocks.check(reply) validates each closed ```nova-ui fence against the JSON
Schema the web registry exported into app/ui_blocks.json, plus the exported
limits, and the main persist boundary files it as a `ui_blocks` span. It never
rewrites the reply: the browser's fallback keeps a bad block readable; the
trace is how the validity rate is known (read-the-trace).
"""

from __future__ import annotations

import json

import pytest

from app import chat, markup_calls, ui_blocks
from app.main import app  # noqa: F401  (the app the owner_client fixture serves)
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

STEPS = {"type": "steps", "items": [{"title": "Plan"}, {"title": "Build"}]}


@pytest.fixture(autouse=True)
def _fresh_cache():
    ui_blocks.load.cache_clear()
    yield
    ui_blocks.load.cache_clear()


def fence(body: object) -> str:
    text = body if isinstance(body, str) else json.dumps(body)
    return f"```nova-ui\n{text}\n```"


def reply(*fences: str) -> str:
    parts = ["Here is the answer."]
    for f in fences:
        parts += ["This shows it.", f]
    return "\n\n".join(parts)


def stack(depth: int) -> dict:
    node: dict = {"type": "text", "text": "leaf"}
    for _ in range(depth - 1):
        node = {"type": "stack", "children": [node]}
    return node


def wide(nodes: int) -> dict:
    return {"type": "stack", "children": [{"type": "text", "text": "x"}] * (nodes - 1)}


def test_t13_c1_check_counts_a_valid_block_and_names_its_type():
    result = ui_blocks.check(reply(fence(STEPS)))
    assert set(result) == {"ui_blocks", "invalid", "first_error", "types"}
    assert result == {"ui_blocks": 1, "invalid": 0, "first_error": None, "types": ["steps"]}


def test_t13_c1_a_reply_without_fences_counts_nothing_and_types_follow_reply_order():
    assert ui_blocks.check("Just prose, no block.")["ui_blocks"] == 0
    callout = {"type": "callout", "kind": "tip", "text": "Start small."}
    result = ui_blocks.check(reply(fence(callout), fence(STEPS)))
    assert result["types"] == ["callout", "steps"]


def test_t13_c2_every_committed_example_validates():
    blocks = ui_blocks.load()["blocks"]
    assert blocks
    result = ui_blocks.check(reply(*(fence(b["example"]) for b in blocks)))
    assert result["ui_blocks"] == len(blocks)
    assert result["invalid"] == 0, result["first_error"]
    assert result["types"] == [b["type"] for b in blocks]


@pytest.mark.parametrize(
    "body,mentions",
    [
        ('{"type": "steps", "items": [', "json"),
        ("[1, 2, 3]", "object"),
        ({"items": [{"title": "Plan"}]}, "type"),
        ({"type": "carousel", "items": []}, "carousel"),
        ({"type": "steps", "items": [{"title": "Plan"}], "style": "x"}, "style"),
        ({"type": "card", "tone": "#23354D", "children": [{"type": "text", "text": "x"}]}, "tone"),
    ],
)
def test_t13_c3_an_invalid_block_is_counted_with_a_one_line_error(body, mentions):
    result = ui_blocks.check(reply(fence(body)))
    assert result["ui_blocks"] == 1
    assert result["invalid"] == 1
    assert result["types"] == []
    error = result["first_error"]
    assert isinstance(error, str) and error.strip()
    assert "\n" not in error
    assert mentions in error.lower()


def test_t13_c3_first_error_is_the_first_failure_and_every_fence_counts():
    result = ui_blocks.check(
        reply(fence(STEPS), fence({"type": "carousel"}), fence("not json"), fence(STEPS))
    )
    assert result["ui_blocks"] == 4
    assert result["invalid"] == 2
    assert "carousel" in result["first_error"]
    assert result["types"] == ["steps", "steps"]


def test_t13_c4_depth_and_node_limits_are_checked():
    limits = ui_blocks.load()["limits"]
    ok = ui_blocks.check(reply(fence(stack(limits["maxDepth"]))))
    assert ok["invalid"] == 0, ok["first_error"]
    deep = ui_blocks.check(reply(fence(stack(limits["maxDepth"] + 1))))
    assert deep["invalid"] == 1 and "depth" in deep["first_error"].lower()
    many = ui_blocks.check(reply(fence(wide(limits["maxNodes"] + 1))))
    assert many["invalid"] == 1 and "nodes" in many["first_error"].lower()


def test_t13_c4_limits_are_read_from_the_catalog_not_hardcoded(monkeypatch, tmp_path):
    catalog = ui_blocks.load()
    lowered = {**catalog, "limits": {**catalog["limits"], "maxDepth": 2}}
    path = tmp_path / "ui_blocks.json"
    path.write_text(json.dumps(lowered), encoding="utf-8")
    monkeypatch.setattr(ui_blocks, "PATH", path)
    ui_blocks.load.cache_clear()
    assert ui_blocks.check(reply(fence(stack(2))))["invalid"] == 0
    result = ui_blocks.check(reply(fence(stack(3))))
    assert result["invalid"] == 1 and "depth" in result["first_error"].lower()


def test_t13_c5_an_unclosed_fence_and_other_languages_are_not_counted():
    tail = reply(fence(STEPS)) + '\n\n```nova-ui\n{"type": "steps", "items": ['
    assert ui_blocks.check(tail) == {
        "ui_blocks": 1,
        "invalid": 0,
        "first_error": None,
        "types": ["steps"],
    }
    others = reply(f"```json\n{json.dumps(STEPS)}\n```", "```python\nprint(1)\n```", fence(STEPS))
    assert ui_blocks.check(others)["ui_blocks"] == 1


def test_t13_c6_a_nova_ui_fence_survives_the_record_boundary_and_is_no_call():
    """Pin, not a code change: guards' fence rule reads every fence as quoted
    teaching, so a block is never stripped as tool-call markup."""
    text = reply(fence(STEPS), fence({"type": "callout", "kind": "note", "text": "Hi."}))
    assert chat.without_markup(text) == text
    assert markup_calls.parse_markup_tool_calls(text).found is False


async def _ui_spans(pool, turn_id) -> list:
    return list(
        await pool.fetch(
            "SELECT name, meta FROM turn_spans WHERE turn_id = $1 AND kind = 'ui_blocks'",
            turn_id,
        )
    )


async def _turn(owner_client, pool, mount_peers, text: str):
    mount_peers(gateway=FakeGateway(deltas=(text,)), memory=FakeMemory())
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"}
    )
    assert resp.status_code == 200
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "how do I build one?"})
    assert resp.status_code == 200
    return await pool.fetchrow("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")


@requires_db
async def test_t13_c7_the_persisted_reply_files_a_ui_blocks_span(owner_client, pool, mount_peers):
    text = reply(fence(STEPS), fence({"type": "carousel"}))
    turn = await _turn(owner_client, pool, mount_peers, text)
    rows = await _ui_spans(pool, turn["id"])
    assert len(rows) == 1, "no ui_blocks span was filed at the persist boundary"
    [row] = rows
    meta = json.loads(row["meta"]) if isinstance(row["meta"], str) else row["meta"]
    assert meta["ui_blocks"] == 2
    assert meta["invalid"] == 1
    assert "carousel" in meta["first_error"]
    assert meta["types"] == ["steps"]


@requires_db
async def test_t13_c7_a_plain_reply_still_files_the_span_with_zero(owner_client, pool, mount_peers):
    turn = await _turn(owner_client, pool, mount_peers, "Paris.")
    rows = await _ui_spans(pool, turn["id"])
    assert len(rows) == 1, "no ui_blocks span was filed at the persist boundary"
    [row] = rows
    meta = json.loads(row["meta"]) if isinstance(row["meta"], str) else row["meta"]
    assert {k: meta[k] for k in ("ui_blocks", "invalid", "first_error", "types")} == {
        "ui_blocks": 0,
        "invalid": 0,
        "first_error": None,
        "types": [],
    }


# -- G7 GREEN coverage: the span records facts only (spec §4) ---------------


def test_t13_c5b_a_nova_ui_line_quoted_inside_another_fence_is_not_a_block():
    """Every fence is tracked, not only nova-ui ones: a ```nova-ui example
    quoted in a ````markdown fence is that fence's text, as the browser shows."""
    quoted = f"````markdown\n{fence(STEPS)}\n````"
    assert ui_blocks.check(reply(quoted))["ui_blocks"] == 0
    tilde = f"~~~nova-ui\n{json.dumps(STEPS)}\n~~~"
    assert ui_blocks.check(reply(tilde))["types"] == ["steps"]


@requires_db
async def test_t13_c7b_the_span_never_rewrites_the_stored_reply(owner_client, pool, mount_peers):
    text = reply(fence(STEPS), fence({"type": "carousel"}))
    turn = await _turn(owner_client, pool, mount_peers, text)
    stored = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn["id"]
    )
    assert stored == text


@requires_db
async def test_t13_c7c_a_check_that_raises_never_blocks_the_reply(
    owner_client, pool, mount_peers, monkeypatch
):
    def boom(_reply):
        raise RuntimeError("catalog unreadable")

    monkeypatch.setattr(ui_blocks, "check", boom)
    turn = await _turn(owner_client, pool, mount_peers, "Paris.")
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn["id"]) == "ok"
    stored = await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn["id"]
    )
    assert stored == "Paris."
    [row] = await _ui_spans(pool, turn["id"])
    meta = json.loads(row["meta"]) if isinstance(row["meta"], str) else row["meta"]
    assert "catalog unreadable" in meta["error"]
    assert "invalid" not in meta
