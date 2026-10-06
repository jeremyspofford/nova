"""decisions.py — the decision role's two questions (decision-role spec §2).

Pins, with no database: the options are exactly the tools the turn advertises,
each with its full registry description (a tool registered tomorrow is an
option by that fact alone), plus `none`; stage 2 asks about stage 1's top three,
quoting each full description; TypeSafe's thresholds, at their boundaries; an
answer of the wrong shape is unreadable, never guessed, and a number it did not
give is never invented; the hint line is the spec's sentence; the module cannot
reach the dispatch funnel, by an absolute import or a relative one. And through
a fake gateway: a decision hints the tool and sets aside the superseded note,
recording paths and never note text; the hint is stage 2's pick, and `none`
winning stage 1 hints nothing; every call walks the decisions role under the
turn's attribution and names no model; a fallback link is on the span in the
gateway's words; no decision model, the budget at any round, an unreadable
answer, a failed or refused note check, an unreachable or unconfigured gateway,
notes that do not line up with their paths and a bug in the step each leave
nothing applied and say why; a cancelled turn says so and keeps what the step
spent; with no hint, or no tools, the notes stand unasked."""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from starlette.responses import JSONResponse, Response

from app import decisions, tools, traces
from app.main import app
from app.tools.base import Tool
from tests.fakes import GATEWAY_URL, FakeGateway

SETUP = "show_setup_qr"
PHONE = "How do I get you on my phone"
NOTES = (
    "[journal, 12 days ago] people/o/journals/2026-09-15.md: sideload the app through TestFlight",
    "people/o/topics/phone.md: his phone is an iPhone 16",
)
PATHS = ("people/o/journals/2026-09-15.md", "people/o/topics/phone.md")


def decider(
    *,
    tool: str = SETUP,
    fit: float = 0.85,
    gate: float = 0.9,
    notes: dict[str, tuple[float, float, float]] | None = None,
):
    """A fake decision model with Jev's answer shapes (TypeSafe's): stage 1
    ranks `tool` first among whatever options it is sent, with gate `gate`;
    stage 2 picks it with fit `fit` (every other candidate 0.1); a note check
    answers (relevant, contradicts, superseded) from the first key of `notes`
    found in the note's text — (0.9, 0.0, 0.0) when none is."""

    def answer(body: dict) -> dict:
        questions = body["questions"]
        if "tool" in questions:
            options = list(questions["tool"]["criteria"])
            rest = 0.4 / max(1, len(options) - 1)
            return {
                "tool": {
                    "type": "choice",
                    "choice": tool,
                    "confidence": 0.55,
                    "probabilities": {name: 0.6 if name == tool else rest for name in options},
                },
                "acts": {"type": "noul", "noul": gate},
            }
        if "pick" in questions:
            short = list(questions["pick"]["criteria"])
            out: dict = {
                "pick": {
                    "type": "choice",
                    "choice": tool,
                    "confidence": 0.7,
                    "probabilities": {name: 0.8 if name == tool else 0.1 for name in short},
                }
            }
            for index, name in enumerate(short):
                out[f"fit{index}"] = {"type": "noul", "noul": fit if name == tool else 0.1}
            return out
        note = json.loads(body["state"])["recalled_note"]
        scores = next(
            (value for key, value in (notes or {}).items() if key in note), (0.9, 0.0, 0.0)
        )
        return {
            key: {"type": "noul", "noul": score}
            for key, score in zip(("relevant", "contradicts", "superseded"), scores, strict=True)
        }

    return answer


def _turn(kind: str = "chat") -> traces.Turn:
    return traces.Turn(
        id=uuid.uuid4(), started_at=datetime.now(UTC), kind=kind, person_id=uuid.uuid4()
    )


def _span(turn: traces.Turn) -> traces.Span:
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    return span


# -- the questions: derived from what the turn advertises -------------------


