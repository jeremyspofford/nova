"""A capped turn's reply says what her tools found (capped-turn-answers).

The owner's turn, 2026-10-07: the tool rounds ran out, the one narration round
answered with a tool call and no prose, and the stored reply was ONLY
"[stopped after 6 tool rounds without finishing]". Her tools had already found
the answer, and he never saw it.

T1 is the backend's statement of what a turn's tools returned:
`chat.tool_results_statement(spans)`, read off the turn's tool spans and
nothing else. Each call whose executor ran (`reached_executor` True) gets one
line, in span order, holding its name, its recorded arguments and the head of
its result as the span recorded it. It is pure (no model, no database, no
prose read), so every test here builds its spans by hand.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from datetime import UTC, datetime

import pytest

from app import chat, guards, tools, traces
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_said_not_done import _arm, _pair
from tests.test_chat_tools import _say, _set, text, whole_call
from tests.test_markup_calls import OBSERVED

_AT = datetime(2026, 10, 7, 12, 7, 58, tzinfo=UTC)


def _span(kind: str, name: str | None, **meta) -> traces.Span:
    return traces.Span(kind=kind, name=name, started_at=_AT, duration_ms=1, meta=meta)


def _reached(name: str, args: object, head: str, *, ok: bool = True) -> traces.Span:
    """A tool span as `_run_tool` files it for a call whose executor ran."""
    meta: dict = {"args_redacted": args, "reached_executor": True, "ok": ok, "result_head": head}
    if not ok:
        meta["error"] = head
    return _span("tool", name, **meta)


def _statement(spans: list[traces.Span]) -> str:
    statement = chat.tool_results_statement(spans)
    assert isinstance(statement, str), statement
    return statement


def _lines_holding(statement: str, text: str) -> list[str]:
    return [line for line in statement.splitlines() if text in line]


def _arg_tokens(args: object) -> list[str]:
    """Every key and string leaf of a recorded argument record."""
    if isinstance(args, dict):
        return [token for key, value in args.items() for token in (key, *_arg_tokens(value))]
    if isinstance(args, list):
        return [token for item in args for token in _arg_tokens(item)]
    return [args] if isinstance(args, str) else []


# Every boundary `str.splitlines` breaks a line on.
_BREAKS = {
    "LF": "\n",
    "CR": "\r",
    "CRLF": "\r\n",
    "VT": "\v",
    "FF": "\f",
    "FS": "\x1c",
    "GS": "\x1d",
    "RS": "\x1e",
    "NEL": "\x85",
    "LS": "\u2028",
    "PS": "\u2029",
}
_ANY_BREAK = re.compile(r"\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]")


def _pieces(value: str) -> list[str]:
    """`value`'s text between its line breaks."""
    return [piece for piece in _ANY_BREAK.split(value) if piece]


# -- C1: every call that reached its executor ---------------------------------


def test_each_call_whose_executor_ran_is_one_line_in_span_order():
    reached = [
        _reached(
            "device_run",
            {"device": "dev-alpha", "argv": ["argv-ps", "argv-everything"]},
            "first-head: no inference process is running",
        ),
        _reached("get_time", {}, "second-head: 2026-10-07T12:07:58Z"),
        _reached(
            "device_run",
            {"device": "dev-alpha", "argv": ["argv-ss", "argv-listening"]},
            "third-head: the port is held by another process",
        ),
    ]
    spans = [
        _span("llm_call", "some-model", round=1, tool_calls=2),
        reached[0],
        reached[1],
        _span("llm_call", "some-model", round=2, tool_calls=1),
        reached[2],
    ]
    before = copy.deepcopy(spans)

    statement = _statement(spans)

    lines = statement.splitlines()
    at = []
    for span in reached:
        holding = [i for i, line in enumerate(lines) if span.meta["result_head"] in line]
        assert len(holding) == 1, (span.meta["result_head"], statement)
        line = lines[holding[0]]
        assert span.name in line
        for token in _arg_tokens(span.meta["args_redacted"]):
            assert token in line, (token, line)
        at.append(holding[0])
    # In the order the spans were given, and two calls of one tool are two lines.
    assert at == sorted(at) and len(set(at)) == 3
    backwards = _statement(list(reversed(spans))).splitlines()
    assert [
        next(i for i, line in enumerate(backwards) if span.meta["result_head"] in line)
        for span in reversed(reached)
    ] == sorted(at)
    assert spans == before  # read, never modified


