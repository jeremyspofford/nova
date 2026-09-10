"""What the backend may run when nobody asked it to, and what it says about it.

Every test here is about ONE property: a note that names a live source must
never quietly pass as current. Either the check ran and its answer is above
the note, or the check did not run and the prompt says why.
"""

from __future__ import annotations

import asyncio
import pathlib

import pytest

from app import chat, live_facts, tools
from app.tools import ToolContext


def _ctx() -> ToolContext:
    """The context a live check runs on. In a turn it is the turn's own — same
    person, same workspace root — so an agent's check is contained exactly
    where its own calls are; here the checks under test need neither."""
    return ToolContext(app=None, person=None, workspace_root=pathlib.Path("."))


def _call(tool: str, args: dict | None = None, note: str = "hardware") -> live_facts.LiveCall:
    return live_facts.LiveCall(tool=tool, args=args or {}, note=note)


# -- the classification tripwire ---------------------------------------------


def test_every_read_only_tool_is_classified_one_way_or_the_other():
    """The line that makes a new tool somebody's decision.

    `reads_only` says a tool changes nothing; it does NOT say the backend may
    run it unasked, and the gap is where fetch_url lives. A tool registered
    tomorrow inherits exclusion, which is the safe answer — this reddens so
    that the safe answer is also a chosen one, with its reason written down
    beside the others.
    """
    reads = {name for name, tool in tools.REGISTRY.items() if tool.reads_only}
    classified = live_facts.AUTO_RUN | set(live_facts.NOT_AUTO_RUN)
    assert reads == classified, (
        "a reads_only tool is neither in AUTO_RUN nor excluded with a reason in "
        f"NOT_AUTO_RUN: {sorted(reads ^ classified)}"
    )


def test_nothing_that_changes_the_world_can_be_run_unasked():
    """The half that would be silent if it were wrong. AUTO_RUN is a set of
    strings, so a typo or a rename could put a writer in it and nothing at
    run time would notice until it ran."""
    for name in live_facts.AUTO_RUN:
        tool = tools.REGISTRY.get(name)
        assert tool is not None, f"AUTO_RUN names {name!r}, which is not a registered tool"
        assert tool.reads_only, f"{name} changes something and must never run unasked"


def test_every_exclusion_carries_a_reason():
    for name, reason in live_facts.NOT_AUTO_RUN.items():
        assert name in tools.REGISTRY, f"NOT_AUTO_RUN names {name!r}, which is not registered"
        assert reason.strip(), f"{name} is excluded with no reason given"


# -- runnable ----------------------------------------------------------------


def test_a_tool_that_changes_something_is_refused_by_name():
    refusal = live_facts.runnable(_call("workspace_write_file", {"path": "a", "content": "b"}))
    assert refusal and "changes something" in refusal


def test_a_tool_that_reaches_an_address_the_note_chose_is_refused():
    """The reason reads_only is necessary and not sufficient.

    A note's live_source was written by a model out of a transcript. If
    fetch_url were auto-runnable, every recall that surfaced that note would
    reach an address nobody vetted, from inside the owner's network, with
    nobody having asked for anything.
    """
    refusal = live_facts.runnable(_call("fetch_url", {"url": "http://somewhere.invalid/"}))
    assert refusal and "address" in refusal
    assert live_facts.runnable(_call("web_search", {"query": "vram"})) is not None


def test_an_unknown_tool_is_refused_rather_than_guessed_at():
    refusal = live_facts.runnable(_call("read_the_owners_mind"))
    assert refusal and "no tool named" in refusal


def test_arguments_that_the_tool_would_refuse_are_refused_before_dispatch():
    refusal = live_facts.runnable(_call("device_info", {"device": 7}))
    assert refusal and "do not fit" in refusal


def test_a_check_the_backend_will_run_returns_no_refusal():
    assert live_facts.runnable(_call("get_time")) is None
    assert live_facts.runnable(_call("device_info", {"device": "desktop"})) is None


# -- running -----------------------------------------------------------------


class _Turn:
    """Just enough of traces.Turn to record spans without a database."""

    def __init__(self):
        self.spans: list = []

    def span(self, kind, name=None):
        turn = self

        class _Rec:
            def __init__(self):
                self.kind, self.name, self.meta = kind, name, {}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                turn.spans.append(self)
                return False

        return _Rec()