def test_stage_one_offers_every_advertised_tool_with_its_full_description_and_none():
    questions = decisions.stage_one(decisions.tool_descriptions(tools.advertised_tools()))

    criteria = questions["tool"]["criteria"]
    assert list(criteria) == [*tools.tool_names(), "none"]
    assert criteria[SETUP] == tools.REGISTRY[SETUP].description
    assert criteria["none"] == decisions.NONE_MEANS
    assert questions["acts"] == {
        "type": "noul",
        "instructions": "Does answering the owner's message require Nova to do, show or look "
        "up something, rather than only talk?",
    }


def test_a_tool_registered_tomorrow_is_an_option_by_that_fact_alone(monkeypatch):
    async def water(args: dict, ctx) -> str:
        return "watered"

    monkeypatch.setitem(
        tools.REGISTRY,
        "water_plants",
        Tool(
            name="water_plants",
            description="Waters the plants on the balcony.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            executor=water,
        ),
    )

    criteria = decisions.stage_one(decisions.tool_descriptions(tools.advertised_tools()))
    assert criteria["tool"]["criteria"]["water_plants"] == "Waters the plants on the balcony."


def test_stage_two_asks_about_the_shortlist_quoting_each_full_description():
    questions = decisions.stage_two(["b", "a"], {"a": "does A", "b": "does B", "c": "does C"})

    assert set(questions) == {"pick", "fit0", "fit1"}
    assert questions["pick"]["criteria"] == {"b": "does B", "a": "does A"}
    assert questions["fit0"]["instructions"] == (
        "Does the tool 'b' do the specific thing the owner's message asks for? "
        "It is described as: does B"
    )


def test_the_shortlist_is_the_top_three_tools_and_never_none():
    probabilities = {"none": 0.5, "a": 0.1, "b": 0.2, "c": 0.05, "d": 0.15}
    descriptions = {"a": "", "b": "", "c": "", "d": ""}
    assert decisions.shortlist(probabilities, descriptions) == ["b", "d", "a"]


@pytest.mark.parametrize(
    ("relevant", "contradicts", "superseded", "kept"),
    [
        (0.45, 0.0, 0.0, True),
        (0.4499, 0.0, 0.0, False),
        (0.9, 0.70, 0.0, False),
        (0.9, 0.6999, 0.0, True),
        (0.9, 0.0, 0.70, False),
        (0.9, 0.0, 0.6999, True),
    ],
)
def test_a_note_is_set_aside_by_typesafes_three_thresholds(relevant, contradicts, superseded, kept):
    assert decisions.keep_note(relevant, contradicts, superseded) is kept


def test_an_answer_of_the_wrong_shape_is_unreadable_never_guessed():
    for answers in ({}, {"acts": {"noul": True}}, {"acts": {"noul": 1.2}}, {"acts": "yes"}):
        with pytest.raises(decisions.Unreadable):
            decisions.read_noul(answers, "acts")
    with pytest.raises(decisions.Unreadable, match="chose 'x', which was not an option"):
        decisions.read_choice({"tool": {"choice": "x", "probabilities": {"x": 1.0}}}, "tool", {"a"})
    # A choice that is not even a name is the model's malformed answer, said as
    # one — never a TypeError the step reports as its own bug.
    with pytest.raises(decisions.Unreadable, match=r"chose \['a'\], which was not an option"):
        decisions.read_choice(
            {"tool": {"choice": ["a"], "probabilities": {"a": 1.0}}}, "tool", {"a"}
        )
    assert decisions.read_choice(
        {"tool": {"choice": "a", "probabilities": {"a": 0.7, "zzz": 0.3}}}, "tool", {"a", "b"}
    ) == ("a", {"a": 0.7})


def test_an_offered_option_with_no_real_probability_is_unreadable_by_name():
    """Never a number invented or hidden: an option we offered, given something
    that is not a probability, makes the answer unreadable and names the option;
    a key nobody offered is dropped unread, whatever it carries."""
    for junk in ("high", 1.5, -0.1, True, None, [0.3]):
        with pytest.raises(
            decisions.Unreadable,
            match="'tool' gave the option 'b' a probability that is not a number between 0 and 1",
        ):
            decisions.read_choice(
                {"tool": {"choice": "a", "probabilities": {"a": 0.7, "b": junk}}},
                "tool",
                {"a", "b"},
            )
    assert decisions.read_choice(
        {"tool": {"choice": "a", "probabilities": {"a": 0.7, "zzz": "junk"}}}, "tool", {"a", "b"}
    ) == ("a", {"a": 0.7})


