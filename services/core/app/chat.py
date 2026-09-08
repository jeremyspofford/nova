"""POST /api/v1/chat/stream — one turn, streamed, and the trace it leaves.

Frame contract (each line is `data: <json>`):
    {"meta": {conversation_id, model, turn_id,
              agent}}                             exactly once, first — `agent`
                                                   (S12) is the name of the agent
                                                   that ran the turn, null when it
                                                   was Nova herself
    {"t": "<delta>"}                              zero or more
    {"activity": {"tool", "status", "reason"?,
                  "detail"?, "agent"?,
                  "agent_turn_id"?, "step"?,
                  "step_status"?}}                zero or more, while tools run
                                                   — `reason` is present ONLY on
                                                   status "error", and only when
                                                   the call itself stated one: the
                                                   ERROR_PREFIX-stripped head of
                                                   its result (see
                                                   _activity_reason), truncated to
                                                   ACTIVITY_REASON_LIMIT chars.
                                                   Without a reason, the UI cannot
                                                   tell a stated tool failure from
                                                   a turn cut off mid-call, so it
                                                   must not claim either happened.
                                                   The other five appear ONLY on
                                                   status "progress" and come from
                                                   the running tool's own report:
                                                   a str report is its `detail`; a
                                                   dict report (S12: a delegation
                                                   relaying the agent turn it is
                                                   running) contributes exactly
                                                   those five keys, copied by name
                                                   in _activity_frame — a tool can
                                                   never set `tool` or `status`.
    {"correction": "<note>"}                      zero or more, when an honesty
                                                   guard contradicts or redirects
                                                   the reply (see app/guards.py)
    {"error": "<stated reason>"}                  at most one, on failure — the
                                                   SAME sentence the turn persists
                                                   as its assistant message (see
                                                   model_failure_statement), so a
                                                   reload shows what the live
                                                   error row said
    [DONE]                                        always last

A turn is a loop, not a single call: the model is offered the tool
registry, and whenever it answers with tool calls they are executed in the
order it asked for, appended to the transcript, and the model is asked
again. The loop is bounded by agents.max_tool_rounds and every exit is
said out loud — a stated error, or a note that the rounds ran out.

Nothing in the loop waits on anyone: a tool call runs the moment the model
makes it (v4 makes no authorization decisions — owner ruling 2026-09-03), so
there is no frame, no note and no round shape for "awaiting approval", and a
reply that claims one is contradicted by guards.consent_claim_check.

Recall is best-effort, the turn is not: a memory service that is down
costs the turn its notes and nothing else. A gateway that fails is stated
in an error frame — never an empty success — AND as a persisted assistant
message that names what happened, derived from the failed round's span
(measured 2026-09-04 17:11: a 300 s silence from a 27B model loading on CPU
ended a turn 'error' with no message at all; the chat showed "still
responding…" for five minutes and then nothing).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Callable, Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import unquote

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import (
    agents,
    conversations,
    db,
    devices,
    guards,
    identity,
    markup_calls,
    peers,
    settings_store,
    tools,
    traces,
)
from app.identity import Person

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])
logger = logging.getLogger("core")

HISTORY_CHAR_BUDGET = 8000
HISTORY_MAX_MESSAGES = 200
RECALL_K = 5
RECALL_TIMEOUT = httpx.Timeout(2.0)
INGEST_TIMEOUT = httpx.Timeout(10.0)
# No short read timeout on the completion: a long first token is the model
# thinking, not a failure.
#
# What `read=300` MEANS (httpx semantics, checked 2026-09-04): it is PER READ,
# not per response. The wait for the response headers is one read, and every
# body chunk after that is another, each with its own fresh 300 s budget — so
# a model that streams a token every few seconds is never cut off however long
# its answer, and the only thing this declares dead is 300 s of SILENCE: no
# headers yet, or no bytes since the last chunk. That is the right definition
# of "dead" for a streaming call. What it also means is that a first token
# slower than 300 s — a 27B model being loaded on CPU (measured 2026-09-04:
# headers after 280 s, then nothing) — is indistinguishable from a hung
# gateway, and the turn ends. The number stays; the turn now SAYS this
# happened (model_failure_statement) instead of ending silently.
GATEWAY_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=10.0, pool=5.0)
EMPTY_REPLY = "the model returned nothing"
# How much of a non-SSE line in the completion stream the llm_call span keeps
# (see _gateway_round): a backend that writes a plain JSON error into a 200
# stream used to be dropped without a trace, and this is the evidence.
STRAY_LINE_HEAD_CHARS = 200
# The `error_class` an llm_call span records for a round that produced nothing
# at all — no content, no tool calls, no stated error — as opposed to a class
# named after the exception that killed it.
EMPTY_ROUND = "EmptyRound"
# Which httpx timeout tripped, so the round can name the budget that expired
# instead of an opaque class name. Checked most-specific first — the four are
# siblings under httpx.TimeoutException, never each other's subclasses.
_TIMEOUT_PHASES: tuple[tuple[type, str], ...] = (
    (httpx.ConnectTimeout, "connect"),
    (httpx.ReadTimeout, "read"),
    (httpx.WriteTimeout, "write"),
    (httpx.PoolTimeout, "pool"),
)
DONE_FRAME = "data: [DONE]\n\n"

# The OPT-IN responsiveness check (agents.responsiveness_check, default False).
# A cheap judge call gets a short timeout — a slow judge must not hold the whole
# turn hostage; on timeout the turn fails OPEN and ships the original reply. The
# token cap keeps the one-word verdict cheap; the redirect regeneration below
# runs uncapped, like any normal reply.
JUDGE_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)
JUDGE_MAX_TOKENS = 16
# The judge's whole job: message-vs-reply relevance, one word out. Kept off the
# turn's history on purpose — the drift case is visible from the pair alone, so
# there is no reason to pay for the whole transcript here.
JUDGE_SYSTEM = (
    "You judge only whether the assistant's reply addresses the user's most "
    "recent message. Reply with exactly one word: on_topic or off_topic."
)
# The live note shown before the corrected reply — its own frame, so the screen
# shows what happened (the drift, then the refocus). It carries no completed-
# action claim and no pending-state phrase, so the mechanical guards, were they
# ever run over it, come back clean.
REFOCUS_NOTE = "Refocusing on your question — that reply drifted off-topic."
# The verdict token, tolerant of on-topic / off_topic / "off topic" spellings.
# off_topic contains no on_topic substring, so the first match wins cleanly.
_VERDICT_RE = re.compile(r"\b(on|off)[_\s-]?topic\b", re.I)

# The ALWAYS-ON deferral guard's two live frames (both {correction}, so the
# screen shows what happened). The note precedes a corrected reply that stopped
# deferring; the honest note is the fail-safe when the one redirect could not
# complete the action — a plain, one-sentence admission, never a fabricated
# claim, so the operator is never left waiting on a promise. Both carry no
# completed-action claim and no pending-state phrase, and (checked in the guard
# suite) neither trips deferral_check itself.
DEFERRAL_NOTE = "Doing that now instead of just saying I would."

# The consent-claim redirect's live note (owner walk 2026-09-02 22:22). Like
# DEFERRAL_NOTE it carries no completed-action claim and no pending-state
# phrase, so the mechanical guards stay clean over it.
CONSENT_REDIRECT_NOTE = "Nothing was pending — doing it now instead of waiting."


def consent_redirect_nudge(*, ran_a_tool: bool) -> str:
    """The redirect's nudge, DERIVED from the fact the caller measured.

    The sentence asserts two things about the turn. That there is no approval
    step is true by construction (v4 has none — owner ruling 2026-09-03). That
    nothing has run is a measured fact, so it is built from that boolean rather
    than written out as a constant that could drift away from the truth: if a
    tool DID run the sentence would be a lie, and a lie told to the model is how
    you get the tool run a SECOND time (the double-execution the redirect is
    gated against); so this REFUSES rather than emitting it. The caller's
    fail-open turns that refusal into the ordinary correction, never an error
    frame.
    """
    if ran_a_tool:
        raise ValueError(
            f"the redirect nudge asserts nothing has run this turn; ran_a_tool={ran_a_tool}"
        )
    return (
        "There is no approval step and nothing has run this turn. Do it now by "
        "calling the tool, or say plainly that you cannot."
    )


# The state-claim redirect's live note (owner walk 2026-09-02 23:51). Same two
# properties as the notes above: it carries no completed-action claim, no
# pending-state phrase, and no assertion about the device's state — so running
# any guard over it, this turn's included, comes back clean.
STATE_REDIRECT_NOTE = "Checking the device now instead of describing it unchecked."


def state_redirect_nudge(*, device: str, ran_a_tool: bool) -> str:
    """The state-claim redirect's nudge, DERIVED from the fact the caller
    measured. It asserts one thing about the turn — nothing has run — so it is
    built from that boolean rather than written out as a constant that could
    drift away from the truth. If a tool DID run, the sentence would be a lie,
    and a lie told to the model is how you get a second dispatch; so this
    REFUSES rather than emitting it. The caller's fail-open turns that refusal
    into the ordinary correction, never an error frame."""
    if ran_a_tool:
        raise ValueError(
            f"the state redirect nudge asserts nothing has run this turn; ran_a_tool={ran_a_tool}"
        )
    return (
        f"You have not checked {device}'s state this turn. Check it now with a "
        "device tool before describing it, or say plainly that you did not check."
    )


# The presented-listing redirect's live note (agent_quality measurement
# 2026-09-03, case bare-intent-no-action: a tree-drawn listing with sizes and
# ZERO tool calls). Same properties as the notes above: no completed-action
# claim, no pending-state phrase, no listing lines — so every guard, this one
# included, comes back clean over it.
PRESENTED_LISTING_REDIRECT_NOTE = (
    "Listing the files now instead of presenting a listing from memory."
)


def presented_listing_redirect_nudge(*, ran_a_tool: bool) -> str:
    """The presented-listing redirect's nudge, DERIVED from the fact the caller
    measured. It asserts one thing about the turn — nothing has run — so it is
    built from that boolean rather than written out as a constant that could
    drift away from the truth; told otherwise it REFUSES (a lie to the model is
    how you get a second dispatch), and the caller's fail-open turns that
    refusal into the ordinary correction, never an error frame."""
    if ran_a_tool:
        raise ValueError(
            "the presented-listing redirect nudge asserts nothing has run this "
            f"turn; ran_a_tool={ran_a_tool}"
        )
    return (
        "You presented a file listing, but no listing tool ran this turn, so it "
        "is not a record of the current state. Either list it now by calling the "
        "tool, or say plainly that it is from before and you have not listed it "
        "this turn."
    )


# The note APPENDED (never replacing) when a presented listing is unbacked but
# some other tool DID run this turn: that tool may have produced a listing the
# detector cannot read in a 500-char result head (a `find` whose head is
# permission-denied noise), so dropping the prose could drop an honest listing
# — and a redirect is refused anyway (a second dispatch is worse than the
# doubt). Bracketed backend prose, like the round-cap note; it makes no claim
# about what the listing IS, only that nothing recorded backs it. Carries no
# listing line, no completed-action claim and no pending-state phrase, so every
# guard comes back clean over it (pinned in the guard suite).
PRESENTED_LISTING_UNVERIFIED_NOTE = (
    "[this listing is not backed by a recorded listing this turn — treat it as unverified]"
)


def _deferral_honest_note(action_phrase: str) -> str:
    return (
        f"I said I'd {action_phrase} but couldn't complete it automatically — "
        "ask me again and I'll try."
    )


def _offer_honest_note(action_phrase: str) -> str:
    """The truthful fallback when an OFFER-shape deferral (owner ruling
    2026-09-03: "want me to?" for what he already instructed) could not be
    redirected into the action — the redirect was refused (a tool had already
    run, or the turn was out of rounds), errored, or regenerated a reply the
    guards rejected. APPENDED, like the commitment shape's note: the offer sat
    inside prose that may be honest content. Says only what is mechanically
    true — nothing of the instructed class ran this turn, or the offer would
    not have fired — and, like every note the turn ships, carries no completed
    action, no pending state and no commitment the guard family could read."""
    return (
        f"I asked instead of doing it — there is no approval step. I did not "
        f"{action_phrase} this turn; ask me again and I'll try."
    )


def offer_redirect_nudge(*, ran_a_tool: bool) -> str:
    """The offer-shape deferral redirect's nudge (owner ruling 2026-09-03). It
    tells her the truth the ruling established — there is no approval step, so
    a "want me to?" for what she was told to do is not a question — and the
    one thing she may still ask, the detail she is missing. Like its siblings
    it asserts that nothing has run this turn, the fact `_claim_redirect`'s own
    precondition guarantees whenever this runs, so it REFUSES rather than emit
    a lie if that precondition somehow did not hold."""
    if ran_a_tool:
        raise ValueError(
            f"the offer redirect nudge asserts nothing has run this turn; ran_a_tool={ran_a_tool}"
        )
    return (
        "You asked whether to do what the user already told you to do. There is "
        "no approval step and nothing has run this turn — do it now by calling "
        "the tool, or ask only for the detail you are missing."
    )


def _completion_honest_note(action_phrase: str) -> str:
    """The truthful fallback when a COMPLETION-shape deferral (S9 walk: "your
    reminder is now running" with no timer tool span) could not be redirected
    into the action. APPENDED like the offer shape's note. States only what is
    mechanically true: no timer tool ran this turn, so nothing is set."""
    return (
        f"Correction: I said that was done, but I did not {action_phrase} this turn — "
        "no timer exists for it. Ask me again and I'll set it."
    )


def completion_redirect_nudge(*, ran_a_tool: bool) -> str:
    """The completion-shape redirect's nudge: the reply claimed a timer exists
    while no timer tool ran, so nothing is set. Refuses to emit if its
    precondition (nothing ran) did not hold, like its siblings."""
    if ran_a_tool:
        raise ValueError(
            "the completion redirect nudge asserts nothing has run this turn; "
            f"ran_a_tool={ran_a_tool}"
        )
    return (
        "You reported a reminder or schedule as set, but no timer tool ran this turn, "
        "so nothing is set. Do it now by calling create_timer (or list_timers to check "
        "what exists), then report only what the tool returned."
    )


def _bare_intent_ran_but_unreported_note(ran_names: str) -> str:
    """The truthful fallback when a bare-intent redirect's FIRST round really
    dispatched a tool but the closing round's report did not survive (empty,
    refused as markup, or rejected by the guard set). BARE_INTENT_HONEST_NOTE
    says "did not" — a call that RAN is never reported as nothing ran, so this
    names what actually happened instead (chat.py's bare-intent block)."""
    return (
        f"[I ran {ran_names} but could not report the result — "
        "ask again and I'll tell you what happened]"
    )


def bare_intent_redirect_nudge(*, ran_a_tool: bool) -> str:
    """The bare-intent redirect's nudge. Fixed text — a bare intent names no
    specific tool, so there is nothing to derive a sentence from the way
    consent/state's nudges do — but it still asserts the one fact
    `_claim_redirect`'s own precondition already guarantees whenever this runs
    (nothing has run yet), so, like those two, it REFUSES rather than emit a
    lie if that precondition somehow did not hold."""
    if ran_a_tool:
        raise ValueError(
            "the bare-intent redirect nudge asserts nothing has run this turn; "
            f"ran_a_tool={ran_a_tool}"
        )
    return (
        "You said you would do it but did not call any tool — do it now, or "
        "say plainly why you cannot."
    )


# The backend note when a bare-intent redirect could not complete the action —
# the fail-safe honest admission, same family as the round-cap note: bracketed
# backend prose, never the model's, and it REPLACES
# the broken promise rather than being appended to it (the promise carried no
# salvageable content). Rides `_claim_redirect`'s `correction_text`, so it is
# exactly what persists whenever that redirect does not stand.
BARE_INTENT_HONEST_NOTE = "[I said I'd check but did not — ask again and I'll do it]"

# How much of a tool call lands in its span. The result head is the
# Activity page's evidence that the call did what it says; the argument
# head keeps a 256 KB file body out of the trace. Both are heads, and both
# say how much they left out.
SPAN_RESULT_HEAD_CHARS = 500

# The round cap must not SWALLOW an answer. The owner's walk, 2026-09-02 23:52:
# the model ran device_run tree (honest "executable not found"), adapted to
# device_run find (exit 0 — the listing he asked for came back), then which
# tree, and hit max_tool_rounds=6. The persisted reply was ONLY
# "[stopped after 6 tool rounds without finishing]": a successful result existed
# and the user never saw it.
#
# So a capped turn gets ONE final NARRATION round — no tools advertised — with
# every accumulated tool result still in context, so the model answers with what it has. It is
# exactly one extra GATEWAY call and dispatches nothing, so the operator's cap
# on TOOL rounds is honored to the letter; a call the model emits anyway is
# refused with a stated result, never run. The note still lands after whatever
# it says: the operator must still know the turn stopped early.
OUT_OF_ROUNDS_REFUSAL = f"{tools.ERROR_PREFIX}out of tool rounds — answer with what you have"
# A tool call emitted in a redirect round that advertised NO tools. Like the two
# above it is REFUSED, never dispatched: a redirect gets one attempt at the
# action and then must speak, and a closing round that quietly ran a tool would
# be a dispatch nobody authorised and nobody would ever read the result of.
REDIRECT_CLOSED_REFUSAL = (
    f"{tools.ERROR_PREFIX}the redirect's tool round is over — answer with what you have"
)
OUT_OF_ROUNDS_NUDGE = (
    "You have used every tool round for this turn and no further tool will run. "
    "Answer now with what the tool results above already give you, and say "
    "plainly what is still unknown."
)
SPAN_ARG_HEAD_CHARS = 200
SPAN_ARGS_TOTAL_CHARS = 2000

# Words that suggest a gateway refusal was ABOUT the tools parameter. This
# only ever adds a sentence in front of the backend's own words, never
# replaces them, and it never changes what the loop does: a backend that
# will not take tools makes the turn fail, because quietly retrying without
# them would hide the fact that she has no hands on that model.
_TOOL_SUPPORT_MARKERS = ("tool", "function_call", "functions")


class GatewayFailure(RuntimeError):
    """The gateway did not produce a completion, with a stated reason."""


class ChatRequest(BaseModel):
    message: str
    conversation_id: uuid.UUID | None = None


# Detached work held so it can be awaited at shutdown instead of vanishing
# with the event loop: each turn itself (_run_turn, so it finishes even after
# the browser hangs up — the durable-turn slice), the memory ingest it
# queues, and the trace close. drain_background() below is what shutdown and
# the tests wait on.
_BACKGROUND: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)
    return task


async def drain_background() -> None:
    """Wait for everything fired and forgotten so far."""
    while _BACKGROUND:
        await asyncio.gather(*list(_BACKGROUND), return_exceptions=True)


async def settle_detached(spawned_before: set[asyncio.Task]) -> None:
    """Wait for the detached work ONE turn fired since `spawned_before` was
    snapshotted — its atomic trace close, a queued memory ingest — so a
    caller that ran _run_turn inline (the scheduler, a delegation) can read
    the turn's status back and trust it.

    Never drain_background(): the caller is often itself one of _BACKGROUND's
    tasks (a suite job, a delegated turn inside a chat turn), and a task that
    gathers the whole set gathers ITSELF — a deadlock, hit the first time an
    eval job ran detached. So this waits only for tasks that appeared after
    the snapshot, never for the task it runs in, and loops so work those
    tasks fire in turn is waited for too. One implementation, shared by the
    scheduler and delegation (S12) so the two can never disagree about what
    "settled" means.
    """
    me = asyncio.current_task()
    while True:
        pending = [
            t for t in _BACKGROUND if t not in spawned_before and t is not me and not t.done()
        ]
        if not pending:
            return
        await asyncio.gather(*pending, return_exceptions=True)


