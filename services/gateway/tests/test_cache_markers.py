"""S38c T8: Anthropic's moving cache breakpoint (T9, below: OpenRouter's
session_id and cache_control for Anthropic upstreams).

The direct Anthropic adapter already marks two stable prefixes (the first
system block, the last tool). A turn's rounds re-send the whole growing
conversation, so without a marker in `messages` every round pays full price
for every earlier round. The third marker sits on the last content block of
the LAST message and moves forward each round; the previous round's prefix
is then read from cache (Anthropic's documented multi-turn pattern).

Anthropic allows at most 4 `cache_control` breakpoints per request; this
adapter places at most 3 (system, tools, the moving one) and never passes a
caller's marker through.
"""

from __future__ import annotations

import copy
import json

import pytest

from app.adapters import anthropic_messages as adapter
from tests.conftest import requires_db
from tests.fakes import FakeAnthropic, FakeOpenAICompat

EPHEMERAL = {"type": "ephemeral"}
MAX_BREAKPOINTS = 4  # Anthropic's documented per-request ceiling

TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a workspace file",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
}


def _markers(request: dict) -> list[tuple[str, int, int | None]]:
    """Every cache_control in a translated request, by where it sits:
    ("system", i, None), ("tools", i, None), ("messages", m, block)."""
    found: list[tuple[str, int, int | None]] = []
    for i, block in enumerate(request.get("system") or []):
        if "cache_control" in block:
            found.append(("system", i, None))
    for i, tool in enumerate(request.get("tools") or []):
        if "cache_control" in tool:
            found.append(("tools", i, None))
    for m, message in enumerate(request["messages"]):
        content = message["content"]
        if isinstance(content, list):
            for b, block in enumerate(content):
                if "cache_control" in block:
                    found.append(("messages", m, b))
    # Nothing hides a marker anywhere else (e.g. on a message itself).
    assert json.dumps(request).count('"cache_control"') == len(found)
    return found


def _round_one() -> list[dict]:
    return [
        {"role": "system", "content": "You are Nova."},
        {"role": "system", "content": "recall: nothing"},
        {"role": "user", "content": "read a"},
    ]


