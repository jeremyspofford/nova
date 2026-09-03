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
        '< atem:function_calls >\n  < atem:invoke name = "ping" >\n'
        "  < /atem:invoke >\n</atem:function_calls >"
    )
    assert [c.name for c in scan.calls] == ["ping"]
    assert scan.calls[0].arguments == {}  # a call with no parameters is not a failure


def test_a_paragraph_between_the_opener_and_the_invoke_is_writing_not_a_call():
    """The plausibility bound. A model emitting a call does not stop for a blank
    line and a new sentence; an answer describing one does. Kept byte for
    byte."""
    prose = (
        "<a:function_calls>\n\nThat opener is followed by an invoke:\n\n"
        '<a:invoke name="device_run"><a:parameter name="k">1</a:parameter></a:invoke>'
        "</a:function_calls>"
    )
    scan = markup_calls.parse_markup_tool_calls(prose, streamed=True)
    assert scan.calls == ()
    assert scan.text == prose


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


CUT_OFF = (
    'Working on it.\n<atem:function_calls>\n<atem:invoke name="device_run">\n'
    '<atem:parameter name="device">DELL'
)


def test_a_half_emitted_call_is_dropped_from_a_STREAMED_round():
    """A round's text really can stop mid-block. The fragment is not prose and
    not a call: dropped, reported, dispatched nowhere."""
    scan = markup_calls.parse_markup_tool_calls(CUT_OFF, streamed=True)
    assert scan.calls == ()  # half a call is not a call
    assert scan.unparsed is True
    assert scan.text == "Working on it."


def test_the_same_text_is_left_alone_in_a_FINISHED_record():
    """A record is never half-written, so the truncation rule does not apply to
    it — applied there it would eat the tail of an honest sentence."""
    scan = markup_calls.parse_markup_tool_calls(CUT_OFF)
    assert scan.calls == ()
    assert scan.text == CUT_OFF


def test_a_bare_tag_mention_keeps_its_tail_even_when_streamed():
    """The truncation rule wants a half-emitted CALL — a quoted invoke name —
    not a sentence that names a tag."""
    mention = "It opens with <function_calls> and then the invokes follow."
    scan = markup_calls.parse_markup_tool_calls(mention, streamed=True)
    assert scan.calls == ()
    assert scan.unparsed is False
    assert scan.text == mention


def test_a_block_whose_invoke_never_closes_is_prose_about_tags():
    """No readable invoke means nothing to run and nothing to strip: an answer
    explaining the format keeps every character."""
    prose = '<a:function_calls><a:invoke name="device_run"></a:function_calls>'
    scan = markup_calls.parse_markup_tool_calls(prose, streamed=True)
    assert scan.calls == ()
    assert scan.text == prose


def test_a_stray_closing_tag_is_left_alone():
    """A stray tag cannot cause an action, and deleting one deletes prose."""
    prose = "All done.\n</atem:function_calls>"
    scan = markup_calls.parse_markup_tool_calls(prose, streamed=True)
    assert scan.calls == ()
    assert scan.text == prose


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


# -- the adversarial corpus (review, 2026-09-03) ---------------------------
#
# Two ways to get this wrong, and both were live. Quoted markup that EXECUTES
# turns a reply explaining a tool call into the tool call — the review's repro
# ran a probe out of a ```xml fence, and pulled ["rm", "-rf", "/"] out of an
# explanation. Prose that gets STRIPPED turns an answer about the format into a
# gutted fragment. Every case here is pinned in both directions: nothing runs,
# and the text comes back byte for byte.

FENCED = (
    "Sure — here is what a call looks like:\n\n```xml\n" + OBSERVED + "\n```\n\n"
    "That is the shape."
)
BLOCKQUOTED = "Like this:\n\n" + "\n".join(f"> {line}" for line in OBSERVED.splitlines())
HERMES_FENCED = (
    "An example of the other format:\n\n```\n"
    '<tool_call>{"name": "device_run", "arguments": {"argv": ["rm", "-rf", "/"]}}'
    "</tool_call>\n```\n"
)
EXPLAINED = (
    "It opens with <function_calls>, nests <invoke name=…> for each call, and "
    "closes with </function_calls>."
)
BACKTICKED = "The tag is `<function_calls>` and it closes with `</function_calls>`."
INDENTED_FENCE = "  ```\n" + OBSERVED + "\n  ```"


@pytest.mark.parametrize(
    "quoted",
    [FENCED, BLOCKQUOTED, HERMES_FENCED, EXPLAINED, BACKTICKED, INDENTED_FENCE],
    ids=["fence", "blockquote", "hermes-in-fence", "explained", "backticked", "indented"],
)
@pytest.mark.parametrize("streamed", [True, False], ids=["streamed", "record"])
def test_quoted_or_described_markup_is_never_a_call_and_never_edited(quoted, streamed):
    scan = markup_calls.parse_markup_tool_calls(quoted, streamed=streamed)
    assert scan.calls == ()  # nothing to dispatch
    assert scan.unparsed is False  # nothing to note, either
    assert scan.text == quoted  # byte for byte, fence contents included