def _frame(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# The cap on an activity frame's `reason` (see the frame contract docstring):
# long enough to carry a stated error head, short enough that one runaway
# tool result cannot bloat the SSE stream or dominate the chat tile.
ACTIVITY_REASON_LIMIT = 160


def _activity_reason(result: str) -> str | None:
    """The short, stated head of a tool's own error text — never invented.

    `result` is what dispatch() (or a closed-round refusal built the same
    way) actually returned, always prefixed with tools.ERROR_PREFIX on a
    failure. That prefix is stripped here — the UI shows the reason itself,
    not the internal marker — and the remainder is capped at
    ACTIVITY_REASON_LIMIT chars so the frame stays a HEAD, not the whole
    result the span already carries in full. Returns None only if the
    stated text is empty, so a caller never attaches an empty `reason` key.
    """
    text = result[len(tools.ERROR_PREFIX) :] if result.startswith(tools.ERROR_PREFIX) else result
    text = text.strip()
    if not text:
        return None
    if len(text) > ACTIVITY_REASON_LIMIT:
        text = text[: ACTIVITY_REASON_LIMIT - 1].rstrip() + "…"
    return text


# The keys a tool's DICT progress report may put on an activity frame (S12):
# the line itself, and the agent turn a delegation is relaying — which agent,
# which turn (so the Activity page can be opened on it), which step it is on
# and how that step ended. Copied by name and nothing else, so `tool` and
# `status` — the frame's own facts about THIS call — can never be written by
# the tool that is reporting.
ACTIVITY_REPORT_KEYS = ("detail", "agent", "agent_turn_id", "step", "step_status")


def _activity_frame(
    tool: str, status: str, result: str | None = None, *, detail: str | dict | None = None
) -> str:
    """The `{"activity": ...}` SSE frame for one tool call's status change.

    `reason` is attached only when status == "error" and the call actually
    stated one (see _activity_reason) — never on "start"/"ok". `detail` is
    attached only on "progress": the tool's own words about a long call
    still running (a pull's percentage), capped like a reason. A dict is a
    structured report (ToolContext.progress): only the string values of
    ACTIVITY_REPORT_KEYS are copied, `detail` capped exactly as a str one
    is, so a str report and a dict `{"detail": ...}` produce the same frame.
    """
    activity: dict[str, str] = {"tool": tool, "status": status}
    if status == "error" and result is not None:
        reason = _activity_reason(result)
        if reason is not None:
            activity["reason"] = reason
    if status == "progress" and detail:
        report = detail if isinstance(detail, dict) else {"detail": detail}
        for key in ACTIVITY_REPORT_KEYS:
            value = report.get(key)
            if not isinstance(value, str) or not value:
                continue
            activity[key] = value.strip()[:ACTIVITY_REASON_LIMIT] if key == "detail" else value
    return _frame({"activity": activity})


def attributed_history(rows: Sequence, runner: str | None) -> list[dict[str, str]]:
    """Transcript rows as the model that is about to answer should read them.

    An assistant row an AGENT wrote — `agent` is the name joined from the
    turn behind the row — is prefixed `[name] `, so a conversation that
    mixed Nova and @coder reads as the conversation it was. A Nova row
    (agent NULL) is byte-identical to its content; so is a deleted agent's
    row (agent_id SET NULL by migration 021 — no name is invented for it); a
    user row is never prefixed, whoever it addressed.

    `runner` (S12, 2026-09-08) is WHOSE turn this is — the name of the agent
    about to answer, None for Nova — and that agent's OWN rows lose the
    prefix. Handing coder "[coder] I wrote hello.py" is handing it its own
    words as somebody else's, and a model reading its history that way
    starts writing about itself in the third person ("coder wrote
    hello.py") — the very sentence the delegation guard then has to correct.
    So the prefix marks OTHER speakers only: from an agent's seat its own
    turns read first person and every other agent is named, and from Nova's
    seat (runner None) every agent is named, exactly as before. The stored
    rows are untouched: this is the copy handed to history_window, nothing
    else.
    """
    out: list[dict[str, str]] = []
    for row in rows:
        content = row["content"]
        if row["role"] == "assistant" and row["agent"] and row["agent"] != runner:
            content = f"[{row['agent']}] {content}"
        out.append({"role": row["role"], "content": content})
    return out


def history_window(
    newest_first: Sequence, budget: int = HISTORY_CHAR_BUDGET
) -> list[dict[str, str]]:
    """Newest-first rows in, oldest-first messages out, whole ones only.

    A message that would cross the budget is dropped entirely, and so is
    everything older — a half-quoted message is worse than an absent one.
    """
    kept: list[dict[str, str]] = []
    used = 0
    for row in newest_first:
        cost = len(row["content"])
        if used + cost > budget:
            break
        kept.append({"role": row["role"], "content": row["content"]})
        used += cost
    kept.reverse()
    return kept


def stable_system_prompt(
    model: str, tool_names: Sequence[str], *, agent_block: str | None = None
) -> str:
    """The half that does not change from turn to turn.

    The tool list is derived from the registry rather than written out
    here, so a tool added to the toolset is named in the prompt by that
    fact alone and cannot drift out of step with what is advertised.

    `agent_block` (S12) is an agent's own block — who it is, its purpose and
    instructions, its folder and round budget — appended after the shared
    preamble as its own section, never in place of it: the preamble is the
    honesty rails the guards enforce, and an agent's turn runs under exactly
    the same guards, so it gets the same rails PLUS its block. None (Nova)
    is byte-identical to the prompt before agents existed.

    The delegation sentence is derived from `tool_names`, not written in
    unconditionally: it belongs to whoever holds agents.DELEGATE_TOOL, and
    an agent's subset never does, so an agent is never told how to relay a
    report it cannot request. The name is the module constant, never a
    literal here: a rename of the tool moves this sentence with it instead
    of silently dropping it from every prompt.
    """
    prompt = (
        "You are Nova, a self-hosted assistant running on this household's own hardware. "
        f"The model answering is {model or 'the gateway default'}. Be direct and concrete, "
        "and say plainly when you do not know something.\n\n"
        f"You can call these tools: {', '.join(tool_names)}. "
        "Use one when it gets a real answer instead of a guess. "
        "When the user asks for something a tool can do, call the tool in THIS "
        "turn — never say you 'will' search or fetch and then stop; do it now. "
        "After writing a file, read it back before you say it worked. "
        "When a tool answers with a line starting 'Error:', say plainly what failed "
        "and do not claim the work was done. "
        "There is no approval step: when you call a tool it runs in this turn. "
        "Never say an action is awaiting or pending anyone's approval — do it now, "
        "or say plainly why you cannot — and never deny having a capability you "
        "have a tool for. "
        "Put code, commands, command output, file listings and directory trees in "
        "fenced code blocks: tag code and shell with the language (```python, "
        "```bash) so it is highlighted, and tag listings and trees ```text so "
        "their spacing survives. "
        "A web fetch is a LIVE, point-in-time read. For anything time-sensitive — "
        "'the latest', current news, today's status — call fetch_url again to get "
        "fresh results; never answer with what an earlier fetch or a recalled note "
        "said and present it as current. "
        "If a search's results do not actually answer the question, refine the query "
        "and search again — a couple of tries is fine — instead of asking the "
        "operator to search or whether you should; just do it. "
        "A model pull downloads gigabytes and reports progress as it runs; say what "
        "was pulled only from the tool's own result line. "
        "Which model answers is decided by the gateway's routing (a role's chain, "
        "monthly caps, a provider that refused); when asked why a reply came from a "
        "given model, use route_explain and quote its reason — never guess."
    )
    if agents.DELEGATE_TOOL in tool_names:
        prompt += (
            f" {agents.DELEGATE_TOOL} runs an agent to completion and answers with a facts line "
            "the backend wrote, then the agent's own report: relay from the facts line — the files "
            "it lists are the files that exist — quote the report as the agent's words, say "
            "the agent did not finish when the result starts with Error:, and never say an "
            "agent did something the facts line does not show or claim its work as your own."
        )
    if agent_block:
        prompt = f"{prompt}\n\n{agent_block}"
    return prompt


def volatile_system_prompt(snippets: Sequence[str], roster: str | None = None) -> str | None:
    """The half that changes every turn — omitted entirely when there is nothing in it.

    `roster` (S12) is the one line naming the agents Nova can delegate to,
    read from the table for THIS turn (agents.roster_line) — None when there
    are none, and then the prompt is byte-identical to before agents existed.
    """
    parts: list[str] = []
    if snippets:
        notes = "\n".join(f"- {snippet}" for snippet in snippets)
        parts.append(f"Relevant notes:\n{notes}")
    if roster:
        parts.append(roster)
    if not parts:
        return None
    parts.append(f"Current time: {datetime.now(UTC).isoformat()}")
    return "\n\n".join(parts)


def base_messages(
    model: str,
    snippets: Sequence[str],
    history: Sequence[dict],
    message: str,
    persona: agents.Persona | None = None,
    roster: str | None = None,
) -> list[dict]:
    """The transcript the first round of the turn starts from.

    `persona` (S12) decides whose prompt this is: None is Nova's, exactly as
    before — the whole live registry and no block; an agent's names its
    subset and carries its block. `roster` is Nova's line about who she can
    delegate to (see volatile_system_prompt)."""
    if persona is None:
        stable = stable_system_prompt(model, tools.tool_names())
    else:
        stable = stable_system_prompt(
            model, persona.tool_names, agent_block=persona.instructions_block
        )
    messages = [{"role": "system", "content": stable}]
    volatile = volatile_system_prompt(snippets, roster)
    if volatile is not None:
        messages.append({"role": "system", "content": volatile})
    messages.extend(history)
    messages.append({"role": "user", "content": message})
    return messages


def completion_payload(model: str, messages: Sequence[dict], advertised: Sequence[dict]) -> dict:
    payload: dict = {"messages": list(messages), "stream": True}
    if model:
        # An empty chat.model means "whatever the gateway is configured for";
        # sending "" would ask for a model actually named "".
        payload["model"] = model
    if advertised:
        payload["tools"] = list(advertised)
    return payload


def _results_from(body: object) -> list:
    """Memory's recall payload, whether it is a bare list or wraps one."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("results", "snippets", "hits"):
            value = body.get(key)
            if isinstance(value, list):
                return value
    return []


def _snippets(results: Iterable) -> list[str]:
    snippets = []
    for hit in results:
        if isinstance(hit, str):
            text = hit
        elif isinstance(hit, dict):
            body = hit.get("snippet") or hit.get("content") or ""
            label = hit.get("title") or hit.get("path") or ""
            text = f"{label}: {body}" if label and body else (body or label)
        else:
            continue
        if text:
            snippets.append(text)
    return snippets


# -- tool calls off the wire ------------------------------------------------


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str
    # This "call" was written as MARKUP in the round's reply text and recovered
    # by markup_calls, rather than arriving in `tool_calls` on the wire. It is
    # NEVER dispatched, in any round (the ruling — see app/markup_calls.py): it
    # exists so the model can be told, by name and with a retryable reason, that
    # what it wrote was text, and so the trace records the attempt.
    from_markup: bool = False

    def as_openai(self) -> dict:
        return {
            "id": self.id,
            "type": "function",
            "function": {"name": self.name, "arguments": self.arguments},
        }


class ToolCallBuffer:
    """Assembles a round's tool calls out of whatever the backend emits.

    Three shapes reach this, not two:

      * OpenAI streams a call across several chunks keyed by `index` — the
        first fragment carries the id and the function name, the rest carry
        more argument text to concatenate;
      * some backends answer a streamed request with one whole completion
        chunk, arguments already complete and often with no `index` at all;
      * an aggregating proxy in front of either can do BOTH — relay the
        per-index deltas as they arrive and then append the finished call
        in a trailing `message` chunk.

    That third shape is why the id matters as a key and not just as a
    field to copy. Treating the trailing restatement as a new call because
    it names a function and carries no index would execute the tool twice
    under one id: memory_save would write the note and a `-2` sibling, a
    future non-idempotent tool would fire twice, and the two `role: tool`
    messages sharing a `tool_call_id` are rejected outright by strict
    backends.
    """

    def __init__(self) -> None:
        self._calls: dict[int, ToolCall] = {}
        # id -> the key its call is filed under, so a later fragment that
        # names the same id lands on the same call.
        self._keys_by_id: dict[str, int] = {}

    def add(self, fragment: dict) -> None:
        function = fragment.get("function")
        function = function if isinstance(function, dict) else {}
        name = function.get("name") or ""
        call_id = str(fragment["id"]) if fragment.get("id") else ""

        index = fragment.get("index")
        restated = False
        if type(index) is int:
            # The streaming contract. While an index is present it is
            # authoritative, and argument text keyed by it concatenates —
            # including when the backend also repeats the id on every
            # delta, which some do.
            key = index
        elif call_id and call_id in self._keys_by_id:
            # No index, and an id already in the buffer: this is the same
            # call restated, not a second one.
            key = self._keys_by_id[call_id]
            restated = True
        else:
            # Nothing to key on: a fragment that names a function starts a
            # new call, and one carrying only argument text continues the
            # newest — which is what keeps two genuinely distinct
            # un-indexed calls in one round from merging into one.
            key = len(self._calls) if (name or not self._calls) else max(self._calls)

        call = self._calls.setdefault(key, ToolCall(id="", name="", arguments=""))
        if call_id:
            call.id = call_id
            # setdefault, not assignment: the first key an id was seen on is
            # the call it belongs to.
            self._keys_by_id.setdefault(call_id, key)
        if name:
            call.name = name

        arguments = function.get("arguments")
        if isinstance(arguments, str):
            if not restated:
                call.arguments += arguments
            elif arguments:
                # A restatement is the backend's last word on this call, so
                # it REPLACES what the deltas accumulated. Concatenating the
                # two would produce arguments that parse as neither, and
                # keeping the deltas would ignore a correction the backend
                # had just made. An empty restatement says nothing and
                # therefore changes nothing.
                call.arguments = arguments
        elif isinstance(arguments, dict):
            # A backend that sends the arguments already parsed; re-encoded
            # so there is exactly one form downstream.
            call.arguments = json.dumps(arguments)

    def finished(self) -> list[ToolCall]:
        """The round's calls, in the order the model asked for them.

        Every call leaves here with an id of its own. A call the backend
        gave no id gets one, and so does a second call the backend gave an
        id already in use — two calls really are two calls, and the same id
        goes on both the assistant message and the tool result answering
        it, so a collision would make the pairing ambiguous and be rejected
        by strict backends besides.
        """
        calls = [self._calls[key] for key in sorted(self._calls)]
        claimed = {call.id for call in calls if call.id}
        issued: set[str] = set()
        for position, call in enumerate(calls, start=1):
            if not call.id or call.id in issued:
                candidate = f"call_{position}"
                suffix = 0
                while candidate in claimed or candidate in issued:
                    suffix += 1
                    candidate = f"call_{position}_{suffix}"
                call.id = candidate
            issued.add(call.id)
        return calls


def _chunk_parts(data: dict) -> tuple[str, dict | None, str | None, list[dict]]:
    """(delta text, usage, error, tool-call fragments) out of one chunk."""
    error = data.get("error")
    if error is not None:
        message = error.get("message") if isinstance(error, dict) else str(error)
        return "", None, message or "unspecified gateway error", []
    delta = ""
    fragments: list[dict] = []
    for choice in data.get("choices") or []:
        # `delta` while streaming; `message` from a backend that answers a
        # streamed request with one whole completion chunk instead.
        payload = choice.get("delta") or choice.get("message") or {}
        if not isinstance(payload, dict):
            continue
        piece = payload.get("content")
        if piece:
            delta += piece
        calls = payload.get("tool_calls")
        if isinstance(calls, list):
            fragments.extend(item for item in calls if isinstance(item, dict))
    usage = data.get("usage")
    return delta, usage if isinstance(usage, dict) else None, None, fragments


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}… (+{len(text) - limit} more chars, {len(text)} total)"


def _redact(value: object) -> object:
    """Trace-sized arguments: the same shape, long strings cut to a head.

    Nothing is filtered by name — none of S2's tools take a credential —
    so "redacted" here means "not the whole payload": a 256 KB file body
    must not be copied into the turn's trace, and the Activity page needs
    something a person can read at a glance.
    """
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return _clip(value, SPAN_ARG_HEAD_CHARS)
    return value


def _span_arguments(raw: object) -> object:
    """What the model actually sent, recorded whether or not it parsed."""
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            # Unparseable arguments are exactly the case worth seeing in the
            # trace, so the raw text is kept rather than dropped.
            parsed = raw
    else:
        parsed = raw
    return _bounded(_redact(parsed))


def _bounded(redacted: object) -> object:
    """A whole-record cap on top of the per-value one.

    The model chooses how many arguments it sends, and they are recorded
    BEFORE validation gets to refuse them — so a call with ten thousand
    keys must not become a ten-thousand-key row in turn_spans. Past the
    cap the record degrades to a clipped string that says how much was
    left out, which is still evidence and is bounded.
    """
    encoded = json.dumps(redacted, default=str)
    if len(encoded) <= SPAN_ARGS_TOTAL_CHARS:
        return redacted
    return _clip(encoded, SPAN_ARGS_TOTAL_CHARS)


def _mentions_tools(reason: str) -> bool:
    lowered = reason.lower()
    return any(marker in lowered for marker in _TOOL_SUPPORT_MARKERS)


def _timeout_phase(exc: BaseException) -> str | None:
    for cls, phase in _TIMEOUT_PHASES:
        if isinstance(exc, cls):
            return phase
    return None


def _transport_failure(exc: Exception) -> str:
    """The stated reason for a round httpx could not complete.

    A timeout names the budget that expired, read off GATEWAY_TIMEOUT itself
    (the one the client was built with), so "300 s" in the sentence is the
    configured number and not a copy of it. Anything else is the transport's
    own words, prefixed so the reader knows which hop failed.
    """
    phase = _timeout_phase(exc)
    if phase == "read":
        return (
            f"nothing arrived from the gateway for {GATEWAY_TIMEOUT.read:g} s "
            f"(its read timeout — {peers.reason(exc)})"
        )
    if phase is not None:
        budget = getattr(GATEWAY_TIMEOUT, phase)
        return f"the gateway {phase} timeout of {budget:g} s expired ({peers.reason(exc)})"
    return f"could not reach the gateway — {peers.reason(exc)}"


def _empty_round_failure(
    elapsed_s: float,
    *,
    saw_done: bool,
    data_lines: int,
    stray_lines: int,
    stray_head: str | None,
) -> str:
    """The stated reason for a round that ended with nothing in it — every
    clause a fact the stream loop counted, never a guess at why."""
    facts = [
        f"{data_lines} data line(s)",
        "[DONE] seen" if saw_done else "[DONE] never sent",
    ]
    if stray_lines:
        facts.append(f"{stray_lines} non-SSE line(s), the first: {stray_head!r}")
    return (
        f"the stream ended after {elapsed_s:.1f} s with no content and no tool "
        f"calls ({', '.join(facts)})"
    )


def turn_usage(spans: Sequence[traces.Span]) -> dict | None:
    """The turn's cost summed over its llm_call spans — ONLY from what the
    gateway stated on each (S10). None when no round carried usage. A round
    with no cost keeps the sum honest: `priced_rounds` says how many of
    `rounds` had a dollar figure, so a partial sum is never read as a whole."""
    rounds = [s for s in spans if s.kind == "llm_call" and "metered" in s.meta]
    if not rounds:
        return None
    cost = sum((s.meta["cost_usd"] for s in rounds if s.meta.get("cost_usd") is not None), 0.0)
    priced = sum(1 for s in rounds if s.meta.get("cost_usd") is not None)
    bases = sorted({s.meta["cost_basis"] for s in rounds if s.meta.get("cost_basis")})
    return {
        "rounds": len(rounds),
        "priced_rounds": priced,
        "cost_usd": round(cost, 6) if priced else None,
        "cost_basis": bases,
        "prompt_tokens": sum(s.meta.get("prompt_tokens") or 0 for s in rounds),
        "completion_tokens": sum(s.meta.get("completion_tokens") or 0 for s in rounds),
        "unmetered_rounds": sum(1 for s in rounds if not s.meta.get("metered")),
        "local_rounds": sum(1 for s in rounds if s.meta.get("local")),
        "unrecorded_rounds": sum(1 for s in rounds if s.meta.get("usage_recorded") is False),
    }


async def _owner_timezone(pool) -> str:
    try:
        return str(await settings_store.read_value(pool, "nova.timezone") or "UTC")
    except Exception:  # noqa: BLE001 — a zone is a convenience; UTC is always a fact
        return "UTC"


def _last_llm_span(spans: Sequence[traces.Span]) -> traces.Span | None:
    for span in reversed(spans):
        if span.kind == "llm_call":
            return span
    return None


def _tool_outcomes(spans: Sequence[traces.Span]) -> tuple[list[str], list[str]]:
    """(tools that ran ok, tools that ran and stated a failure), by name, in
    order, deduped — from the spans, never from any prose. A refused call (a
    closed round, markup written as text) was never dispatched and is in
    neither list: it did not run, so it is not something that "ran"."""
    ran = guards.successful_tool_names(spans)
    failed: list[str] = []
    for span in spans:
        if span.kind != "tool" or not span.name:
            continue
        meta = span.meta or {}
        if meta.get("ok") is True or any(key.startswith("refused_") for key in meta):
            continue
        if span.name not in failed and span.name not in ran:
            failed.append(span.name)
    return ran, failed


def _names(names: Sequence[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


def _ran_clause(spans: Sequence[traces.Span]) -> str:
    """ "Nothing was run." — or what did, DERIVED: a call that ran is never
    reported as nothing ran (the rule every honest note in here follows)."""
    ran, failed = _tool_outcomes(spans)
    if not ran and not failed:
        return "Nothing was run."
    pieces = []
    if ran:
        pieces.append(f"{_names(ran)} ran")
    if failed:
        pieces.append(f"{_names(failed)} failed")
    return f"Before that, {' and '.join(pieces)} — see Activity for the results."


RETRY_HINT = "Try again, or check the model in Settings → Models."


def model_failure_statement(*, model: str, failure: str, spans: Sequence[traces.Span]) -> str:
    """The assistant message a turn keeps when its model call did not answer.

    Every clause is a fact the turn measured: the model from the setting the
    turn ran under, the engine from the gateway's X-Nova-Served-By header (on
    the llm_call span, when the gateway got far enough to send headers), the
    round from that span, the reason from the exception or the stream shape
    (`failure`, composed by _gateway_round), and "nothing was run" from the
    tool spans. Never a generic "something went wrong": the sentence the owner
    reads is the sentence the trace backs.

    It is persisted as the turn's assistant row AND sent as the turn's error
    frame, so the live error row and the reloaded transcript say the same
    thing. It is NOT ingested into memory (a failed call is plumbing, not
    knowledge — the same rule a guard correction follows) and it carries no
    completed-action claim and no pending-state phrase.
    """
    llm = _last_llm_span(spans)
    meta = llm.meta if llm is not None else {}
    served_by = meta.get("served_by")
    served_kind, _, served_model = (
        served_by.partition(":") if isinstance(served_by, str) else ("", "", "")
    )
    # The served model name comes from the span when the setting is empty —
    # the gateway told us what actually answered, so say that, not a label.
    who = model or served_model or "the gateway's default model"
    if served_kind:
        who = f"{who} ({served_kind})"
    route_reason = meta.get("route_reason")
    if isinstance(route_reason, str) and route_reason:
        # The gateway routed this round past its first link (S10-2): the
        # statement names that too, in the gateway's words.
        who = f"{who}, after the gateway {route_reason}"
    round_number = meta.get("round")
    where = ""
    if isinstance(round_number, int) and round_number > 1:
        where = f" in round {round_number}"
    return (
        f"I didn't get a response from {who}{where}: {failure}. {_ran_clause(spans)} {RETRY_HINT}"
    )


def turn_failure_statement(reason: str, spans: Sequence[traces.Span]) -> str:
    """The message for a turn that died somewhere OTHER than the model call —
    the unplanned exception path. The model may well have answered; what is
    known is only that the turn failed, and what ran."""
    return f"This turn failed before I could answer: {reason}. {_ran_clause(spans)} {RETRY_HINT}"


# -- peers -----------------------------------------------------------------


async def _recall_scope(client: httpx.AsyncClient, query: str, person_id: str) -> list:
    """One /recall for one memory partition; raises on any failure so the
    caller can record it against THAT scope."""
    response = await client.post(
        "/recall", json={"query": query, "person_id": person_id, "k": RECALL_K}
    )
    response.raise_for_status()
    return _results_from(response.json())


async def _recall(
    app, turn: traces.Turn, person: Person, query: str, *, shared: uuid.UUID | None = None
) -> list[str]:
    """The notes the turn starts with, under ONE memory_recall span.

    `person` is whose partition is asked — the owner for Nova's turns, the
    agent (a Person value, S12) for an agent's. `shared` names a SECOND
    partition recalled alongside it: the owner's, only for an agent allowed
    to read the household's shared notes. The two calls run concurrently
    (asyncio.gather) inside the one RECALL_TIMEOUT budget, so a second scope
    never doubles the wait, and each is fail-open on its own: one partition
    the memory service could not answer costs THOSE notes, never the other's
    and never the turn. Shared hits are prefixed "(shared) " so the model
    can tell whose note it is reading. With `shared` None the request, the
    span meta ({k, hits} or {k, error}) and the return are exactly what they
    were before agents existed; with it the span also carries
    `scopes: {own: n, shared: m}` and, per failed scope, `errors`.
    """
    with turn.span("memory_recall") as span:
        span.meta["k"] = RECALL_K
        scopes = {"own": str(person.id)}
        if shared is not None:
            scopes["shared"] = str(shared)
        try:
            async with peers.client(app, peers.MEMORY, RECALL_TIMEOUT) as client:
                outcomes = await asyncio.gather(
                    *(_recall_scope(client, query, pid) for pid in scopes.values()),
                    return_exceptions=True,
                )
        except Exception as exc:
            # The client itself could not be made (the peer is unconfigured):
            # no scope was asked, so the whole recall is the one failure.
            reason = peers.reason(exc)
            span.meta["error"] = reason
            logger.warning("memory recall failed, continuing without notes: %s", reason)
            return []
        hits: dict[str, list[str]] = {}
        errors: dict[str, str] = {}
        for name, outcome in zip(scopes, outcomes, strict=True):
            if isinstance(outcome, BaseException):
                errors[name] = peers.reason(outcome)
                hits[name] = []
            else:
                hits[name] = _snippets(outcome)
        if shared is None:
            if errors:
                span.meta["error"] = errors["own"]
                logger.warning("memory recall failed, continuing without notes: %s", errors["own"])
                return []
            snippets = hits["own"]
        else:
            for name, reason in errors.items():
                logger.warning(
                    "memory recall (%s scope) failed, continuing without those notes: %s",
                    name,
                    reason,
                )
            if errors:
                span.meta["errors"] = errors
            snippets = [*hits["own"], *(f"(shared) {s}" for s in hits["shared"])]
            span.meta["scopes"] = {"own": len(hits["own"]), "shared": len(hits["shared"])}
        span.meta["hits"] = len(snippets)
        return snippets


async def _ingest(app, person: Person, conversation_id: uuid.UUID, exchange: dict) -> None:
    try:
        async with peers.client(app, peers.MEMORY, INGEST_TIMEOUT) as client:
            response = await client.post(
                "/ingest",
                json={
                    "person_id": str(person.id),
                    "conversation_id": str(conversation_id),
                    "exchange": exchange,
                },
            )
            response.raise_for_status()
    except Exception as exc:
        logger.warning(
            "memory ingest failed for conversation %s: %s", conversation_id, peers.reason(exc)
        )


def _queue_ingest(
    app, turn: traces.Turn, person: Person, conversation_id: uuid.UUID, exchange: dict
) -> None:
    with turn.span("memory_ingest") as span:
        try:
            peers.peer_config(peers.MEMORY)
        except peers.PeerUnconfigured as exc:
            span.meta.update(queued=False, error=str(exc))
            logger.warning("memory ingest not queued: %s", exc)
            return
        _spawn(_ingest(app, person, conversation_id, exchange))
        span.meta["queued"] = True


async def _paired_device_names(pool: asyncpg.Pool) -> list[str]:
    """Every LIVE paired device's name, from the registry itself.

    Revoked rows are excluded: a revoked machine is not paired, so a claim about
    it is not a claim about anything this household has. Returns [] on ANY
    failure — the state-claim guard never fires without names, so a database
    blip costs a check, never a false correction (precision-first: doubt never
    becomes a correction).
    """
    try:
        return [
            device["name"]
            for device in await devices.list_devices(pool)
            if not device.get("revoked_at")
        ]
    except Exception:
        logger.exception(
            "device registry read failed; the state-claim guard stays silent this turn"
        )
        return []


# The two exemption reads behind _agent_names, as ONE round trip. Each half
# names an agent this conversation ALREADY has on record before this turn:
# it wrote an assistant row here (an @mention ran it in this very
# conversation), or an EARLIER turn of this conversation delegated to it and
# that delegation succeeded. Both are read from the trace and the transcript,
# never from a list: creating an agent arms the guard for its name, and the
# first time that agent actually runs here it stops being a name she could
# only have fabricated.
#
# The CURRENT turn is excluded from both halves ($2) on purpose: what THIS
# turn did is the spans' business, and the spans are exactly what the guard
# reads for backing. Excluding it also keeps the turn's own (unwritten)
# assistant row out of the question entirely.
_BACKED_AGENTS_SQL = """
SELECT DISTINCT a.name AS name
  FROM messages m
  JOIN turns t ON t.id = m.turn_id
  JOIN agents a ON a.id = t.agent_id
 WHERE m.conversation_id = $1 AND m.role = 'assistant' AND t.id <> $2
