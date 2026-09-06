"""S10-pre T2: the anthropic-messages adapter, driven through the gateway's
real data plane against a fake Anthropic that replays the documented
Messages API event shapes. Core reads what comes out of this exactly as it
reads any OpenAI-compatible provider: text deltas, indexed tool_calls
fragments, a usage chunk, `[DONE]`, and an `{"error":…}` chunk when the
provider says so."""

from __future__ import annotations

import json

from app.adapters import anthropic_messages as adapter
from tests.conftest import requires_db
from tests.fakes import FakeAnthropic

# ── request translation (pure) ───────────────────────────────────────────

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


def test_system_messages_fold_into_the_top_level_system_field():
    body = {
        "messages": [
            {"role": "system", "content": "You are Nova."},
            {"role": "developer", "content": "Be brief."},
            {"role": "user", "content": "hi"},
        ],
        "stream": True,
    }
    out = adapter.to_messages_request(body, "claude-opus-5").body
    assert out["system"] == "You are Nova.\n\nBe brief."
    assert out["messages"] == [{"role": "user", "content": "hi"}]
    assert out["model"] == "claude-opus-5"
    assert out["stream"] is True
    # max_tokens is REQUIRED by the API; a caller naming none gets a real
    # ceiling, not a lowball.
    assert out["max_tokens"] == adapter.DEFAULT_MAX_TOKENS


def test_a_tool_round_trip_becomes_tool_use_and_one_tool_result_user_message():
    body = {
        "messages": [
            {"role": "user", "content": "read a and b"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "toolu_a",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path": "a"}'},
                    },
                    {
                        "id": "toolu_b",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path": "b"}'},
                    },
                ],
            },
            {"role": "tool", "tool_call_id": "toolu_a", "content": "A!"},
            {"role": "tool", "tool_call_id": "toolu_b", "content": {"text": "B!"}},
            {"role": "user", "content": "thanks"},
        ],
        "tools": [TOOL],
        "max_tokens": 512,
    }
    out = adapter.to_messages_request(body, "claude-opus-5").body
    assert out["messages"][1] == {
        "role": "assistant",
        "content": [
            {"type": "tool_use", "id": "toolu_a", "name": "read_file", "input": {"path": "a"}},
            {"type": "tool_use", "id": "toolu_b", "name": "read_file", "input": {"path": "b"}},
        ],
    }
    # BOTH results in ONE user message — the documented shape — and the user
    # text that follows them is merged into the same message (roles must
    # alternate; a second consecutive user message is a 400).
    assert out["messages"][2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_a", "content": "A!"},
            {"type": "tool_result", "tool_use_id": "toolu_b", "content": '{"text": "B!"}'},
            {"type": "text", "text": "thanks"},
        ],
    }
    assert len(out["messages"]) == 3
    assert out["tools"] == [
        {
            "name": "read_file",
            "description": "Read a workspace file",
            "input_schema": TOOL["function"]["parameters"],
        }
    ]
    assert out["max_tokens"] == 512


def test_unparsable_arguments_are_kept_not_dropped_and_forced_tool_choice_is_noted():
    body = {
        "messages": [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "tool_calls": [{"id": "t", "function": {"name": "x", "arguments": "{not json"}}],
            },
        ],
        "tool_choice": "required",
    }
    translation = adapter.to_messages_request(body, "m")
    assert translation.body["messages"][1]["content"][0]["input"] == {"_raw": "{not json"}
    assert "tool_choice" not in translation.body
    assert any("tool_choice" in note for note in translation.notes)


def test_tool_choice_auto_and_none_map_and_stop_becomes_stop_sequences():
    user = [{"role": "user", "content": "x"}]
    auto = adapter.to_messages_request({"messages": user, "tool_choice": "auto"}, "m").body
    assert auto["tool_choice"] == {"type": "auto"}
    none = adapter.to_messages_request(
        {"messages": user, "tool_choice": "none", "stop": "END"}, "m"
    ).body
    assert none["tool_choice"] == {"type": "none"}
    assert none["stop_sequences"] == ["END"]