def test_the_hint_line_is_the_specs_sentence():
    hint = decisions.Hint(tool=SETUP, fit=0.85, gate=0.9)
    assert hint.line() == (
        "A decision model reads the owner's message as needing your tool show_setup_qr "
        "(fit 0.85). Use it if it fits."
    )


def test_the_decision_role_cannot_reach_the_dispatch_funnel():
    """The hint is a request (spec §2) and tests/test_no_approvals.py pins the
    funnel. This module imports nothing of the tool registry or dispatch, so no
    line in it can refuse, reorder or run a call."""
    tree = ast.parse(Path(decisions.__file__).read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            # A relative import (`from . import chat`) has no module name of its
            # own: resolved against this module's package, it is app's too.
            module = importlib.util.resolve_name(
                "." * node.level + (node.module or ""), decisions.__package__
            )
            if module == "app" or module.startswith("app."):
                imported |= {f"{module}.{alias.name}" for alias in node.names}
        elif isinstance(node, ast.Import):
            imported |= {alias.name for alias in node.names if alias.name.startswith("app")}
    assert imported == {"app.peers", "app.traces"}


# -- run(): the whole step, against the gateway ------------------------------


async def test_a_decision_hints_the_tool_and_sets_aside_the_superseded_note(mount_peers):
    gateway = FakeGateway(
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.9, 0.1, 0.1)})
    )
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice(
        hint=decisions.Hint(tool=SETUP, fit=0.85, gate=0.9), keep=(1,)
    )
    meta = _span(turn).meta
    assert meta["outcome"] == "decided"
    assert meta["hint"] == {"tool": SETUP, "fit": 0.85, "gate": 0.9}
    assert meta["shortlist"][0]["tool"] == SETUP
    assert meta["notes_checked"] is True
    assert meta["notes"] == [
        {"path": PATHS[0], "relevant": 0.8, "contradicts": 0.2, "superseded": 0.9, "kept": False},
        {"path": PATHS[1], "relevant": 0.9, "contradicts": 0.1, "superseded": 0.1, "kept": True},
    ]
    assert meta["served_by"] == ["openrouter:~typesafe/jev-latest"]
    assert meta["calls"] == 4
    assert meta["cost_usd"] == 4e-05 and meta["priced_calls"] == 4
    assert "TestFlight" not in json.dumps(meta), "note paths, never note text"
    facts = {json.loads(c["body"]["state"])["current_facts"] for c in gateway.decision_calls[2:]}
    assert facts == {f"Nova has the tool {SETUP}: {tools.REGISTRY[SETUP].description}"}


async def test_every_call_walks_the_decisions_role_under_the_turns_attribution(mount_peers):
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn(kind="eval")

    await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert len(gateway.decision_calls) == 2
    for call in gateway.decision_calls:
        assert call["headers"]["x-nova-role"] == "decisions"
        assert call["headers"]["x-nova-purpose"] == "eval"
        assert call["headers"]["x-nova-turn-id"] == str(turn.id)
        assert "model" not in call["body"], "the decisions chain decides who answers"
        assert json.loads(call["body"]["state"])["owner_message"] == PHONE
        # No kinds stated, none named: the gateway reads that as every kind.
        assert "x-nova-decision-kinds" not in call["headers"]
    assert "kinds" not in _span(turn).meta


# -- the two switches (decision-role spec §6) ---------------------------------


