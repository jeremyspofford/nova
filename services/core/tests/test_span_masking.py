"""Credentials never reach the trace (S37a, plan decision P14): a value under a
credential-shaped key is masked by `chat._redact`, before the span is bounded,
for every tool — mcp_connect's token first among them."""

from __future__ import annotations

import json

import pytest

from app import chat, tools
from app.tools.base import Tool
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _nova_turn, _owner, _spans
from tests.test_chat_tools import text


def test_credential_keys_are_masked_at_any_depth():
    recorded = chat._span_arguments(
        json.dumps(
            {
                "name": "github",
                "url": "https://x.invalid/mcp",
                "token": "ghp_secret_value",
                "headers": {
                    "Authorization": "Bearer abc123",
                    "X-MCP-Toolsets": "actions",
                    "X-Api-Key": "k-9",
                },
                "env": {"GH_TOKEN": "tok-2", "PATH": "/usr/bin"},
                "items": [{"password": "hunter2"}],
            }
        )
    )
    written = json.dumps(recorded)
    for secret in ("ghp_secret_value", "abc123", "k-9", "tok-2", "hunter2"):
        assert secret not in written
    assert recorded["token"] == "<masked:16 chars>"
    assert recorded["headers"]["X-MCP-Toolsets"] == "actions"
    assert recorded["env"]["PATH"] == "/usr/bin"


def test_ordinary_arguments_are_left_as_they_were():
    args = {"path": "notes/today.md", "query": "token budget", "key": "digest", "name": "tidy"}
    assert chat._span_arguments(args) == args


def test_a_null_credential_stays_null():
    assert chat._span_arguments({"token": None}) == {"token": None}


def test_a_huge_credential_is_masked_before_it_is_bounded():
    recorded = chat._span_arguments({"token": "x" * 100_000})
    assert recorded == {"token": "<masked:100000 chars>"}


def test_a_headers_object_header_named_only_for_a_key_is_masked():
    """Ruling F8, superseded in MECHANISM (not intent) by the Task 5 carry
    T5-B-REVISED: a header NAME carrying no 'token'/'secret'/'password'/
    'auth'/'cookie' word, only 'key' (`X-Hass-Key`, ha-mcp's own header), is
    still masked — by `app.mcp.client.is_credential_header`, the SAME
    predicate the client's own reason scrub already uses, not a second word
    list kept here."""
    value = "ha-secret-value"
    recorded = chat._span_arguments({"headers": {"X-Hass-Key": value, "X-MCP-Toolsets": "actions"}})
    assert recorded["headers"]["X-Hass-Key"] == f"<masked:{len(value)} chars>"
    assert recorded["headers"]["X-MCP-Toolsets"] == "actions"


async def _unused_executor(args: dict, ctx) -> str:
    return "unused"


def _register_stand_in(monkeypatch) -> None:
    """A tool that declares `url` as origin-only, registered for the test
    alone (ruling X2-REVISED) — `monkeypatch.setitem` restores the registry
    on teardown, the same pattern every other chat test uses."""
    monkeypatch.setitem(
        tools.REGISTRY,
        "stand_in",
        Tool(
            name="stand_in",
            description="d",
            # `url` is in its schema: for a tool that declares an origin-only
            # argument, a key the schema does not name is masked whole
            # (final review I1), so the declaration alone is not enough.
            parameters={
                "type": "object",
                "properties": {"name": {"type": "string"}, "url": {"type": "string"}},
            },
            executor=_unused_executor,
            traced_as_origin=("url",),
        ),
    )


def test_a_declared_url_argument_is_reduced_to_its_origin(monkeypatch):
    _register_stand_in(monkeypatch)
    recorded = chat._span_arguments(
        {"name": "ha", "url": "https://User:pw@HA.example:8123/private_abc123/mcp?k=1"},
        "stand_in",
    )
    assert recorded["url"] == "https://ha.example:8123"
    written = json.dumps(recorded)
    for secret in ("private_abc123", "pw", "k=1"):
        assert secret not in written


def test_a_declared_argument_that_is_not_a_url_is_masked_whole(monkeypatch):
    _register_stand_in(monkeypatch)
    value = "not a url at all"
    recorded = chat._span_arguments({"url": value}, "stand_in")
    assert recorded == {"url": f"<masked:{len(value)} chars>"}