def test_an_empty_assistant_turn_is_dropped_with_a_note():
    translation = adapter.to_messages_request(
        {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": ""}]}, "m"
    )
    assert translation.body["messages"] == [{"role": "user", "content": "a"}]
    assert "dropped an empty assistant message" in translation.notes


# ── the Messages API's request rules, made true before sending ──────────


def test_a_history_window_that_opens_on_a_reply_drops_the_leading_assistant():
    """core's history_window can hand us an assistant row first — the API
    refuses a request whose first message is not `user`."""
    translation = adapter.to_messages_request(
        {
            "messages": [
                {"role": "system", "content": "sys"},
                {"role": "assistant", "content": "earlier reply"},
                {"role": "user", "content": "next question"},
            ]
        },
        "m",
    )
    assert [m["role"] for m in translation.body["messages"]] == ["user"]
    assert any("leading assistant" in n for n in translation.notes)


def test_consecutive_same_role_messages_merge_so_roles_alternate():
    """An empty assistant reply between two user turns (a markup-only reply
    persisted as "") used to leave [user, user] — a 400."""
    translation = adapter.to_messages_request(
        {
            "messages": [
                {"role": "user", "content": "one"},
                {"role": "assistant", "content": ""},
                {"role": "user", "content": "two"},
                {"role": "assistant", "content": "reply"},
                {"role": "assistant", "content": "again"},
                {"role": "user", "content": "three"},
            ]
        },
        "m",
    )
    msgs = translation.body["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert msgs[0]["content"] == [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}]
    assert msgs[1]["content"] == [
        {"type": "text", "text": "reply"},
        {"type": "text", "text": "again"},
    ]


def test_an_orphan_tool_result_is_carried_as_text_not_sent_as_a_pairing_claim():
    translation = adapter.to_messages_request(
        {
            "messages": [
                {"role": "tool", "tool_call_id": "toolu_gone", "content": "42"},
                {"role": "user", "content": "go on"},
            ]
        },
        "m",
    )
    msgs = translation.body["messages"]
    assert [m["role"] for m in msgs] == ["user"]
    assert msgs[0]["content"] == [
        {"type": "text", "text": "[result of an earlier tool call]\n42"},
        {"type": "text", "text": "go on"},
    ]
    assert not any(b.get("type") == "tool_result" for b in msgs[0]["content"])


def test_a_request_with_no_user_message_is_refused_here_not_sent():
    import pytest

    from app.adapters.base import ProviderRefused

    with pytest.raises(ProviderRefused) as excinfo:
        adapter.to_messages_request({"messages": [{"role": "system", "content": "only"}]}, "m")
    assert excinfo.value.status == 400


def test_sampling_parameters_are_dropped_with_a_note_never_sent():
    translation = adapter.to_messages_request(
        {"messages": [{"role": "user", "content": "x"}], "temperature": 0.7, "top_p": 0.9}, "m"
    )
    assert "temperature" not in translation.body and "top_p" not in translation.body
    assert any("temperature, top_p" in n for n in translation.notes)


def test_max_tokens_is_clamped_to_the_models_stated_output_cap():
    translation = adapter.to_messages_request(
        {"messages": [{"role": "user", "content": "x"}]}, "old-haiku", output_cap=4096
    )
    assert translation.body["max_tokens"] == 4096
    assert any("clamped" in n for n in translation.notes)
    untouched = adapter.to_messages_request(
        {"messages": [{"role": "user", "content": "x"}], "max_tokens": 100}, "m", output_cap=4096
    )
    assert untouched.body["max_tokens"] == 100


# ── response translation (pure) ──────────────────────────────────────────


def _feed_all(events: list[dict], model="m") -> list:
    translator = adapter.StreamTranslator(model)
    out = []
    for event in events:
        for chunk in translator.feed(event):
            payload = chunk.decode()[len("data: ") :].strip()
            out.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    return out


def test_stream_translator_emits_indexed_tool_fragments_finish_reason_and_usage():
    chunks = _feed_all(
        [
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "model": "claude-opus-5",
                    "usage": {"input_tokens": 40, "output_tokens": 1},
                },
            },
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Let me"},
            },
            {"type": "content_block_stop", "index": 0},
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "read_file",
                    "input": {},
                },
            },
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": ""},
            },
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": '{"path"'},
            },
            {
                "type": "content_block_delta",
                "index": 1,
                "delta": {"type": "input_json_delta", "partial_json": ': "a"}'},
            },
            {"type": "content_block_stop", "index": 1},
            {
                "type": "content_block_start",
                "index": 2,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_2",
                    "name": "fetch_url",
                    "input": {},
                },
            },
            {
                "type": "content_block_delta",
                "index": 2,
                "delta": {"type": "input_json_delta", "partial_json": "{}"},
            },
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use"},
                "usage": {"output_tokens": 30},
            },
            {"type": "message_stop"},
        ]
    )
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant", "content": ""}
    assert chunks[0]["model"] == "claude-opus-5"
    assert chunks[1]["choices"][0]["delta"] == {"content": "Let me"}
    assert chunks[2]["choices"][0]["delta"]["tool_calls"] == [
        {
            "index": 0,
            "id": "toolu_1",
            "type": "function",
            "function": {"name": "read_file", "arguments": ""},
        }
    ]
    # Fragments repeat the call's index; the empty first partial emits nothing.
    assert chunks[3]["choices"][0]["delta"]["tool_calls"] == [
        {"index": 0, "function": {"arguments": '{"path"'}}
    ]
    assert chunks[4]["choices"][0]["delta"]["tool_calls"] == [
        {"index": 0, "function": {"arguments": ': "a"}'}}
    ]
    # The second tool_use block gets index 1 regardless of its block index.
    assert chunks[5]["choices"][0]["delta"]["tool_calls"][0]["index"] == 1
    assert chunks[5]["choices"][0]["delta"]["tool_calls"][0]["id"] == "toolu_2"
    assert chunks[6]["choices"][0]["delta"]["tool_calls"] == [
        {"index": 1, "function": {"arguments": "{}"}}
    ]
    assert chunks[7]["choices"][0]["finish_reason"] == "tool_calls"
    assert chunks[8] == {
        **chunks[8],
        "choices": [],
        "usage": {"prompt_tokens": 40, "completion_tokens": 30, "total_tokens": 70},
    }
    assert chunks[9] == "[DONE]"


