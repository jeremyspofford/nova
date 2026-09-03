"""The tool-call MARKUP parser: what it recovers, what it strips, what it
refuses to touch.

Pure and DB-free, like the guard suites it belongs beside. The corpus is
pinned: the first case is the EXACT block the owner's model emitted on
2026-09-03 11:57, and the precision cases are the reason this can run over
every round's text without ever mangling an honest reply.
"""
from __future__ import annotations

import pytest

from app import markup_calls

# Verbatim from the trace — mangled namespace prefix and all ("atem" is the
# model's corruption of "antml"). If this ever stops parsing, the defect that
# put raw XML in front of the owner is back.
OBSERVED = (
    '<atem:function_calls>\n'
    '<atem:invoke name="device_run">\n'
    '<atem:parameter name="device">DELL-XPS-8950</atem:parameter>\n'
    '<atem:parameter name="argv">["find", "/home/jeremy", "-maxdepth", "2", '
    '"-type", "d", "-print"]</atem:parameter>\n'
    '</atem:invoke>\n'
    '</atem:function_calls>'
)


def test_the_observed_block_parses_to_the_call_the_model_meant():
    scan = markup_calls.parse_markup_tool_calls(OBSERVED)
    assert scan.unparsed is False
    assert len(scan.calls) == 1
    call = scan.calls[0]
    assert call.name == "device_run"
    assert call.arguments == {
        "device": "DELL-XPS-8950",
        "argv": ["find", "/home/jeremy", "-maxdepth", "2", "-type", "d", "-print"],
    }
    assert scan.text == ""  # the markup was the whole reply; nothing survives it


@pytest.mark.parametrize("prefix", ["", "antml:", "atem:", "tool_use:", "x.y-z:"])
def test_any_namespace_prefix_is_recognised(prefix):
    """The prefix is exactly the part a confused model gets wrong, so it is
    never matched literally."""
    block = (
        f'<{prefix}function_calls><{prefix}invoke name="web_search">'
        f'<{prefix}parameter name="query">nova</{prefix}parameter>'
        f"</{prefix}invoke></{prefix}function_calls>"
    )
    scan = markup_calls.parse_markup_tool_calls(block)
    assert [c.name for c in scan.calls] == ["web_search"]
    assert scan.calls[0].arguments == {"query": "nova"}


def test_prose_around_a_block_is_kept_and_the_block_is_removed():
    scan = markup_calls.parse_markup_tool_calls(
        f"Let me adapt to find instead.\n\n{OBSERVED}\n\nThat should list them."
    )
    assert [c.name for c in scan.calls] == ["device_run"]
    assert scan.text == "Let me adapt to find instead.\n\nThat should list them."
    assert "function_calls" not in scan.text
    assert "atem" not in scan.text


def test_whitespace_and_newlines_inside_the_tags_are_tolerated():
    scan = markup_calls.parse_markup_tool_calls(
        '< atem:function_calls >\n\n  < atem:invoke name = "ping" >\n'
        "  < /atem:invoke >\n</atem:function_calls >"
    )
    assert [c.name for c in scan.calls] == ["ping"]
    assert scan.calls[0].arguments == {}  # a call with no parameters is not a failure


def test_a_parameter_that_looks_like_json_is_parsed_and_one_that_does_not_is_a_string():
    scan = markup_calls.parse_markup_tool_calls(
        '<p:function_calls><p:invoke name="t">'
        '<p:parameter name="argv">["ls", "-la"]</p:parameter>'
        '<p:parameter name="obj">{"a": 1}</p:parameter>'
        '<p:parameter name="plain">DELL-XPS-8950</p:parameter>'
        '<p:parameter name="brokenish">[not, json</p:parameter>'
        "</p:invoke></p:function_calls>"
    )
    assert scan.calls[0].arguments == {
        "argv": ["ls", "-la"],
        "obj": {"a": 1},
        "plain": "DELL-XPS-8950",
        # It STARTED like JSON and did not parse: kept verbatim rather than
        # repaired, because guessing at a repair invents an argument.
        "brokenish": "[not, json",
    }


def test_an_unclosed_block_is_stripped_and_reported_never_dispatched():
    scan = markup_calls.parse_markup_tool_calls(
        'Working on it.\n<atem:function_calls>\n<atem:invoke name="device_run">\n'
        '<atem:parameter name="device">DELL'
    )
    assert scan.calls == ()  # nothing to dispatch — half a call is not a call
    assert scan.unparsed is True
    assert scan.text == "Working on it."


def test_a_block_whose_invoke_never_closes_is_unparsed():
    scan = markup_calls.parse_markup_tool_calls(
        '<a:function_calls><a:invoke name="device_run"></a:function_calls>'
    )
    assert scan.calls == ()
    assert scan.unparsed is True
    assert scan.text == ""


def test_a_stray_closing_tag_is_stripped():
    scan = markup_calls.parse_markup_tool_calls("All done.\n</atem:function_calls>")
    assert scan.calls == ()
    assert scan.unparsed is True
    assert scan.text == "All done."


def test_the_hermes_json_variant_is_recognised():
    scan = markup_calls.parse_markup_tool_calls(
        'Checking.\n<tool_call>{"name": "web_search", "arguments": {"query": "nova"}}'
        "</tool_call>"
    )
    assert [c.name for c in scan.calls] == ["web_search"]
    assert scan.calls[0].arguments == {"query": "nova"}
    assert "tool_call" not in scan.text


def test_a_malformed_hermes_call_is_unparsed_not_guessed_at():
    scan = markup_calls.parse_markup_tool_calls('<tool_call>{"name": broken</tool_call>')
    assert scan.calls == ()
    assert scan.unparsed is True


def test_two_calls_in_one_block_stay_two_calls_in_order():
    scan = markup_calls.parse_markup_tool_calls(
        '<a:function_calls>'
        '<a:invoke name="first"><a:parameter name="k">1</a:parameter></a:invoke>'
        '<a:invoke name="second"><a:parameter name="k">2</a:parameter></a:invoke>'
        "</a:function_calls>"
    )
    assert [c.name for c in scan.calls] == ["first", "second"]
    assert [c.arguments["k"] for c in scan.calls] == ["1", "2"]


# -- PRECISION: an honest reply is never touched ----------------------------


@pytest.mark.parametrize(
    "prose",
    [
        "a < b and b > c, so a < c.",
        "The comparison 3 < 5 holds.",
        "I can make function calls when you ask me to.",
        "Use the invoke parameter of the API.",
        "<div>this is html, not a tool call</div>",
        "```python\nprint(1 < 2)\n```",
        "",
    ],
)
def test_ordinary_text_is_returned_byte_for_byte(prose):
    scan = markup_calls.parse_markup_tool_calls(prose)
    assert scan.calls == ()
    assert scan.unparsed is False
    assert scan.found is False
    assert scan.text == prose  # identical, not merely equivalent


def test_the_note_names_the_calls_it_found_and_deduplicates():
    assert markup_calls.no_tool_round_note(["device_run"]) == (
        "[I tried to run device_run but had no tool round left — "
        "ask again and I'll run it]"
    )
    assert "device_run, web_search" in markup_calls.no_tool_round_note(
        ["device_run", "web_search", "device_run"]
    )
    # Nothing nameable: the note still says only what is true.
    assert "a tool" in markup_calls.no_tool_round_note([])