def test_two_identical_calls_are_two_lines():
    def call() -> traces.Span:
        return _reached("get_time", {}, "2026-10-07T12:07:58Z")

    one = _statement([call()])
    two = _statement([call(), call()])

    assert len(two.splitlines()) == len(one.splitlines()) + 1
    assert len(_lines_holding(two, "2026-10-07T12:07:58Z")) == 2


def test_a_call_that_reached_its_executor_and_failed_is_listed_like_one_that_succeeded():
    ok_head = "LISTEN 0 4096 127.0.0.1:11435"
    failed_head = "Error: device dev-alpha is not connected"

    succeeded = _statement([_reached("device_run", {"device": "dev-alpha"}, ok_head)])
    failed = _statement([_reached("device_run", {"device": "dev-alpha"}, failed_head, ok=False)])

    assert len(_lines_holding(failed, failed_head)) == 1
    # The same line but for its head: no ok or failed word of the backend's own.
    assert failed.replace(failed_head, "<head>") == succeeded.replace(ok_head, "<head>")


@pytest.mark.parametrize(
    "recorded",
    [{}, {"args_redacted": None, "result_head": None}],
    ids=["nothing-recorded", "none-recorded"],
)
def test_a_reached_call_with_no_recorded_head_or_arguments_still_gets_its_line(recorded):
    bare = _span("tool", "get_time", reached_executor=True, ok=True, **recorded)
    full = _statement([_reached("get_time", {}, "2026-10-07T12:07:58Z")])

    statement = _statement([bare])

    assert len(statement.splitlines()) == len(full.splitlines())
    assert len(_lines_holding(statement, "get_time")) == 1


def test_non_ascii_arguments_are_held_as_recorded():
    args = {"path": "notes/café-ß-日本.md", "who": "Zoë"}

    statement = _statement([_reached("device_read_file", args, "contents: naïve")])

    (line,) = _lines_holding(statement, "contents: naïve")
    for token in _arg_tokens(args):
        assert token in line, (token, line)


def test_a_missing_and_a_none_record_get_the_same_stand_in():
    nothing = _span("tool", "get_time", reached_executor=True, ok=True)
    none = _span(
        "tool", "get_time", reached_executor=True, ok=True, args_redacted=None, result_head=None
    )

    statement = _statement([nothing])

    assert _statement([none]) == statement
    assert "null" not in statement and "None" not in statement


def test_the_statement_opens_with_one_fixed_header_naming_the_trace():
    statement = _statement(
        [_reached("get_time", {}, "2026-10-07T12:07:58Z"), _reached("get_time", {}, "later")]
    )

    header, *calls = statement.splitlines()
    assert header == chat.TOOL_RESULTS_HEADER
    assert "trace" in header
    assert len(calls) == 2 and all(line.startswith("> ") for line in calls)


# -- C2: nothing else, and None when nothing reached -------------------------

_OTHER_NAME = "other_tool"
_OTHER_ARGS = {"other_key": "other-arg-value"}
_OTHER_HEAD = "other-head-value"


def _other(case: str, ok: bool) -> traces.Span:
    """A span that is not a call whose executor ran: `ok` as given, so an
    `ok`-based filter cannot tell it from one."""
    common = {"args_redacted": dict(_OTHER_ARGS), "ok": ok, "result_head": _OTHER_HEAD}
    if case == "refused-out-of-rounds":
        return _span("tool", _OTHER_NAME, **common, refused_out_of_rounds=True)
    if case == "refused-as-markup-in-text":
        return _span(
            "tool", _OTHER_NAME, **common, refused_markup_as_text=True, parsed_from_markup=True
        )
    if case == "refused-in-a-closed-redirect-round":
        return _span("tool", _OTHER_NAME, **common, refused_redirect_closed=True)
    if case == "refused-as-an-unknown-tool":
        return _span("tool", _OTHER_NAME, **common, reason="unknown_tool")
    if case == "refused-by-dispatch":
        return _span("tool", _OTHER_NAME, **common, reached_executor=False)
    if case == "cut-off-mid-dispatch":
        return _span("tool", _OTHER_NAME, **{**common, "result_head": chat.NEVER_RETURNED})
    if case == "reached-but-cut-off-mid-dispatch":
        # The pre-set head with a True key: `_run_tool` sets both after
        # dispatch answers, so only a hand-built span holds the pair today.
        # The Assumptions rule: interrupted, so left out (T1 COVERAGE).
        return _span(
            "tool",
            _OTHER_NAME,
            **{**common, "result_head": chat.NEVER_RETURNED},
            reached_executor=True,
        )
    if case == "reached-key-truthy-but-not-true":
        return _span("tool", _OTHER_NAME, **common, reached_executor=1)
    if case == "a-scripted-step":
        return _span("tool", _OTHER_NAME, **common, via_skill=True, step=0)
    if case == "an-unasked-live-check":
        return _span("tool", _OTHER_NAME, **common, unasked=True)
    if case == "a-span-of-another-kind":
        return _span("llm_call", _OTHER_NAME, **common, reached_executor=True)
    raise AssertionError(case)