def test_stream_translator_maps_every_stop_reason_and_relays_an_error_event():
    for stop, finish in (
        ("end_turn", "stop"),
        ("max_tokens", "length"),
        ("refusal", "content_filter"),
    ):
        chunks = _feed_all([{"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {}}])
        assert chunks[0]["choices"][0]["finish_reason"] == finish
    chunks = _feed_all(
        [{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}]
    )
    assert chunks == [
        {"error": {"message": "anthropic reported an error — overloaded_error: Overloaded"}}
    ]


def test_to_chat_completion_carries_text_tool_calls_and_usage():
    out = adapter.to_chat_completion(
        {
            "id": "msg_9",
            "model": "claude-opus-5",
            "content": [
                {"type": "text", "text": "Reading."},
                {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "a"}},
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        },
        "claude-opus-5",
    )
    assert out["object"] == "chat.completion"
    message = out["choices"][0]["message"]
    assert message["content"] == "Reading."
    assert message["tool_calls"] == [
        {
            "id": "toolu_1",
            "type": "function",
            "function": {"name": "read_file", "arguments": '{"path": "a"}'},
        }
    ]
    assert out["choices"][0]["finish_reason"] == "tool_calls"
    assert out["usage"] == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}


# ── through the real data plane (DB) ─────────────────────────────────────

pytestmark_db = requires_db


def _sse_payloads(raw: bytes) -> list:
    out = []
    for line in raw.decode().splitlines():
        if line.startswith("data:"):
            payload = line[len("data:") :].strip()
            out.append("[DONE]" if payload == "[DONE]" else json.loads(payload))
    return out


async def _add_anthropic(client, mount_backend, fake: FakeAnthropic, monkeypatch=None):
    mount_backend("http://anthropic.test", fake.app)
    # Creating a provider checks its name against the local tags (see
    # admin._refuse_name_that_shadows_a_local_tag), so ollama must answer.
    import os

    from tests.fakes import FakeOllama

    os.environ["OLLAMA_URL"] = "http://ollama.test"
    mount_backend("http://ollama.test", FakeOllama().app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test/v1",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-4321",
        },
    )
    assert resp.status_code == 200, resp.text


@requires_db
async def test_a_tool_calling_turn_streams_in_the_openai_shape_core_reads(
    client, pool, mount_backend
):
    fake = FakeAnthropic(
        blocks=("Let me look.", {"name": "read_file", "input": {"path": "notes.md"}}),
        stop_reason="tool_use",
        input_tokens=100,
        output_tokens=42,
    )
    await _add_anthropic(client, mount_backend, fake)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [
                {"role": "system", "content": "You are Nova."},
                {"role": "user", "content": "what's in notes.md?"},
            ],
            "tools": [TOOL],
            "stream": True,
        },
    )

    assert resp.status_code == 200
    assert resp.headers["x-nova-served-by"] == "anthropic:claude-opus-5"
    assert resp.headers["content-type"].startswith("text/event-stream")
    frames = _sse_payloads(resp.content)
    assert frames[-1] == "[DONE]"
    text = "".join(
        f["choices"][0]["delta"].get("content") or ""
        for f in frames
        if f != "[DONE]" and f.get("choices")
    )
    assert text == "Let me look."
    fragments = [
        item
        for f in frames
        if f != "[DONE]"
        for choice in f.get("choices", [])
        for item in (choice["delta"].get("tool_calls") or [])
    ]
    assert fragments[0] == {
        "index": 0,
        "id": "toolu_01",
        "type": "function",
        "function": {"name": "read_file", "arguments": ""},
    }
    assert "".join(fr["function"]["arguments"] for fr in fragments) == '{"path": "notes.md"}'
    assert [f["choices"][0]["finish_reason"] for f in frames if f != "[DONE]" and f.get("choices")][
        -1
    ] == "tool_calls"
    usage = [f["usage"] for f in frames if f != "[DONE]" and f.get("usage")]
    assert usage == [{"prompt_tokens": 100, "completion_tokens": 42, "total_tokens": 142}]

    # What Anthropic actually received: its own shapes, with the key in its header.
    path, sent = fake.seen[-1]
    assert path == "/v1/messages"
    assert sent["model"] == "claude-opus-5"
    assert sent["system"] == "You are Nova."
    assert sent["tools"][0]["input_schema"] == TOOL["function"]["parameters"]
    assert sent["stream"] is True and sent["max_tokens"] == adapter.DEFAULT_MAX_TOKENS
    assert fake.seen_headers[-1]["x-api-key"] == "sk-ant-4321"
    assert "authorization" not in fake.seen_headers[-1]