def _round_two() -> list[dict]:
    return _round_one() + [
        {
            "role": "assistant",
            "content": "Looking.",
            "tool_calls": [
                {
                    "id": "toolu_a",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "a"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "toolu_a", "content": "A!"},
    ]


def _round_three() -> list[dict]:
    return _round_two() + [
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "toolu_b",
                    "type": "function",
                    "function": {"name": "read_file", "arguments": '{"path": "b"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "toolu_b", "content": "B!"},
        {"role": "user", "content": "and now?"},
    ]


def _translate(messages: list[dict], **extra) -> dict:
    return adapter.to_messages_request({"messages": messages, **extra}, "claude-opus-5").body


def _unmarked(message: dict) -> dict:
    """A message as the cache reads it: no cache_control key, and a string
    content as the one text block it is shorthand for."""
    content = message["content"]
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    return {
        **message,
        "content": [{k: v for k, v in block.items() if k != "cache_control"} for block in content],
    }


# ── C1: the moving breakpoint sits on the last block of the last message ──


def test_c1_a_string_user_message_last_becomes_one_marked_text_block():
    out = _translate(_round_one())
    assert out["messages"] == [
        {
            "role": "user",
            "content": [{"type": "text", "text": "read a", "cache_control": EPHEMERAL}],
        }
    ]


def test_c1_a_tool_result_last_carries_the_marker():
    out = _translate(_round_two())
    last = out["messages"][-1]
    assert last["role"] == "user"
    assert last["content"] == [
        {
            "type": "tool_result",
            "tool_use_id": "toolu_a",
            "content": "A!",
            "cache_control": EPHEMERAL,
        }
    ]


def test_c1_the_marker_is_on_the_last_block_of_a_merged_message_only():
    out = _translate(_round_three())
    last = out["messages"][-1]
    # The results and the user text that follows them are ONE user message;
    # only its LAST block carries the marker.
    assert [b["type"] for b in last["content"]] == ["tool_result", "text"]
    assert "cache_control" not in last["content"][0]
    assert last["content"][-1] == {"type": "text", "text": "and now?", "cache_control": EPHEMERAL}


def test_c1_an_assistant_tool_use_last_carries_the_marker():
    out = _translate(
        [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{"id": "t1", "function": {"name": "x", "arguments": "{}"}}],
            },
        ]
    )
    blocks = out["messages"][-1]["content"]
    assert [b["type"] for b in blocks] == ["text", "tool_use"]
    assert "cache_control" not in blocks[0]
    assert blocks[-1]["cache_control"] == EPHEMERAL


@pytest.mark.parametrize("build", [_round_one, _round_two, _round_three])
def test_c1_no_earlier_message_carries_a_marker(build):
    out = _translate(build())
    in_messages = [(m, b) for where, m, b in _markers(out) if where == "messages"]
    last = len(out["messages"]) - 1
    assert in_messages == [(last, len(out["messages"][last]["content"]) - 1)]


# ── C2: three breakpoints at most, never past Anthropic's four ────────────


def test_c2_system_tools_and_the_moving_marker_make_exactly_three():
    out = _translate(_round_three(), tools=[TOOL, {**TOOL, "function": {"name": "y"}}])
    markers = _markers(out)
    assert len(markers) == 3 <= MAX_BREAKPOINTS
    assert markers[0] == ("system", 0, None)  # the stable prompt, not the recall block
    assert markers[1] == ("tools", 1, None)  # the LAST tool
    assert markers[2][0] == "messages"


def test_c2_without_system_or_tools_only_the_moving_marker_is_placed():
    out = _translate([{"role": "user", "content": "hi"}])
    assert "system" not in out and "tools" not in out
    assert _markers(out) == [("messages", 0, 0)]


def test_c2_a_callers_cache_control_never_passes_through():
    out = _translate(
        [
            {
                "role": "system",
                "content": [{"type": "text", "text": "sys", "cache_control": EPHEMERAL}],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "one", "cache_control": EPHEMERAL},
                    {"type": "text", "text": "two", "cache_control": EPHEMERAL},
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "r", "cache_control": EPHEMERAL}],
            },
            {"role": "user", "content": [{"type": "text", "text": "q"}]},
        ],
        tools=[{**TOOL, "cache_control": EPHEMERAL}],
    )
    assert len(_markers(out)) == 3 <= MAX_BREAKPOINTS


# ── C3: earlier rounds stay byte-identical, so the cache can read them ────


@pytest.mark.parametrize(
    ("earlier", "later"), [(_round_one, _round_two), (_round_two, _round_three)]
)
def test_c3_the_next_round_keeps_every_earlier_block_identical(earlier, later):
    first = _translate(earlier(), tools=[TOOL])
    second = _translate(later(), tools=[TOOL])
    # The two stable prefixes do not move at all.
    assert second["system"] == first["system"]
    assert second["tools"] == first["tools"]
    n = len(first["messages"])
    assert len(second["messages"]) > n
    # Every message of the earlier round is in the later one unchanged, but
    # for the marker that moved off it (and the string shorthand).
    assert [_unmarked(m) for m in second["messages"][: n - 1]] == [
        _unmarked(m) for m in first["messages"][: n - 1]
    ]
    assert second["messages"][: n - 1] == first["messages"][: n - 1]
    # The earlier round's last message may have grown by merging (results
    # then user text); its earlier blocks are the earlier round's blocks.
    before = _unmarked(first["messages"][n - 1])["content"]
    after = _unmarked(second["messages"][n - 1])["content"]
    assert after[: len(before)] == before
    # The marker moved forward to the later round's last block.
    last = len(second["messages"]) - 1
    assert _markers(second)[-1] == ("messages", last, len(second["messages"][last]["content"]) - 1)


# ── C4: the caller's body is never written to ─────────────────────────────


def test_guard_translating_does_not_mutate_the_callers_body_or_an_earlier_translation():
    body = {"messages": _round_three(), "tools": [TOOL]}
    before = copy.deepcopy(body)
    first = adapter.to_messages_request(body, "m").body
    snapshot = copy.deepcopy(first)
    adapter.to_messages_request({"messages": _round_three() + [], "tools": [TOOL]}, "m")
    assert body == before
    assert first == snapshot


