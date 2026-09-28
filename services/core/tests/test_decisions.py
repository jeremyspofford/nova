"""decisions.py — the decision role's two questions (decision-role spec §2).

Pins, with no database: the options are exactly the tools the turn advertises,
each with its full registry description (a tool registered tomorrow is an
option by that fact alone), plus `none`; stage 2 asks about stage 1's top three,
quoting each full description; TypeSafe's thresholds, at their boundaries; an
answer of the wrong shape is unreadable, never guessed; the hint line is the
spec's sentence; the module cannot reach the dispatch funnel. And through a fake
gateway: a decision hints the tool and sets aside the superseded note, recording
paths and never note text; the hint is stage 2's pick; every call walks the
decisions role under the turn's attribution and names no model; a fallback link
is on the span in the gateway's words; no decision model, the budget, an
unreadable answer and a failed or refused note check each leave nothing applied
and say why; with no hint the notes stand unasked."""

from __future__ import annotations

import ast
import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import pytest
from starlette.responses import JSONResponse, Response

from app import decisions, tools, traces
from app.main import app
from app.tools.base import Tool
from tests.fakes import FakeGateway

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
        if isinstance(node, ast.ImportFrom) and (node.module or "").startswith("app"):
            imported |= {f"{node.module}.{alias.name}" for alias in node.names}
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