@requires_db
async def test_a_non_streamed_probe_is_a_whole_chat_completion(client, pool, mount_backend):
    fake = FakeAnthropic(blocks=("hi",))
    await _add_anthropic(client, mount_backend, fake)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 1,
            "stream": False,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["choices"][0]["message"]["content"] == "hi"
    assert body["choices"][0]["finish_reason"] == "stop"
    assert fake.seen[-1][1]["max_tokens"] == 1


@requires_db
async def test_an_in_stream_error_event_becomes_the_openai_error_chunk(client, pool, mount_backend):
    fake = FakeAnthropic(blocks=("part", "never"), error_after=1)
    await _add_anthropic(client, mount_backend, fake)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    frames = _sse_payloads(resp.content)
    errors = [f for f in frames if f != "[DONE]" and "error" in f]
    assert errors == [
        {"error": {"message": "anthropic reported an error — overloaded_error: Overloaded"}}
    ]
    assert "[DONE]" not in frames


@requires_db
async def test_a_stream_that_ends_without_message_stop_says_so(client, pool, mount_backend):
    fake = FakeAnthropic(blocks=("half",), truncate=True)
    await _add_anthropic(client, mount_backend, fake)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    frames = _sse_payloads(resp.content)
    assert any(
        "before message_stop" in f.get("error", {}).get("message", "")
        for f in frames
        if f != "[DONE]"
    )