@pytest.mark.parametrize(
    ("kinds", "named"),
    [({"cloud"}, "cloud"), ({"local"}, "local"), ({"local", "cloud"}, "cloud,local")],
)
async def test_every_call_names_the_kinds_of_decision_model_the_owner_allows(
    mount_peers, kinds, named
):
    """Every call, every round: the gateway passes over a link of any other
    kind, in words, and the span keeps what was allowed."""
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(
        app, turn, PHONE, NOTES, PATHS, tools.advertised_tools(), kinds=frozenset(kinds)
    )

    assert advice.hint is not None
    assert len(gateway.decision_calls) == 4
    assert {c["headers"]["x-nova-decision-kinds"] for c in gateway.decision_calls} == {named}
    meta = _span(turn).meta
    assert meta["outcome"] == "decided"
    assert meta["kinds"] == sorted(kinds)


async def test_with_both_decision_models_switched_off_nothing_is_asked_and_the_span_says_so(
    mount_peers,
):
    """No call and no delay: the turn is exactly the turn it was before this
    module existed, and its one `decisions` span says the step is off."""
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(
        app, turn, PHONE, NOTES, PATHS, tools.advertised_tools(), kinds=frozenset()
    )

    assert advice == decisions.Advice()
    assert gateway.decision_calls == []
    span = _span(turn)
    assert span.meta == {
        "outcome": "off",
        "why": "both decision models are switched off in Settings, so none was asked",
        "kinds": [],
        "calls": 0,
        "served_by": [],
    }
    assert span.duration_ms < 100


async def test_with_nothing_left_to_answer_the_step_fails_open_at_once_in_the_gateways_words(
    mount_peers,
):
    """One kind switched off and the chain holding only that kind: the gateway
    answers 503 at once, in words, and the step fails open with them — the
    budget is never waited out."""
    said = (
        "no model in the 'decisions' chain can serve right now — dell-kev:kev-latest: local "
        "decision models are switched off in Settings (alpha)"
    )
    gateway = FakeGateway(
        decision_answer=lambda body: JSONResponse({"error": said}, status_code=503)
    )
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(
        app, turn, PHONE, NOTES, PATHS, tools.advertised_tools(), kinds=frozenset({"cloud"})
    )

    assert advice == decisions.Advice()
    span = _span(turn)
    assert span.meta["outcome"] == "failed_open"
    assert span.meta["reason"] == f"the gateway refused (503): {said}"
    assert span.meta["calls"] == 1
    assert span.duration_ms < 1000, "the 5 s budget is not waited out"


async def test_with_no_decision_model_nothing_is_applied_and_the_span_says_why(mount_peers):
    mount_peers(gateway=FakeGateway())  # 503: the decisions chain is empty
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"].startswith(
        "the gateway refused (503): no model in the 'decisions' chain can serve right now"
    )
    assert "the decisions chain is empty" in meta["reason"]
    assert meta["calls"] == 1 and meta["served_by"] == []


async def test_a_slow_decision_model_costs_the_budget_and_no_more(mount_peers, monkeypatch):
    """Review focus 3, in core: the Dell asleep or cold. The budget ends the
    wait — not the socket — and the turn gets nothing rather than a half."""
    monkeypatch.setattr(decisions, "TURN_BUDGET_S", 0.2)
    hold = asyncio.Event()
    mount_peers(gateway=FakeGateway(decision_answer=decider(), decision_hold=hold))
    turn = _turn()
    try:
        advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())
    finally:
        hold.set()

    assert advice == decisions.Advice()
    span = _span(turn)
    assert span.meta["outcome"] == "failed_open"
    assert span.meta["reason"] == "no decision within the 0.2 s budget"
    assert span.duration_ms < 1000


async def test_an_answer_that_is_not_an_option_is_unreadable_and_fails_open(mount_peers):
    mount_peers(gateway=FakeGateway(decision_answer=decider(tool="no_such_tool")))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    assert _span(turn).meta["reason"] == (
        "a decision model's answer could not be read — 'tool' chose 'no_such_tool', which "
        "was not an option"
    )


async def test_an_answer_that_is_not_json_fails_open(mount_peers):
    mount_peers(
        gateway=FakeGateway(
            decision_answer=lambda body: Response("<html>oops</html>", media_type="text/html")
        )
    )
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    assert _span(turn).meta["reason"] == (
        "a decision model's answer could not be read — the answer was not JSON"
    )