def test_a_malformed_url_value_is_masked_whole_not_raised(monkeypatch):
    """A bad port makes `urlsplit(...).port` raise ValueError (every existing
    caller of `_normalize_origin` only ever sees an already-validated URL, so
    this never surfaced before). The trace writer has no such guarantee — a
    typo in the model's own argument must still be masked whole, per spec,
    never crash the span it is recorded on."""
    _register_stand_in(monkeypatch)
    value = "https://host:not-a-port/mcp"
    recorded = chat._span_arguments({"url": value}, "stand_in")
    assert recorded == {"url": f"<masked:{len(value)} chars>"}


def test_a_tool_without_the_declaration_leaves_its_url_argument_alone():
    """fetch_url takes no `traced_as_origin` (S38 strips its query
    separately) — its one url argument must come through exactly as sent,
    the same as when no tool_name is passed at all (every test above)."""
    assert tools.REGISTRY["fetch_url"].traced_as_origin == ()
    recorded = chat._span_arguments({"url": "https://x.invalid/mcp"}, "fetch_url")
    assert recorded["url"] == "https://x.invalid/mcp"


# ── final review I1: arguments that do not parse, or arrive off-schema ──────
#
# Arguments are recorded BEFORE dispatch validates them, so a local model's
# truncated JSON or a key the schema never named used to reach turn_spans
# raw. For a tool whose arguments can carry a credential — derived from the
# tool itself (`traced_as_origin`, or a credential-shaped or `headers`
# property in its schema), never a list kept here — unparsed text is a
# length only, an unknown key's value is masked whole, and a `headers` value
# that is not an object of valid header names is masked whole.

_TOKEN = "ghp_LEAKLEAKLEAK123"
_HEADER = "hdr_LEAKLEAKLEAK123"
_PATH = "s3cr3tpath"
_LEAKY_SHAPES = {
    "truncated JSON": (
        '{"name": "gh", "url": "http://gh.mcp.invalid/s3cr3tpath/mcp", '
        '"token": "ghp_LEAKLEAKLEAK123"'
    ),
    "single quotes": (
        "{'name': 'gh', 'url': 'http://gh.mcp.invalid/s3cr3tpath/mcp', "
        "'token': 'ghp_LEAKLEAKLEAK123'}"
    ),
    "trailing comma": (
        '{"name": "gh", "url": "http://gh.mcp.invalid/s3cr3tpath/mcp", '
        '"token": "ghp_LEAKLEAKLEAK123",}'
    ),
    "headers as pairs": json.dumps(
        {"name": "gh", "url": "http://gh.mcp.invalid/mcp", "headers": [["X-Api-Key", _HEADER]]}
    ),
    "headers as a string": json.dumps(
        {
            "name": "gh",
            "url": "http://gh.mcp.invalid/mcp",
            "headers": f"Authorization: Bearer {_TOKEN}",
        }
    ),
    "token under an unknown key": json.dumps(
        {"name": "gh", "url": "http://gh.mcp.invalid/mcp", "pat": _TOKEN}
    ),
    "URL in upper case": json.dumps({"name": "gh", "URL": "http://gh.mcp.invalid/s3cr3tpath/mcp"}),
    "a header NAME holding the token": json.dumps(
        {
            "name": "gh",
            "url": "http://gh.mcp.invalid/mcp",
            "headers": {f"Authorization: Bearer {_TOKEN}": ""},
        }
    ),
    "a JSON string, not an object": json.dumps(f"http://gh.mcp.invalid/{_PATH}/mcp {_TOKEN}"),
}


@pytest.mark.parametrize("raw", _LEAKY_SHAPES.values(), ids=list(_LEAKY_SHAPES))
def test_mcp_connect_arguments_off_schema_never_reach_the_trace(raw):
    written = json.dumps(chat._span_arguments(raw, "mcp_connect"))
    for secret in (_TOKEN, _HEADER, _PATH):
        assert secret not in written, written


def test_unparsed_text_is_recorded_as_its_length_only():
    raw = _LEAKY_SHAPES["truncated JSON"]
    assert chat._span_arguments(raw, "mcp_connect") == f"<unparsed: {len(raw)} chars>"


def test_a_well_formed_connect_still_shows_what_is_safe():
    recorded = chat._span_arguments(
        json.dumps(
            {
                "name": "gh",
                "url": f"http://gh.mcp.invalid/{_PATH}/mcp",
                "token": _TOKEN,
                "headers": {"X-Api-Key": _HEADER, "X-MCP-Toolsets": "actions"},
            }
        ),
        "mcp_connect",
    )
    # Ruling F-H1 (fix round 2): no check can tell a header NAME from a
    # credential (`ghp_…` is a valid header token), so a connect's headers
    # are recorded as a count only. This used to pin the names; the owner
    # still sees them on the Connections tab.
    assert recorded == {
        "name": "gh",
        "url": "http://gh.mcp.invalid",
        "token": f"<masked:{len(_TOKEN)} chars>",
        "headers": "<masked:2 headers>",
    }


