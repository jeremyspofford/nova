"""The decision role: before she answers, a decision model says which tool the
owner's message needs and which recalled notes still hold.

Spec: docs/plans/rebuild/decision-role/spec.md §2 (owner-approved 2026-09-27/28).
The recipes are TypeSafe's skill-suggestion cookbook (the tool hint) and its
RAG-passage cookbook (the recall check); both were measured on the S47 setup
case — 3/3 with Jev, 3/3 with Kev-4B — before this was written.

THE TOOL HINT. Stage 1 is one request: a `choice` over every tool this turn
advertises, each with its FULL registry description (never a truncated line),
plus `none`, and one `noul` gate — does answering require doing, showing or
looking something up? Stage 2 is a second request: a `choice` over stage 1's
top three tools (never `none`, whose probability is only recorded, as
`none_p`) and one fit `noul` per candidate, each quoting that candidate's full
description. The stage-2 pick becomes a hint when its fit is at least FIT_MIN
and the gate at least GATE_MIN; a hint is ONE system line in her turn
(Hint.line). It is a request: she still decides, and every guard still judges
what she writes.

THE RECALL CHECK. Only when there is a hint (plan decision 2): the current
facts a note is judged against ARE the hinted tool's full description, and
with no hint there is nothing current to judge a stale note by. Each note is
one request of three separate nouls — relevant, contradicts, superseded —
over one state holding the message, the note and the facts; all notes at
once. A note is set aside when relevant < RELEVANT_MIN, contradicts >=
CONTRADICTS_MAX or superseded >= SUPERSEDED_MAX — TypeSafe's starting points;
tune them on the eval corpus, never on one message.

DERIVED, NEVER LISTED. The options are the tools the turn advertises, read off
the very array the model is sent; the facts are the registry's own words.
Nothing here names a tool.

FAIL-OPEN, AND SAID. A decision is applied whole or not at all (plan decision
3). No decision model (the decisions chain is empty, or nothing in it can run),
a refusal, an answer that cannot be read, the per-turn budget running out, or
notes handed in without their paths (a caller bug) leaves the turn exactly as
it was before this module existed — no hint, every note — and the `decisions`
span says which. A cancellation of the turn itself is said on the span too,
then passed on, never swallowed; either way the span keeps the calls made and
what they cost.

WHAT IT NEVER DOES. Refuse, reorder or rewrite a tool call, or touch the
dispatch funnel (tests/test_no_approvals.py pins it; this module imports
nothing of app.tools). Run on a scheduled firing, a drained queue or an agent's
turn (chat._run_turn's `decide`).
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field

import httpx

from app import peers, traces

logger = logging.getLogger("core")

#: The routing role these calls walk — the gateway's routing.DECISIONS_ROLE.
ROLE = "decisions"
#: (plan decision 6) The whole step's wall-clock budget per turn — "5 s to start"
#: (spec §2). Past it the turn runs as if there were no decision model.
TURN_BUDGET_S = 5.0
#: One call's own timeouts; the budget above bounds the whole step.
CALL_TIMEOUT = httpx.Timeout(connect=2.0, read=5.0, write=2.0, pool=2.0)
#: TypeSafe's skill-suggestion thresholds (FITS_THRESHOLD, GATE_THRESHOLD).
FIT_MIN = 0.30
GATE_MIN = 0.30
#: TypeSafe's RAG-passage thresholds, per note.
RELEVANT_MIN = 0.45
CONTRADICTS_MAX = 0.70
SUPERSEDED_MAX = 0.70
#: Stage 2 weighs stage 1's top three (TypeSafe's beam width).
SHORTLIST = 3
#: How much of one note a check sends — the spike's measured cut.
NOTE_CHARS = 3000
#: The option that means "no tool": the reply only talks.
NONE = "none"
NONE_MEANS = "No tool: the reply only talks, from knowledge or the conversation."
#: Who the decision model is told the assistant is (the measured wording).
ASSISTANT = "Nova, a household AI assistant with tools"
#: The span's outcomes: a decision applied whole, none applied (fail-open, with
#: the reason), or the turn itself cancelled while the step ran.
DECIDED = "decided"
FAILED_OPEN = "failed_open"
CANCELLED = "cancelled"
CANCELLED_WHY = "the turn was cancelled during the decision step"
NO_HINT_NO_FACTS = (
    "no tool hint, so there are no current facts to judge the notes against — they "
    "stand as recalled"
)
GATE_QUESTION = (
    "Does answering the owner's message require Nova to do, show or look up something, "
    "rather than only talk?"
)
NOTE_QUESTIONS = {
    "relevant": {
        "type": "noul",
        "instructions": "Does the recalled note address the subject of the owner's message?",
    },
    "contradicts": {
        "type": "noul",
        "instructions": "Does the recalled note contradict the current facts about how Nova works?",
    },
    "superseded": {
        "type": "noul",
        "instructions": "Is the advice in the recalled note replaced by something the current "
        "facts say Nova can now do?",
    },
}


class Unanswered(RuntimeError):
    """No decision came back: no decision model, a refusal, a transport failure
    — in the gateway's own words."""