# ── C5: what Anthropic receives, through the real data plane ─────────────


@requires_db
@pytest.mark.parametrize("stream", [True, False])
async def test_c5_anthropic_receives_three_markers_the_last_on_the_last_block(
    client, pool, mount_backend, stream
):
    from tests.test_anthropic_adapter import _add_anthropic

    fake = FakeAnthropic(blocks=("ok",), input_tokens=10, output_tokens=2)
    await _add_anthropic(client, mount_backend, fake)
    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": _round_two(),
            "tools": [TOOL],
            "stream": stream,
        },
    )
    assert resp.status_code == 200, resp.text
    path, sent = fake.seen[-1]
    assert path == "/v1/messages"
    markers = _markers(sent)
    assert len(markers) == 3 <= MAX_BREAKPOINTS
    assert markers[-1] == ("messages", len(sent["messages"]) - 1, 0)
    assert sent["messages"][-1]["content"][0]["type"] == "tool_result"


# ══ S38c T9: OpenRouter — session_id, and cache_control for Anthropic ══════
#
# OpenRouter's prompt-caching guide (read 2026-10-14,
# https://openrouter.ai/docs/guides/best-practices/prompt-caching):
# "Include `session_id` as a top-level field in your request body" (at most
# 256 characters; with it, sticky routing starts on any successful request);
# Anthropic upstreams need explicit `cache_control: {"type": "ephemeral"}` on
# content blocks, "a limit of four explicit breakpoints". The gateway sends
# session_id = the turn id on every OpenRouter call, and on an Anthropic
# upstream marks the first system message's last part and the last message's
# last part — 2 of the 4.

OPENROUTER = "https://openrouter.ai/api/v1"
TURN = "0d5f7b2e-2b2c-4d0c-9c8e-8b3d6f1a2c3d"
CLAUDE = "anthropic/claude-sonnet-4.5"


def _hint(messages: list[dict], model: str = CLAUDE, base_url: str = OPENROUTER, **extra) -> dict:
    from app.adapters import openai_chat

    return openai_chat.cache_hints({"model": model, "messages": messages, **extra}, base_url, TURN)


def _parts(request: dict) -> list[tuple[str, int, int | None]]:
    """Every cache_control in an OpenAI-shaped request, by where it sits:
    ("messages", m, part), ("message", m, None) on a message itself,
    ("tools", i, None), ("top", 0, None) for the top-level field."""
    found: list[tuple[str, int, int | None]] = []
    if "cache_control" in request:
        found.append(("top", 0, None))
    for i, tool in enumerate(request.get("tools") or []):
        if "cache_control" in tool:
            found.append(("tools", i, None))
    for m, message in enumerate(request["messages"]):
        if "cache_control" in message:
            found.append(("message", m, None))
        content = message.get("content")
        if isinstance(content, list):
            for p, part in enumerate(content):
                if "cache_control" in part:
                    found.append(("messages", m, p))
    assert json.dumps(request).count('"cache_control"') == len(found)
    return found


def _plain(message: dict) -> dict:
    """A message without its markers, string content as its one text part."""
    content = message.get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if isinstance(content, list):
        content = [{k: v for k, v in p.items() if k != "cache_control"} for p in content]
    return {**{k: v for k, v in message.items() if k != "cache_control"}, "content": content}


# ── T9 C1: session_id = the turn id, on OpenRouter only ──────────────────


@pytest.mark.parametrize("model", [CLAUDE, "google/gemini-3.8-flash", "openrouter/auto", "x"])
def test_t9_c1_an_openrouter_call_carries_the_turn_as_session_id(model):
    out = _hint(_round_one(), model=model)
    assert out["session_id"] == TURN


@pytest.mark.parametrize("turn", [None, ""])
def test_t9_c1_no_turn_no_session_id(turn):
    from app.adapters import openai_chat

    out = openai_chat.cache_hints({"model": CLAUDE, "messages": _round_one()}, OPENROUTER, turn)
    assert "session_id" not in out