def test_an_unknown_key_is_masked_whole_and_case_sensitively():
    recorded = chat._span_arguments({"name": "gh", "URL": "http://gh.mcp.invalid/x"}, "mcp_connect")
    # Round 2 (ruling F-H1, N3): the off-schema KEY is recorded by position
    # too, never by name — this pinned `"URL"` as the key in round 1.
    assert recorded == {"name": "gh", "<key 1>": "<masked:23 chars>"}


def test_a_tool_with_a_credential_parameter_is_guarded_without_declaring_origin(monkeypatch):
    """Derived from the schema: a `token` property is enough, no list names
    the tool."""
    monkeypatch.setitem(
        tools.REGISTRY,
        "stand_in_token",
        Tool(
            name="stand_in_token",
            description="d",
            parameters={"type": "object", "properties": {"token": {"type": "string"}}},
            executor=_unused_executor,
        ),
    )
    raw = '{"token": "ghp_LEAKLEAKLEAK123"'
    assert chat._span_arguments(raw, "stand_in_token") == f"<unparsed: {len(raw)} chars>"


def test_a_tool_without_credential_parameters_keeps_its_unparsed_text():
    """Unparseable arguments are worth seeing in the trace (why it was kept
    raw at all), so a tool that cannot carry a credential keeps them."""
    assert tools.REGISTRY["fetch_url"].traced_as_origin == ()
    raw = '{"url": "https://x.invalid/page"'
    assert chat._span_arguments(raw, "fetch_url") == raw
    assert chat._span_arguments({"url": "u", "extra": "e"}, "fetch_url") == {
        "url": "u",
        "extra": "e",
    }


def test_an_unregistered_tool_name_changes_nothing():
    raw = '{"query": "x"'
    assert chat._span_arguments(raw, "no_such_tool_anywhere") == raw
    assert chat._span_arguments({"url": "https://x.invalid/p"}, "no_such_tool_anywhere") == {
        "url": "https://x.invalid/p"
    }