class Unreadable(ValueError):
    """An answer that is not the shape its question asked for."""


@dataclass(frozen=True)
class Hint:
    tool: str
    fit: float
    gate: float

    def line(self) -> str:
        """The one line in her turn — the spec's sentence (§2)."""
        return (
            f"A decision model reads the owner's message as needing your tool {self.tool} "
            f"(fit {self.fit:.2f}). Use it if it fits."
        )

    def as_meta(self) -> dict:
        return {"tool": self.tool, "fit": round(self.fit, 4), "gate": round(self.gate, 4)}


@dataclass(frozen=True)
class NoteVerdict:
    path: str
    relevant: float
    contradicts: float
    superseded: float

    @property
    def kept(self) -> bool:
        return keep_note(self.relevant, self.contradicts, self.superseded)

    def as_meta(self) -> dict:
        """By PATH, never text: the note already lives in memory."""
        return {
            "path": self.path,
            "relevant": round(self.relevant, 4),
            "contradicts": round(self.contradicts, 4),
            "superseded": round(self.superseded, 4),
            "kept": self.kept,
        }


@dataclass(frozen=True)
class Advice:
    """What the turn applies: a hint or None, and the indexes of the notes to
    keep — None leaves the notes exactly as recalled."""

    hint: Hint | None = None
    keep: tuple[int, ...] | None = None


@dataclass
class Calls:
    """What each call this turn learned about who answered — for the span."""

    count: int = 0
    served_by: list[str] = field(default_factory=list)
    fell_back: list[str] = field(default_factory=list)
    cost_usd: float = 0.0
    priced: int = 0

    def note(self, response: httpx.Response) -> None:
        served = response.headers.get("x-nova-served-by")
        if served and served not in self.served_by:
            self.served_by.append(served)
        route = peers.route_fields(response.headers.get("x-nova-route"))
        reason = route.get("reason")
        if route.get("link", "1") != "1" and reason and reason not in self.fell_back:
            self.fell_back.append(reason)

    def note_cost(self, usage: object) -> None:
        cost = usage.get("cost_usd") if isinstance(usage, dict) else None
        if isinstance(cost, int | float) and not isinstance(cost, bool):
            self.cost_usd += float(cost)
            self.priced += 1

    def meta(self) -> dict:
        out: dict = {"calls": self.count, "served_by": list(self.served_by)}
        if self.fell_back:
            out["fell_back"] = list(self.fell_back)
        if self.priced:
            out["cost_usd"] = round(self.cost_usd, 6)
            out["priced_calls"] = self.priced
        return out


# -- the questions -------------------------------------------------------------


def tool_descriptions(advertised: Sequence[dict]) -> dict[str, str]:
    """{name: full description} for every tool the turn advertises, in its
    order — read off the very array the model is sent, so a tool registered
    tomorrow is an option by that fact alone."""
    out: dict[str, str] = {}
    for entry in advertised:
        function = entry.get("function") if isinstance(entry, dict) else None
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            out[function["name"]] = str(function.get("description") or "")
    return out


def stage_one(descriptions: dict[str, str]) -> dict:
    return {
        "tool": {
            "type": "choice",
            "instructions": "Which of Nova's tools would a correct reply to the owner's "
            "message use?",
            "criteria": {**descriptions, NONE: NONE_MEANS},
        },
        "acts": {"type": "noul", "instructions": GATE_QUESTION},
    }


def stage_two(shortlist: Sequence[str], descriptions: dict[str, str]) -> dict:
    questions: dict = {
        "pick": {
            "type": "choice",
            "instructions": "Which of these tools does the owner's message need?",
            "criteria": {name: descriptions[name] for name in shortlist},
        }
    }
    for index, name in enumerate(shortlist):
        questions[f"fit{index}"] = {
            "type": "noul",
            "instructions": f"Does the tool '{name}' do the specific thing the owner's "
            f"message asks for? It is described as: {descriptions[name]}",
        }
    return questions


def shortlist(
    probabilities: dict[str, float], descriptions: dict[str, str], k: int = SHORTLIST
) -> list[str]:
    """Stage 1's top `k` advertised tools by probability — never `none`."""
    ranked = sorted(
        (name for name in probabilities if name in descriptions),
        key=lambda name: (-probabilities[name], name),
    )
    return ranked[:k]


def keep_note(relevant: float, contradicts: float, superseded: float) -> bool:
    return (
        relevant >= RELEVANT_MIN and contradicts < CONTRADICTS_MAX and superseded < SUPERSEDED_MAX
    )