@pytest.mark.parametrize(
    "base_url",
    ["https://api.openai.com/v1", "http://ollama.test/v1", "https://openrouter.ai.evil.test/v1"],
)
def test_t9_c1_c3_a_host_that_is_not_openrouter_gets_nothing(base_url):
    body = {"model": CLAUDE, "messages": _round_two()}
    before = copy.deepcopy(body)
    from app.adapters import openai_chat

    out = openai_chat.cache_hints(body, base_url, TURN)
    assert out == before and body == before


def test_t9_c1_a_callers_own_session_id_is_kept():
    out = _hint(_round_one(), session_id="caller-chose-this")
    assert out["session_id"] == "caller-chose-this"


# ── T9 C2: an Anthropic upstream gets two markers, never past four ───────


def test_t9_c2_the_first_system_and_the_last_message_are_marked():
    out = _hint(_round_one())
    assert _parts(out) == [("messages", 0, 0), ("messages", 2, 0)]
    assert out["messages"][0]["content"] == [
        {"type": "text", "text": "You are Nova.", "cache_control": EPHEMERAL}
    ]
    assert out["messages"][2]["content"] == [
        {"type": "text", "text": "read a", "cache_control": EPHEMERAL}
    ]
    # the recall block (second system message) is not the stable prefix
    assert out["messages"][1] == {"role": "system", "content": "recall: nothing"}


def test_t9_c2_a_tool_result_last_carries_the_moving_marker():
    out = _hint(_round_two())
    assert _parts(out) == [("messages", 0, 0), ("messages", 4, 0)]
    assert out["messages"][4] == {
        "role": "tool",
        "tool_call_id": "toolu_a",
        "content": [{"type": "text", "text": "A!", "cache_control": EPHEMERAL}],
    }


def test_t9_c2_a_list_content_is_marked_on_its_last_part_only():
    messages = [
        {
            "role": "system",
            "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}],
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
            ],
        },
    ]
    out = _hint(messages)
    assert _parts(out) == [("messages", 0, 1), ("messages", 1, 1)]


@pytest.mark.parametrize(
    "model", ["~anthropic/claude-sonnet-latest", "Anthropic/Claude-Opus-5", "anthropic/x:thinking"]
)
def test_t9_c2_the_vendor_is_read_from_the_id_sent(model):
    assert len(_parts(_hint(_round_two(), model=model))) == 2


def test_t9_c2_one_marker_when_the_only_message_is_the_system_one_or_there_is_no_system():
    assert _parts(_hint([{"role": "system", "content": "s"}])) == [("messages", 0, 0)]
    assert _parts(_hint([{"role": "user", "content": "hi"}])) == [("messages", 0, 0)]


def test_t9_c2_a_last_message_without_content_moves_the_marker_to_the_latest_with_content():
    messages = _round_one() + [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c", "type": "function", "function": {"name": "f", "arguments": "{}"}}
            ],
        }
    ]
    out = _hint(messages)
    assert _parts(out) == [("messages", 0, 0), ("messages", 2, 0)]
    assert out["messages"][3] == messages[3]


def test_t9_c2_an_empty_text_is_never_marked():
    out = _hint([{"role": "system", "content": ""}, {"role": "user", "content": "hi"}])
    assert out["messages"][0] == {"role": "system", "content": ""}
    assert _parts(out) == [("messages", 1, 0)]


def test_t9_c2_a_callers_markers_never_pass_through():
    marked = {"type": "text", "text": "x", "cache_control": EPHEMERAL}
    out = _hint(
        [
            {"role": "system", "content": [dict(marked)], "cache_control": EPHEMERAL},
            {"role": "user", "content": [dict(marked), dict(marked), dict(marked)]},
            {"role": "assistant", "content": [dict(marked)]},
            {"role": "user", "content": [dict(marked)]},
        ],
        cache_control=EPHEMERAL,
        tools=[{**TOOL, "cache_control": EPHEMERAL}],
    )
    assert _parts(out) == [("messages", 0, 0), ("messages", 3, 0)]
    assert len(_parts(out)) <= MAX_BREAKPOINTS