@requires_db
async def test_a_truncated_connect_through_the_chat_loop_stores_neither_secret(pool, mount_peers):
    """One real turn: the model sends mcp_connect with a missing brace,
    dispatch refuses it as not JSON, and the stored span holds neither the
    token nor the secret path."""
    owner = await _owner(pool)
    raw = _LEAKY_SHAPES["truncated JSON"]
    call = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": "mcp_connect", "arguments": raw},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }
    gateway = ScriptedGateway(rounds=((call,), (text("That did not parse."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner, "connect github")
    spans = [s for s in await _spans(pool, turn.id) if s["name"] == "mcp_connect"]
    assert spans, "the refused call must still leave a span"
    stored = await pool.fetch("SELECT meta::text AS m FROM turn_spans WHERE turn_id = $1", turn.id)
    written = "\n".join(r["m"] for r in stored)
    for secret in (_TOKEN, _PATH):
        assert secret not in written
    assert spans[0]["meta"]["args_redacted"] == f"<unparsed: {len(raw)} chars>"


# ── final review fix round 2: no name a caller chose reaches a span ─────────
#
# Ruling F-H1. N1: a declared URL argument that is not a string is masked
# whole. N2: a connection name that fails the store's rule is masked. N3: an
# off-schema KEY is recorded as `<key N>`. N4: headers are a count only. And
# whatever was masked out of the arguments is scrubbed from the same span's
# `result_head` and `error`. N5: a tool with a free-form object property
# records unparsed text as its length.

_ROUND_2_SHAPES = {
    "N1 url as a list": {"name": "gh", "url": [f"http://gh.mcp.invalid/{_PATH}/mcp"]},
    "N1 url as an object": {"name": "gh", "url": {"href": f"http://gh.mcp.invalid/{_PATH}/mcp"}},
    "N2 token as the server name": {"name": _TOKEN, "url": "http://gh.mcp.invalid/mcp"},
    "N3 token as a top-level key": {"name": "gh", "url": "http://gh.mcp.invalid/mcp", _TOKEN: "x"},
    "N4 token as a header name": {
        "name": "gh",
        "url": "http://gh.mcp.invalid/mcp",
        "headers": {_TOKEN: "v"},
    },
    "N4 secret under a plain header name": {
        "name": "gh",
        "url": "http://gh.mcp.invalid/mcp",
        "headers": {"X-Hass-Access": _HEADER},
    },
}


@pytest.mark.parametrize("args", _ROUND_2_SHAPES.values(), ids=list(_ROUND_2_SHAPES))
@pytest.mark.parametrize("form", ["object", "json"])
def test_round_2_shapes_never_reach_the_recorded_arguments(args, form):
    raw = args if form == "object" else json.dumps(args)
    written = json.dumps(chat._span_arguments(raw, "mcp_connect"))
    for secret in (_TOKEN, _HEADER, _PATH):
        assert secret not in written, written


def test_a_declared_url_that_is_not_a_string_is_masked_whole():
    value = {"href": f"http://gh.mcp.invalid/{_PATH}/mcp"}
    recorded = chat._span_arguments({"name": "gh", "url": value}, "mcp_connect")
    assert recorded["url"] == f"<masked:{len(json.dumps(value))} chars>"


def test_a_name_that_fails_the_name_rule_is_masked_and_a_good_one_kept():
    recorded = chat._span_arguments({"name": _TOKEN, "url": "http://x.invalid/m"}, "mcp_connect")
    assert recorded["name"] == f"<masked:{len(_TOKEN)} chars>"
    kept = chat._span_arguments({"name": "github", "url": "http://x.invalid/m"}, "mcp_connect")
    assert kept["name"] == "github"


def test_an_off_schema_key_is_recorded_by_position():
    recorded = chat._span_arguments(
        {"name": "gh", _TOKEN: "x", "url": "http://x.invalid/m", "pat": "y"}, "mcp_connect"
    )
    assert recorded == {
        "name": "gh",
        "<key 1>": "<masked:1 chars>",
        "url": "http://x.invalid",
        "<key 2>": "<masked:1 chars>",
    }


def test_headers_are_a_count_only():
    recorded = chat._span_arguments(
        {"name": "gh", "url": "http://x.invalid/m", "headers": {_TOKEN: "v", "X-A": "b"}},
        "mcp_connect",
    )
    assert recorded["headers"] == "<masked:2 headers>"


def test_what_was_masked_is_scrubbed_from_the_spans_own_text():
    args = {"name": _TOKEN, "url": "http://gh.mcp.invalid/mcp", _HEADER: "x"}
    recorded, scrub = chat._span_record(args, "mcp_connect")
    assert _TOKEN not in json.dumps(recorded)
    text = f"Error: unknown argument {_HEADER!r}; {_TOKEN!r} cannot be a server name"
    cleaned = scrub(text)
    assert _TOKEN not in cleaned and _HEADER not in cleaned
    assert "<key 1>" in cleaned


def test_the_scrub_leaves_short_ordinary_words_alone():
    """Only a value at least as long as the client's credential floor is a
    scrub candidate, so a masked `v` or `x` never rewrites the sentence."""
    _recorded, scrub = chat._span_record(
        {"name": "gh", "url": "http://x.invalid/m", "headers": {"X-A": "v"}, "zz": "x"},
        "mcp_connect",
    )
    assert scrub("a value was given") == "a value was given"


@pytest.mark.parametrize("tool", ["mcp_call", "run_skill", "create_timer"])
def test_a_tool_with_a_free_form_object_records_unparsed_text_as_its_length(tool):
    """N5: a free-form object (`mcp_call`'s `arguments`) can carry a third
    party's credential the schema cannot name."""
    raw = '{"server": "ha", "tool": "set", "arguments": {"token": "ghp_LEAKLEAKLEAK123"}'
    assert chat._span_arguments(raw, tool) == f"<unparsed: {len(raw)} chars>"


def _raw_call(name: str, arguments: str) -> dict:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c1",
                            "type": "function",
                            "function": {"name": name, "arguments": arguments},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


_ROUND_2_TURNS = {
    **_ROUND_2_SHAPES,
    "the token as the header name AND the server name": {
        "name": _TOKEN,
        "url": "http://gh.mcp.invalid/mcp",
        "headers": {_TOKEN: "v"},
    },
    "N5 mcp_call truncated": None,
}


@requires_db
@pytest.mark.parametrize("label", list(_ROUND_2_TURNS))
async def test_round_2_shapes_through_the_chat_loop_store_no_secret(pool, mount_peers, label):
    """A real turn per shape: whatever dispatch, the store or the client
    answered, the stored spans (args_redacted, result_head, error) hold no
    secret. Read by turn id."""
    owner = await _owner(pool)
    if label.startswith("N5"):
        name = "mcp_call"
        raw = '{"server": "ha", "tool": "set", "arguments": {"token": "ghp_LEAKLEAKLEAK123"}'
    else:
        name, raw = "mcp_connect", json.dumps(_ROUND_2_TURNS[label])
    gateway = ScriptedGateway(rounds=((_raw_call(name, raw),), (text("That did not work."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner, "connect github")
    spans = [s for s in await _spans(pool, turn.id) if s["name"] == name]
    assert spans and spans[0]["meta"]["ok"] is False
    for span in spans:
        for field in ("args_redacted", "result_head", "error"):
            written = json.dumps(span["meta"].get(field))
            for secret in (_TOKEN, _HEADER, _PATH):
                assert secret not in written, (field, written)
    stored = await pool.fetch("SELECT meta::text AS m FROM turn_spans WHERE turn_id = $1", turn.id)
    everything = "\n".join(r["m"] for r in stored)
    for secret in (_TOKEN, _HEADER, _PATH):
        assert secret not in everything


# ── hub ruling after fix round 2: every tool that names a server ─────────────
#
# N2's rule held only for `mcp_connect`. `mcp_tools` and `mcp_call` (`server`)
# and `mcp_disconnect` (`name`) recorded a token pasted as the name, and the
# store's "there is no connected MCP server named 'ghp_…'" carried it into the
# span's result_head and error.

_NAMES_A_SERVER = {
    "mcp_tools": {"server": _TOKEN},
    "mcp_call": {"server": _TOKEN, "tool": "list", "arguments": {}},
    "mcp_disconnect": {"name": _TOKEN},
}


@pytest.mark.parametrize("tool", list(_NAMES_A_SERVER))
def test_a_server_name_that_fails_the_name_rule_is_masked_for_every_mcp_tool(tool):
    args = _NAMES_A_SERVER[tool]
    recorded, scrub = chat._span_record(args, tool)
    assert _TOKEN not in json.dumps(recorded)
    assert scrub(f"there is no connected MCP server named {_TOKEN!r}") == (
        "there is no connected MCP server named '[masked]'"
    )


@pytest.mark.parametrize("tool", list(_NAMES_A_SERVER))
def test_a_real_server_name_is_kept_for_every_mcp_tool(tool):
    key = "name" if tool == "mcp_disconnect" else "server"
    args = {**_NAMES_A_SERVER[tool], key: "github"}
    assert chat._span_arguments(args, tool)[key] == "github"


@requires_db
@pytest.mark.parametrize("tool", list(_NAMES_A_SERVER))
async def test_a_token_as_the_server_name_through_the_chat_loop_stores_no_secret(
    pool, mount_peers, tool
):
    owner = await _owner(pool)
    raw = json.dumps(_NAMES_A_SERVER[tool])
    gateway = ScriptedGateway(rounds=((_raw_call(tool, raw),), (text("That did not work."),)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner, "use github")
    spans = [s for s in await _spans(pool, turn.id) if s["name"] == tool]
    assert spans and spans[0]["meta"]["ok"] is False
    stored = await pool.fetch("SELECT meta::text AS m FROM turn_spans WHERE turn_id = $1", turn.id)
    assert _TOKEN not in "\n".join(r["m"] for r in stored)


# -- S38 (merge review, 2026-10-07): what she types on a page ----------------


@pytest.mark.parametrize("action", ["type", "accept"])
def test_text_she_typed_on_a_page_is_recorded_as_its_length(action):
    """A password typed into a sign-in form, or a prompt's answer, must never
    sit in turn_spans or on Activity (the S38 plan: typed text is never
    echoed). The span's own result and error are scrubbed of it too."""
    raw = json.dumps({"action": action, "ref": "e4", "value": "hunter2-Secret!"})
    recorded, scrub = chat._span_record(raw, "browser_act")
    assert recorded == {"action": action, "ref": "e4", "value": "<masked:15 chars>"}
    assert "hunter2-Secret!" not in scrub("Error: could not type hunter2-Secret! into e4")


@pytest.mark.parametrize(
    "args",
    [
        {"action": "select", "ref": "e7", "value": "Canada"},
        {"action": "press", "value": "Enter"},
        {"action": "click", "ref": "e3"},
    ],
)
def test_what_she_chose_or_pressed_on_a_page_is_recorded_as_it_was(args):
    """An option's label and a key's name are not hers to hide — the trace is
    where the owner reads what she did."""
    assert chat._span_record(json.dumps(args), "browser_act")[0] == args


def test_another_tools_value_argument_is_left_as_it_was():
    args = {"action": "type", "value": "hello"}
    assert chat._span_record(json.dumps(args), "memory_save")[0] == args