@pytest.mark.asyncio
async def test_a_check_that_runs_files_a_real_tool_span_marked_unasked():
    """Two properties at once, and they pull in opposite directions.

    It is a REAL tool span — kind "tool", named for the tool, with ok and
    result_head — because the honesty guards read spans to decide whether a
    claim is backed, and a listing this produced is a listing that really ran
    this turn. File it under a private kind and the presented-listing guard
    contradicts her for showing a true one.

    And it says `unasked`, because the trace is where "did she choose to run
    that?" gets answered without taking anybody's word for it. She did not.
    """
    turn = _Turn()
    checked = await live_facts.run([_call("get_time")], turn, _ctx())
    assert len(checked) == 1
    assert checked[0].ok and checked[0].result
    (span,) = turn.spans
    assert (span.kind, span.name) == ("tool", "get_time")
    assert span.meta["ok"] is True
    assert span.meta["unasked"] is True
    assert span.meta["result_head"]


@pytest.mark.asyncio
async def test_the_same_call_named_by_two_notes_runs_once():
    checked = await live_facts.run(
        [_call("get_time", note="a"), _call("get_time", note="b")], _Turn(), _ctx()
    )
    assert len(checked) == 1


@pytest.mark.asyncio
async def test_a_refused_check_is_reported_and_never_dropped():
    """The property the whole module exists for. A check that did not happen
    must not leave the note reading exactly as it would if the check had
    confirmed it."""
    turn = _Turn()
    checked = await live_facts.run([_call("fetch_url", {"url": "http://x.invalid/"})], turn, _ctx())
    assert len(checked) == 1
    assert not checked[0].ok
    assert checked[0].problem and "address" in checked[0].problem
    # Refused BEFORE dispatch, so there is no tool span: nothing ran. The
    # reason survives on the Checked, which is what reaches the prompt.
    assert turn.spans == []


@pytest.mark.asyncio
async def test_more_notes_than_the_budget_allows_are_stated_not_silently_skipped():
    # Distinct args so the dedupe does not collapse them first.
    calls = [
        live_facts.LiveCall(tool="route_explain", args={"role": role}, note=role)
        for role in ("chat", "scheduled", "judge", "coding", "vision")
    ]
    checked = await live_facts.run(calls, _Turn(), _ctx())
    assert len(checked) == len(calls)
    skipped = [c for c in checked if c.problem and "at most" in c.problem]
    assert len(skipped) == len(calls) - live_facts.MAX_CHECKS


@pytest.mark.asyncio
async def test_a_check_that_hangs_is_stated_rather_than_holding_the_turn(monkeypatch):
    """A live check runs on the path to an answer. An unreachable device must
    cost a sentence, never the turn."""

    async def _hang(args, ctx):
        await asyncio.sleep(30)

    slow = tools.Tool(
        name="slow_check",
        description="hangs",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        executor=_hang,
        reads_only=True,
    )
    monkeypatch.setitem(tools.REGISTRY, "slow_check", slow)
    monkeypatch.setattr(live_facts, "AUTO_RUN", live_facts.AUTO_RUN | {"slow_check"})
    monkeypatch.setattr(live_facts, "CHECK_TIMEOUT", 0.05)

    checked = await live_facts.run([_call("slow_check")], _Turn(), _ctx())
    assert len(checked) == 1
    assert not checked[0].ok
    assert "did not answer" in checked[0].problem


# -- the ordering, which is the ruling ---------------------------------------


def test_the_live_answer_is_named_current_and_the_note_is_named_history():
    checked = [live_facts.Checked(_call("device_info", note="hardware"), result="24 GB")]
    (line,) = live_facts.lines(checked)
    assert "current answer" in line
    assert "24 GB" in line
    assert "what was true when it was written" in line
    # The live answer precedes the demotion of the note: a small model reads
    # the head of the line and stops.
    assert line.index("24 GB") < line.index("what was true")


def test_a_failed_check_tells_her_to_say_the_note_may_be_out_of_date():
    checked = [live_facts.Checked(_call("device_info", note="hardware"), problem="device offline")]
    (line,) = live_facts.lines(checked)
    assert line.startswith("NOT checked")
    assert "device offline" in line
    assert "may be out of date" in line