def current_facts(hint: Hint, descriptions: dict[str, str]) -> str:
    return f"Nova has the tool {hint.tool}: {descriptions[hint.tool]}"


def note_state(message: str, note: str, facts: str) -> str:
    return json.dumps(
        {"owner_message": message, "recalled_note": note[:NOTE_CHARS], "current_facts": facts}
    )


def request_body(state: str, questions: dict) -> dict:
    """One call's body: the state and the questions, and NO model — the
    decisions chain decides who answers (plan decision 9)."""
    return {"state": state, "questions": questions}


# -- reading an answer ---------------------------------------------------------


def _is_probability(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and 0.0 <= value <= 1.0


def read_noul(answers: dict, key: str) -> float:
    entry = answers.get(key)
    value = entry.get("noul") if isinstance(entry, dict) else None
    if not _is_probability(value):
        raise Unreadable(f"{key!r} carried no noul between 0 and 1")
    return float(value)


def read_choice(answers: dict, key: str, options: Collection[str]) -> tuple[str, dict[str, float]]:
    entry = answers.get(key)
    if not isinstance(entry, dict):
        raise Unreadable(f"{key!r} is missing")
    chosen = entry.get("choice")
    # A name first: a list or an object here would raise TypeError on the
    # membership test, and a malformed answer must read as one.
    if not isinstance(chosen, str) or chosen not in options:
        raise Unreadable(f"{key!r} chose {chosen!r}, which was not an option")
    stated = entry.get("probabilities")
    if not isinstance(stated, dict):
        raise Unreadable(f"{key!r} carried no probabilities")
    probabilities: dict[str, float] = {}
    for name, value in stated.items():
        if name not in options:
            continue  # a key nobody offered is dropped unread
        if not _is_probability(value):
            # Never a number invented or hidden: an offered option with no real
            # probability makes the whole answer unreadable, by name.
            raise Unreadable(
                f"{key!r} gave the option {name!r} a probability that is not a number "
                "between 0 and 1"
            )
        probabilities[name] = float(value)
    if not probabilities:
        raise Unreadable(f"{key!r} carried no probability for any option")
    return chosen, probabilities


# -- the calls -----------------------------------------------------------------


def _detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:300]
    if isinstance(body, dict) and isinstance(body.get("error"), str):
        return body["error"][:300]
    return response.text[:300]


async def ask(
    client: httpx.AsyncClient, turn: traces.Turn, state: str, questions: dict, calls: Calls
) -> dict:
    """One decision request through the gateway: the answers, or a stated
    Unanswered / Unreadable — never a guess at a missing answer."""
    calls.count += 1
    try:
        response = await client.post(
            "/v1/systemone",
            json=request_body(state, questions),
            headers=peers.attribution_headers(turn, traces.purpose_of(turn), ROLE),
        )
    except httpx.HTTPError as exc:
        raise Unanswered(f"the gateway could not be reached — {peers.reason(exc)}") from exc
    calls.note(response)
    if response.status_code != 200:
        raise Unanswered(f"the gateway refused ({response.status_code}): {_detail(response)}")
    try:
        body = response.json()
    except ValueError as exc:
        raise Unreadable("the answer was not JSON") from exc
    if not isinstance(body, dict) or not isinstance(body.get("answers"), dict):
        raise Unreadable("the answer carried no answers object")
    calls.note_cost(body.get("usage"))
    return body["answers"]