UNION
SELECT DISTINCT s.meta->'args_redacted'->>'agent' AS name
  FROM turn_spans s
  JOIN turns t ON t.id = s.turn_id
 WHERE t.conversation_id = $1
   AND s.kind = 'tool'
   AND s.name = $3
   AND s.meta->>'ok' = 'true'
   AND t.id <> $2
"""


async def _agent_names(
    pool: asyncpg.Pool,
    turn: traces.Turn,
    persona: agents.Persona,
    conversation_id: uuid.UUID,
) -> list[str]:
    """The roster the delegation-claim guard is derived from (S12): the
    agents whose work THIS turn would have to have delegated for a claim
    about them to be true — every agent's name, read LIVE from the table,
    MINUS the ones this conversation already has on record.

    The whole Turn is taken rather than just its id because it is used as
    both — the id the exemption reads exclude, and the span sink a failed
    read is filed on — and one value cannot disagree with itself: a caller
    cannot file the failure on one turn while exempting against another.

    Its own read, not the roster line's: the roster line is a prompt
    SENTENCE read only for Nova (an agent's turn never reads it), and this
    guard runs on every turn — an agent crediting another agent with work
    is the same fabrication as Nova doing it. So one extra SELECT per turn,
    beside the device-names read that feeds the state-claim guard.

    WHY the exemption (2026-09-08, review finding): the guard's fact is a
    successful delegate_to_agent span of THIS turn, which makes "coder wrote
    hello.py" a fabrication the turn after coder really wrote it — @coder in
    turn 1, Nova reporting it in turn 2, and the correction ("I did not hand
    anything to coder this turn") is then itself the lie, about work the
    operator watched happen. So an agent that has spoken in this
    conversation, or that an earlier turn of it successfully delegated to,
    is left out of the names the guard is given: precision-first, the family
    rule — a missed fabrication costs a correction, a wrong correction costs
    the truth. What is NOT exempted is a name that has never appeared here:
    that claim is still contradicted.

    An agent's OWN name is KEPT on its own turn (and kept whether or not the
    exemption reads would have dropped it): the guard is told which name is
    the speaker's (self_name) and answers it with the self correction —
    "coder finished the tests", written by coder with no tool span behind
    it, is a claim about work nothing shows happening, and narration's rule
    is the right one for it.

    FAIL-OPEN to no names — the guard is then silent, so a read that blips
    costs a check, never a false correction — but never quiet: the failure
    is filed on an `agent_names` span, which exists ONLY on failure (the
    agent_roster idiom), so a turn that lost its roster is a turn with that
    span, not a log line nobody reads. Either read failing is that case: a
    roster with no exemptions applied would correct exactly the honest
    reports this exemption exists for.
    """
    try:
        names = await agents.names(pool)
        backed = {
            str(row["name"]).strip().lower()
            for row in await pool.fetch(
                _BACKED_AGENTS_SQL, conversation_id, turn.id, agents.DELEGATE_TOOL
            )
            if row["name"]
        }
    except Exception as exc:
        with turn.span("agent_names") as span:
            span.meta["error"] = peers.reason(exc)
        logger.exception(
            "the roster or this conversation's backed agents could not be read; "
            "the delegation-claim guard stays silent this turn"
        )
        return []
    own = persona.agent.name if persona.agent is not None else None
    return [name for name in names if name == own or name.lower() not in backed]


def without_markup(text: str) -> str:
    """`text` with any tool-call markup removed and an honest note in its place.

    THE INVARIANT, pinned at the persist boundary: no message Nova stores
    contains UNQUOTED, READABLE tool-call markup. A raw `<atem:function_calls>`
    blob is not an answer — the operator reads XML instead of a reply, and worse,
    the next turn reads it back through history_window and learns to write more
    of them.

    Two things are deliberately NOT covered by that sentence, and both are the
    precision rule rather than a gap. A QUOTED example — fenced, inline-coded or
    blockquoted — is stored verbatim, because a reply teaching what a call looks
    like is an answer and gutting it would be the defect. And markup too
    malformed to read as a call is left where it is: it names no tool, so there
    is nothing to say about it, and editing it would mean editing prose on a
    guess. Neither can act; nothing can, under the ruling.

    Every path that could produce one is already handled upstream (a round's
    text is scanned in _gateway_round, the turn's accumulated deltas in
    _run_turn), so this is DEFENCE IN DEPTH: it is a no-op on clean text, and
    the day someone adds a fifth way for model text to reach the database it is
    still true. Nothing is dispatched from here — by this point the round is
    long over — so the note states exactly that.

    NOT streamed: a record is never half-written, so the truncation rule that a
    live round needs would only ever eat the tail of an honest sentence here
    (the review's "it opens with <function_calls> and then…" lost its rest).
    Complete, readable calls are removed; everything else is left alone.
    """
    scan = markup_calls.parse_markup_tool_calls(text)
    if not scan.found:
        return text
    logger.warning(
        "tool-call markup reached the record boundary (%d call(s), unparsed=%s); stripping it",
        len(scan.calls),
        scan.unparsed,
    )
    note = (
        markup_calls.no_tool_round_note(scan.names)
        if scan.calls
        else markup_calls.MALFORMED_MARKUP_NOTE
    )
    return f"{scan.text}\n\n{note}" if scan.text.strip() else note


async def _persist_assistant(
    pool: asyncpg.Pool,
    conversation_id: uuid.UUID,
    text: str,
    turn_id: uuid.UUID | None = None,
) -> None:
    """The assistant row, linked to the turn that produced it (S10-pre): the
    link is what lets a transcript be badged from the trace rather than
    from anything the reply says about itself."""
    text = without_markup(text)
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, turn_id) "
        "VALUES ($1, 'assistant', $2, $3)",
        conversation_id,
        text,
        turn_id,
    )


async def _run_tool(
    turn: traces.Turn,
    ctx: tools.ToolContext,
    call: ToolCall,
    *,
    subset: Collection[str] | None = None,
) -> tuple[str, bool]:
    """One tool call, timed, recorded, and unable to raise.

    dispatch() decides ok; nothing here reads the result text to work out
    whether it worked, so the span and the activity frame say what actually
    happened rather than what the prose looked like. Nothing here waits on
    anyone either: the call is dispatched the moment it is made (v4 has no
    approval step), so every span is ok, or carries the stated error.

    Any FACTS the call determined (ToolContext.facts_sink) are copied onto the
    span the same way — by diffing the sink across the call, never by reading
    the result text. That is what lets a REFUSAL count as a real check: a device
    tool refused with "not connected" established the machine is offline, and
    the span carries `facts: [{"device": …, "connected": false}]` so a guard can
    tell "it checked and reports offline" from "it never looked".

    `subset` (S12) is the toolset the turn's persona was advertised (an
    agent's); None is Nova, who holds the whole registry. A call naming a
    tool outside it is marked on the span and RUNS regardless: the subset is
    scope, not permission — the model was shown fewer tools, and the trace
    says when it reached past what it was shown, so the Activity page can
    show the specialism was crossed. Nothing here decides whether it may.
    """
    facts = ctx.facts_sink
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        if call.from_markup:
            # Recovered from tool-call markup in the round's text rather than
            # read off the wire. It still goes through schema validation — the
            # accommodation changes where the call was READ, never what it is.
            span.meta["parsed_from_markup"] = True
        if subset is not None and call.name not in subset:
            # Scope, not permission (see the docstring): recorded, then run.
            span.meta["outside_subset"] = True
        # Pre-set, and overwritten the moment dispatch answers. A turn the
        # client abandons mid-call still files this span on the way out, and
        # it must read as "never finished" rather than as an untested
        # success.
        span.meta["ok"] = False
        span.meta["result_head"] = "(the turn ended before this call returned)"
        facts_before = len(facts) if facts is not None else 0
        result, ok = await tools.dispatch(call.name, call.arguments, ctx)
        span.meta["ok"] = ok
        span.meta["result_head"] = result[:SPAN_RESULT_HEAD_CHARS]
        if facts is not None and len(facts) > facts_before:
            # Exactly what THIS call settled — the sink is append-only for the
            # turn, so the slice beyond the mark is this call's own contribution.
            span.meta["facts"] = list(facts[facts_before:])
        if not ok:
            span.meta["error"] = result[:SPAN_RESULT_HEAD_CHARS]
    return result, ok


async def _dispatch_calls(
    turn: traces.Turn,
    tool_ctx: tools.ToolContext,
    calls: Sequence[ToolCall],
    messages: list[dict],
    emit: Callable[[str | None], None],
    *,
    subset: Collection[str] | None = None,
) -> bool:
    """Run one round's tool calls, append their results, stream what happened.

    Sequential, in the model's own order: concurrency is a later slice, and two
    tools writing the same file at once is not a problem worth having yet. The
    turn loop and the claim redirects share this ONE implementation, so a call
    made in a redirect is dispatched, recorded and framed exactly like a call
    made in a normal round — there is no second, weaker path. And every call
    that reaches a tool RUNS: nothing here decides whether it may (v4 makes no
    authorization decisions); the only calls ever refused are one the model
    wrote as text and one naming a tool that does not exist (which could not
    run anywhere — see below for why an agent's is answered here).

    Returns `ran_ephemeral`, a MECHANICAL fact about this batch: whether a
    successful call was an ephemeral (point-in-time) read. The caller ORs it
    into its own. `subset` is handed to _run_tool unchanged (S12: the
    persona's toolset, or None for Nova) — it marks, it never gates.
    """
    ran_ephemeral = False
    for call in calls:
        emit(_activity_frame(call.name, "start"))
        if call.from_markup:
            # THE RULING, enforced in the one place every dispatch goes through:
            # a tool call written as text is refused, never run — so neither the
            # turn loop nor a redirect can acquire a weaker path to it, and no
            # future caller can either. Recorded as a refused span with a stated,
            # retryable reason, exactly like a closed round's refusal.
            result = _refuse_markup_as_text(turn, call)
            emit(_activity_frame(call.name, "error", result))
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
            continue
        if subset is not None and call.name not in tools.REGISTRY:
            # A name no tool has, from a persona that was shown a SUBSET. Not a
            # gate: tools.dispatch would refuse this call too (there is nothing
            # to run) — but its sentence names the WHOLE registry as "the tools
            # you have", which for an agent is a lie about its hands and an
            # invitation to reach for the twenty-odd tools it was never given.
            # So the refusal is composed here from the subset it was actually
            # shown, synchronously (no await joins the funnel; test_no_approvals
            # pins the await list), recorded as a refused span like any other.
            # Nova (subset None) still gets dispatch's own sentence: the whole
            # registry IS her hands.
            result = _refuse_unknown_tool(turn, call, subset)
            emit(_activity_frame(call.name, "error", result))
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
            continue
        # The call's own progress channel: a frame per report, under this
        # call's name. Bound synchronously (no await joins the funnel).
        call_ctx = dataclasses.replace(
            tool_ctx,
            progress=lambda detail, _name=call.name: emit(
                _activity_frame(_name, "progress", detail=detail)
            ),
        )
        # What the turn is doing right now, for whoever asks (traces.DOING):
        # the tool's name, set synchronously so no await joins the funnel.
        traces.set_doing(turn.id, call.name)
        result, ok = await _run_tool(turn, call_ctx, call, subset=subset)
        ran_tool = tools.REGISTRY.get(call.name)
        if ok and ran_tool is not None and ran_tool.ephemeral:
            ran_ephemeral = True
        emit(_activity_frame(call.name, "ok" if ok else "error", result))
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
    return ran_ephemeral


# The flag a markup refusal in an OPEN round files. It is also what tells
# _refuse_call which of the two shapes it is composing — a round that had tools
# has no other reason to refuse, so the as-text sentence stands alone.
MARKUP_AS_TEXT_FLAG = "refused_markup_as_text"


def markup_as_text_refusal(name: str) -> str:
    """The whole refusal for markup in a round that DID advertise tools.

    Nothing was wrong with the round — the model simply typed the call instead
    of making it — so this says exactly that and is RETRYABLE: it names the tool
    and tells the model the one thing it has to do differently. The turn loop
    then gives it another round to do it, which is why this is a stated result
    and not a note.
    """
    return (
        f"{tools.ERROR_PREFIX}your reply wrote a tool call as text ({name}) — tools "
        "only run when issued as a tool call; re-issue it as one"
    )


def markup_refusal_fact(name: str) -> str:
    """The markup fact APPENDED to a CLOSED round's own refusal.

    The round's own reason (the rounds ran out, the redirect's tool round is
    over) is the one the model most needs, and overwriting it — as the first cut
    of this did — cost a closed round its own reason. So both are said."""
    return (
        f"and that was tool-call markup in your reply text, not a tool call, so {name} did not run"
    )


def _refuse_call(turn: traces.Turn, call: ToolCall, reason: str, flag: str) -> str:
    """A tool call made in a CLOSED round: NOT dispatched. It is still recorded
    as a tool span — ok=False with the stated reason as `error` — so the trace
    shows the call the model made and why it did not run, rather than a silent
    drop (a reply is a claim, the span is the fact). Returns the stated result
    the call is answered with. ONE implementation for every closed round (the
    tool rounds ran out, or a redirect's closing round), so none can quietly
    become a dispatch.

    It is ALSO the only thing that ever happens to a tool call the model wrote as
    MARKUP in its reply text, in any round (the ruling — see app/markup_calls.py).
    Two shapes, told apart by the flag the caller passes:

      * an OPEN round (MARKUP_AS_TEXT_FLAG) has no other reason to refuse, so the
        as-text sentence stands alone and is retryable;
      * a CLOSED round already has a reason, and the markup fact is APPENDED to
        it — never substituted for it, or a capped round stops saying the rounds
        ran out. Its span also carries `refused_markup`, which is what the turn
        derives its honest note from — never the reply's prose.
    """
    closed_round = flag != MARKUP_AS_TEXT_FLAG
    if call.from_markup and closed_round:
        fact = markup_refusal_fact(call.name)
        if fact not in reason:
            reason = f"{reason} {fact}"
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        span.meta["ok"] = False
        span.meta["result_head"] = reason[:SPAN_RESULT_HEAD_CHARS]
        span.meta["error"] = reason[:SPAN_RESULT_HEAD_CHARS]
        span.meta[flag] = True
        if call.from_markup:
            span.meta["parsed_from_markup"] = True
            if closed_round:
                span.meta["refused_markup"] = True
    return reason


def _refuse_out_of_rounds(turn: traces.Turn, call: ToolCall) -> str:
    """The out-of-rounds narration round's refusal."""
    return _refuse_call(turn, call, OUT_OF_ROUNDS_REFUSAL, "refused_out_of_rounds")


def _refuse_markup_as_text(turn: traces.Turn, call: ToolCall) -> str:
    """A tool call written as TEXT, refused in a round that HAD tools.

    THE line the ruling turns on. Three Criticals in a row came from trying to
    turn reply prose into an executable call — a fenced example that ran, a
    nested quote that moved ["rm","-rf","/"] onto a real call, a backticked tag
    boundary that absorbed the next invoke's arguments — and every one of them
    was an argument-fidelity defect that only mattered because something would
    run the result. Nothing runs it now. The model is told, by name, with the one
    thing it must do differently, and the turn gives it another round."""
    return _refuse_call(turn, call, markup_as_text_refusal(call.name), MARKUP_AS_TEXT_FLAG)


def unknown_tool_refusal(name: str, subset: Collection[str]) -> str:
    """The refusal an agent gets for naming a tool that does not exist: the
    same fact tools.dispatch states, but the list is the SUBSET the agent was
    shown, in the order it was shown, never the whole registry."""
    return (
        f"{tools.ERROR_PREFIX}there is no tool named {name!r} — the tools you were given are: "
        f"{', '.join(subset)}"
    )


def _refuse_unknown_tool(turn: traces.Turn, call: ToolCall, subset: Collection[str]) -> str:
    """A call to a name no tool has, from a persona holding a subset: NOT
    dispatched (nothing could run), recorded as a tool span with ok=False and
    `reason: unknown_tool` so the trace shows the call and why, and answered
    with the subset-scoped sentence. Returns that stated result."""
    reason = unknown_tool_refusal(call.name, subset)
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        span.meta["ok"] = False
        span.meta["result_head"] = reason[:SPAN_RESULT_HEAD_CHARS]
        span.meta["error"] = reason[:SPAN_RESULT_HEAD_CHARS]
        span.meta["reason"] = "unknown_tool"
    return reason


def _refuse_redirect_closed(turn: traces.Turn, calls: Sequence[ToolCall]) -> list[ToolCall]:
    """Every tool call a redirect made in a round that advertised no tools:
    refused and recorded, never dispatched, never silently dropped.

    Returns the refused calls that were written as MARKUP, so the redirect can
    report an honest note for a round whose whole text was a tool call it could
    not make — derived from what was actually refused."""
    for call in calls:
        _refuse_call(turn, call, REDIRECT_CLOSED_REFUSAL, "refused_redirect_closed")
    return [call for call in calls if call.from_markup]


def _markup_tool_calls(
    parsed: Sequence[markup_calls.ParsedCall], existing: Sequence[ToolCall]
) -> list[ToolCall]:
    """The calls a round's TEXT named, as ToolCalls that exist only to be refused.

    They travel with the round's real calls so that one loop refuses them, one
    transcript records them, and the model gets one well-formed tool result per
    thing it asked for. Nothing dispatches them — _dispatch_calls refuses every
    `from_markup` call before a tool is reached, and every closed round refuses
    them as it refuses any other call it cannot run.

    The de-duplication against the wire calls that used to live here is GONE with
    the dispatch it protected: a markup "call" that repeats a real one is now
    just a second refusal, not a second execution. Ids are still unique, because
    the assistant message and its tool results have to pair up.
    """
    taken = {call.id for call in existing}
    out: list[ToolCall] = []
    for position, call in enumerate(parsed, start=1):
        arguments = call.arguments
        encoded = arguments if isinstance(arguments, str) else json.dumps(arguments)
        candidate = f"markup_{position}"
        suffix = 0
        while candidate in taken:
            suffix += 1
            candidate = f"markup_{position}_{suffix}"
        taken.add(candidate)
        out.append(ToolCall(id=candidate, name=call.name, arguments=encoded, from_markup=True))
    return out


# -- the opt-in responsiveness check ---------------------------------------
#
# A SOFT, LLM-JUDGED, OPT-IN quality guard — the first LLM-judgment control in a
# guard family that is otherwise mechanical (narration/consent/capability derive
# their verdict from spans/the text/the registry — facts). This one ASKS a
# model "does this reply address the user's message?", a judgment that can be
# wrong, so it is opt-in (default OFF), fail-OPEN (never breaks a turn), and
# bounded (one redirect, no re-judge loop). It catches RELEVANCE drift — the
# "asked about the pixel, answered about openai" case, most common on small
# local models — NOT factual accuracy, which the mechanical guards and tools own.


async def _gateway_round(
    app,
    turn: traces.Turn,
    model: str,
    messages: Sequence[dict],
    advertised: Sequence[dict],
    *,
    round_number: int,
    on_delta: Callable[[str], None] | None,
    purpose: str | None = None,
    role: str | None = None,
) -> tuple[str, list[ToolCall], str | None]:
    """ONE gateway round: its text, the tool calls it asked for, a failure or None.

    `purpose` is what the gateway's ledger records this call as (S10);
    it defaults to the turn's kind (chat / scheduled / eval). `role` names
    the routing chain to walk (S10-2); None sends none.

    The turn loop's own round, lifted out verbatim so it has exactly one
    implementation — the loop below and the claim redirect (which must be able
    to CALL TOOLS, unlike the text-only `_collect_completion`) run the same code,
    record the same `llm_call` span, and parse the same wire shapes. A gateway
    that refuses, or a transport that dies, is returned as a STATED reason rather
    than raised: every caller has to decide what a dead round means for its own
    flow, and none of them may treat one as an empty success.

    `on_delta` receives each content delta as it arrives (the turn loop streams
    it live and accumulates it); passing None collects silently, which is what a
    redirect wants — its text is emitted once, after the note, and only if it is
    actually going to be used.
    """
    # One site covers every round there is — the loop's, the narration
    # round, both redirect shapes — because they all come through here.
    traces.set_doing(turn.id, "thinking")
    collected: list[str] = []
    buffer = ToolCallBuffer()
    failure: str | None = None
    # The stream's SHAPE, counted as it arrives: a stream that ends without a
    # [DONE] marker, or that carries lines which are not SSE data at all, is the
    # only evidence an empty round leaves behind, and it goes on the span.
    # (Measured 2026-09-04 17:11: headers after 280 s, then the stream ended at
    # 300 s with zero data lines — and the span recorded nothing about it, so
    # the trace said a round had run and said nothing about how it ended.)
    saw_done = False
    data_lines = 0
    stray_lines = 0
    stray_head: str | None = None
    t0 = time.perf_counter()
    purpose = purpose or _purpose_of(turn)
    role = role if role is not None else _role_of(turn)
    with turn.span("llm_call", model or None) as span:
        span.meta["model"] = model
        span.meta["round"] = round_number
        span.meta["tools_advertised"] = bool(advertised)
        span.meta["purpose"] = purpose
        try:
            async with peers.client(app, peers.GATEWAY, GATEWAY_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    "/v1/chat/completions",
                    json=completion_payload(model, messages, advertised),
                    headers=peers.attribution_headers(turn, purpose, role),
                ) as response:
                    served_by = response.headers.get("x-nova-served-by")
                    if served_by:
                        span.meta["served_by"] = served_by
                    _note_route(span, response.headers.get("x-nova-route"))
                    if response.status_code != 200:
                        span.meta["gateway_status"] = response.status_code
                        detail = (await response.aread()).decode(errors="replace")[:400]
                        raise GatewayFailure(
                            f"the gateway refused the request ({response.status_code}): {detail}"
                        )
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line or line.startswith(":"):
                            # Frame separators and SSE comments (a proxy's
                            # keep-alive) — not data, not evidence either.
                            continue
                        if not line.startswith("data:"):
                            # Not SSE. A backend that writes a plain JSON error
                            # body into a 200 stream lands here; it used to be
                            # dropped without a trace. Counted, first head kept.
                            stray_lines += 1
                            if stray_head is None:
                                stray_head = line[:STRAY_LINE_HEAD_CHARS]
                            continue
                        data_lines += 1
                        data = line[len("data:") :].strip()
                        if data == "[DONE]":
                            saw_done = True
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            span.meta["malformed_chunks"] = span.meta.get("malformed_chunks", 0) + 1
                            continue
                        delta, usage, error, fragments = _chunk_parts(chunk)
                        if error is not None:
                            raise GatewayFailure(f"the gateway reported: {error}")
                        if usage is not None:
                            # Only what the gateway actually reported — a null
                            # token count is not a measurement.
                            _note_usage(span, usage)
                        for fragment in fragments:
                            buffer.add(fragment)
                        if delta:
                            collected.append(delta)
                            if on_delta is not None:
                                on_delta(delta)
        except GatewayFailure as exc:
            failure = str(exc)
            span.meta["error"] = failure
            span.meta["error_class"] = type(exc).__name__
        except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
            # The class AND the message, so the trace can tell a read timeout
            # from a refused connection without parsing the sentence.
            failure = _transport_failure(exc)
            span.meta["error"] = failure
            span.meta["error_class"] = type(exc).__name__
            phase = _timeout_phase(exc)
            if phase is not None:
                span.meta["timeout_phase"] = phase
                span.meta["timeout_s"] = getattr(GATEWAY_TIMEOUT, phase)
        elapsed_s = time.perf_counter() - t0
        calls = buffer.finished()
        # A round's content is scanned ONCE, here, so every round in the system
        # — the turn loop's, the out-of-rounds narration round, both of a
        # redirect's — gets the same treatment from the same code. A model that
        # writes its tool call as XML in the reply text (see app/markup_calls.py)
        # has it recovered and turned into an ordinary ToolCall; the text that
        # remains is the round's content, and the markup is gone from it.
        #
        # NOTHING here dispatches, and neither does anything downstream: under
        # the ruling a tool call written as text is refused in EVERY round. An
        # open round refuses it through _dispatch_calls with a stated, retryable
        # reason and then gives the model another round; a closed round refuses
        # it alongside its own reason. Both go through the one _refuse_call.
        text = "".join(collected)
        # streamed=True: a round's text really can stop mid-block, and half an
        # emitted call is not prose. (The persist boundary passes False — a
        # finished record is never partial, and the rule would eat a sentence.)
        scan = markup_calls.parse_markup_tool_calls(text, streamed=True)
        if scan.found:
            text = scan.text
            span.meta["markup_calls"] = len(scan.calls)
            if scan.unparsed:
                # Markup too malformed to read: stripped, never dispatched, and
                # said out loud in the span rather than silently dropped.
                span.meta["markup_unparsed"] = True
            calls.extend(_markup_tool_calls(scan.calls, calls))
        span.meta["tool_calls"] = len(calls)
        if failure is None and not collected and not calls:
            # A round that produced NOTHING — no content, no tool calls, no
            # stated error — is a failed round, said so here with the stream's
            # counted facts, not an empty success for the caller to discover
            # later (or, before this, never: the turn's floor caught only a
            # whole-turn silence, and the span said nothing at all). Every
            # caller already handles a stated failure: the turn loop ends the
            # turn with the statement, the narration round fails open, a
            # redirect ships its correction.
            failure = _empty_round_failure(
                elapsed_s,
                saw_done=saw_done,
                data_lines=data_lines,
                stray_lines=stray_lines,
                stray_head=stray_head,
            )
            span.meta["error"] = failure
            span.meta["error_class"] = EMPTY_ROUND
        if not saw_done or stray_lines:
            # Only the unusual shapes are recorded — a clean stream is the
            # norm and needs no row of counters saying so.
            stream: dict[str, object] = {"done": saw_done, "data_lines": data_lines}
            if stray_lines:
                stream["stray_lines"] = stray_lines
                stream["stray_head"] = stray_head
            span.meta["stream"] = stream
    return text, calls, failure


# The usage fields the gateway's synthetic chunk states (S10) — copied onto
# the llm_call span only when present; a null is not a measurement.
_USAGE_FIELDS = (
    "prompt_tokens",
    "completion_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_usd",
    "cost_basis",
    "provider",
    "local",
    "metered",
)


def _note_usage(span, usage: dict) -> None:
    for field in _USAGE_FIELDS:
        if usage.get(field) is not None:
            span.meta[field] = usage[field]
    if usage.get("recorded") is False:
        # The gateway could not write its ledger row: said on the span so
        # the Activity page shows the gap instead of a silent under-count.
        span.meta["usage_recorded"] = False


def _note_route(span, header: str | None) -> None:
    """The gateway's X-Nova-Route (S10-2): `role=…;link=N;reason=…`."""
    if not header:
        return
    fields = dict(part.split("=", 1) for part in header.split(";") if "=" in part)
    if fields.get("role"):
        span.meta["route_role"] = fields["role"]
    if fields.get("link", "").isdigit():
        span.meta["route_link"] = int(fields["link"])
    if fields.get("reason"):
        span.meta["route_reason"] = unquote(fields["reason"])


def _purpose_of(turn: traces.Turn) -> str:
    """What the ledger records a turn's own rounds as: its kind."""
    kind = getattr(turn, "kind", None)
    return kind if isinstance(kind, str) and kind else "chat"


# The routing chain a turn's own rounds walk (S10-2): a chat turn the chat
# chain, a scheduled turn the scheduled chain, a beat the beat chain; an eval
# NAMES its model and walks none — a measurement on a substituted model would
# be a lie about which model was measured (rail 17).
#
# A kind missing from here is not a neutral omission, which is why `beat` was
# added the same day the kind was (S11-1): with no X-Nova-Role the gateway
# serves the turn's explicit model with NO chain behind it and NO fallback
# when that model is walled, and the ledger meters the spend under a NULL role
# — so a beat's hourly cost would be invisible on the Spend page.
_ROLE_BY_KIND = {"chat": "chat", "scheduled": "scheduled", "beat": "beat"}


def _role_of(turn: traces.Turn) -> str | None:
    """The turn's own role when it was opened with one (S12: an agent's
    `agent_<name>`, whatever kind the turn is), else the kind's. An eval turn
    is opened with none and its kind maps to none — rail 17 holds by the same
    line."""
    return turn.role or _ROLE_BY_KIND.get(_purpose_of(turn))


async def _collect_completion(
    app,
    turn: traces.Turn,
    model: str,
    messages: Sequence[dict],
    *,
    purpose: str,
    max_tokens: int | None = None,
) -> str:
    """One non-tool gateway call, every content delta concatenated into a string.

    A plain completion (no tools advertised): the judge wants a word, the
    redirect wants a focused reply, and neither needs the tool loop. Reuses the
    same peer client, bearer and SSE parsing as the turn's own rounds. Raises
    GatewayFailure/httpx errors on a bad round; the callers turn any raise into
    fail-open (ship the original reply), so this never has to swallow anything.

    Records an `llm_call` span of its own with `purpose` (judge / redirect) —
    S10: these calls cost money too, and before this they were the one
    round nobody could see or attribute. The routing role it walks is the
    TURN's own when it has one (S12: an agent's redirect rounds walk its
    chain and count against its cap, exactly like its tool rounds), and the
    judge role otherwise — Nova's judge/redirect rounds are unchanged.
    """
    # A redirect or judge round is a gateway round too: whoever asks what the
    # turn is doing gets the same answer as for its own rounds (traces.DOING).
    traces.set_doing(turn.id, "thinking")
    payload: dict = {"messages": list(messages), "stream": True}
    if model:
        # An empty chat.model means "the gateway default"; sending "" would ask
        # for a model literally named "".
        payload["model"] = model
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    collected: list[str] = []
    with turn.span("llm_call", model or None) as span:
        span.meta["model"] = model
        span.meta["purpose"] = purpose
        span.meta["tools_advertised"] = False
        span.meta["ok"] = False
        try:
            async with peers.client(app, peers.GATEWAY, JUDGE_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    "/v1/chat/completions",
                    json=payload,
                    headers=peers.attribution_headers(turn, purpose, turn.role or "judge"),
                ) as response:
                    served_by = response.headers.get("x-nova-served-by")
                    if served_by:
                        span.meta["served_by"] = served_by
                    _note_route(span, response.headers.get("x-nova-route"))
                    if response.status_code != 200:
                        detail = (await response.aread()).decode(errors="replace")[:200]
                        span.meta["gateway_status"] = response.status_code
                        raise GatewayFailure(
                            f"the gateway refused ({response.status_code}): {detail}"
                        )
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[len("data:") :].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        delta, usage, error, _fragments = _chunk_parts(chunk)
                        if usage is not None:
                            _note_usage(span, usage)
                        if error is not None:
                            raise GatewayFailure(f"the gateway reported: {error}")
                        if delta:
                            collected.append(delta)
        except Exception as exc:
            span.meta["error"] = peers.reason(exc)[:400]
            raise
        span.meta["ok"] = True
    return "".join(collected)


def _parse_verdict(raw: str) -> str | None:
    """ "on_topic" or "off_topic" from the judge's text, or None if neither is
    there. None is the unparseable case, which the caller treats as on_topic
    (fail-open): a judge that did not answer clearly must never trigger a
    redirect."""
    match = _VERDICT_RE.search(raw)
    if match is None:
        return None
    return "off_topic" if match.group(1).lower() == "off" else "on_topic"


async def _judge_verdict(app, turn: traces.Turn, model: str, message: str, reply: str) -> str:
    """The cheap judge call: does `reply` address `message`? on_topic/off_topic.

    Inputs are the pair alone, not the turn's history — the drift is visible from
    message-vs-reply and the whole point is to stay cheap. An unparseable answer
    is on_topic (fail-open); a gateway/transport error raises, and the caller
    treats that as on_topic too.
    """
    judge_messages = [
        {"role": "system", "content": JUDGE_SYSTEM},
        {
            "role": "user",
            "content": f"User message:\n{message}\n\nAssistant reply:\n{reply}",
        },
    ]
    raw = await _collect_completion(
        app, turn, model, judge_messages, purpose="judge", max_tokens=JUDGE_MAX_TOKENS
    )
    return _parse_verdict(raw) or "on_topic"


async def _responsiveness_redirect(
    app,
    turn: traces.Turn,
    model: str,
    message: str,
    reply: str,
    messages: Sequence[dict],
    emit: Callable[[str | None], None],
) -> tuple[str, bool]:
    """Judge `reply` for drift and, if it drifted, regenerate ONCE, focused.

    Returns (durable_text, redirected). On an on_topic verdict the original
    reply stands. On off_topic, one corrective regeneration runs off the turn's
    EXISTING message context (so this turn's tool results are reused) plus a
    nudge to answer the latest message directly; the corrected reply is emitted
    after a brief refocus note and REPLACES the durable text (history/memory keep
    the good one, like the anti-poison replace) — the drift already streamed live
    as `t` frames but must not be what the next turn reads.

    FAIL-OPEN throughout: a judge error, a gateway error, an empty regeneration,
    or an unparseable verdict all ship the ORIGINAL reply unchanged, logged,
    never an error frame and never a lost turn. Bounded to ONE redirect — the
    corrected reply is never re-judged. Records exactly one 'responsiveness'
    guard span; the caller only reaches here when the setting is on, so a span
    always means the check actually ran.

    v1 uses the turn's own chat.model as the judge — the same model reviewing its
    own reply (the disclaimer says so). A different/stronger judge model is an S4
    upgrade.
    """
    with turn.span("guard", "responsiveness") as span:
        span.meta["checked"] = True
        try:
            verdict = await _judge_verdict(app, turn, model, message, reply)
        except Exception as exc:
            span.meta.update(verdict="on_topic", redirected=False, error=peers.reason(exc))
            logger.warning(
                "responsiveness judge failed, shipping the reply as-is: %s",
                peers.reason(exc),
            )
            return reply, False
        span.meta["verdict"] = verdict
        if verdict != "off_topic":
            span.meta["redirected"] = False
            return reply, False

        nudge = {
            "role": "system",
            "content": (
                f"Focus only on the user's latest message: {message}. "
                "Do not drift to earlier topics; answer it directly."
            ),
        }
        try:
            corrected = (
                await _collect_completion(app, turn, model, [*messages, nudge], purpose="redirect")
            ).strip()
        except Exception as exc:
            span.meta.update(redirected=False, error=peers.reason(exc))
            logger.warning(
                "responsiveness redirect failed, shipping the original reply: %s",
                peers.reason(exc),
            )
            return reply, False
        if not corrected:
            # A redirect that produced nothing is not a correction — keep the
            # original rather than persist an empty reply.
            span.meta["redirected"] = False
            logger.warning("responsiveness redirect produced no text, shipping the original reply")
            return reply, False

        span.meta["redirected"] = True
        emit(_frame({"correction": REFOCUS_NOTE}))
        emit(_frame({"t": corrected}))
        return corrected, True


# -- the always-on deferral guard ------------------------------------------
#
# Separate from agents.responsiveness_check: a deferral is a broken promise (a
# DEFECT), not a preference, so the detector runs on every turn — but the
# redirect it triggers only ever fires when a deferral ACTUALLY happened
# (guards.deferral_check returned a claim), so the cost is targeted, unlike the
# opt-in responsiveness check which second-guesses good answers. This runs FIRST
# and shares the turn's single redirect budget: if it redirects, the (opt-in)
# responsiveness check does not redirect again this turn (no loops, ever).


async def _deferral_redirect(
    app,
    turn: traces.Turn,
    model: str,
    claim: guards.DeferralClaim,
    reply: str,
    messages: Sequence[dict],
    emit: Callable[[str | None], None],
    user_message: str = "",
    *,
    persona: agents.Persona,
) -> str:
    """Regenerate ONCE to actually do the promised action, or say so honestly.

    Reuses the responsiveness redirect's shape: one corrective regeneration off
    the turn's EXISTING message context (so this turn's context is reused) plus a
    nudge to do it now by calling the tool. Returns the durable text:

      * On a regeneration that no longer defers, the corrected reply is emitted
        after a brief note and REPLACES the durable text (the deferral already
        streamed live as `t` frames but must not be what the next turn reads,
        like the responsiveness/anti-poison replace).
      * If the redirect STILL defers, produces nothing, or errors, it is NOT
        retried — an honest one-sentence note is appended so the operator is
        never left waiting on a promise. This is the only always-on behavior
        that is not a redirect, and it never fabricates a completed action.

    FAIL-OPEN and bounded to ONE redirect: the regenerated reply is checked once
    (never re-redirected), and a gateway/transport error degrades to the honest
    note rather than an error frame or a lost turn. Records exactly one
    'deferral' guard span. The re-check reads `persona.tool_names` (S12) —
    the toolset THIS turn was shown, so an agent is judged against its own
    hands and never against a tool only Nova holds.
    """
    with turn.span("guard", "deferral") as span:
        span.meta.update(detected=True, action=claim.tool, phrase=claim.phrase)
        nudge = {
            "role": "system",
            "content": (
                f"You told the user you would {claim.action_phrase}. Do it now "
                "by calling the appropriate tool — do not say you will; actually "
                "make the call."
            ),
        }
        try:
            corrected = (
                await _collect_completion(app, turn, model, [*messages, nudge], purpose="redirect")
            ).strip()
        except Exception as exc:
            span.meta.update(redirected=False, error=peers.reason(exc))
            logger.warning(
                "deferral redirect failed, appending an honest note: %s",
                peers.reason(exc),
            )
            note = _deferral_honest_note(claim.action_phrase)
            emit(_frame({"correction": note}))
            return f"{reply}\n\n{note}"

        # Bounded to ONE redirect: the regenerated reply is judged once, never
        # re-redirected. A redirect that STILL commits to the tool without
        # calling it (or that produced nothing) has not done the thing, so it
        # degrades to the honest note rather than looping.
        still_defers = False
        if corrected:
            try:
                still_defers = (
                    guards.deferral_check(
                        corrected, turn.spans, persona.tool_names, user_message=user_message
                    )
                    is not None
                )
            except Exception:
                logger.exception("deferral re-check raised; treating the redirect as complete")
                still_defers = False
        if not corrected or still_defers:
            span.meta["redirected"] = False
            note = _deferral_honest_note(claim.action_phrase)
            emit(_frame({"correction": note}))
            return f"{reply}\n\n{note}"

        span.meta["redirected"] = True
        emit(_frame({"correction": DEFERRAL_NOTE}))
        emit(_frame({"t": corrected}))
        return corrected


# -- the CLAIM redirect: one path, several claim kinds ----------------------
#
# The owner's walk, 2026-09-02 22:22: he said "try again" (re-run a device
# command), the local model produced a reply whose WHOLE stance was "still
# awaiting your approval" with no tool call, guards.consent_claim_check
# correctly fired (nothing was pending) — and nothing was retried. The lie was
# contradicted and the WORK still did not happen: "try again" did nothing.
#
# An hour later, 23:51, the SAME shape with a different claim: "try again" ->
# zero tool calls -> "Looks like the device is still offline", parroted out of
# the history while the machine was online. Contradicting it is not enough
# there either — the work (checking) still has to happen.
#
# So a fired REPLACE-class guard gets the same ONE mechanical redirect the
# deferral guard has, off the turn's existing message context, with a nudge that
# states the facts that guard just established. The difference from
# _deferral_redirect is that this one advertises TOOLS: the whole point is that
# the action runs, so a tool call in the redirect is dispatched through the SAME
# machinery as any other round (_dispatch_calls), followed by one final text
# round with the loop closed. Bounded to that: at most two gateway calls, never
# a second redirect, and it spends the turn's single shared redirect budget so a
# second claim kind, a deferral or a responsiveness redirect can never also run.
#
# ONE implementation, parameterized by CLAIM KIND (the guard span's name, the
# correction it ships, the facts it records, the nudge it derives and the live
# note it emits on success) rather than copied per guard: a second copy is a
# second place for the double-execution precondition, the full-guard-set vetting
# of the regeneration, or the single-budget rule to drift out of agreement.


def _regen_rejected_by(
    corrected: str,
    turn: traces.Turn,
    tool_ctx: tools.ToolContext,
    device_names: Sequence[str],
    user_message: str,
    persona: agents.Persona,
    *,
    agent_names: Sequence[str],
) -> str | None:
    """Which mechanical guard, if any, REFUSES the regenerated reply.

    The redirect's output does not just stream — it REPLACES the durable record
    and (unlike a corrected turn) is INGESTED into per-person memory. So it must
    clear the same bar the model's own reply had to clear, not merely the
    consent re-check that motivated the redirect: the full mechanical set, over
    THIS turn's live spans and the toolset THIS turn was shown (S12:
    `persona.tool_names` — Nova's is the live registry, an agent's its
    subset, so an agent's honest "I have no such tool" is never refused as a
    false denial of a tool only Nova holds). Without that, a regen
    answering "Done — I've saved it to report.md" with no span behind it would
    persist unvetted and poison recall — trading a pending-state fabrication for
    a completed-action one, which is worse, because it is ingested.

    Returns the NAME of the first guard that fires (checked cheapest-first, in
    the same order the turn runs them), or None when the regen is clean. Each
    check is fail-OPEN on its own: a guard that raises is logged and does not
    reject, exactly as in the turn body. bare_intent is included so a regen
    that itself came back as another bare ack-and-go ("Checking now…", no
    call) is caught here too, whichever claim's redirect produced it — not
    only the bare-intent redirect's own attempt. presented_listing reads the
    same live spans: a redirect that actually listed (a declared listing tool,
    or a shell run whose result is a listing) backs the listing the regen then
    presents; one that did not is refused by name. `user_message` is what the
    listing guard exempts — lines the user pasted are theirs, not a claim.
    `agent_names` (S12) is the live roster the turn read once at its closer
    (see _agent_names — already minus the agents this conversation has on
    record), so a regeneration that credits "coder" with work no
    delegate_to_agent span backs is refused by the same guard that would
    have corrected the original reply — a lie about a helper is no better
    for having been written on the second try. Whose reply it is comes from
    `persona`, so the regeneration is judged by exactly the rule the
    original was.
    """
    checks: tuple[tuple[str, Callable[[], object | None]], ...] = (
        ("consent_claim", lambda: guards.consent_claim_check(corrected)),
        ("narration", lambda: guards.narration_check(corrected, turn.spans)),
        (
            "delegation_claim",
            lambda: guards.delegation_claim_check(
                corrected,
                turn.spans,
                agent_names,
                # Whose reply this is, DERIVED from the persona this vetting
                # already judges the toolset by, never handed in beside it:
                # two sources for one fact is two facts that can disagree.
                self_name=persona.agent.name if persona.agent is not None else None,
            ),
        ),
        (
            "capability_claim",
            lambda: guards.capability_claim_check(corrected, persona.tool_names),
        ),
        (
            "state_claim",
            lambda: guards.state_claim_check(corrected, turn.spans, device_names),
        ),
        (
            "presented_listing",
            lambda: guards.presented_listing_check(
                corrected, turn.spans, persona.listing_tools, user_message
            ),
        ),
        (
            "deferral",
            lambda: guards.deferral_check(
                corrected, turn.spans, persona.tool_names, user_message=user_message
            ),
        ),
        ("bare_intent", lambda: guards.bare_intent_check(corrected, turn.spans)),
    )
    for name, check in checks:
        try:
            if check() is not None:
                return name
        except Exception:
            logger.exception("%s re-check raised over the redirect; not rejecting on it", name)
    return None


@dataclass
class _ClaimRedirect:
    """What the one redirect produced, as facts the caller composes from."""

    text: str
    redirected: bool
    read_ephemeral: bool
    # Set when a round of this redirect wrote a tool call as MARKUP and it was
    # refused (the round advertised no tools). A BACKEND note, like the round-cap
    # note: the caller keeps it whatever the composition below does with the
    # model's prose, so a turn whose last word was an unrunnable tool call says
    # so instead of showing XML or nothing.
    markup_note: str | None = None


async def _claim_redirect(
    app,
    turn: traces.Turn,
    model: str,
    *,
    claim_kind: str,
    correction_text: str,
    span_meta: dict,
    nudge_for: Callable[[bool], str],
    redirect_note: str,
    out_of_rounds: bool,
    messages: Sequence[dict],
    advertised: Sequence[dict],
    tool_ctx: tools.ToolContext,
    device_names: Sequence[str],
    agent_names: Sequence[str],
    user_message: str,
    emit: Callable[[str | None], None],
    persona: agents.Persona,
    subset: Collection[str] | None = None,
) -> _ClaimRedirect:
    """Regenerate ONCE, with tools, after a REPLACE-class guard fired.

    `claim_kind` names the guard span this owns ("consent_claim",
    "state_claim", "presented_listing"); `span_meta` are the facts that guard
    measured, recorded as
    the caller measured them; `nudge_for` DERIVES the system nudge from
    ran_a_tool (measured here, from the spans) so the sentence it sends the
    model is true by construction rather than by a comment promising it is; and
    `redirect_note` is the live frame shipped ahead of a successful regeneration.

    Outcomes, all recorded on the turn's single guard span:

      * The regeneration is CLEAN under the full mechanical guard set (and may
        have actually called the tool): it REPLACES the durable text — the
        fabricated prose already streamed live, but what the NEXT turn reads is
        the reply that did the work. redirected=True.
      * It is rejected by a guard, produces nothing, or the gateway fails: the
        correction persists exactly as before, the turn stays plumbing (not
        ingested), and the span names the rejecting guard. redirected=False.

    Two mechanical PRECONDITIONS, checked before anything is generated, because
    a redirect is an ACTION and not just a re-word:

      * NOTHING RAN YET (guards.ran_a_tool over this turn's spans). If round 1
        really executed the tool and round 2 merely narrated about it,
        redirecting would run it a SECOND time — a duplicated side effect, which
        is worse than the lie it was correcting.
      * THE TURN IS NOT OUT OF ROUNDS. A turn that hit its round cap must not
        get one more dispatch through a side door.

    And inside the redirect the same rule holds mechanically rather than by
    assumption: a tool call emitted in a round that advertised NO tools — the
    closing round always, the first round if it was somehow opened closed — is
    refused through the shared `_refuse_call` and recorded, never dispatched and
    never silently dropped.

    Either way the correction ships with a stated reason in the span.

    The regeneration is judged by the FULL mechanical set against LIVE facts,
    not the stale ones: if the redirect's own call ran a device tool, a state
    report is then backed; if it listed, a listing is. The same facts that make
    each guard fire or stay silent, read again after the tools ran. deferral is
    in the set too (owner ruling 2026-09-03): a regeneration that promises the
    tool again, or asks "want me to?" for the instructed action again, has not
    done the thing and is refused by name.

    FAIL-OPEN throughout: any exception ships the correction, never an error
    frame and never a lost turn.

    `persona` and `subset` (S12) are the turn's own, threaded through
    unchanged: the regeneration is vetted against the toolset this turn was
    shown, and a call it dispatches is marked outside the subset exactly as
    the turn loop's would be.
    """
    read_ephemeral = False
    # Tool calls this redirect wrote as MARKUP and had refused (a round with no
    # tools). Collected from the refusals themselves, never from the text.
    markup_refused: list[ToolCall] = []

    def _markup_note() -> str | None:
        """The note the caller keeps: this redirect's closing round wrote a tool
        call as text and had no round left to be told in, so the operator is."""
        if not markup_refused:
            return None
        return markup_calls.no_tool_round_note([call.name for call in markup_refused])

    with turn.span("guard", claim_kind) as span:
        span.meta.update(span_meta)
        # DERIVED from the turn's own spans, never from the reply's prose: a
        # successful tool span means the work already happened this turn.
        ran_a_tool = guards.ran_a_tool(turn.spans)
        span.meta["ran_a_tool"] = ran_a_tool
        blocked = (
            "tools_already_ran" if ran_a_tool else ("out_of_rounds" if out_of_rounds else None)
        )
        if blocked is not None:
            # No regeneration at all: doing the work twice, or past the cap, is
            # not a correction. The lie is still contradicted, as before.
            span.meta.update(redirected=False, not_redirected_because=blocked)
            logger.info("%s redirect skipped (%s); shipping the correction", claim_kind, blocked)
            emit(_frame({"correction": correction_text}))
            return _ClaimRedirect(
                correction_text, False, read_ephemeral, markup_note=_markup_note()
            )

        try:
            attempt: list[dict] = [
                *messages,
                {"role": "system", "content": nudge_for(ran_a_tool)},
            ]
            # round_number 0: not one of the turn's numbered rounds — this is
            # the redirect, and the span says so rather than pretending to be
            # round N+1. Deltas are collected silently: the regenerated text is
            # emitted once, after the note, and only if it is actually used.
            regenerated, calls, failure = await _gateway_round(
                app,
                turn,
                model,
                attempt,
                advertised,
                round_number=0,
                on_delta=None,
            )
            if failure is not None:
                raise GatewayFailure(failure)
            span.meta["redirect_tool_calls"] = len(calls)
            if calls and not advertised:
                # The round advertised no tools and asked for one anyway: it is
                # refused and recorded, exactly like the turn's own closed
                # rounds. Nothing is dispatched, and the regenerated text still
                # stands or falls on the guard vetting below.
                span.meta["refused_calls"] = len(calls)
                markup_refused.extend(_refuse_redirect_closed(turn, calls))
            elif calls:
                attempt.append(
                    {
                        "role": "assistant",
                        "content": regenerated,
                        "tool_calls": [call.as_openai() for call in calls],
                    }
                )
                read_ephemeral = await _dispatch_calls(
                    turn, tool_ctx, calls, attempt, emit, subset=subset
                )
                # One final round to say what happened, with the tool loop
                # CLOSED (no tools advertised) — the redirect gets one attempt at
                # the action, never a loop of its own. A call it makes anyway is
                # refused and recorded rather than dropped on the floor.
                regenerated, more, failure = await _gateway_round(
                    app, turn, model, attempt, (), round_number=0, on_delta=None
                )
                if more:
                    span.meta["refused_calls"] = len(more)
                    markup_refused.extend(_refuse_redirect_closed(turn, more))
                if failure is not None:
                    raise GatewayFailure(failure)
        except Exception as exc:
            span.meta.update(redirected=False, error=peers.reason(exc))
            logger.warning(
                "%s redirect failed, shipping the correction: %s",
                claim_kind,
                peers.reason(exc),
            )
            emit(_frame({"correction": correction_text}))
            return _ClaimRedirect(
                correction_text, False, read_ephemeral, markup_note=_markup_note()
            )

        if markup_refused:
            # The redirect wrote a tool call as text in a round that had no
            # tools. It is already refused and recorded as a tool span; naming it
            # on the guard span too is what makes the note the caller keeps
            # traceable to the round that earned it.
            span.meta["refused_markup_calls"] = len(markup_refused)

        corrected = regenerated.strip()
        # Judged ONCE by the FULL mechanical set — this text is about to replace
        # the durable record AND be ingested — and never re-redirected.
        rejected_by = (
            _regen_rejected_by(
                corrected,
                turn,
                tool_ctx,
                device_names,
                user_message,
                persona,
                agent_names=agent_names,
            )
            if corrected
            else None
        )
        if not corrected or rejected_by is not None:
            span.meta["redirected"] = False
            if rejected_by is not None:
                span.meta["regen_rejected_by"] = rejected_by
                logger.warning(
                    "%s redirect regenerated a reply the %s guard refused; shipping the correction",
                    claim_kind,
                    rejected_by,
                )
            emit(_frame({"correction": correction_text}))
            return _ClaimRedirect(
                correction_text, False, read_ephemeral, markup_note=_markup_note()
            )

        span.meta["redirected"] = True
        emit(_frame({"correction": redirect_note}))
        emit(_frame({"t": corrected}))
        return _ClaimRedirect(corrected, True, read_ephemeral, markup_note=_markup_note())


async def _run_turn(
    app,
    pool: asyncpg.Pool,
    turn: traces.Turn,
    person: Person,
    conversation_id: uuid.UUID,
    message: str,
    history: Sequence[dict],
    model: str,
    max_tool_rounds: int,
    emit: Callable[[str | None], None],
    *,
    ingest: bool = True,
    persona: agents.Persona | None = None,
) -> None:
    """The whole turn, run to completion regardless of who is still watching.

    `ingest=False` (S9) skips the memory ingest and nothing else: a scheduled
    timer's instruction rides as the model's message and must not be written
    into memory as something he said today, every day. Chat and the eval
    runner leave it at the default.

    `persona` (S12) is WHO the turn runs as. None is Nova — agents.nova_
    persona(), the whole live registry and the env workspace root, and every
    byte the gateway sees is what it saw before agents existed (pinned). An
    agent's persona is read at exactly the sites that used to read the
    registry or the environment: the prompt (its subset and its block), the
    advertised tools, the workspace root the tool context is contained in,
    the toolset every honesty guard judges against (so an agent's honest "I
    have no such tool" is never "corrected"), the second memory scope
    recalled, the cap checked before the first round, and the subset flag on
    each tool span. There is no second path for an agent: the same loop,
    the same guards, the same persist and the same close.

    This is the ONLY writer of the assistant message and the ONLY caller of
    close_turn for this turn. It is spawned as a detached background task, so
    a client that hangs up — a hard refresh, a closed tab — tears down only
    the browser↔core SSE stream, never this: core↔gateway stays open and the
    turn finishes server-side, persisting the COMPLETE reply with status
    'ok', exactly as if the browser had stayed (ruling S2c-R1: with no
    explicit Stop yet, every disconnect means "finish"). Because there is
    exactly ONE path through here, the honesty guard, the persist, the ingest
    and the atomic trace close all run identically whether or not the browser
    stayed — there is no second "detached" path that could skip one, and no
    second writer that could double-persist.

    Frames go to `emit`, which hands them to whatever SSE consumer is still
    attached (see `_stream_from_queue`); once the client is gone they are
    simply dropped and the work finishes anyway. `emit(None)` is the
    end-of-turn sentinel, sent LAST — after the atomic close — so a reader
    that drains the stream has, by [DONE], seen a fully-recorded turn.
    """
    # Everything streamed to the client this turn, across every round, in
    # order — this is what persists, so a reload shows exactly what was
    # watched live.
    parts: list[str] = []
    # The outcome, once the turn has actually reached one. None means the
    # turn is still in flight; the finally below closes it as 'error' only if
    # the coroutine is torn down (e.g. at shutdown) before deciding.
    decided: str | None = None
    # Whether an assistant row for this turn is on record — the ok reply or a
    # failure statement. The unplanned-exception path below writes one only
    # if none is, so a turn never gets two.
    persisted_reply = False

    async def _end_without_a_reply(stated: str, *, verbatim: bool = False) -> None:
        """The turn's ONE exit for a model call that did not answer.

        A turn that ends 'error' owes the owner a VISIBLE reply, not a blank:
        before this, the failure went out as a live error frame and nothing
        else, so a page that had been reloaded (or was polling pending_turn
        after a hard refresh) saw the turn close and then found nothing in the
        transcript. The statement is composed from the failed round's span
        and the tool spans (model_failure_statement), persisted as the
        assistant row FIRST — so if the database refuses it the unplanned
        path below says so, and this turn never claims a record it does not
        have — then sent as the error frame, the same words. Streamed prose
        from the dead round (`parts`) is not the record: it was watched live,
        but it is unguarded text from a call that did not finish, and the
        next turn must not read it back as an answer. Not ingested: a failed
        call is plumbing, not knowledge.

        `verbatim` (S12) persists `stated` as-is instead of composing a
        model-failure statement around it: the cap exit's sentence is already
        the whole fact ("agent coder is over its monthly cap…") and no model
        was called for it to have failed. Everything else — decided 'error',
        persist first then emit, no ingest — is identical.
        """
        nonlocal decided, persisted_reply
        statement = (
            stated
            if verbatim
            else model_failure_statement(model=model, failure=stated, spans=turn.spans)
        )
        logger.warning("chat turn %s failed: %s", turn.id, stated)
        decided = "error"
        await _persist_assistant(pool, conversation_id, statement, turn.id)
        persisted_reply = True
        emit(_frame({"error": statement}))
        emit(DONE_FRAME)

    try:
        # Inside the try, so a persona that cannot be built still reaches
        # the finally that closes the turn.
        persona = persona or agents.nova_persona()
        if persona.agent is not None and (
            turn.agent_id != persona.agent.id or turn.role != persona.agent.role
        ):
            # The turn row says WHO did the work and which chain its rounds
            # walked; the persona says whose tools, folder and cap the turn
            # runs under. Two answers is a programming error in the caller,
            # and running through it would bill one agent for another's work
            # (or Nova's) and file spans under the wrong name — so it is
            # stated and the turn ends 'error' through the except below,
            # never quietly run as either.
            raise ValueError(
                f"turn {turn.id} was opened as {turn.role or 'nova'} but is being run as "
                f"{persona.agent.role}"
            )
        if persona.agent is not None:
            # The round budget is ONE fact, the agent's own row (copied there
            # at create time; agents._rounds_for): the argument is what the
            # caller happened to read, and a caller that read the global
            # setting instead of the row would run an agent past the budget
            # its prompt states ("You have N tool rounds per task"). So the
            # row wins, always.
            max_tool_rounds = persona.agent.max_tool_rounds
        emit(
            _frame(
                {
                    "meta": {
                        "conversation_id": str(conversation_id),
                        "model": model,
                        "turn_id": str(turn.id),
                        # S12: an optional field on a known key — old clients
                        # ignore it; the Agents page reads it.
                        "agent": persona.agent.name if persona.agent else None,
                    }
                }
            )
        )
        traces.set_doing(turn.id, "starting")

        if persona.agent is not None:
            # The cap, BEFORE any recall or round: read from the same ledger
            # the Spend page shows and recorded on its own span whatever it
            # says — read, skipped (no cap), or unreadable (the turn runs and
            # the span says so; fail-open, never quiet). A hit ends the turn
            # through the one failure exit with the sentence persisted as-is:
            # the assistant row, the error frame and the turn's status agree,
            # and nothing was spent finding out.
            with turn.span("agent_cap") as span:
                problem, facts = await agents.cap_problem(app, pool, persona.agent)
                span.meta.update(facts)
            if problem:
                await _end_without_a_reply(problem, verbatim=True)
                return

        # Nova's roster of agents to delegate to, read from the table for
        # THIS turn — None when there are none (the prompt is then byte-
        # identical to before) and never for an agent (it does not delegate).
        # A table that cannot be read is fail-OPEN (the turn runs with no
        # roster, as if none existed) but never quiet: the failure is filed
        # on an `agent_roster` span, which exists ONLY on failure — so a turn
        # that silently lost its roster is a turn with that span, not a
        # log line nobody reads.
        roster = None
        if persona.agent is None:
            try:
                roster = await agents.roster_line(pool)
            except Exception as exc:
                with turn.span("agent_roster") as span:
                    span.meta["error"] = peers.reason(exc)
        snippets = await _recall(app, turn, person, message, shared=persona.shared_person_id)
        messages = base_messages(model, snippets, history, message, persona, roster=roster)
        if persona.agent is None:
            # The bare call, exactly as before: the whole registry.
            advertised = tools.advertised_tools()
            tool_ctx = tools.context_for(
                app,
                person,
                # The turn's own facts channel: a call that DETERMINED
                # something (a device's connectivity) records it here even
                # when it then refused, and _run_tool copies each call's
                # slice onto its span.
                facts_sink=[],
            )
        else:
            advertised = tools.advertised_tools(persona.tool_names)
            tool_ctx = tools.context_for(
                app,
                person,
                facts_sink=[],
                # The agent's folder is the containment boundary for every
                # filesystem call this turn makes — the same gate as Nova's,
                # rooted lower.
                workspace_root=persona.workspace_root,
            )
        # The toolset the trace marks a call against (None: Nova, who holds
        # everything). Computed once, threaded into every dispatch site.
        subset = persona.tool_names if persona.agent is not None else None
        # Did this turn run an EPHEMERAL tool (a live, point-in-time read like a
        # web fetch)? Its result goes stale, so the turn is not ingested into
        # long-term memory — otherwise recall would serve the cached snapshot as
        # "the latest" and the model would re-narrate it instead of fetching
        # again. Derived from the tool's own `ephemeral` flag, not a name here.
        read_ephemeral = False

        # A round is one gateway call plus the tool calls it asks for. The
        # cap counts gateway calls: reaching it with tools still pending
        # ends the turn with the note below rather than executing work
        # whose result nothing would ever read.
        rounds_allowed = max(1, max_tool_rounds)
        failure: str | None = None
        out_of_rounds = False

        def _stream_delta(delta: str) -> None:
            """Every content delta, live and accumulated: the turn's durable text
            is exactly what the watcher saw, in order, across every round."""
            parts.append(delta)
            emit(_frame({"t": delta}))

        served_by_sent = False
        usage_sent = False
        route_sent = False

        def _emit_route() -> None:
            """The `route` frame, once per turn, ONLY when the gateway served
            from a link past the first (S10-2): who answered and the stated
            reason, read off the llm_call span the gateway's X-Nova-Route
            header landed on — never composed here."""
            nonlocal route_sent
            if route_sent:
                return
            llm = _last_llm_span(turn.spans)
            if llm is None:
                return
            link = llm.meta.get("route_link")
            if isinstance(link, int) and link > 1:
                route_sent = True
                emit(
                    _frame(
                        {
                            "route": {
                                "role": llm.meta.get("route_role"),
                                "link": link,
                                "reason": llm.meta.get("route_reason"),
                                "served_by": llm.meta.get("served_by"),
                            }
                        }
                    )
                )

        def _emit_usage() -> None:
            """The turn's cost so far, once, summed over its llm_call spans
            from what the gateway's ledger stated (S10): dollars with their
            basis, tokens, and whether any round was local. Sent only when
            at least one round carried usage."""
            nonlocal usage_sent
            if usage_sent:
                return
            summary = turn_usage(turn.spans)
            if summary is not None:
                usage_sent = True
                emit(_frame({"usage": summary}))

        def _emit_served_by() -> None:
            """The `served_by` frame, once per turn, from the llm_call span —
            the gateway's own X-Nova-Served-By header (`provider:model`), never
            the setting the turn ran under and never anything the reply
            claims. Sent only when the gateway actually stated it."""
            nonlocal served_by_sent
            if served_by_sent:
                return
            llm = _last_llm_span(turn.spans)
            served_by = llm.meta.get("served_by") if llm is not None else None
            if isinstance(served_by, str) and served_by:
                served_by_sent = True
                emit(_frame({"served_by": served_by}))

        for round_number in range(1, rounds_allowed + 1):
            round_text, calls, failure = await _gateway_round(
                app,
                turn,
                model,
                messages,
                advertised,
                round_number=round_number,
                on_delta=_stream_delta,
            )
            if failure is not None:
                break
            # A round that answered is badged with who answered it; a failed
            # round's statement already names the engine (model_failure_
            # statement), and the error frame stays where clients expect it.
            _emit_served_by()
            _emit_route()
            if not calls:
                _emit_usage()
                break
            if round_number == rounds_allowed:
                out_of_rounds = True
                break

            messages.append(
                {
                    # "" rather than null: a model that said nothing this
                    # round still needs an assistant message to hang its
                    # tool calls on, and not every backend accepts a null
                    # content there.
                    "role": "assistant",
                    "content": round_text,
                    "tool_calls": [call.as_openai() for call in calls],
                }
            )
            ran_ephemeral = await _dispatch_calls(
                turn, tool_ctx, calls, messages, emit, subset=subset
            )
            read_ephemeral = read_ephemeral or ran_ephemeral

        if failure is not None:
            stated = failure
            failed_round = _last_llm_span(turn.spans)
            gateway_said_so = (
                failed_round is not None
                and failed_round.meta.get("error_class") == GatewayFailure.__name__
            )
            if gateway_said_so and _mentions_tools(failure):
                # Layered in front of the backend's own words, never
                # instead of them — and the turn still fails, because a
                # silent retry without tools would leave her looking
                # capable while having no hands at all. Only a reason the
                # GATEWAY stated can be about tools: a timeout or an empty
                # stream is composed here and mentions "tool calls" itself.
                stated = f"the serving model/backend does not support tools — {failure}"
            await _end_without_a_reply(stated)
            return

        # A note the BACKEND wrote about how the turn ended — the round cap, or a
        # refused markup call. It is not the model's prose and it is not a claim:
        # it is the only record the operator has that the turn stopped early, so
        # it must survive every REPLACE-class composition below (found in review:
        # a state-claim correction on a capped turn silently swallowed the cap
        # note, and a capped turn then read exactly like an ordinary one).
        backend_note: str | None = None

        # Tool-call MARKUP in what streamed. _gateway_round already parsed it out
        # of each round's returned text (and dispatched or refused what it
        # found), but `parts` holds the raw deltas exactly as they were emitted,
        # so the DURABLE text is cleaned here — once, over the whole turn. What
        # the watcher saw is unchanged; what the next turn READS never contains
        # a tool call written as text.
        streamed_scan = markup_calls.parse_markup_tool_calls("".join(parts), streamed=True)
        if streamed_scan.found:
            logger.info(
                "chat turn %s: stripped tool-call markup from the reply text "
                "(%d call(s), unparsed=%s)",
                turn.id,
                len(streamed_scan.calls),
                streamed_scan.unparsed,
            )
            parts[:] = [streamed_scan.text] if streamed_scan.text else []
        # Which markup calls were refused in a CLOSED round — read off the spans
        # the refusals filed, never off the prose. That is the only case where a
        # note is owed: the model had no round left to be told in, so the note is
        # what tells the OPERATOR. A markup call refused in an OPEN round needs
        # none — its stated, retryable reason went to the model, which got
        # another round to re-issue it properly.
        refused_markup = [
            span.name
            for span in turn.spans
            if span.kind == "tool" and span.meta.get("refused_markup")
        ]

        if out_of_rounds:
            # ONE final narration round, no tools advertised, with every
            # accumulated tool result still in `messages`: the answer the work
            # already earned must not be swallowed by the cap (see
            # OUT_OF_ROUNDS_NUDGE). Its deltas stream and accumulate exactly like
            # any other round's, so the operator watches it arrive.
            final_text, final_calls, final_failure = await _gateway_round(
                app,
                turn,
                model,
                [*messages, {"role": "system", "content": OUT_OF_ROUNDS_NUDGE}],
                (),
                round_number=0,
                on_delta=_stream_delta,
            )
            if final_failure is not None:
                # FAIL-OPEN: a dead narration round costs the answer, never the
                # turn. Whatever streamed before it died stays (it was watched
                # live) and the note below still lands.
                logger.warning("the out-of-rounds narration round failed: %s", final_failure)
            elif final_calls:
                # It asked for tools anyway. NOTHING is dispatched: each call is
                # answered with the stated result and recorded as a refused span,
                # so the cap on TOOL rounds holds mechanically rather than by the
                # nudge asking nicely. The refusals join `messages` so the
                # transcript any later redirect reads stays well-formed.
                messages.append(
                    {
                        "role": "assistant",
                        "content": final_text,
                        "tool_calls": [call.as_openai() for call in final_calls],
                    }
                )
                for call in final_calls:
                    emit(_activity_frame(call.name, "start"))
                    result = _refuse_out_of_rounds(turn, call)
                    emit(_activity_frame(call.name, "error", result))
                    messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
            backend_note = f"[stopped after {rounds_allowed} tool rounds without finishing]"
            note = f"\n\n{backend_note}" if parts else backend_note
            parts.append(note)
            emit(_frame({"t": note}))
        elif (
            streamed_scan.found
            and not "".join(parts).strip()
            # Exactly the two things a note can honestly say. Anything else that
            # markup did this turn was already stated to the model in a tool
            # result, and the ordinary empty-reply path judges the turn.
            and (refused_markup or streamed_scan.unparsed)
        ):
            # The whole reply was a tool call written as text, nothing ran (it
            # never can), and there is nothing else to show. An empty reply would
            # be an error frame and the markup itself must never be the answer,
            # so the turn says the true thing instead. Which true thing depends
            # on what the spans record: a call refused for want of a tool round
            # names itself and can simply be asked for again; a fragment that
            # named no tool says only that, because "no tool round left" would be
            # a guess at why nothing ran.
            backend_note = (
                markup_calls.no_tool_round_note(refused_markup)
                if refused_markup
                else markup_calls.MALFORMED_MARKUP_NOTE
            )
            parts.append(backend_note)
            emit(_frame({"t": backend_note}))

        text = "".join(parts)
        if not text:
            # Zero deltas and no error at all: still a failure, said out loud.
            # The floor judges the whole turn, so a tool round that said
            # nothing is fine as long as some round eventually did. Since an
            # empty round is a stated failure in _gateway_round this is
            # defence in depth — a turn whose every round produced something
            # that was then stripped (markup) can still land here.
            await _end_without_a_reply(EMPTY_REPLY)
            return

        # The honesty guards: a reply is a claim, the spans are the fact. All
        # of them run on the model's ACTUAL streamed reply —
        # `text` is left untouched between them so each judges what the model
        # really said, not a copy already carrying the other's correction (a
        # correction sentence names no file/url and no pending state, so the
        # verdicts are the same either way; reading the raw reply just keeps
        # that guarantee obvious). Each is PURE and fail-OPEN: a guard that
        # crashes logs and yields no correction, never an error frame and never
        # a lost reply. Derived from the spans and the live registry, never the
        # prompt (the prompt's honesty line still stands; this is the enforcement).
        #
        # What a fired guard does to the DURABLE record (persist + ingest, i.e.
        # what the NEXT turn's history_window feeds back to the model) differs
        # by the SHAPE of the lie, and that difference is this fix:
        #
        #  * narration_check catches a fabricated COMPLETED-action claim ("I
        #    created X.md") that routinely sits BESIDE real content — a genuine
        #    summary, the answer the user asked for. There is no clean
        #    mechanical way to tell "the whole reply is the lie" from "one false
        #    claim beside real content" (the guard anchors on a short phrase,
        #    not the reply's bounds), and persisting correction-only would throw
        #    away that real content. So the correction is APPENDED: the durable
        #    reply carries both what was said and the contradiction.
        #  * consent_claim_check catches a reply whose WHOLE stance is a
        #    fabricated pending state ("that fetch is awaiting your approval").
        #    Nothing there is salvageable — the entire message is predicated on
        #    an approval step that does not exist. Appending and persisting BOTH
        #    would feed the lie back through history_window and train the small
        #    model to pattern-complete "awaiting approval" next turn instead of
        #    calling the tool (the context-poisoning loop the owner's walk hit).
        #    So a fired consent guard REPLACES: the persisted and ingested text
        #    is the correction ALONE. The original prose already streamed as `t`
        #    frames this turn; what must not survive is what the NEXT turn reads.
        #  * capability_claim_check catches a false CAPABILITY denial ("I cannot
        #    access external websites") of a tool that is actually registered —
        #    the T7 defect, where the model disowned fetch_url the same turn it
        #    called it. Like the consent lie, this is a whole-stance fabrication:
        #    the reply exists to refuse the request, and replaying "I can't do X"
        #    through history primes the small model to keep refusing. So it too
        #    REPLACES — the durable record becomes the honest correction (which
        #    NAMES the real tool), never the disavowal. A rare bit of real
        #    content sharing the reply is sacrificed to keep the self-limiting
        #    denial out of the next turn's context; it already streamed live.
        #
        # Streaming is unchanged: every correction still ships on its own
        # {correction} frame, in order, so the live screen shows the
        # contradiction. Only the durable text is composed, once, below.

        # The paired-device names, read LIVE from the registry — the fact the
        # state-claim guard is derived from. Never a list kept in the guard: a
        # household with nothing paired can make no claim about "the device",
        # and pairing a machine arms the check by itself. FAIL-OPEN to no names,
        # which makes the guard silent — a registry read that blips must never
        # turn an honest reply into a false correction.
        device_names = await _paired_device_names(pool)
        # And the agents' names (S12), the same way — the fact the
        # delegation-claim guard is derived from. Read once here and threaded
        # into every redirect's vetting, exactly like device_names. The
        # conversation and this turn's id go with it: which names are already
        # backed is a fact about THIS conversation before THIS turn
        # (see _agent_names).
        agent_names = await _agent_names(pool, turn, persona, conversation_id)
        # Whose turn this is, for the guard: an agent speaking of ITSELF in
        # the third person is not a delegation claim (it cannot delegate) —
        # it is narration, and gets narration's rule. None on Nova's turn.
        self_name = persona.agent.name if persona.agent is not None else None

        try:
            correction = guards.narration_check(text, turn.spans)
        except Exception:
            logger.exception("narration guard raised; shipping the reply uncorrected")
            correction = None
        if correction is not None:
            with turn.span("guard", "narration") as span:
                span.meta["claims"] = [
                    {"kind": claim.kind, "target": claim.target} for claim in correction.claims
                ]
                span.meta["backing_span"] = False
            emit(_frame({"correction": correction.text}))

        # The delegation-claim guard (S12): the third-person mirror of
        # narration. "coder built the kitchen list" credits a NAMED agent
        # with a completed action, which narration_check (first person only)
        # cannot see; the fact it is checked against is a successful
        # delegate_to_agent span for that agent THIS turn. Unbacked -> nothing
        # was delegated; backed only by a failed run -> "did not finish".
        # Same shape as narration in every other way: pure, fail-open, the
        # correction APPENDED to the reply (the sentence beside it may be real
        # content), and the turn is plumbing, never ingested — a recalled
        # "coder built X" is how the next fabrication gets its wording.
        # `self_name` (2026-09-08) tells it which of those names is the
        # speaker: coder writing "coder finished the tests" delegated to
        # nobody — it is narrating its own turn — so it is judged by
        # narration's fact (did ANY tool run) and corrected in the first
        # person, and an agent that credits ANOTHER agent is told what is
        # true for an agent: it cannot delegate, so Nova has to.
        try:
            delegation_claim = guards.delegation_claim_check(
                text, turn.spans, agent_names, self_name=self_name
            )
        except Exception:
            logger.exception("delegation-claim guard raised; shipping the reply uncorrected")
            delegation_claim = None
        if delegation_claim is not None:
            with turn.span("guard", "delegation_claim") as span:
                span.meta["agent"] = delegation_claim.agent
                span.meta["phrase"] = delegation_claim.phrase
                span.meta["backing"] = delegation_claim.backing
            emit(_frame({"correction": delegation_claim.text}))

        # The pending-approval guard consults NO state: there is no approval
        # step, so a reply asserting one is a fabrication by construction.
        try:
            consent_correction = guards.consent_claim_check(text)
        except Exception:
            logger.exception("consent-claim guard raised; shipping the reply uncorrected")
            consent_correction = None
        # A fired consent guard gets ONE redirect (the FIX for the walk where
        # the correction was right and "try again" still did nothing). The
        # redirect owns the guard's single span and its live frame: on success
        # it emits a note plus the regenerated reply, on any other outcome the
        # correction, exactly as this block used to. It spends the turn's one
        # shared redirect budget either way — trying is what costs, so a
        # failed redirect can never be followed by a second one below.
        consent_redirected = False
        consent_text: str | None = None
        if consent_correction is not None:
            outcome = await _claim_redirect(
                app,
                turn,
                model,
                claim_kind="consent_claim",
                correction_text=consent_correction.text,
                # The guard fired on the text alone — there is no external
                # fact to record; the redirect records ran_a_tool itself.
                span_meta={},
                nudge_for=lambda ran: consent_redirect_nudge(ran_a_tool=ran),
                redirect_note=CONSENT_REDIRECT_NOTE,
                # A turn already at its round cap gets no extra dispatch
                # through the redirect's side door.
                out_of_rounds=out_of_rounds,
                messages=messages,
                advertised=advertised,
                tool_ctx=tool_ctx,
                device_names=device_names,
                agent_names=agent_names,
                user_message=message,
                emit=emit,
                persona=persona,
                subset=subset,
            )
            consent_text = outcome.text
            consent_redirected = outcome.redirected
            read_ephemeral = read_ephemeral or outcome.read_ephemeral
            backend_note = backend_note or outcome.markup_note
        # The turn's single redirect budget: ONE regeneration per turn, first
        # claim wins, never two. Spent by TRYING, not by succeeding.
        redirect_spent = consent_correction is not None

        # The capability-denial guard, on the same raw reply, same fail-OPEN
        # contract. Derived from the toolset THIS turn was shown (persona.tool_
        # names — Nova's is the live registry, an agent's its subset): a denial
        # is only false when its satisfying tool is actually in the model's
        # hands, so registering/removing a tool moves the verdict by itself,
        # and an agent's honest "I can't browse the web" (it was given no
        # fetch_url) is never "corrected" into a lie.
        try:
            capability_correction = guards.capability_claim_check(text, persona.tool_names)
        except Exception:
            logger.exception("capability-claim guard raised; shipping the reply uncorrected")
            capability_correction = None
        if capability_correction is not None:
            with turn.span("guard", "capability_claim") as span:
                span.meta["capabilities"] = [
                    {"tool": claim.target, "phrase": claim.phrase}
                    for claim in capability_correction.claims
                ]
            emit(_frame({"correction": capability_correction.text}))

        # The LIVE-STATE claim guard, on the same raw reply, same fail-OPEN
        # contract. Derived from the live device registry (`device_names`, read
        # above): it fires only when the reply asserts a paired device's CURRENT
        # connectivity/availability and NO successful device_* span ran this
        # turn — the 23:51 walk, where "the device is still offline" was
        # parroted out of history at a machine that was online.
        #
        # It is skipped entirely when the consent redirect already SUCCEEDED:
        # the durable text is then the regeneration, which `_regen_rejected_by`
        # already vetted with this very check against the now-live spans, so
        # judging the discarded prose would file a span about text nobody reads.
        state_claim = None
        state_redirected = False
        state_text: str | None = None
        if not consent_redirected:
            try:
                state_claim = guards.state_claim_check(text, turn.spans, device_names)
            except Exception:
                logger.exception("state-claim guard raised; shipping the reply uncorrected")
                state_claim = None
        if state_claim is not None:
            claim_meta = {
                "detected": True,
                "device": state_claim.device,
                "phrase": state_claim.phrase,
                "paired_devices": len(device_names),
            }
            if redirect_spent:
                # The consent guard took the turn's one redirect and its own
                # regeneration did not stand. Both claims are still contradicted
                # (the composition below carries both corrections); what does not
                # happen is a SECOND regeneration.
                with turn.span("guard", "state_claim") as span:
                    span.meta.update(
                        claim_meta,
                        redirected=False,
                        not_redirected_because="redirect_spent",
                    )
                emit(_frame({"correction": state_claim.text}))
            else:
                outcome = await _claim_redirect(
                    app,
                    turn,
                    model,
                    claim_kind="state_claim",
                    correction_text=state_claim.text,
                    span_meta=claim_meta,
                    nudge_for=lambda ran: state_redirect_nudge(
                        device=state_claim.device, ran_a_tool=ran
                    ),
                    redirect_note=STATE_REDIRECT_NOTE,
                    out_of_rounds=out_of_rounds,
                    messages=messages,
                    advertised=advertised,
                    tool_ctx=tool_ctx,
                    device_names=device_names,
                    agent_names=agent_names,
                    user_message=message,
                    emit=emit,
                    persona=persona,
                    subset=subset,
                )
                state_text = outcome.text
                state_redirected = outcome.redirected
                read_ephemeral = read_ephemeral or outcome.read_ephemeral
                backend_note = backend_note or outcome.markup_note
                redirect_spent = True

        # The PRESENTED-LISTING guard, on the same raw reply, same fail-OPEN
        # contract. It fires only when the reply presents a directory/file
        # listing (three or more contiguous entry lines) and NO listing-producing
        # call ran this turn — the agent_quality measurement of 2026-09-03, where
        # "list the workspace" got a tree-drawn listing WITH SIZES and zero tool
        # calls, recited from a memory recall. Derived two ways, never a name
        # list: a tool DECLARING its result is a listing (tools.tool_names_by_
        # result_kind, read live off the registry), or a call whose recorded
        # result is listing-SHAPED (a device_run of ls/find/tree). A result
        # that merely contains the names backs nothing — a memory recall of an
        # old listing is the defect, not its backing. The user's own pasted
        # names are exempt.
        #
        # Skipped when an earlier redirect already STOOD: the durable text is
        # then the regeneration, which `_regen_rejected_by` vetted with this very
        # check against the now-live spans — judging the discarded prose would
        # file a span about text nobody reads.
        listing_claim = None
        listing_redirected = False
        # Set when the listing is unbacked but some other tool DID run: the
        # claim then APPENDS a note instead of replacing the prose (see
        # PRESENTED_LISTING_UNVERIFIED_NOTE).
        listing_unverified = False
        listing_text: str | None = None
        # The listing tools THIS turn was shown, off the persona (S12): read
        # from the registry once when the persona was built, narrowed to its
        # toolset — a listing tool an agent was not given cannot be the one
        # it "should have called". Nova's is every listing tool registered.
        listing_tools: list[str] = list(persona.listing_tools)
        if not consent_redirected and not state_redirected:
            try:
                listing_claim = guards.presented_listing_check(
                    text, turn.spans, listing_tools, message
                )
            except Exception:
                logger.exception("presented-listing guard raised; shipping the reply uncorrected")
                listing_claim = None
        if listing_claim is not None:
            listing_meta = {
                "detected": True,
                "entries": listing_claim.entries,
                "phrase": listing_claim.phrase,
                "listing_tools": listing_tools,
            }
            if guards.ran_a_tool(turn.spans):
                # A tool ran, and its recorded result is not one this guard can
                # read as a listing. That is DOUBT, not a fabrication: a `find`
                # whose 500-char head is permission-denied noise still listed.
                # No redirect (a second dispatch is worse than the doubt), no
                # replacement (that could drop an honest listing): the note is
                # appended and the span says why, the same reason
                # `_claim_redirect` would have refused with.
                listing_unverified = True
                with turn.span("guard", "presented_listing") as span:
                    span.meta.update(
                        listing_meta,
                        ran_a_tool=True,
                        redirected=False,
                        not_redirected_because="tools_already_ran",
                        appended_note=True,
                    )
                emit(_frame({"correction": PRESENTED_LISTING_UNVERIFIED_NOTE}))
            elif redirect_spent:
                # An earlier claim took the turn's one redirect and its own
                # regeneration did not stand. Both are still contradicted (the
                # composition below carries both corrections); what does not
                # happen is a SECOND regeneration.
                with turn.span("guard", "presented_listing") as span:
                    span.meta.update(
                        listing_meta,
                        redirected=False,
                        not_redirected_because="redirect_spent",
                    )
                emit(_frame({"correction": listing_claim.text}))
            else:
                outcome = await _claim_redirect(
                    app,
                    turn,
                    model,
                    claim_kind="presented_listing",
                    correction_text=listing_claim.text,
                    span_meta=listing_meta,
                    nudge_for=lambda ran: presented_listing_redirect_nudge(ran_a_tool=ran),
                    redirect_note=PRESENTED_LISTING_REDIRECT_NOTE,
                    out_of_rounds=out_of_rounds,
                    messages=messages,
                    advertised=advertised,
                    tool_ctx=tool_ctx,
                    device_names=device_names,
                    agent_names=agent_names,
                    user_message=message,
                    emit=emit,
                    persona=persona,
                    subset=subset,
                )
                listing_text = outcome.text
                listing_redirected = outcome.redirected
                read_ephemeral = read_ephemeral or outcome.read_ephemeral
                backend_note = backend_note or outcome.markup_note
                redirect_spent = True

        # Compose the DURABLE text once, from the outcome above. The consent,
        # capability, state and presented-listing guards are REPLACE-class: each
        # catches a whole-stance fabrication (a non-existent pending state, a
        # disowned capability, an unchecked assertion about a live device, or a
        # listing nothing produced) that must
        # not survive into the next turn's context, so a fired one DROPS the
        # model's prose and the record becomes the correction(s) alone.
        # If narration ALSO fired on the same turn (a doubly-fabricated reply),
        # its correction is kept too: the corrections stand adjacent, each once,
        # in a stable order, with NO lie between them — the coherent composition,
        # not blocks stacked around the fabrication. When ONLY narration fired,
        # its correction is APPENDED, preserving any real content the reply
        # carried. When none fired, the reply stands.
        # The unverified-listing case is APPEND-class (a note after the prose),
        # never a replacement — see the guard block above.
        listing_replacement = None if listing_unverified else listing_claim
        replace_corrections = [
            c
            for c in (
                consent_correction,
                capability_correction,
                state_claim,
                listing_replacement,
            )
            if c is not None
        ]
        if consent_redirected:
            # The redirect produced a reply that no longer fabricates a pending
            # state — and may have actually run the tool. THAT is the durable
            # record: the discarded prose (and any correction about it) already
            # streamed live, but what the next turn reads is the honest reply.
            persisted = consent_text or ""
        elif state_redirected:
            # Same rule, the other claim kind: the regeneration CHECKED the
            # device (or said plainly that it did not) and is what the next turn
            # reads. The unchecked prose already streamed live.
            persisted = state_text or ""
        elif listing_redirected:
            # And the third: the regeneration LISTED the files (or said plainly
            # that it had not) and is what the next turn reads.
            persisted = listing_text or ""
        elif replace_corrections:
            persisted = "\n\n".join(
                c.text
                for c in (
                    correction,
                    delegation_claim,
                    consent_correction,
                    capability_correction,
                    state_claim,
                    listing_replacement,
                )
                if c is not None
            )
        elif correction is not None or delegation_claim is not None:
            # The APPEND class: narration and its third-person mirror, the
            # delegation claim (S12) — the prose stays, each correction
            # follows it, once, in the order the guards ran.
            persisted = "\n\n".join(
                [text, *(c.text for c in (correction, delegation_claim) if c is not None)]
            )
        else:
            persisted = text
        # `text` carries the backend note, so the two branches above keep it by
        # construction. The three that DROP the model's prose have to put it
        # back — mechanically, off the same flag, never by looking for the note
        # in the string. A note a REDIRECT earned (its closing round wrote a tool
        # call as markup and had it refused) rides the same slot: the redirect is
        # exactly the path where the composition below drops the prose, so
        # without this the operator would be told nothing at all about the call
        # the model tried to make.
        prose_dropped = (
            consent_redirected
            or state_redirected
            or listing_redirected
            or bool(replace_corrections)
        )
        if backend_note is not None and prose_dropped:
            persisted = f"{persisted}\n\n{backend_note}" if persisted else backend_note
        if listing_unverified:
            # Appended after whatever the composition kept — the prose itself in
            # the ordinary case — so the operator sees the listing AND the doubt.
            persisted = f"{persisted}\n\n{PRESENTED_LISTING_UNVERIFIED_NOTE}"

        # The OPT-IN responsiveness check (agents.responsiveness_check, default
        # OFF): a SOFT, LLM-judged guard that catches a reply drifting off the
        # user's question and re-answers ONCE. It runs here, on the durable text,
        # AFTER the mechanical guards — and NEVER second-guesses one of them:
        # when a mechanical guard fired (the hard line), its handling stands and
        # this soft check is skipped, because a regeneration could re-introduce
        # the very fabrication the hard guard just removed (the mechanical guards
        # do not re-run over the regenerated reply). In the common case no
        # mechanical guard fired, so `persisted` is exactly the model's reply.
        #
        # When the setting is OFF there is ZERO overhead — the model is not
        # called and no span is recorded. When ON, the redirect (if any) REPLACES
        # `persisted`, so the corrected reply is what persists and ingests below;
        # the drift already streamed live but is not what the next turn reads.
        mechanical_guard_fired = (
            correction is not None
            or delegation_claim is not None
            or consent_correction is not None
            or capability_correction is not None
            or state_claim is not None
            or listing_claim is not None
        )

        # The ALWAYS-ON deferral guard, and the FIRST claim on the turn's single
        # redirect budget. Run on the composed reply + this turn's spans + the
        # live registry: it fires only when the reply COMMITS to a tool action
        # ("I'll search…") that no successful span backs — a broken promise. Pure
        # and fail-OPEN: a detector error ships the reply, logs, never breaks the
        # turn. It is skipped when a mechanical honesty guard already corrected
        # the reply (the same reason responsiveness is: a regeneration could
        # re-introduce the very fabrication that guard just removed, and the
        # honesty correction outranks re-prompting a promise).
        try:
            deferral = guards.deferral_check(
                persisted, turn.spans, persona.tool_names, user_message=message
            )
        except Exception:
            logger.exception("deferral guard raised; shipping the reply uncorrected")
            deferral = None
        # The SIXTH sibling: a BARE-INTENT reply ("Got it. Checking the
        # workspace…") commits to nothing deferral_check can anchor on — no
        # first-person modal lead — so it is checked only when the commitment
        # form did NOT already fire. The two shapes can overlap on a phrase
        # like "let me look it up", and must never both claim the turn's one
        # redirect.
        bare_intent = None
        if deferral is None:
            try:
                bare_intent = guards.bare_intent_check(persisted, turn.spans)
            except Exception:
                logger.exception("bare-intent guard raised; shipping the reply uncorrected")
                bare_intent = None
        deferral_fired = deferral is not None or bare_intent is not None
        if (
            deferral is not None
            and deferral.kind == "commitment"
            and not mechanical_guard_fired
            and not redirect_spent
            # Same rule as _claim_redirect: a turn at its round cap gets no
            # extra gateway round with a "do it now" nudge. Found in review —
            # the nudge would tell the model to call a tool the capped
            # narration round was not even offered, and the redirect's success
            # path would replace (and so discard) the cap note.
            and not out_of_rounds
        ):
            # ONE redirect: _deferral_redirect regenerates once (do it now), and
            # REPLACES persisted with the corrected reply — or, if it still
            # defers/errors, appends an honest note. Either way it consumes the
            # turn's one redirect, so the responsiveness check below is skipped.
            persisted = await _deferral_redirect(
                app,
                turn,
                model,
                deferral,
                persisted,
                messages,
                emit,
                user_message=message,
                persona=persona,
            )

        # The OFFER shape of the same guard (owner ruling 2026-09-03: "want me
        # to?" for what he already instructed is the instruction handed back,
        # and there is no approval step for it to wait on). It gets the SAME
        # tools-advertised redirect as bare intent, through `_claim_redirect`
        # — never the commitment shape's text-only one: the whole point of
        # "do it now" is that the tool CAN be called this time, dispatched
        # through the ordinary round machinery. Unlike bare intent the original
        # reply may carry honest prose around the offer, so on a redirect that
        # did not stand the honest note is APPENDED (as the commitment shape
        # appends), not swapped in. Shares the guard span NAME "deferral" with
        # the other two shapes; `kind` in its meta tells them apart.
        # The COMPLETION shape (S9 walk 2026-09-07: "your blink reminder is now
        # running" with no timer tool span) takes the same tools-advertised
        # redirect: the row can be written this time. Only the nudge and the
        # honest note differ; `kind` in the span meta says which shape fired.
        offer_redirected = False
        if (
            deferral is not None
            and deferral.kind in ("offer", "completion")
            and not mechanical_guard_fired
            and not redirect_spent
            and not out_of_rounds
        ):
            # Measured BEFORE the redirect: the offer shape can fire with some
            # OTHER tool's span already on the turn (a memory search, then
            # "want me to check the web?"), in which case _claim_redirect
            # refuses to regenerate at all — so a successful span AFTER it is
            # only the redirect's own work when there was none before.
            ran_before = guards.ran_a_tool(turn.spans)
            outcome = await _claim_redirect(
                app,
                turn,
                model,
                claim_kind="deferral",
                correction_text=(
                    _completion_honest_note(deferral.action_phrase)
                    if deferral.kind == "completion"
                    else _offer_honest_note(deferral.action_phrase)
                ),
                span_meta={
                    "kind": deferral.kind,
                    "detected": True,
                    "action": deferral.tool,
                    "phrase": deferral.phrase,
                },
                nudge_for=(
                    (lambda ran: completion_redirect_nudge(ran_a_tool=ran))
                    if deferral.kind == "completion"
                    else (lambda ran: offer_redirect_nudge(ran_a_tool=ran))
                ),
                redirect_note=DEFERRAL_NOTE,
                out_of_rounds=out_of_rounds,
                messages=messages,
                advertised=advertised,
                tool_ctx=tool_ctx,
                device_names=device_names,
                agent_names=agent_names,
                user_message=message,
                emit=emit,
                persona=persona,
                subset=subset,
            )
            offer_redirected = outcome.redirected
            read_ephemeral = read_ephemeral or outcome.read_ephemeral
            if offer_redirected:
                persisted = outcome.text
            elif not ran_before and guards.ran_a_tool(turn.spans):
                # The redirect's own first round dispatched a successful tool
                # but its report did not survive — the same rule as the
                # bare-intent block: a call that RAN is never reported as
                # nothing ran, so the note names what actually happened.
                ran_names = ", ".join(guards.successful_tool_names(turn.spans)) or "a tool"
                persisted = f"{persisted}\n\n{_bare_intent_ran_but_unreported_note(ran_names)}"
            else:
                persisted = f"{persisted}\n\n{outcome.text}"
            if outcome.markup_note:
                persisted = f"{persisted}\n\n{outcome.markup_note}"
            backend_note = backend_note or outcome.markup_note
            # Spent by TRYING, not by succeeding — same rule as consent/state.
            redirect_spent = True

        # A bare-intent claim gets the SAME redirect shape as consent/state —
        # a regeneration WITH TOOLS ADVERTISED, through `_claim_redirect` —
        # never the commitment form's text-only one above: the whole point of
        # "you did not call any tool" is that a tool CAN be called this time,
        # dispatched through the ordinary round machinery, not merely
        # re-worded. REPLACE-class like consent/state: the original
        # "Checking…" carried nothing salvageable, so a successful regen or
        # the honest backend note (BARE_INTENT_HONEST_NOTE) is the whole
        # durable record either way — `_claim_redirect`'s own `.text` is
        # already one or the other. Shares the guard span NAME "deferral"
        # with the commitment form (same family, same live note); `kind` in
        # its meta is what tells them apart.
        bare_intent_redirected = False
        if (
            bare_intent is not None
            and not mechanical_guard_fired
            and not redirect_spent
            and not out_of_rounds
        ):
            outcome = await _claim_redirect(
                app,
                turn,
                model,
                claim_kind="deferral",
                correction_text=BARE_INTENT_HONEST_NOTE,
                span_meta={
                    "kind": "bare_intent",
                    "detected": True,
                    "phrase": bare_intent.phrase,
                },
                nudge_for=lambda ran: bare_intent_redirect_nudge(ran_a_tool=ran),
                redirect_note=DEFERRAL_NOTE,
                out_of_rounds=out_of_rounds,
                messages=messages,
                advertised=advertised,
                tool_ctx=tool_ctx,
                device_names=device_names,
                agent_names=agent_names,
                user_message=message,
                emit=emit,
                persona=persona,
                subset=subset,
            )
            bare_intent_redirected = outcome.redirected
            read_ephemeral = read_ephemeral or outcome.read_ephemeral

            if not bare_intent_redirected and guards.ran_a_tool(turn.spans):
                # The redirect's OWN first round actually dispatched a
                # successful tool (bare_intent only ever fires when nothing
                # had run yet, so any span here was created by this
                # redirect) even though the closing round's report did not
                # survive — empty, refused as markup, or rejected by the
                # guard set. BARE_INTENT_HONEST_NOTE says "did not" and
                # would then be a LIE: a call that RAN is never reported as
                # nothing ran (the same rule the consent-wave's markup fix
                # established). Name what actually ran instead.
                ran_names = ", ".join(guards.successful_tool_names(turn.spans)) or "a tool"
                persisted = _bare_intent_ran_but_unreported_note(ran_names)
            else:
                persisted = outcome.text
            if outcome.markup_note:
                # This block runs AFTER the turn's one shared backend-note
                # append (the "compose the DURABLE text once" section,
                # above) already ran, so setting `backend_note` alone would
                # leave this note computed and never attached to anything —
                # append it directly, here, the one place left that still
                # writes `persisted`.
                persisted = f"{persisted}\n\n{outcome.markup_note}"
            backend_note = backend_note or outcome.markup_note
            # Spent by TRYING, not by succeeding — same rule as consent/state.
            redirect_spent = True

        # The OPT-IN responsiveness check (agents.responsiveness_check, default
        # OFF): a SOFT, LLM-judged guard that catches a reply drifting off the
        # user's question and re-answers ONCE. It runs here, on the durable text,
        # AFTER the mechanical guards — and NEVER second-guesses one of them:
        # when a mechanical guard fired (the hard line), its handling stands and
        # this soft check is skipped, because a regeneration could re-introduce
        # the very fabrication the hard guard just removed (the mechanical guards
        # do not re-run over the regenerated reply). In the common case no
        # mechanical guard fired, so `persisted` is exactly the model's reply.
        #
        # It also YIELDS to the deferral guard: the two share ONE redirect budget
        # per turn (deferral has first claim), so if a deferral was detected this
        # turn the responsiveness check does not run — total ≤ 1 redirect, no
        # loops.
        #
        # When the setting is OFF there is ZERO overhead — the model is not
        # called and no span is recorded. When ON, the redirect (if any) REPLACES
        # `persisted`, so the corrected reply is what persists and ingests below;
        # the drift already streamed live but is not what the next turn reads.
        try:
            responsiveness_on = bool(
                await settings_store.read_value(pool, "agents.responsiveness_check")
            )
        except Exception:
            # Fail toward OFF: a settings read that raises must not silently
            # start spending extra model calls on every turn.
            logger.exception("responsiveness setting read failed; treating it as off")
            responsiveness_on = False
        if (
            responsiveness_on
            and not mechanical_guard_fired
            and not deferral_fired
            and not redirect_spent
        ):
            # The redirect REPLACES persisted on drift; its redirected flag is
            # recorded in the span it files, not needed further here.
            persisted, _redirected = await _responsiveness_redirect(
                app, turn, model, message, persisted, messages, emit
            )

        # The record boundary. Everything above has already been cleaned where it
        # was produced; this is the one line that makes the invariant hold for
        # the durable record AND for memory, including the two soft redirects
        # (deferral, responsiveness) whose text comes back through
        # _collect_completion rather than a scanned round. A no-op on clean text.
        persisted = without_markup(persisted)

        await _persist_assistant(pool, conversation_id, persisted, turn.id)
        persisted_reply = True
        # Memory hygiene: a guarded consent/capability turn is interaction
        # PLUMBING, not knowledge. A turn the consent guard had to correct, or
        # that the capability guard had to correct, is "awaiting approval" / "I
        # can't do that" noise; ingesting it makes /recall re-inject that noise
        # into later turns — even in other conversations, since memory is
        # per-person — which trains the model to narrate a pending state or
        # disown a tool instead of calling it (the cross-conversation poison the
        # owner's walk hit). The transcript still persists above; only the
        # durable MEMORY must not carry it. A consent guard whose REDIRECT
        # succeeded is the exception: the durable reply is then the regenerated
        # one, which did the work instead of narrating a pending state, so it is
        # ordinary knowledge again.
        plumbing_turn = (
            (consent_correction is not None and not consent_redirected)
            or capability_correction is not None
            # A completed action credited to an agent that never ran (S12) is
            # the same noise with a name on it: ingesting "coder built the
            # list" beside its correction is how recall hands the next turn a
            # helper's work to cite. Unlike narration there is no redirect
            # here — the correction stands, and the turn is plumbing.
            or delegation_claim is not None
            # An unchecked live-state claim is the same kind of noise: ingesting
            # "the device is still offline" makes recall serve that falsehood
            # back as knowledge, which is exactly how the 23:51 parrot got its
            # line. A redirect that stood did the check (or said plainly it did
            # not), so THAT turn is ordinary knowledge again.
            or (state_claim is not None and not state_redirected)
            # A presented listing nothing produced is the same noise again —
            # and the worst of it, because a recalled listing is exactly what
            # produced this one: ingesting it is how the next parrot gets its
            # tree. A redirect that stood listed for real (or said plainly it
            # had not), so THAT turn is ordinary knowledge.
            or (listing_claim is not None and not listing_redirected)
            # A bare-intent claim that did not redirect is the same shape: the
            # honest note ("I said I'd check but did not…") is choreography
            # about the broken promise, not knowledge, so it must not recall
            # back in as if it were an answer. A redirect that stood either
            # ran a tool or said plainly it did not — ordinary knowledge again.
            or (bare_intent is not None and not bare_intent_redirected)
            # An offer-shape deferral that did not redirect is the same shape
            # again: "want me to?" plus the honest note is choreography about
            # the instruction handed back, and recalling it later is how the
            # habit gets reinforced. A redirect that stood did the work.
            # The completion shape is the worst of them: "your reminder is now
            # running" with no row is a fabricated fact, and a recalled
            # fabrication is how the next one gets its wording. A redirect that
            # stood wrote the row (or said plainly it did not).
            or (
                deferral is not None
                and deferral.kind in ("offer", "completion")
                and not offer_redirected
            )
        )
        # A turn that only READ live external data (a web fetch — an ephemeral
        # tool) is a point-in-time snapshot, not durable knowledge. Ingesting it
        # makes recall serve a stale page as "the latest": the model regurgitates
        # the cached result instead of fetching again (byte-identical, same old
        # timestamp — the owner's walk caught exactly this). So skip it too; the
        # next "what's the latest?" re-fetches.
        if ingest and not plumbing_turn and not read_ephemeral:
            _queue_ingest(
                app, turn, person, conversation_id, {"user": message, "assistant": persisted}
            )
        decided = "ok"
        emit(DONE_FRAME)
    except Exception as exc:
        # Anything unplanned — a database that refuses the assistant row, a
        # bug in here — still owes any attached client the frame contract, and
        # still records the turn as failed. (A client disconnect is NOT caught
        # here: it never reaches this coroutine, because the browser↔core SSE
        # generator is what gets cancelled, not this detached task — so the
        # turn simply runs on, which is the whole point of the slice.)
        logger.exception("chat turn %s failed unexpectedly", turn.id)
        decided = "error"
        reason = f"the turn failed — {peers.reason(exc)[:300]}"
        if not persisted_reply:
            # The same owed reply, best effort: if the database is what failed
            # this fails too, and is LOGGED — never reported as recorded.
            try:
                await _persist_assistant(
                    pool, conversation_id, turn_failure_statement(reason, turn.spans), turn.id
                )
            except Exception:
                logger.exception("could not record the failure of turn %s", turn.id)
        emit(_frame({"error": reason}))
        emit(DONE_FRAME)
    finally:
        # The atomic trace close, always — shielded so a cancellation during
        # shutdown cannot leave the turn's status NULL forever. Then the
        # sentinel, so the SSE consumer stops only AFTER the turn is on record:
        # a reader that saw [DONE] can trust the trace is written and the reply
        # persisted.
        close = _spawn(traces.close_turn(pool, turn, decided or "error"))
        try:
            await asyncio.shield(close)
        except Exception:
            # A trace that cannot be written is reported, never swallowed —
            # but in a detached task it must not re-raise (nothing would
            # retrieve it), so it is logged and the sentinel still fires.
            logger.exception("could not close turn %s", turn.id)
        finally:
            # No longer this process's in-flight turn — closed (or its close
            # failed and was logged). Before the sentinel, so a reader that
            # saw [DONE] also sees pending_turn clear. discard, not remove:
            # an eval turn never registered (scratch persons stay off the
            # owner's flag) and still ends here.
            traces.INFLIGHT.discard(turn.id)
            # And no longer doing anything (traces.DOING): the one writer that
            # pops, on every exit path, beside the INFLIGHT discard.
            traces.clear_doing(turn.id)
            emit(None)


@router.post("/stream")
async def chat_stream(
    body: ChatRequest,
    request: Request,
    person: Person = Depends(identity.require_person),
) -> StreamingResponse:
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="message is empty — nothing to ask")

    pool = await db.get_pool()
    conversation = await conversations.resolve(pool, person, body.conversation_id)
    conversation_id = conversation["id"]

    message_id = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'user', $2) RETURNING id",
        conversation_id,
        message,
    )
    # S12: "@coder fix the tests" runs the WHOLE turn as coder, inside this
    # conversation. The row above is what was said, verbatim; WHO answers is
    # decided here by data — agents.mentioned is a leading @name that has a
    # row. No such agent, or an @ anywhere else, is an ordinary Nova turn,
    # byte for byte: she holds list_agents and her roster line, so "@nobody
    # hi" gets "there is no agent named nobody" from her, never a fabricated
    # call. On a match: its chain picks the model (model "" is the gateway
    # default for the role the turn carries, agent_<name>), its row the
    # rounds, and the funnel runs it as the agent's Person so the exchange
    # lands in the AGENT's memory partition — while the turn stays the
    # owner's (his conversation, his money via person_id, his Activity).
    #
    # Resolved BEFORE the history read (2026-09-08, review finding) because
    # the history is written from the answering model's seat: who is
    # answering has to be known before its transcript can be attributed.
    agent = await agents.mentioned(pool, message)

    # user/assistant only, because that is all the messages table holds. A
    # turn's tool calls and their results live in that turn's transcript and
    # in its spans, and are deliberately not replayed into the next turn: a
    # follow-up like "add milk to that list" works because she reads the
    # file again, not because a stale copy of it is still in the prompt.
    # S12: an assistant row an AGENT wrote is handed to the model as
    # "[coder] …" (attributed_history) — derived from the turn behind the
    # row, the get_messages idiom, never a stored label — EXCEPT the rows
    # written by whoever is answering now, which are its own words and are
    # handed back unlabelled. The rows themselves are untouched.
    history = history_window(
        attributed_history(
            await pool.fetch(
                "SELECT m.role, m.content, a.name AS agent FROM messages m "
                "LEFT JOIN turns t ON t.id = m.turn_id "
                "LEFT JOIN agents a ON a.id = t.agent_id "
                "WHERE m.conversation_id = $1 AND m.id <> $2 "
                "ORDER BY m.created_at DESC, m.id DESC LIMIT $3",
                conversation_id,
                message_id,
                HISTORY_MAX_MESSAGES,
            ),
            None if agent is None else agent.name,
        )
    )

    if agent is None:
        model = await settings_store.read_value(pool, "chat.model")
        max_tool_rounds = await settings_store.read_value(pool, "agents.max_tool_rounds")
        runs_as = person
        persona = None
    else:
        model = ""
        max_tool_rounds = agent.max_tool_rounds
        runs_as = agent.person()
        persona = agents.persona_for(agent, owner_id=person.id)
    turn = await traces.open_turn(
        pool,
        conversation_id=conversation_id,
        model=model,
        person_id=person.id,
        timezone=await _owner_timezone(pool),
        agent_id=None if agent is None else agent.id,
        role=None if agent is None else agent.role,
    )
    # Registered the instant it exists (no await between): this process is
    # running it, which is what conversations.has_pending_turn reads —
    # discarded in _run_turn's finally, after the close, on every exit path.
    traces.INFLIGHT.add(turn.id)

    # The turn runs as its own detached task; the response only FORWARDS the
    # frames it produces (through this queue). Decoupling "does it finish" from
    # "who is watching" is the whole slice: a client disconnect cancels the
    # forwarder below, never the task, so the turn finishes and persists the
    # full reply regardless. put_nowait onto an unbounded queue never blocks,
    # so a detached completion is never stalled by an absent reader — the
    # frames it emits after the client is gone are simply never read.
    queue: asyncio.Queue = asyncio.Queue()
    _spawn(
        _run_turn(
            request.app,
            pool,
            turn,
            runs_as,
            conversation_id,
            message,
            history,
            model,
            max_tool_rounds,
            queue.put_nowait,
            persona=persona,
        )
    )

    return StreamingResponse(
        _stream_from_queue(queue),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


async def _stream_from_queue(queue: asyncio.Queue) -> AsyncIterator[str]:
    """Forward a detached turn's frames to whoever is still reading.

    Owns nothing. The turn runs in `_run_turn` as its own task, so a client
    disconnect cancels ONLY this generator — a CancelledError/GeneratorExit at
    the await below — and never the turn: the work runs on, finishes, and
    persists. `None` is the end-of-turn sentinel `_run_turn` emits after the
    atomic trace close, so draining this generator to its end means the turn
    is fully on record.
    """
    while True:
        frame = await queue.get()
        if frame is None:
            return
        yield frame