def test_a_real_call_beside_a_quoted_one_runs_only_the_real_one():
    """The regression guard for the masking: an unquoted block still dispatches,
    and the quoted example beside it survives intact."""
    text = f"{FENCED}\n\nRunning it now.\n\n{OBSERVED}"
    scan = markup_calls.parse_markup_tool_calls(text, streamed=True)
    assert [c.name for c in scan.calls] == ["device_run"]  # exactly one
    assert scan.calls[0].arguments["argv"][0] == "find"
    assert "```xml" in scan.text  # the fence is untouched
    assert scan.text.count("function_calls") == 2  # the fenced pair, and no more


NESTED = (
    '<a:function_calls>\n<a:invoke name="device_run">\n'
    '<a:parameter name="device">DELL-XPS-8950</a:parameter>\n'
    '<a:parameter name="note">as in <a:invoke name="other">'
    '<a:parameter name="argv">["rm", "-rf", "/"]</a:parameter></a:invoke>'
    "</a:parameter>\n"
    '<a:parameter name="argv">["ok"]</a:parameter>\n'
    "</a:invoke>\n</a:function_calls>"
)


def test_a_nested_quote_inside_a_parameter_is_named_but_never_trusted():
    """The review's I3 repro, under the ruling. The non-greedy match still closes
    on the INNER tags — `argv` does not survive — and that is now a matter of
    RECORD ONLY: what comes out is a name to refuse, never a call to run. The
    text is stripped either way, so no XML is stored."""
    scan = markup_calls.parse_markup_tool_calls(NESTED, streamed=True)
    assert [c.name for c in scan.calls] == ["device_run"]  # a name, to be refused
    assert "argv" not in scan.calls[0].arguments  # the damage, harmless now
    assert scan.text == ""


# NEW-1, the review's third Critical and the one that ended the dispatch path.
# A quotation that swallows a STRUCTURAL tag — the close of one invoke and the
# open of the next, in backticks, a fence or a blockquote — makes the non-greedy
# match close on the WRONG tag and absorb the following invoke's parameters. The
# pre-mask parser read two calls; the masked one reads one call carrying the
# second's argv, with nothing anywhere reporting doubt. No arrangement of tags
# can be trusted to say what the model meant, which is why nothing runs.


def _boundary_swallowed(open_quote: str, close_quote: str) -> str:
    return (
        '<a:function_calls>\n<a:invoke name="markup_probe">\n'
        '<a:parameter name="device">DELL-XPS-8950</a:parameter>\n'
        '<a:parameter name="argv">["ok"]</a:parameter>\n'
        f'{open_quote}</a:invoke><a:invoke name="other">{close_quote}\n'
        '<a:parameter name="argv">["rm", "-rf", "/"]</a:parameter>\n'
        "</a:invoke>\n</a:function_calls>"
    )


BACKTICK_SWALLOWED = _boundary_swallowed("`", "`")
FENCE_SWALLOWED = _boundary_swallowed("```\n", "\n```")
QUOTE_SWALLOWED = _boundary_swallowed("> ", "")


@pytest.mark.parametrize(
    "repro",
    [BACKTICK_SWALLOWED, FENCE_SWALLOWED, QUOTE_SWALLOWED],
    ids=["backtick", "fence", "blockquote"],
)
def test_a_quote_swallowing_a_tag_boundary_produces_names_and_nothing_else(repro):
    """Whatever the mask does to the boundary, the result is a set of NAMES: no
    exception, no partial text left behind, and — the point — nothing that any
    code path will execute."""
    scan = markup_calls.parse_markup_tool_calls(repro, streamed=True)
    assert all(isinstance(call.name, str) and call.name for call in scan.calls)
    # Whatever it read, it read it as markup: no half-block survives as prose.
    assert "function_calls" not in scan.text
    assert "<a:invoke" not in scan.text


def test_a_long_backtick_run_is_not_a_denial_of_service():
    """NEW-2. The unbounded code-span pattern was superlinear: 8,000 backticks
    took 3.5s and 12,000 took 11.8s, on the event loop — and a small model stuck
    in a repetition loop emits exactly that. The delimiter is now 1-3 backticks
    with a bounded span."""
    import time

    payload = "`" * 20000
    started = time.perf_counter()
    scan = markup_calls.parse_markup_tool_calls(payload + OBSERVED, streamed=True)
    elapsed = time.perf_counter() - started
    assert elapsed < 0.05, f"took {elapsed:.3f}s"
    assert isinstance(scan.text, str)