@requires_db
async def test_anthropics_refusal_is_relayed_with_its_status_and_message(
    client, pool, mount_backend
):
    fake = FakeAnthropic(
        status=400,
        error_body={
            "type": "error",
            "error": {"type": "invalid_request_error", "message": "max_tokens: must be positive"},
        },
    )
    await _add_anthropic(client, mount_backend, fake)

    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:claude-opus-5",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
    )

    assert resp.status_code == 400
    assert resp.headers["x-nova-served-by"] == "anthropic:claude-opus-5"
    assert resp.json() == {
        "error": {"message": "max_tokens: must be positive", "type": "invalid_request_error"}
    }


@requires_db
async def test_a_bare_anthropic_origin_is_normalised_to_its_v1_path(client, pool, mount_backend):
    """The form's convention is 'base URL includes the version path'; a bare
    origin typed for Anthropic gets /v1 appended rather than saving a row
    whose every call would 404."""
    fake = FakeAnthropic()
    mount_backend("http://anthropic.test", fake.app)
    import os

    from tests.fakes import FakeOllama

    os.environ["OLLAMA_URL"] = "http://ollama.test"
    mount_backend("http://ollama.test", FakeOllama().app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-1",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["base_url"] == "http://anthropic.test/v1"
    assert fake.seen[-1][0] == "/v1/models"


@requires_db
async def test_a_listing_that_never_stops_paging_is_refused_not_reported_partial(
    client, pool, mount_backend
):
    import os

    from tests.fakes import FakeOllama

    class Endless(FakeAnthropic):
        async def _models(self, request):
            await self._record(request)
            after = request.query_params.get("after_id") or "m0"
            nxt = f"m{int(after[1:]) + 1}"
            from starlette.responses import JSONResponse

            return JSONResponse(
                {"data": [{"id": nxt}], "has_more": True, "first_id": nxt, "last_id": nxt}
            )

    fake = Endless()
    mount_backend("http://anthropic.test", fake.app)
    os.environ["OLLAMA_URL"] = "http://ollama.test"
    mount_backend("http://ollama.test", FakeOllama().app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test/v1",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-1",
        },
    )
    assert resp.status_code == 502
    assert "partial list" in resp.json()["error"]


@requires_db
async def test_the_listed_output_cap_clamps_a_later_completion(client, pool, mount_backend):
    import os

    from tests.fakes import FakeOllama

    class Capped(FakeAnthropic):
        async def _models(self, request):
            await self._record(request)
            from starlette.responses import JSONResponse

            return JSONResponse(
                {
                    "data": [{"id": "old-haiku", "display_name": "Old", "max_tokens": 4096}],
                    "has_more": False,
                    "last_id": "old-haiku",
                }
            )

    fake = Capped(blocks=("hi",))
    mount_backend("http://anthropic.test", fake.app)
    os.environ["OLLAMA_URL"] = "http://ollama.test"
    mount_backend("http://ollama.test", FakeOllama().app)
    resp = await client.post(
        "/admin/providers",
        json={
            "name": "anthropic",
            "adapter": "anthropic-messages",
            "base_url": "http://anthropic.test/v1",
            "auth_shape": "api-key-header",
            "api_key": "sk-ant-1",
        },
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/v1/chat/completions",
        json={
            "model": "anthropic:old-haiku",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": False,
        },
    )
    assert resp.status_code == 200, resp.text
    assert fake.seen[-1][1]["max_tokens"] == 4096