async def test_one_note_check_that_cannot_be_read_drops_the_whole_decision(mount_peers):
    """(plan decision 3) Half a decision is one nobody measured: the hint that
    stage 2 reached is NOT applied when a note check fails; the span keeps it
    under `reached`, as evidence, never as what the turn did."""
    fine = decider()

    def answer(body: dict) -> dict:
        if "relevant" in body["questions"] and "iPhone" in body["state"]:
            return {"relevant": {"type": "noul", "noul": "high"}}
        return fine(body)

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert "'relevant' carried no noul between 0 and 1" in meta["reason"]
    assert "hint" not in meta
    assert meta["reached"]["hint"]["tool"] == SETUP


async def test_without_a_hint_the_notes_stand_and_are_never_asked_about(mount_peers):
    gateway = FakeGateway(decision_answer=decider(fit=0.1))
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "decided" and meta["hint"] is None
    assert meta["notes_checked"] is False
    assert meta["notes_unchecked"] == (
        "no tool hint, so there are no current facts to judge the notes against — they "
        "stand as recalled"
    )
    assert len(gateway.decision_calls) == 2


async def test_a_gate_below_its_threshold_is_no_hint(mount_peers):
    mount_peers(gateway=FakeGateway(decision_answer=decider(gate=0.29)))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice.hint is None
    assert _span(turn).meta["gate"] == 0.29


@pytest.mark.parametrize(
    ("fit", "gate", "hinted"),
    [(0.30, 0.30, True), (0.2999, 0.9, False), (0.9, 0.2999, False)],
)
async def test_the_fit_and_the_gate_are_each_at_least_their_threshold(
    mount_peers, fit, gate, hinted
):
    """The spec's "at least 0.30", both of them, at the boundary."""
    mount_peers(gateway=FakeGateway(decision_answer=decider(fit=fit, gate=gate)))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert (advice.hint is not None) is hinted


async def test_the_hint_is_stage_twos_pick_not_stage_ones_favourite(mount_peers):
    """Stage 1 only shortlists; stage 2, asked about each candidate's full
    description, is the answer. Here they disagree, and stage 2 wins."""
    ranked = decider()

    def answer(body: dict) -> dict:
        if "pick" in body["questions"]:
            runner_up = list(body["questions"]["pick"]["criteria"])[1]
            return decider(tool=runner_up)(body)
        return ranked(body)

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    meta = _span(turn).meta
    assert meta["shortlist"][0]["tool"] == SETUP
    runner_up = meta["shortlist"][1]["tool"]
    assert meta["pick"] == runner_up
    assert advice.hint == decisions.Hint(tool=runner_up, fit=0.85, gate=0.9)


async def test_a_note_check_the_gateway_refuses_drops_the_whole_decision_in_its_words(
    mount_peers,
):
    fine = decider()

    def answer(body: dict):
        if "relevant" in body["questions"] and "iPhone" in body["state"]:
            return JSONResponse({"error": "openrouter answered 502"}, status_code=502)
        return fine(body)

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"] == "the gateway refused (502): openrouter answered 502"
    assert meta["reached"]["hint"]["tool"] == SETUP
    assert meta["calls"] == 4


async def test_a_fallback_link_is_on_the_span_with_the_gateways_reason(mount_peers):
    """Review focus 3, as the trace reads it: the first link walled (the Dell
    asleep), the gateway answers from the next and says why in X-Nova-Route.
    The span keeps who served and that reason, in the gateway's words, once."""
    fine = decider()
    why = (
        "fell back to link 2 (openrouter:~typesafe/jev-latest) — dell-kev:kev-latest: "
        "unreachable; answered by the next link"
    )

    def answer(body: dict):
        return JSONResponse(
            {"answers": fine(body), "usage": {"cost_usd": 1e-05}},
            headers={
                "X-Nova-Served-By": "openrouter:~typesafe/jev-latest",
                "X-Nova-Route": f"role=decisions;link=2;reason={quote(why, safe='')}",
            },
        )

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice.hint is not None
    meta = _span(turn).meta
    assert meta["served_by"] == ["openrouter:~typesafe/jev-latest"]
    assert meta["fell_back"] == [why]