async def decide(
    app,
    turn: traces.Turn,
    message: str,
    notes: Sequence[str],
    paths: Sequence[str],
    advertised: Sequence[dict],
    calls: Calls,
    meta: dict,
) -> Advice:
    """The whole decision — or an exception, never half of one. `meta` fills as
    each answer arrives, so a step that fails still shows how far it got.
    (plan decision 1) Three rounds: stage 1, stage 2, then every note at once."""
    descriptions = tool_descriptions(advertised)
    if not descriptions:
        meta["hint"] = None
        meta["why"] = "the turn advertises no tools, so there is nothing to choose between"
        return Advice()
    state = json.dumps({"assistant": ASSISTANT, "owner_message": message})
    async with peers.client(app, peers.GATEWAY, CALL_TIMEOUT) as client:
        first = await ask(client, turn, state, stage_one(descriptions), calls)
        _chosen, probabilities = read_choice(first, "tool", {*descriptions, NONE})
        gate = read_noul(first, "acts")
        short = shortlist(probabilities, descriptions)
        if not short:
            raise Unreadable("stage 1 gave no probability to any advertised tool")
        meta["shortlist"] = [{"tool": name, "p": round(probabilities[name], 4)} for name in short]
        # Not stated is not zero: an answer that gave `none` no probability is
        # recorded as having given none.
        none_p = probabilities.get(NONE)
        meta["none_p"] = round(none_p, 4) if none_p is not None else None
        meta["gate"] = round(gate, 4)
        second = await ask(client, turn, state, stage_two(short, descriptions), calls)
        pick, _probabilities = read_choice(second, "pick", set(short))
        fits = {name: read_noul(second, f"fit{index}") for index, name in enumerate(short)}
        meta["pick"] = pick
        meta["fits"] = {name: round(value, 4) for name, value in fits.items()}
        hint = (
            Hint(tool=pick, fit=fits[pick], gate=gate)
            if fits[pick] >= FIT_MIN and gate >= GATE_MIN
            else None
        )
        meta["hint"] = hint.as_meta() if hint is not None else None
        if not notes:
            return Advice(hint=hint)
        if hint is None:
            meta["notes_checked"] = False
            meta["notes_unchecked"] = NO_HINT_NO_FACTS
            return Advice()
        facts = current_facts(hint, descriptions)
        answers = await asyncio.gather(
            *(
                ask(client, turn, note_state(message, note, facts), NOTE_QUESTIONS, calls)
                for note in notes
            ),
            return_exceptions=True,
        )
        failed = next((answer for answer in answers if isinstance(answer, BaseException)), None)
        if failed is not None:
            raise failed
        verdicts = [
            NoteVerdict(
                path=path,
                relevant=read_noul(answer, "relevant"),
                contradicts=read_noul(answer, "contradicts"),
                superseded=read_noul(answer, "superseded"),
            )
            # run() refuses notes and paths that do not line up; strict says so again.
            for answer, path in zip(answers, paths, strict=True)
        ]
        meta["notes_checked"] = True
        meta["notes"] = [verdict.as_meta() for verdict in verdicts]
        return Advice(
            hint=hint, keep=tuple(index for index, verdict in enumerate(verdicts) if verdict.kept)
        )


def _fail_open(span, reason: str) -> Advice:
    span.meta["outcome"] = FAILED_OPEN
    span.meta["reason"] = reason
    return Advice()


async def run(
    app,
    turn: traces.Turn,
    message: str,
    notes: Sequence[str],
    paths: Sequence[str],
    advertised: Sequence[dict],
) -> Advice:
    """The decision step as a turn runs it: under ONE `decisions` span, inside
    TURN_BUDGET_S, fail-open with the reason on the span. Never raises a
    failure — it costs the hint, never the turn — and passes a cancellation of
    the turn on, after saying so on the span. However the step ends, the span
    keeps the calls it made and what they cost. The span's own duration is
    the step's latency."""
    calls = Calls()
    reached: dict = {}
    with turn.span("decisions") as span:
        span.meta["budget_s"] = TURN_BUDGET_S
        if len(paths) != len(notes):
            # A caller bug, said rather than papered over: each verdict is filed
            # by its note's path, and a guessed path would file one note's
            # verdict under another.
            logger.error(
                "decisions: turn %s passed %d recalled notes with %d paths",
                turn.id,
                len(notes),
                len(paths),
            )
            span.meta.update(calls.meta())
            return _fail_open(
                span,
                f"the recalled notes and their paths do not line up (notes: {len(notes)}, "
                f"paths: {len(paths)}) — each verdict is filed by its note's path, so nothing "
                "was asked (a caller bug)",
            )
        try:
            advice = await asyncio.wait_for(
                decide(app, turn, message, notes, paths, advertised, calls, reached),
                TURN_BUDGET_S,
            )
        except asyncio.CancelledError:
            # The turn itself is being cancelled: said here, then passed on, never
            # swallowed — a swallowed cancellation keeps a stopped turn running.
            span.meta["outcome"] = CANCELLED
            span.meta["why"] = CANCELLED_WHY
            raise
        except TimeoutError:
            advice = _fail_open(span, f"no decision within the {TURN_BUDGET_S:g} s budget")
        except Unanswered as exc:
            advice = _fail_open(span, str(exc))
        except Unreadable as exc:
            advice = _fail_open(span, f"a decision model's answer could not be read — {exc}")
        except peers.PeerUnconfigured as exc:
            advice = _fail_open(span, f"the gateway link is not configured — {exc}")
        except Exception as exc:  # a bug: on the span and in the log, never the turn's end
            logger.exception("decisions: the decision step raised for turn %s", turn.id)
            advice = _fail_open(span, f"the decision step failed — {peers.reason(exc)}")
        else:
            span.meta["outcome"] = DECIDED
            span.meta.update(reached)
        finally:
            if span.meta.get("outcome") != DECIDED and reached:
                # How far it got before it failed or was cancelled — evidence for
                # tuning, never applied.
                span.meta["reached"] = reached
            span.meta.update(calls.meta())
    return advice