# -- the prompt --------------------------------------------------------------


def test_the_checks_reach_the_prompt_under_the_notes_and_win():
    recall = chat.Recalled(
        notes=("hardware: 24GB VRAM",),
        live=("Checked just now, and this is the current answer — device_info says: 32 GB",),
    )
    prompt = chat.volatile_system_prompt(recall)
    assert prompt is not None
    assert prompt.index("24GB VRAM") < prompt.index("32 GB"), "the notes block comes first"
    assert "the check is the current answer and the note is history" in prompt


def test_a_turn_with_no_live_note_has_the_prompt_it_had_before():
    recall = chat.Recalled(notes=("he prefers short answers",))
    prompt = chat.volatile_system_prompt(recall)
    assert "Live checks" not in prompt


# -- reading the calls off the hits ------------------------------------------


def test_a_hit_naming_a_call_yields_it_with_the_notes_title():
    (call,) = chat._live_calls(
        [
            {
                "title": "hardware",
                "snippet": "24GB",
                "live_source": {"tool": "device_info", "args": {"device": "desktop"}},
            }
        ]
    )
    assert call.tool == "device_info"
    assert call.args == {"device": "desktop"}
    assert call.note == "hardware"


def test_a_malformed_live_source_yields_nothing_rather_than_a_guess():
    """A check that ran the wrong command and reported an answer is worse than
    no check: the note would then be contradicted by something that never
    described it."""
    assert chat._live_calls([{"title": "a", "live_source": {"args": {}}}]) == []
    assert chat._live_calls([{"title": "a", "live_source": "device_info"}]) == []
    assert chat._live_calls([{"title": "a", "live_source": {"tool": "x", "args": []}}]) == []
    assert chat._live_calls([{"title": "a"}]) == []
    assert chat._live_calls(["a bare string hit"]) == []


def test_a_live_source_with_no_arguments_is_read_as_an_empty_call():
    (call,) = chat._live_calls([{"title": "time", "live_source": {"tool": "get_time"}}])
    assert call.args == {}


@pytest.mark.asyncio
async def test_a_check_that_reads_something_stale_stops_the_turn_being_ingested():
    """The loop this closes, and it is not obvious.

    A note says device_info answers the VRAM question. The backend runs it,
    she quotes the fresh figure, and the exchange is ingested — producing a
    NEW note, dated today, asserting that figure as current, with no live
    source on it. Next month recall serves her own sentence back and there is
    nothing to check it against. The staleness the check exists to kill comes
    back laundered through her own words, one month later, looking newer.
    """
    ran = [live_facts.Checked(_call("device_info", {"device": "d"}), result="24 GB")]
    assert tools.REGISTRY["device_info"].ephemeral  # the fact this rides on
    assert live_facts.ephemeral(ran) is True

    # A check that did NOT run read nothing, so it stales nothing.
    assert live_facts.ephemeral([live_facts.Checked(ran[0].call, problem="offline")]) is False
    # And a check of something that does not go stale leaves ingest alone.
    assert live_facts.ephemeral([live_facts.Checked(_call("list_timers"), result="none")]) is False


@pytest.mark.asyncio
async def test_a_slow_check_does_not_cost_a_fast_one_its_answer(monkeypatch):
    """One budget over the whole gather would cancel a check that had already
    answered and report it as a timeout. Reporting a finished check as failed
    is under-claiming, and under-claiming is still saying something untrue."""

    async def _hang(args, ctx):
        await asyncio.sleep(30)

    monkeypatch.setitem(
        tools.REGISTRY,
        "slow_check",
        tools.Tool(
            name="slow_check",
            description="hangs",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=_hang,
            reads_only=True,
        ),
    )
    monkeypatch.setattr(live_facts, "AUTO_RUN", live_facts.AUTO_RUN | {"slow_check"})
    monkeypatch.setattr(live_facts, "CHECK_TIMEOUT", 0.05)

    checked = await live_facts.run([_call("slow_check"), _call("get_time")], _Turn(), _ctx())
    by_tool = {c.call.tool: c for c in checked}
    assert not by_tool["slow_check"].ok
    assert by_tool["get_time"].ok, "the fast check answered and must be reported as answered"