_OTHER_CASES = [
    "refused-out-of-rounds",
    "refused-as-markup-in-text",
    "refused-in-a-closed-redirect-round",
    "refused-as-an-unknown-tool",
    "refused-by-dispatch",
    "cut-off-mid-dispatch",
    "reached-but-cut-off-mid-dispatch",
    "reached-key-truthy-but-not-true",
    "a-scripted-step",
    "an-unasked-live-check",
    "a-span-of-another-kind",
]


@pytest.mark.parametrize("case", _OTHER_CASES)
def test_a_span_whose_executor_did_not_run_adds_no_line(case):
    def reached() -> traces.Span:
        return _reached("get_time", {"zone": "UTC"}, "2026-10-07T12:07:58Z")

    alone = _statement([reached()])
    assert len(_lines_holding(alone, "2026-10-07T12:07:58Z")) == 1

    for ok in (True, False):
        assert _statement([_other(case, ok), reached()]) == alone, ok
        assert _statement([reached(), _other(case, ok)]) == alone, ok


@pytest.mark.parametrize(
    "spans",
    [
        [],
        [_other(case, True) for case in _OTHER_CASES],
        [_other(case, False) for case in _OTHER_CASES],
    ],
    ids=["no-spans", "every-other-span-ok", "every-other-span-not-ok"],
)
def test_a_turn_where_no_call_reached_its_executor_states_nothing(spans):
    assert chat.tool_results_statement(spans) is None


# -- C3: each line bounded ----------------------------------------------------


@pytest.mark.parametrize("brk", list(_BREAKS.values()), ids=list(_BREAKS))
def test_a_line_break_inside_a_recorded_value_starts_no_new_line(brk):
    assert len(f"a{brk}b".splitlines()) == 2  # the premise: this does break a line

    statement = _statement(
        [
            _reached(
                f"name_top{brk}name_end", {"cmd": f"arg_top{brk}arg_end"}, f"head_top{brk}head_end"
            ),
            _reached("device_run", f"record_top{brk}record_end", "plain-head"),
        ]
    )
    clean = _statement(
        [
            _reached("name_top name_end", {"cmd": "arg_top arg_end"}, "head_top head_end"),
            _reached("device_run", "record_top record_end", "plain-head"),
        ]
    )

    assert len(statement.splitlines()) == len(clean.splitlines())
    (line,) = _lines_holding(statement, "head_top")
    for piece in ("name_top", "name_end", "arg_top", "arg_end", "head_end"):
        assert piece in line, (piece, line)
    (record_line,) = _lines_holding(statement, "record_top")
    assert "record_end" in record_line


def test_no_line_outgrows_the_bound_however_long_the_recorded_values():
    # Hand-built: `_run_tool` records nothing this long. The lengths differ so
    # each cut's stated length names one value.
    name, record, head = "n" * 12_345, "a" * 23_456, "h" * 34_567

    statement = _statement([_reached(name, record, head)])

    bound = chat.TOOL_RESULTS_LINE_CHARS
    assert isinstance(bound, int)
    assert all(len(line) <= bound for line in statement.splitlines()), bound
    (line,) = _lines_holding(statement, "h" * 10)
    for value in (name, record, head):
        assert value not in line
        assert str(len(value)) in line  # the cut says so


def test_the_bound_is_tight_to_the_longest_line_a_cut_can_make():
    # A bound of any size satisfies "no line outgrows it"; it must also be
    # near the longest line real cuts produce, or it bounds nothing. The only
    # slack allowed is the cut counts' digits (sized for sys.maxsize).
    statement = _statement([_reached("n" * 12_345, "a" * 23_456, "h" * 34_567)])

    (line,) = _lines_holding(statement, "h" * 10)
    digits_slack = 6 * len(str(sys.maxsize))
    assert chat.TOOL_RESULTS_LINE_CHARS - len(line) <= digits_slack, (
        chat.TOOL_RESULTS_LINE_CHARS,
        len(line),
    )