# -- every way the step ends, said on the span -------------------------------


async def _until_calls(gateway: FakeGateway, count: int) -> None:
    """Wait, bounded, until `count` decision calls have reached the fake."""
    for _ in range(500):
        if len(gateway.decision_calls) >= count:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"only {len(gateway.decision_calls)} of {count} decision calls arrived")


@pytest.mark.parametrize(
    ("held", "calls", "priced"),
    [("pick", 2, 1), ("relevant", 4, 2)],
    ids=["at-stage-two", "mid-note-check"],
)
async def test_the_budget_bounds_every_round_not_only_the_first(
    mount_peers, monkeypatch, held, calls, priced
):
    """The budget is the whole step's: stage 2 held, or every note check held,
    and the step still ends at the budget, fails open and says so, with how far
    it got. Bounded from outside as well, so a round moved out from under the
    budget fails here in seconds instead of hanging on the held call."""
    monkeypatch.setattr(decisions, "TURN_BUDGET_S", 0.2)
    hold = asyncio.Event()
    gateway = FakeGateway(decision_answer=decider(), decision_hold=hold, decision_hold_on=held)
    mount_peers(gateway=gateway)
    turn = _turn()
    try:
        advice = await asyncio.wait_for(
            decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools()), 3.0
        )
    finally:
        hold.set()

    assert advice == decisions.Advice()
    span = _span(turn)
    assert span.meta["outcome"] == "failed_open"
    assert span.meta["reason"] == "no decision within the 0.2 s budget"
    assert span.duration_ms < 1000
    assert span.meta["calls"] == calls and span.meta["priced_calls"] == priced
    assert span.meta["reached"]["shortlist"][0]["tool"] == SETUP
    assert ("hint" in span.meta["reached"]) is (held == "relevant")
    assert "hint" not in span.meta


async def test_a_cancelled_turn_says_so_with_the_calls_it_made_and_their_cost(mount_peers):
    """The turn itself cancelled mid-step (a stop, a shutdown): the cancellation
    is never swallowed, but the span says so and keeps the calls made, what they
    cost, and how far the step got."""
    hold = asyncio.Event()
    gateway = FakeGateway(decision_answer=decider(), decision_hold=hold, decision_hold_on="pick")
    mount_peers(gateway=gateway)
    turn = _turn()
    step = asyncio.create_task(
        decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())
    )
    try:
        await _until_calls(gateway, 2)
        step.cancel()
        with pytest.raises(asyncio.CancelledError):
            await step
    finally:
        hold.set()

    meta = _span(turn).meta
    assert meta["outcome"] == "cancelled"
    assert meta["why"] == "the turn was cancelled during the decision step"
    assert meta["calls"] == 2
    assert meta["cost_usd"] == 1e-05 and meta["priced_calls"] == 1
    assert meta["served_by"] == ["openrouter:~typesafe/jev-latest"]
    assert meta["reached"]["shortlist"][0]["tool"] == SETUP
    assert "hint" not in meta


async def test_a_probability_the_answer_never_gave_is_absent_never_zero(mount_peers):
    fine = decider()

    def answer(body: dict) -> dict:
        out = fine(body)
        if "tool" in body["questions"]:
            del out["tool"]["probabilities"][decisions.NONE]
        return out

    mount_peers(gateway=FakeGateway(decision_answer=answer))
    turn = _turn()

    await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert _span(turn).meta["none_p"] is None