# ── T9 C3: any other upstream is passed through untouched ───────────────


@pytest.mark.parametrize(
    "model",
    [
        "google/gemini-3.8-flash",
        "openai/gpt-5",
        "openrouter/auto",
        "claude-sonnet-4.5",
        "notanthropic/claude",
        "anthropic-mirror/claude",
        "",
    ],
)
@pytest.mark.parametrize("caller_marks", [True, False])
def test_t9_c3_a_model_not_in_anthropics_namespace_gets_no_marker(model, caller_marks):
    # The WHOLE body is asserted: a marker added anywhere (top level, a tool,
    # a message) or a caller's marker removed from anywhere must fail. Without
    # caller markers, an added one cannot hide behind an identical caller's.
    from app.adapters import openai_chat

    if caller_marks:
        marked = {"type": "text", "text": "x", "cache_control": EPHEMERAL}
        body = {
            "model": model,
            "messages": _round_two() + [{"role": "user", "content": [marked]}],
            "tools": [{**TOOL, "cache_control": EPHEMERAL}, TOOL],
            "cache_control": EPHEMERAL,
        }
        kept = [("top", 0, None), ("tools", 0, None), ("messages", 5, 0)]
    else:
        body = {"model": model, "messages": _round_two(), "tools": [TOOL]}
        kept = []
    out = openai_chat.cache_hints(copy.deepcopy(body), OPENROUTER, TURN)
    assert out == {**body, "session_id": TURN}  # untouched, the caller's markers kept
    assert _parts(out) == kept


def test_t9_c3_no_model_named_gets_no_marker():
    from app.adapters import openai_chat

    body = {"messages": _round_two(), "tools": [TOOL]}
    out = openai_chat.cache_hints(copy.deepcopy(body), OPENROUTER, TURN)
    assert out == {**body, "session_id": TURN}
    assert _parts(out) == []


# ── T9 C4: the marker moves; every earlier part stays what it was ────────


@pytest.mark.parametrize(
    ("earlier", "later"), [(_round_one, _round_two), (_round_two, _round_three)]
)
def test_t9_c4_the_next_round_keeps_every_earlier_message_identical(earlier, later):
    first = _hint(earlier())
    second = _hint(later())
    n = len(first["messages"])
    assert second["messages"][0] == first["messages"][0]  # the stable system prefix
    assert second["messages"][: n - 1] == first["messages"][: n - 1]
    assert _plain(second["messages"][n - 1]) == _plain(first["messages"][n - 1])
    last = len(second["messages"]) - 1
    assert _parts(second)[-1] == ("messages", last, 0)


def test_t9_c4_the_callers_body_is_never_written_to():
    body = {"model": CLAUDE, "messages": _round_three(), "tools": [TOOL]}
    before = copy.deepcopy(body)
    from app.adapters import openai_chat

    first = openai_chat.cache_hints(body, OPENROUTER, TURN)
    snapshot = copy.deepcopy(first)
    openai_chat.cache_hints(body, OPENROUTER, TURN)
    assert body == before
    assert first == snapshot


# ── T9 C5: what OpenRouter receives, through the real data plane ─────────


async def _openrouter(client, mount_backend, fake, monkeypatch) -> None:
    # Saving a provider checks its name against the hub's local model tags.
    from tests.fakes import FakeOllama

    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    mount_backend("http://ollama.test", FakeOllama().app)
    mount_backend("http://openrouter.ai", fake.app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "openrouter",
            "adapter": "openai-chat",
            "base_url": "http://openrouter.ai/api/v1",
            "auth_shape": "static-bearer",
            "api_key": "sk-1",
        },
    )
    assert resp.status_code == 200, resp.text


def _fake(**kw) -> FakeOpenAICompat:
    return FakeOpenAICompat(
        prefix="/api/v1",
        models_body={
            "object": "list",
            "data": [{"id": CLAUDE}, {"id": "google/gemini-3.8-flash"}],
        },
        accepts_key="sk-1",
        **kw,
    )