@pytest.mark.parametrize("brk", list(_BREAKS.values()), ids=list(_BREAKS))
def test_each_line_break_is_shown_as_one_character(brk):
    head = f"row-one{brk}row-two{brk}{brk}row-four"

    statement = _statement([_reached("device_run", {}, head)])

    (line,) = _lines_holding(statement, "row-one")
    shown = line.split(" returned: ", 1)[1]
    assert shown == _ANY_BREAK.sub(chat._LINE_BREAK_SHOWN, head)
    assert len(chat._LINE_BREAK_SHOWN) == 1 and not chat._LINE_BREAK_SHOWN.isspace()


def _full_head() -> str:
    """A one-line head exactly as long as the most `_run_tool` records."""
    head = " ".join(f"row-{i:03d}" for i in range(chat.SPAN_RESULT_HEAD_CHARS))
    return head[: chat.SPAN_RESULT_HEAD_CHARS - len("|end")] + "|end"


def test_a_whole_head_is_never_cut_and_a_dict_of_arguments_is_cut_before_it():
    head = _full_head()
    assert len(head) == chat.SPAN_RESULT_HEAD_CHARS
    args = {"path": "notes/" + "p" * 150, "content": "c" * 150}

    statement = _statement([_reached("device_write_file", args, head)])

    (line,) = _lines_holding(statement, head)
    assert len(line) <= chat.TOOL_RESULTS_LINE_CHARS
    assert "c" * 150 not in line
    assert re.search(r"\(\+\d+ more chars, \d+ total\)", line), line  # the cut says so


def test_a_whole_head_is_never_cut_and_a_clipped_record_is_cut_before_it():
    head = _full_head()
    # What `_run_tool` records for a call whose arguments outgrow SPAN_ARGS_TOTAL_CHARS.
    record = chat._bounded({f"key_{i:02d}": "v" * 150 for i in range(20)})
    assert isinstance(record, str) and len(record) > chat.SPAN_ARGS_TOTAL_CHARS

    statement = _statement([_reached("device_run", record, head)])

    (line,) = _lines_holding(statement, head)
    assert len(line) <= chat.TOOL_RESULTS_LINE_CHARS
    assert record not in line
    assert chat._clip(record, chat.SPAN_ARG_HEAD_CHARS) in line  # cut, and says so


def _multi_line_head(size: int) -> str:
    """A head exactly `size` long whose rows are split by every kind of break."""
    breaks = list(_BREAKS.values())
    head = "LISTEN 0 4096 127.0.0.1:11400"
    for i in range(1, size):
        piece = f"{breaks[i % len(breaks)]}LISTEN 0 4096 127.0.0.1:{11400 + i}"
        if len(head) + len(piece) > size - len("\nend"):
            break
        head += piece
    return head + "\nend".ljust(size - len(head), ".")


def test_a_whole_multi_line_head_is_never_cut():
    head = _multi_line_head(chat.SPAN_RESULT_HEAD_CHARS)
    assert len(head) == chat.SPAN_RESULT_HEAD_CHARS
    rows = _pieces(head)

    statement = _statement([_reached("device_run", {"device": "dev-alpha"}, head)])

    (line,) = _lines_holding(statement, rows[0])
    position = 0
    for row in rows:  # every row, in order, on the call's one line
        found = line.find(row, position)
        assert found != -1, (row, line)
        position = found + len(row)


# -- C4: reaches storage as written -------------------------------------------

_ONE_LINE_OBSERVED = OBSERVED.replace("\n", " ")
# Single quotes, so the block stays readable inside a JSON-encoded record.
_QUOTED_ARG_MARKUP = (
    "<function_calls><invoke name='device_run'>"
    "<parameter name='device'>dev-alpha</parameter></invoke></function_calls>"
)
_STAMP = f"[that turn failed at 12:07; {guards.HISTORY_STAMP_RECORD}]"