async def test_notes_and_paths_that_do_not_line_up_fail_open_before_any_call(mount_peers):
    """A caller bug, stated: each verdict is filed by its note's path, and a
    guessed path would file one note's verdict under another."""
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS[:1], tools.advertised_tools())

    assert advice == decisions.Advice()
    assert gateway.decision_calls == []
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"] == (
        "the recalled notes and their paths do not line up (notes: 2, paths: 1) — each "
        "verdict is filed by its note's path, so nothing was asked (a caller bug)"
    )
    assert meta["calls"] == 0


async def test_a_turn_that_advertises_no_tools_asks_nothing(mount_peers):
    gateway = FakeGateway(decision_answer=decider())
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, [])

    assert advice == decisions.Advice()
    assert gateway.decision_calls == []
    meta = _span(turn).meta
    assert meta["outcome"] == "decided" and meta["hint"] is None
    assert meta["why"] == "the turn advertises no tools, so there is nothing to choose between"
    assert meta["calls"] == 0


async def test_none_winning_stage_one_hints_nothing_and_the_notes_stand(mount_peers):
    """`none` is a stage-1 option and never a stage-2 candidate: the shortlist is
    tools only, and none's probability rides on the span as `none_p`. A model
    that reads the message as talk (none first, the action gate low, no
    candidate fitting) hints nothing, and with no hint the notes stand unasked.
    As built, `none` alone does not end the question: stage 2 is still asked,
    and the gate and the fit decide."""

    def answer(body: dict) -> dict:
        questions = body["questions"]
        if "tool" in questions:
            offered = [name for name in questions["tool"]["criteria"] if name != "none"]
            return {
                "tool": {
                    "type": "choice",
                    "choice": "none",
                    "probabilities": {"none": 0.7, **dict.fromkeys(offered, 0.3 / len(offered))},
                },
                "acts": {"type": "noul", "noul": 0.1},
            }
        short = list(questions["pick"]["criteria"])
        return {
            "pick": {
                "type": "choice",
                "choice": short[0],
                "probabilities": dict.fromkeys(short, 1 / len(short)),
            },
            **{f"fit{index}": {"type": "noul", "noul": 0.1} for index in range(len(short))},
        }

    gateway = FakeGateway(decision_answer=answer)
    mount_peers(gateway=gateway)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "decided" and meta["hint"] is None
    assert meta["none_p"] == 0.7
    assert all(entry["p"] < meta["none_p"] for entry in meta["shortlist"])
    assert "none" not in gateway.decision_calls[1]["body"]["questions"]["pick"]["criteria"]
    assert meta["notes_checked"] is False
    assert len(gateway.decision_calls) == 2, "stage 2 is still asked; no note is"


async def test_a_bug_in_the_step_is_logged_and_fails_open_in_words(
    mount_peers, monkeypatch, caplog
):
    def broken(*args, **kwargs):
        raise RuntimeError("the shortlist broke")

    monkeypatch.setattr(decisions, "shortlist", broken)
    mount_peers(gateway=FakeGateway(decision_answer=decider()))
    turn = _turn()

    with caplog.at_level(logging.ERROR, logger="core"):
        advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"] == "the decision step failed — RuntimeError: the shortlist broke"
    assert "the decision step raised" in caplog.text


async def test_a_gateway_that_cannot_be_reached_fails_open_in_the_transports_words(
    mount_peers,
):
    mount_peers(gateway=FakeGateway(decision_answer=decider()))

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    app.state.peer_transports[GATEWAY_URL] = httpx.MockTransport(refuse)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, NOTES, PATHS, tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"] == "the gateway could not be reached — ConnectError: connection refused"
    assert meta["calls"] == 1 and meta["served_by"] == []


async def test_an_unconfigured_gateway_link_fails_open_and_names_the_setting(monkeypatch):
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    monkeypatch.delenv("CORE_GATEWAY_TOKEN", raising=False)
    turn = _turn()

    advice = await decisions.run(app, turn, PHONE, (), (), tools.advertised_tools())

    assert advice == decisions.Advice()
    meta = _span(turn).meta
    assert meta["outcome"] == "failed_open"
    assert meta["reason"] == "the gateway link is not configured — GATEWAY_URL is unset"
    assert meta["calls"] == 0