def _sent(fake) -> list[dict]:
    return [b for p, b in fake.seen if p.endswith("/chat/completions")]


@requires_db
@pytest.mark.parametrize("stream", [True, False])
async def test_t9_c5_an_anthropic_upstream_receives_the_session_and_two_markers(
    client, pool, mount_backend, monkeypatch, stream
):
    fake = _fake()
    await _openrouter(client, mount_backend, fake, monkeypatch)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": f"openrouter:{CLAUDE}", "messages": _round_two(), "stream": stream},
        headers={"X-Nova-Turn-Id": TURN.upper()},
    )
    assert resp.status_code == 200, resp.text
    (sent,) = _sent(fake)
    assert sent["session_id"] == TURN
    assert _parts(sent) == [("messages", 0, 0), ("messages", 4, 0)]


@requires_db
@pytest.mark.parametrize("caller_marks", [True, False])
async def test_t9_c5_a_gemini_upstream_gets_the_session_and_no_marker(
    client, pool, mount_backend, monkeypatch, caller_marks
):
    fake = _fake()
    await _openrouter(client, mount_backend, fake, monkeypatch)
    request = {"model": "openrouter:google/gemini-3.8-flash", "messages": _round_two()}
    if caller_marks:
        request |= {
            "tools": [{**TOOL, "cache_control": EPHEMERAL}, TOOL],
            "cache_control": EPHEMERAL,
        }
    else:
        request |= {"tools": [TOOL]}
    resp = await client.post("/v1/chat/completions", json=request, headers={"X-Nova-Turn-Id": TURN})
    assert resp.status_code == 200, resp.text
    (sent,) = _sent(fake)
    # The whole body but the gateway's own usage ask: the request as given,
    # the model id unprefixed, plus session_id — no marker added anywhere,
    # the caller's top-level and tool markers kept.
    assert {k: v for k, v in sent.items() if k != "usage"} == {
        **request,
        "model": "google/gemini-3.8-flash",
        "session_id": TURN,
    }
    assert _parts(sent) == ([("top", 0, None), ("tools", 0, None)] if caller_marks else [])


@requires_db
async def test_t9_c5_no_turn_header_no_session_id(client, pool, mount_backend, monkeypatch):
    fake = _fake()
    await _openrouter(client, mount_backend, fake, monkeypatch)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": f"openrouter:{CLAUDE}", "messages": _round_two()},
        headers={"X-Nova-Turn-Id": "not-a-uuid"},
    )
    assert resp.status_code == 200, resp.text
    (sent,) = _sent(fake)
    assert "session_id" not in sent
    assert len(_parts(sent)) == 2


@requires_db
async def test_t9_c5_the_usage_refusal_retry_keeps_the_session_and_markers(
    client, pool, mount_backend, monkeypatch
):
    fake = _fake(rejects_usage_fields=True)
    await _openrouter(client, mount_backend, fake, monkeypatch)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": f"openrouter:{CLAUDE}", "messages": _round_two(), "stream": True},
        headers={"X-Nova-Turn-Id": TURN},
    )
    assert resp.status_code == 200, resp.text
    first, retry = _sent(fake)
    assert "usage" in first and "usage" not in retry
    for sent in (first, retry):
        assert sent["session_id"] == TURN
        assert _parts(sent) == [("messages", 0, 0), ("messages", 4, 0)]


@requires_db
async def test_t9_c5_the_credit_retry_keeps_the_session_and_markers(
    client, pool, mount_backend, monkeypatch
):
    fake = _fake(affords_tokens=100)
    await _openrouter(client, mount_backend, fake, monkeypatch)
    resp = await client.post(
        "/v1/chat/completions",
        json={"model": f"openrouter:{CLAUDE}", "messages": _round_two()},
        headers={"X-Nova-Turn-Id": TURN},
    )
    assert resp.status_code == 200, resp.text
    first, retry = _sent(fake)
    assert "max_tokens" not in first and retry["max_tokens"] == 100
    for sent in (first, retry):
        assert sent["session_id"] == TURN
        assert _parts(sent) == [("messages", 0, 0), ("messages", 4, 0)]