_STORED_CASES = {
    "head-is-a-markup-block": ({"device": "dev-alpha"}, OBSERVED),
    "head-holds-a-block-on-one-line": ({}, f"found: {_ONE_LINE_OBSERVED}"),
    "head-has-a-lone-backtick-before-a-block": ({}, f"a ` tick, then {OBSERVED}"),
    "head-has-a-backtick-fence-run-before-a-block": ({}, f"a ``` run, then {OBSERVED}"),
    "head-is-a-fenced-block": ({}, f"```xml\n{OBSERVED}\n```"),
    "head-opens-with-a-history-stamp": ({}, f"{_STAMP} the port is held"),
    "argument-holds-a-markup-block": ({"note": _QUOTED_ARG_MARKUP}, "done"),
    "argument-holds-a-tool-call-block": (
        {"text": '<tool_call>{"name": "device_run", "arguments": {}}</tool_call>'},
        "done",
    ),
    "argument-has-a-lone-backtick-before-a-block": (
        {"cmd": f"a ` tick, then {_QUOTED_ARG_MARKUP}"},
        "done",
    ),
    "record-opens-with-a-history-stamp": (f"{_STAMP} recorded", "done"),
}


@pytest.mark.parametrize(("args", "head"), list(_STORED_CASES.values()), ids=list(_STORED_CASES))
def test_the_statement_reaches_storage_as_written(args, head):
    statement = _statement([_reached("device_run", args, head)])

    # The two rewrites `_persist_assistant` applies.
    stored = guards.without_leading_stamp(chat.without_markup(statement))

    assert stored == statement
    assert "[I tried to" not in stored
    for piece in _pieces(head):  # no tool output is lost on the way
        assert piece in stored, piece


# -- C5: the backend's voice --------------------------------------------------

_FIRST_PERSON = frozenset(
    {
        "i",
        "me",
        "my",
        "mine",
        "myself",
        "we",
        "us",
        "our",
        "ours",
        "ourselves",
        "i'm",
        "i've",
        "i'll",
        "i'd",
        "we're",
        "we've",
        "we'll",
        "we'd",
        "let's",
    }
)


