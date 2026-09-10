"""Checking a note against the world before she answers from it.

Owner ruling, 2026-09-10, in his words: hardware specs "can be found ad hoc
and shouldn't be written. Or if they're written, that's fine for comparing
if we ever update our system and have that data stored, but it should still
treat the ad-hoc command as truth and be done first. Things like that. But
I can't think of every edge case so we need to build nova to be able to
think on her feet."

There are two kinds of fact in her memory and only one of them is an answer.
A preference, a decision, something he said once — memory IS the source, and
nothing can check it. A machine's disk, what models are installed, what
timers exist — she has a tool that knows RIGHT NOW, and a note about it is
history. Until this module, the difference reached her as a sentence in the
prompt ("not the current answer — device_info answers this now, ask it
first"), which is a request, not a control: a model under pressure answers
from the conversation, and reciting 24GB from a note written before the card
was changed is exactly the failure the sentence was asking her to avoid.

So the BACKEND runs the check. A recalled note that names a live source is
checked before she is asked anything, and she is handed both — what he said,
dated, and what the machine says now. She never answers from a stale note
because a current one is always beside it.

**The one thing that is not her judgement**, stated because it is the failure
this codebase keeps catching: WHICH SOURCE WINS is code. `lines()` puts the
live answer first and labels the note as history. Her feet decide how to say
it; the ordering is not up for negotiation.

**And what is checked is not what is dispatched.** Nothing here decides
whether SHE may call something — every tool in the registry is hers, always,
and dispatch is untouched. This answers a different question the codebase has
never had to ask: what may the backend run when NOBODY asked it to.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app import tools
from app.tools import schema

logger = logging.getLogger(__name__)

# The whole set of live checks a turn may run, and how long they get between
# them. Both are bounds on a cost the owner never asked for: recall can return
# ten notes, and ten notes must not become ten calls on the path to an answer.
MAX_CHECKS = 3
CHECK_TIMEOUT = 8.0
# What of a check's result reaches the prompt. A live answer is a supporting
# fact next to a note, not the turn's content, and device_list_files can be
# thousands of lines.
MAX_RESULT_CHARS = 600
# The same head length a call she made records, so a check reads identically
# in the trace to the call it is.
SPAN_RESULT_HEAD_CHARS = 400


# Which tools the backend may run on its own initiative.
#
# `Tool.reads_only` is NECESSARY — a check must never change anything — and it
# is NOT SUFFICIENT, which is the whole reason this set is written down
# separately instead of derived from the flag alone. fetch_url and web_search
# change nothing and are honestly reads_only, and both take an argument that
# decides WHO GETS CONTACTED. The arguments on a note were written by a model
# from a transcript. A stored fetch_url would make every recall that surfaces
# that note reach an address nobody vetted, on the owner's network, unasked.
#
# So the line is: a check may reach only things this system already knows
# about. A device that is PAIRED, a path under the workspace root, a model, a
# role, a timer — each of those arguments is checked by the executor against
# live local state, so the worst a wrong argument costs is a stated failure.
# A URL and a search query are checked against nothing.
#
# The safe default is exclusion: a tool added tomorrow is not in here and so
# is not run unasked, and `test_live_facts` reddens until somebody classifies
# it deliberately rather than letting it inherit either answer.
AUTO_RUN = frozenset(
    {
        "device_info",
        "device_list",
        "device_list_apps",
        "device_list_files",
        "device_read_file",
        "get_time",
        "list_agents",
        "list_timers",
        "model_catalog_search",
        "model_check_update",
        "route_explain",
        "spend_report",
        "workspace_list_files",
        "workspace_read_file",
    }
)

# reads_only, and deliberately NOT auto-run — each with the reason, because an
# exclusion nobody can explain gets deleted by the next person who reads it.
NOT_AUTO_RUN = {
    "fetch_url": "the note would choose the address; nothing checks it against this system",
    "web_search": "the note would choose the query; a search reaches whoever answers it",
    "memory_search": "the note came out of memory, so checking it against memory proves nothing",
}


@dataclass(frozen=True)
class LiveCall:
    """A call a recalled note says answers its fact now."""

    tool: str
    args: dict[str, Any]
    # The note this came off, for the line that reports the check. Its title,
    # never its body: this is a label, not a second copy of the note.
    note: str

    def key(self) -> tuple:
        """Two notes about one subject name the same call — run it once."""
        return (self.tool, tuple(sorted((k, repr(v)) for k, v in self.args.items())))


def runnable(call: LiveCall) -> str | None:
    """Why this call may NOT be run unasked, or None when it may.

    Every condition is read off the live registry, so registering a tool and
    adding it to AUTO_RUN is the whole of granting a check — there is no
    second list to remember. A refusal returns its reason rather than a bare
    False because the caller states it: a check that did not happen must never
    be indistinguishable from one that passed.
    """
    tool = tools.REGISTRY.get(call.tool)
    if tool is None:
        return f"there is no tool named {call.tool!r}"
    if not tool.reads_only:
        return f"{call.tool} changes something, and nothing runs unasked that does"
    if call.tool not in AUTO_RUN:
        return NOT_AUTO_RUN.get(
            call.tool, f"{call.tool} is not one of the checks the backend runs on its own"
        )
    problem = schema.validate(tool.parameters, call.args)
    if problem is not None:
        return f"the stored arguments do not fit {call.tool}: {problem}"
    return None


@dataclass(frozen=True)
class Checked:
    """One live check that was attempted, and what came back."""

    call: LiveCall
    result: str | None = None
    # Why there is no result: refused before running, failed, or timed out.
    problem: str | None = None

    @property
    def ok(self) -> bool:
        return self.result is not None


def _clip(text: str) -> str:
    text = text.strip()
    if len(text) <= MAX_RESULT_CHARS:
        return text
    # Said, not silently truncated: a cut-off listing that reads as complete is
    # how "those are all the files" becomes false.
    return f"{text[:MAX_RESULT_CHARS].rstrip()} […cut off at {MAX_RESULT_CHARS} characters]"


async def _run_one(call: LiveCall, turn, ctx) -> Checked:
    """One check, on its OWN tool span, under its own timeout.

    THE SPAN IS A REAL TOOL SPAN — kind "tool", named for the tool, carrying
    args, ok and result_head exactly as `chat._run_tool` writes them — and
    that is deliberate, because the guards read spans to decide whether a
    claim is backed. A listing this check produced is a real listing that
    really ran this turn, and if it were filed under a private kind of its own
    the presented-listing guard would "correct" her for showing it. A guard
    that contradicts a true statement is the guard becoming the liar.

    `unasked` is what keeps that honest in the other direction: the trace must
    never let a call the BACKEND made read as one she chose to make.

    Its own timeout rather than one over the whole gather: a check that
    finished must be reported as finished, and cancelling a completed answer
    to report it as a timeout is under-claiming, which is still lying.
    """
    with turn.span("tool", call.tool) as span:
        span.meta["args_redacted"] = dict(call.args)
        # Not her call. Nobody asked for it; a recalled note named it and the
        # backend ran it before she was asked anything.
        span.meta["unasked"] = True
        span.meta["ok"] = False
        span.meta["result_head"] = "(the turn ended before this check returned)"
        try:
            async with asyncio.timeout(CHECK_TIMEOUT):
                result, ok = await tools.dispatch(call.tool, call.args, ctx)
        except TimeoutError:
            problem = f"the check did not answer within {CHECK_TIMEOUT:g}s"
            span.meta["error"] = problem
            span.meta["result_head"] = problem
            return Checked(call, problem=problem)
        span.meta["ok"] = ok
        span.meta["result_head"] = result[:SPAN_RESULT_HEAD_CHARS]
        if not ok:
            span.meta["error"] = result[:SPAN_RESULT_HEAD_CHARS]
            return Checked(call, problem=_clip(result))
    return Checked(call, result=_clip(result))


def ephemeral(checked: list[Checked]) -> bool:
    """Did any check that RAN read something that goes stale?

    The turn is not ingested into long-term memory when it did (`Tool.ephemeral`
    — the same rule a call she made obeys). Without this the loop closes on
    itself: a note says device_info answers the VRAM question, the backend runs
    it, she quotes the figure, the exchange is ingested, and next month recall
    returns HER SENTENCE asserting that figure as current — a fresh-looking
    note with no live source, which is precisely the staleness the check was
    added to kill, laundered through her own reply.
    """
    return any(
        check.ok and (tool := tools.REGISTRY.get(check.call.tool)) is not None and tool.ephemeral
        for check in checked
    )


async def run(calls: list[LiveCall], turn, ctx) -> list[Checked]:
    """Run the checks the notes named, concurrently, each under its own budget.

    Fail-open, never quiet. A check that refuses, fails or times out returns a
    Checked carrying the reason, and `lines()` prints it beside the note —
    because the entire point is that a stale note cannot pass as current, and
    a check that silently did not happen leaves the note reading exactly as it
    would have if the check had confirmed it.
    """
    seen: set[tuple] = set()
    wanted: list[LiveCall] = []
    for call in calls:
        key = call.key()
        if key in seen:
            continue
        seen.add(key)
        wanted.append(call)

    checked: list[Checked] = []
    runners: list[LiveCall] = []
    for call in wanted:
        problem = runnable(call)
        if problem is not None:
            checked.append(Checked(call, problem=problem))
        elif len(runners) < MAX_CHECKS:
            runners.append(call)
        else:
            checked.append(
                Checked(call, problem=f"not run — a turn runs at most {MAX_CHECKS} live checks")
            )

    if runners:
        outcomes = await asyncio.gather(
            *(_run_one(call, turn, ctx) for call in runners), return_exceptions=True
        )
        for call, outcome in zip(runners, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                # A bug, not a refusal anybody wrote. It reaches the log in
                # full and the prompt in one line, and it still cannot cost
                # the turn.
                logger.exception("live check %s raised", call.tool, exc_info=outcome)
                checked.append(Checked(call, problem=f"{type(outcome).__name__}: {outcome}"))
            else:
                checked.append(outcome)
    return checked


def lines(checked: list[Checked]) -> list[str]:
    """The prompt lines. The live answer first, the note demoted to history.

    This function IS the ruling that a live check beats a note. It is four
    lines of formatting and it is the reason the rest of the module exists:
    everything else gathers facts, and this decides which one she reads first.
    """
    out: list[str] = []
    for check in checked:
        if check.ok:
            out.append(
                f"Checked just now, and this is the current answer — {check.call.tool} says: "
                f"{check.result} (the note above about {check.call.note!r} is what was true "
                "when it was written; use this instead, and say so if they differ)"
            )
        else:
            out.append(
                f"NOT checked — {check.call.tool} was supposed to answer this now and did "
                f"not: {check.problem}. The note above about {check.call.note!r} is a record "
                "of what was true when it was written and may be out of date; say that "
                "rather than reading it out as current."
            )
    return out
