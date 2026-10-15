"""Her prompt advertises the component blocks from the committed catalog (S54a T12).

services/core/app/ui_blocks.json is written by the web registry's export
test (apps/web/src/components/ui-blocks/export.test.ts), so registering a
component puts it in her prompt by that fact alone: nothing here names a
block type.
"""

from __future__ import annotations

import json

import pytest

from app import chat, tools, ui_blocks

FIXTURE = {
    "limits": {"maxDepth": 4, "maxNodes": 40, "strings": {"short": 80, "long": 400}},
    "icons": ["arrow-right", "lightbulb"],
    "blocks": [
        {
            "type": "steps",
            "describe": "A numbered flow of steps.",
            "example": {"type": "steps", "items": [{"title": "Plan"}, {"title": "Build"}]},
            "schema": {"type": "object", "properties": {"type": {"const": "steps"}}},
        },
        {
            "type": "callout",
            "describe": "A note, warning or tip set apart from the prose.",
            "example": {"type": "callout", "kind": "tip", "text": "Start small."},
            "schema": {"type": "object", "properties": {"type": {"const": "callout"}}},
        },
    ],
}


@pytest.fixture(autouse=True)
def _fresh_cache():
    ui_blocks.load.cache_clear()
    yield
    ui_blocks.load.cache_clear()


def _use(monkeypatch, tmp_path, catalog: dict) -> None:
    path = tmp_path / "ui_blocks.json"
    path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setattr(ui_blocks, "PATH", path)
    ui_blocks.load.cache_clear()


def test_t12_c1_load_reads_the_committed_catalog():
    assert ui_blocks.PATH.name == "ui_blocks.json"
    assert ui_blocks.PATH.parent.name == "app"
    data = ui_blocks.load()
    assert data == json.loads(ui_blocks.PATH.read_text(encoding="utf-8"))
    assert data["blocks"], "the committed catalog lists no blocks"
    for b in data["blocks"]:
        assert {"type", "describe", "example", "schema"} <= set(b)


def test_t12_c2_catalog_names_every_type_with_its_describe_and_example(monkeypatch, tmp_path):
    _use(monkeypatch, tmp_path, FIXTURE)
    text = ui_blocks.catalog_prompt()
    for b in FIXTURE["blocks"]:
        assert b["type"] in text
        assert b["describe"] in text
        assert json.dumps(b["example"]) in text


def test_t12_c2b_the_real_catalog_names_every_committed_type():
    data = ui_blocks.load()
    assert data.get("blocks"), "the committed catalog lists no blocks"
    text = ui_blocks.catalog_prompt()
    for b in data["blocks"]:
        assert b["describe"] in text
        assert json.dumps(b["example"]) in text


def test_t12_c3_catalog_names_the_fence_the_icons_and_the_limits(monkeypatch, tmp_path):
    _use(monkeypatch, tmp_path, FIXTURE)
    text = ui_blocks.catalog_prompt()
    assert "```nova-ui" in text
    assert "one JSON object" in text
    for name in FIXTURE["icons"]:
        assert name in text
    lim = FIXTURE["limits"]
    assert f"nest at most {lim['maxDepth']} levels and {lim['maxNodes']} nodes" in text
    # Depth and node counts that are not substrings of each other, so a dropped
    # or changed depth limit cannot hide inside the node count.
    other = {**FIXTURE, "limits": {**lim, "maxDepth": 7, "maxNodes": 23}}
    _use(monkeypatch, tmp_path, other)
    text = ui_blocks.catalog_prompt()
    assert "nest at most 7 levels and 23 nodes" in text
    assert "4 levels" not in text and "40 nodes" not in text


def test_t12_c4_catalog_carries_the_use_guidance(monkeypatch, tmp_path):
    _use(monkeypatch, tmp_path, FIXTURE)
    text = ui_blocks.catalog_prompt()
    assert "never for a short answer" in text
    assert "at most 3" in text
    assert "understandable without" in text


def test_t12_c4b_catalog_asks_for_a_sentence_before_each_block(monkeypatch, tmp_path):
    # Spec section 4: a block is introduced by prose saying what it shows, so a
    # reader whose client cannot draw it still knows what the JSON was for.
    _use(monkeypatch, tmp_path, FIXTURE)
    assert "one sentence before each block" in ui_blocks.catalog_prompt()


def test_t12_c5_an_extra_type_in_the_file_changes_the_prompt_with_no_other_edit(
    monkeypatch, tmp_path
):
    _use(monkeypatch, tmp_path, FIXTURE)
    before_catalog = ui_blocks.catalog_prompt()
    before_prompt = chat.stable_system_prompt("m", tools.tool_names())
    extra = {
        "type": "zz_test_block",
        "describe": "A test-only block that never ships.",
        "example": {"type": "zz_test_block", "text": "hello"},
        "schema": {"type": "object", "properties": {"type": {"const": "zz_test_block"}}},
    }
    _use(monkeypatch, tmp_path, {**FIXTURE, "blocks": [*FIXTURE["blocks"], extra]})
    after_catalog = ui_blocks.catalog_prompt()
    after_prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert after_catalog != before_catalog
    assert extra["describe"] in after_prompt
    assert extra["describe"] not in before_prompt


def test_t12_c6_catalog_sits_immediately_before_answer_layout():
    catalog = ui_blocks.catalog_prompt()
    assert "nova-ui" in catalog
    prompt = chat.stable_system_prompt("m", tools.tool_names())
    assert prompt.endswith(catalog + chat.ANSWER_LAYOUT)
    with_agent = chat.stable_system_prompt("m", tools.tool_names(), agent_block="AGENT BLOCK")
    assert with_agent.endswith(catalog + chat.ANSWER_LAYOUT + "\n\nAGENT BLOCK")