def _first_person_words(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*", text)
    return [word for word in words if word.lower().replace("’", "'") in _FIRST_PERSON]


def test_the_statement_says_nothing_in_the_first_person():
    spans = [
        _reached(
            "device_run",
            {"device": "dev-alpha", "argv": ["ss", "-ltnp"]},
            "LISTEN 0 4096 127.0.0.1:11435",
        ),
        _reached(
            "device_run",
            {"device": "dev-alpha"},
            "Error: device dev-alpha is not connected",
            ok=False,
        ),
        # Every value cut, so every cut's own words are read too.
        _reached("n" * 12_345, "a" * 23_456, "h" * 34_567),
        _reached("get_time", {"zone": "UTC"}, "line one\nline two\r\nline three\u2028line four"),
        # The stand-ins for a head and arguments never recorded.
        _span("tool", "get_time", reached_executor=True, ok=True),
    ]
    recorded = " ".join(
        f"{span.name} {span.meta.get('args_redacted')} {span.meta.get('result_head')}"
        for span in spans
    )
    assert _first_person_words(recorded) == []  # the premise: the values hold none

    statement = _statement(spans)

    assert _first_person_words(statement) == [], statement


def test_the_backends_own_words_do_not_change_with_the_calls():
    def spans(tag: str) -> list[traces.Span]:
        return [
            _reached(f"tool_{tag}", {f"key_{tag}": f"value_{tag}"}, f"head_{tag}"),
            _reached(f"tool_{tag}", {f"key_{tag}": f"value_{tag}"}, f"Error: head_{tag}", ok=False),
        ]

    def own_words(tag: str) -> str:
        statement = _statement(spans(tag))
        for value, stand_in in (
            (f"tool_{tag}", "<name>"),
            (f"key_{tag}", "<key>"),
            (f"value_{tag}", "<value>"),
            (f"head_{tag}", "<head>"),
        ):
            statement = statement.replace(value, stand_in)
        return statement

    assert own_words("alpha") == own_words("omega")


# -- T2: the narration path states what the tools returned --------------------
#
# A stopped turn gets one toolless narration round. When that round does not
# answer in prose (it fails, is silent, or asks for a tool on the wire or as
# markup), the reply is T1's statement, read off this turn's own tool spans,
# then the unchanged note: never the note alone while a call reached its
# executor. These run the real funnel (`/api/v1/chat/stream`) against a
# scripted gateway, so they need the database.

# PINS MOVED (no-ceiling T4, 2026-10-08): this section stopped its turns with
# the round CAP (a limit of 2, round 2's call never ran, note "[stopped after
# 2 tool rounds without finishing]"). The count is gone by owner ruling; the
# circling stop is the only round stop and reaches the same narration path.
# Each pin keeps its subject on a circling stop instead: the same get_time
# call a third time (all three run), then the narration round.
NOTE_2 = "[stopped after 3 tool rounds: the same call was repeated]"
CLOCK = "2026-10-07 16:44 UTC"


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _arm_clock(monkeypatch, result: str = CLOCK):
    """get_time with its real schema and flags, and a spy body returning
    `result`: the spy proves how often the executor ran, and the result is
    the head the span records."""
    return _arm(monkeypatch, "get_time", result, schema=tools.REGISTRY["get_time"].parameters)


def _clock_call(call_id: str) -> dict:
    return whole_call(call_id, "get_time", {})


def _meta(value) -> dict:
    return value if isinstance(value, dict) else json.loads(value)


async def _turn_spans(pool) -> list[traces.Span]:
    rows = await pool.fetch(
        "SELECT kind, name, started_at, duration_ms, meta FROM turn_spans ORDER BY started_at"
    )
    return [
        traces.Span(
            kind=row["kind"],
            name=row["name"],
            started_at=row["started_at"],
            duration_ms=row["duration_ms"],
            meta=_meta(row["meta"]),
        )
        for row in rows
    ]


async def _turn_statement(pool) -> str:
    """T1's statement of the turn just run, built from its stored spans."""
    statement = chat.tool_results_statement(await _turn_spans(pool))
    assert isinstance(statement, str), "no call reached its executor this turn"
    return statement


async def _stored(pool) -> str:
    return await pool.fetchval("SELECT content FROM messages WHERE role = 'assistant'")


def _texts(sent: list) -> list[str]:
    return [f["t"] for f in sent if isinstance(f, dict) and "t" in f]


def _corrections(sent: list) -> list[str]:
    return [f["correction"] for f in sent if isinstance(f, dict) and "correction" in f]


async def _cap_held(pool, gateway, spy, *, narration_calls: int) -> None:
    """C4: the stop is unchanged. Three tool rounds and one narration round;
    each round's call reached its executor; the narration round advertised no
    tools and each call it asked for was refused, none dispatched."""
    assert gateway.calls == 4
    assert gateway.payloads[3].get("tools") in (None, [])
    assert len(spy.calls) == 3
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    spans = await _turn_spans(pool)
    narration = [s for s in spans if s.kind == "llm_call" and s.meta.get("round") == 0]
    assert len(narration) == 1
    assert narration[0].meta.get("tools_advertised") is False
    refused = [s for s in spans if s.kind == "tool" and s.meta.get("refused_out_of_rounds")]
    assert len(refused) == narration_calls
    reached = [s for s in spans if s.kind == "tool" and s.meta.get("reached_executor") is True]
    assert [s.name for s in reached] == ["get_time"] * 3


async def _run(owner_client, mount_peers, narration: tuple | None, *, first: tuple = ()):
    """Rounds 1-3 ask for the clock (all run; the third is the circling
    stop), then the narration round plays `narration` (None: the script
    ends, so the narration call fails at the gateway)."""
    rounds = ((*first, _clock_call("c1")), (_clock_call("c2"),), (_clock_call("c3"),))
    if narration is not None:
        rounds = (*rounds, narration)
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=FakeMemory())
    sent = await _say(owner_client, "what time is it?")
    return gateway, sent


def _narrations() -> dict:
    return {
        # (narration round, calls it asks for)
        "fails-at-the-gateway": (None, 0),
        "is-silent": ((), 0),
        "asks-for-a-tool-on-the-wire": ((whole_call("n1", "get_time", {}),), 1),
    }


@requires_db
@pytest.mark.parametrize("case", list(_narrations()), ids=list(_narrations()))
async def test_a_narration_round_that_does_not_answer_stores_the_statement_then_the_note(
    case, owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 (a)(b)(c), C2, C4: the reply is the statement, a blank line, then the
    note. What streamed is what was stored, so a reload shows it."""
    narration, narration_calls = _narrations()[case]
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(owner_client, mount_peers, narration)

    statement = await _turn_statement(pool)
    assert CLOCK in statement
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=narration_calls)


@requires_db
async def test_a_preamble_then_a_wire_call_keeps_the_preamble_then_the_statement(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 (d): a round that asked for a tool did not answer, whatever it said
    first. Its streamed preamble stays, the statement follows it."""
    preamble = "Let me look once more."
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(
        owner_client, mount_peers, (text(preamble), whole_call("n1", "get_time", {}))
    )

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{preamble}\n\n{statement}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=1)


@requires_db
async def test_text_streamed_in_an_earlier_round_is_followed_by_the_statement(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1: prose from round 1 stays where it streamed; the statement comes
    after it, a blank line between, then the note."""
    earlier = "Checking the clock."
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(
        owner_client,
        mount_peers,
        (whole_call("n1", "get_time", {}),),
        first=(text(earlier),),
    )

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{earlier}\n\n{statement}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=1)


@requires_db
async def test_a_narration_round_of_only_markup_gets_the_statement_then_the_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 (e): a tool call written as markup is no answer. The markup is
    handled at the persist boundary as today; the statement+note block is
    what this pins. Nothing it names is dispatched."""
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(owner_client, mount_peers, (text(OBSERVED),))

    statement = await _turn_statement(pool)
    block = f"{statement}\n\n{NOTE_2}"
    stored = await _stored(pool)
    assert block in stored
    assert stored.count(statement) == 1
    assert block in "".join(_texts(sent))
    assert gateway.calls == 4
    assert len(spy.calls) == 3
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    reached = [
        s.name
        for s in await _turn_spans(pool)
        if s.kind == "tool" and s.meta.get("reached_executor") is True
    ]
    assert reached == ["get_time"] * 3


@requires_db
async def test_every_distinct_call_that_ran_is_in_the_statement(
    owner_client, pool, mount_peers, workspace
):
    """C1, c042afa1's shape: several distinct calls ran, each found something,
    and the narration round asked for one more on the wire. Every result is
    in the stored reply, above the note. (Stopped by d.md's missing-file read
    a third time, no longer by a cap of 4.)"""
    workspace.mkdir(parents=True, exist_ok=True)
    found = {name: f"finding number {i} lives in {name}" for i, name in enumerate("abc", 1)}
    for name, body in found.items():
        (workspace / f"{name}.md").write_text(body)
    reads = tuple(
        (whole_call(f"r{i}", "workspace_read_file", {"path": f"{name}.md"}),)
        for i, name in enumerate("abcddd")
    )
    narration = (whole_call("n1", "workspace_read_file", {"path": "e.md"}),)
    gateway = ScriptedGateway(rounds=(*reads, narration))
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "find it")

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n[stopped after 6 tool rounds: the same call was repeated]"
    for body in found.values():
        assert len(_lines_holding(stored, body)) == 1
    assert "".join(_texts(sent)) == stored
    assert gateway.calls == 7


@requires_db
async def test_a_head_holding_markup_reaches_storage_byte_for_byte(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2: the statement goes through `_persist_assistant` untouched, even when
    a tool returned a complete tool-call markup block: nothing stripped, and
    no "[I tried to run" note for markup a tool returned."""
    spy = _arm_clock(monkeypatch, OBSERVED)

    gateway, sent = await _run(owner_client, mount_peers, (whole_call("n1", "get_time", {}),))

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n{NOTE_2}"
    assert "[I tried to run" not in stored
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=1)


_GUARD_HEADS = {
    "stack-claim-serving-is-down": "The local model is unavailable, so a cloud model answered.",
    "served-claim-tagged-model": "Current model in use: `qwen3.8:27b` on hub.",
    "said-not-done-launch-claim": "I launched Notepad++ on your DELL-XPS-8950.",
}


@requires_db
@pytest.mark.parametrize("head", list(_GUARD_HEADS.values()), ids=list(_GUARD_HEADS))
async def test_a_result_head_carrying_a_guard_trigger_is_not_judged_as_hers(
    head, owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C5: the statement is the backend's. A head an honesty guard would fire
    on, were she to write it, adds no correction and files no guard span."""
    await _pair(pool)
    spy = _arm_clock(monkeypatch, head)

    gateway, sent = await _run(owner_client, mount_peers, ())

    statement = await _turn_statement(pool)
    assert head in statement
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n{NOTE_2}"
    assert _corrections(sent) == []
    assert [s.name for s in await _turn_spans(pool) if s.kind == "guard"] == []
    await _cap_held(pool, gateway, spy, narration_calls=0)


@requires_db
async def test_a_replace_class_correction_keeps_the_statement_and_the_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C5: her preamble draws state_claim's REPLACE-class correction. The
    correction replaces her words, and the backend's statement and note are
    kept after it, as backend_note is kept today."""
    await pool.execute(
        "INSERT INTO devices (name, platform, hostname, pubkey) "
        "VALUES ('DELL-XPS-8950', 'linux', 'dell', $1)",
        "a" * 64,
    )
    claim = "The device is still offline."
    spy = _arm_clock(monkeypatch)

    gateway, _sent = await _run(
        owner_client, mount_peers, (text(claim), whole_call("n1", "get_time", {}))
    )

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert [s.name for s in await _turn_spans(pool) if s.kind == "guard"] == ["state_claim"]
    assert claim not in stored
    assert stored == (
        "Correction: I did not actually check the device this turn — I have no "
        f"record of doing so.\n\n{statement}\n\n{NOTE_2}"
    )
    await _cap_held(pool, gateway, spy, narration_calls=1)


# -- T2 COVERAGE: what stays exactly as today, and the opt-in judge -----------


@requires_db
async def test_a_narration_round_that_answers_in_prose_stores_exactly_todays_reply(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3: a narration round that answers in prose, with no call, is the
    answer. No statement: the stored and streamed reply is exactly today's,
    the prose, a blank line, then the note."""
    answer = "The clock came back with 16:44 UTC."
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(owner_client, mount_peers, (text(answer),))

    stored = await _stored(pool)
    assert stored == f"{answer}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=0)


@requires_db
@pytest.mark.parametrize("case", list(_narrations()), ids=list(_narrations()))
async def test_a_stopped_turn_where_no_call_ran_stores_exactly_todays_reply(
    case, owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3: the same unreadable call three times (arguments get_time refuses
    before its executor) is a circling stop where nothing reached an executor:
    the narration round that does not answer leaves the note alone. PIN MOVED
    (no-ceiling T4): this was a cap of 1 refusing round 1's call."""
    narration, narration_calls = _narrations()[case]
    spy = _arm_clock(monkeypatch)
    bad = lambda i: (whole_call(f"c{i}", "get_time", {"bogus": 1}),)  # noqa: E731
    rounds = (bad(1), bad(2), bad(3)) + ((narration,) if narration is not None else ())
    gateway = ScriptedGateway(rounds=rounds)
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "what time is it?")

    note = NOTE_2
    assert await _stored(pool) == note
    assert "".join(_texts(sent)) == note
    assert spy.calls == []
    assert gateway.calls == 4
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    refused = [
        s
        for s in await _turn_spans(pool)
        if s.kind == "tool" and s.meta.get("refused_out_of_rounds")
    ]
    assert len(refused) == narration_calls


async def _set_judge(client) -> None:
    await _set(client, "agents.responsiveness_check", True)


@requires_db
async def test_an_on_topic_judge_keeps_the_statement_and_the_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C5: the opt-in responsiveness judge runs on a stopped turn too. An
    on_topic verdict leaves the reply as it streamed: statement, then note."""
    spy = _arm_clock(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (_clock_call("c1"),),
            (_clock_call("c2"),),
            (_clock_call("c3"),),
            (),
            (text("on_topic"),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_judge(owner_client)

    sent = await _say(owner_client, "what time is it?")

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{statement}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    assert gateway.calls == 5
    assert len(spy.calls) == 3


@requires_db
async def test_a_refocused_reply_is_not_cut_open_by_the_statement(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C5: an off_topic verdict's regeneration REPLACES the whole reply, the
    note included, exactly as today. The statement's place was in front of
    that note, so it goes with it: never spliced into the refocused text."""
    corrected = "It is 16:44 UTC, by the clock this turn read."
    spy = _arm_clock(monkeypatch)
    gateway = ScriptedGateway(
        rounds=(
            (_clock_call("c1"),),
            (_clock_call("c2"),),
            (_clock_call("c3"),),
            (),
            (text("off_topic"),),
            (text(corrected),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_judge(owner_client)

    await _say(owner_client, "what time is it?")

    assert await _stored(pool) == corrected
    assert gateway.calls == 6
    assert len(spy.calls) == 3


@requires_db
async def test_a_narration_round_that_dies_after_some_prose_still_gets_the_statement(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C1 (a): a round that failed did not answer, even when some prose
    streamed before the gateway reported the failure. The prose stays where it
    streamed (it was watched live); the statement follows it, then the note."""
    started = "Here is what I"
    spy = _arm_clock(monkeypatch)

    gateway, sent = await _run(
        owner_client, mount_peers, (text(started), {"error": {"message": "the link dropped"}})
    )

    statement = await _turn_statement(pool)
    stored = await _stored(pool)
    assert stored == f"{started}\n\n{statement}\n\n{NOTE_2}"
    assert "".join(_texts(sent)) == stored
    await _cap_held(pool, gateway, spy, narration_calls=0)
