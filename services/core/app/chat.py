"""POST /api/v1/chat/stream — one turn, streamed, and the trace it leaves.

Frame contract (each line is `data: <json>`):
    {"meta": {conversation_id, model, turn_id}}   exactly once, first
    {"t": "<delta>"}                              zero or more
    {"activity": {"tool", "status"}}              zero or more, while tools run
    {"consent": {<card_spec>}}                    zero or more, when the policy
                                                   kernel raises an approval card
                                                   this turn (see app/consents.py's
                                                   card_spec and app/policy.py)
    {"error": "<stated reason>"}                  at most one, on failure
    [DONE]                                        always last

A turn is a loop, not a single call: the model is offered the tool
registry, and whenever it answers with tool calls they are executed in the
order it asked for, appended to the transcript, and the model is asked
again. The loop is bounded by agents.max_tool_rounds and every exit is
said out loud — a stated error, or a note that the rounds ran out.

Recall is best-effort, the turn is not: a memory service that is down
costs the turn its notes and nothing else. A gateway that fails is stated
in an error frame — never an empty success.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import (
    consents,
    conversations,
    db,
    devices,
    guards,
    identity,
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
GATEWAY_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=10.0, pool=5.0)
EMPTY_REPLY = "the model returned nothing"
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


def consent_redirect_nudge(*, has_pending_consent: bool, ran_a_tool: bool) -> str:
    """The redirect's nudge, DERIVED from the facts the caller measured.

    The sentence asserts two things about the turn — no approval is pending, and
    nothing has run — so it is built from those two booleans rather than written
    out as a constant that could drift away from the truth. If either fact does
    not hold the sentence would be a lie, and a lie told to the model is how you
    get the tool run a SECOND time (the double-execution the redirect is gated
    against); so this REFUSES rather than emitting it. The caller's fail-open
    turns that refusal into the ordinary correction, never an error frame.
    """
    if has_pending_consent or ran_a_tool:
        raise ValueError(
            "the redirect nudge asserts nothing is pending and nothing has run; "
            f"has_pending_consent={has_pending_consent} ran_a_tool={ran_a_tool}"
        )
    return (
        "No approval is pending and nothing has run this turn. Do it now by "
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
            "the state redirect nudge asserts nothing has run this turn; "
            f"ran_a_tool={ran_a_tool}"
        )
    return (
        f"You have not checked {device}'s state this turn. Check it now with a "
        "device tool before describing it, or say plainly that you did not check."
    )


def _deferral_honest_note(action_phrase: str) -> str:
    return (
        f"I said I'd {action_phrase} but couldn't complete it automatically — "
        "ask me again and I'll try."
    )

# How much of a tool call lands in its span. The result head is the
# Activity page's evidence that the call did what it says; the argument
# head keeps a 256 KB file body out of the trace. Both are heads, and both
# say how much they left out.
SPAN_RESULT_HEAD_CHARS = 500

# Once a round raises an approval card, the tool loop is CLOSED for the rest of
# the turn (see _run_turn): the model gets one more gateway round, WITHOUT tools
# advertised, to tell the user, and the turn ends. A tool call it emits anyway
# in that round is never dispatched — it gets this stated result — and if it
# said nothing at all in text, this note is the reply, so a turn with a card
# pending always ENDS (status ok) instead of dying as an empty reply. Both are
# mechanical facts about the turn (the sink is non-empty), never a claim.
PENDING_APPROVAL_REFUSAL = (
    f"{tools.ERROR_PREFIX}an approval is pending — tell the user and wait for it"
)
PENDING_APPROVAL_NOTE = "[waiting for your approval before continuing]"

# messages.kind (migration 014). 'plumbing' marks a row that exists so the
# SYSTEM can resume a turn — the web's continuation message after an approve,
# and a reply that is ONLY the note above — as opposed to something a person or
# Nova actually said. Plumbing rows stay in the transcript the operator reads;
# they are simply never fed back to the model as history.
MESSAGE_KIND_CHAT = "chat"
MESSAGE_KIND_PLUMBING = "plumbing"
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
    # The consent this message is RESUMING (the web's continuation after an
    # approve — chat-store.tsx). It marks the user row as plumbing so later
    # turns never read the choreography back; see MESSAGE_KIND_* below. It is
    # a HINT, never a permission: nothing about the turn changes, and a value
    # that does not name a consent this person may resume is simply ignored.
    #
    # Typed `str`, not `uuid.UUID`, deliberately: a uuid field makes pydantic
    # reject a malformed value with a 422 BEFORE the endpoint runs, which would
    # cost the operator a whole turn over an optional hint. Parsed leniently
    # below instead — unparseable means absent.
    continuation_of: str | None = None


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


def _as_uuid(value: str | None) -> uuid.UUID | None:
    """A uuid, or None — a malformed one is ABSENT, never an error.

    continuation_of is an optional hint that can only ever remove a message from
    future history. Refusing the turn over a bad one would cost the operator the
    whole message to protect nothing.
    """
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        logger.info("continuation_of was not a uuid; treating the message as chat")
        return None


def _frame(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def history_window(
    newest_first: Sequence, budget: int = HISTORY_CHAR_BUDGET
) -> list[dict[str, str]]:
    """Newest-first rows in, oldest-first messages out, whole ones only.

    A message that would cross the budget is dropped entirely, and so is
    everything older — a half-quoted message is worse than an absent one.

    PLUMBING rows never make it into a window. Approval choreography — the web's
    "You're approved: …, please go ahead now" continuation, the "[waiting for
    your approval before continuing]" note — is how the system resumes a turn,
    not something the household said; replaying it teaches a small model to
    pattern-complete "awaiting approval" instead of calling the tool (the
    context-poisoning loop the owner's walk hit). The query below filters them
    out too; this second check is what makes the property hold even if a caller
    forgets the WHERE, and a row that never carried `kind` (an eval fixture, a
    hand-built dict) counts as 'chat' exactly as the column default does.
    """
    kept: list[dict[str, str]] = []
    used = 0
    for row in newest_first:
        if row.get("kind", MESSAGE_KIND_CHAT) == MESSAGE_KIND_PLUMBING:
            continue
        cost = len(row["content"])
        if used + cost > budget:
            break
        kept.append({"role": row["role"], "content": row["content"]})
        used += cost
    kept.reverse()
    return kept


def stable_system_prompt(model: str, tool_names: Sequence[str]) -> str:
    """The half that does not change from turn to turn.

    The tool list is derived from the registry rather than written out
    here, so a tool added to the toolset is named in the prompt by that
    fact alone and cannot drift out of step with what is advertised.
    """
    return (
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
        "Some actions need the operator's approval first: when you call such a tool "
        "the system shows them an approval card and the tool answers 'Awaiting your "
        "approval'. That means your request is waiting for their OK, not that you are "
        "unable to do it — say you've requested their approval, and never deny having "
        "the capability. "
        "A web fetch is a LIVE, point-in-time read. For anything time-sensitive — "
        "'the latest', current news, today's status — call fetch_url again to get "
        "fresh results; never answer with what an earlier fetch or a recalled note "
        "said and present it as current. "
        "If a search's results do not actually answer the question, refine the query "
        "and search again — a couple of tries is fine — instead of asking the "
        "operator to search or whether you should; just do it."
    )


def volatile_system_prompt(snippets: Sequence[str]) -> str | None:
    """The half that changes every turn — omitted entirely when there is nothing in it."""
    if not snippets:
        return None
    notes = "\n".join(f"- {snippet}" for snippet in snippets)
    return f"Relevant notes:\n{notes}\n\nCurrent time: {datetime.now(UTC).isoformat()}"


def base_messages(
    model: str, snippets: Sequence[str], history: Sequence[dict], message: str
) -> list[dict]:
    """The transcript the first round of the turn starts from."""
    messages = [{"role": "system", "content": stable_system_prompt(model, tools.tool_names())}]
    volatile = volatile_system_prompt(snippets)
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


# -- peers -----------------------------------------------------------------


async def _recall(app, turn: traces.Turn, person: Person, query: str) -> list[str]:
    with turn.span("memory_recall") as span:
        span.meta["k"] = RECALL_K
        try:
            async with peers.client(app, peers.MEMORY, RECALL_TIMEOUT) as client:
                response = await client.post(
                    "/recall",
                    json={"query": query, "person_id": str(person.id), "k": RECALL_K},
                )
                response.raise_for_status()
                results = _results_from(response.json())
        except Exception as exc:
            reason = peers.reason(exc)
            span.meta["error"] = reason
            logger.warning("memory recall failed, continuing without notes: %s", reason)
            return []
        snippets = _snippets(results)
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
    blip costs a check, never a false correction (precision-first, the same way
    the pending-consent lookup fails toward "do not correct").
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


async def _persist_assistant(
    pool: asyncpg.Pool,
    conversation_id: uuid.UUID,
    text: str,
    kind: str = MESSAGE_KIND_CHAT,
) -> None:
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, kind) "
        "VALUES ($1, 'assistant', $2, $3)",
        conversation_id,
        text,
        kind,
    )


async def record_consent_resolution(
    pool: asyncpg.Pool,
    conversation_id: uuid.UUID | None,
    summary: str,
    decision: str,
) -> None:
    """Put a DECIDED consent back into its conversation as an assistant turn.

    Called by the decide API (consents_api.py) so the message-format concern
    lives in the chat layer and consents.py stays a pure policy primitive. Two
    jobs, both from the live walk's third defect: (a) the operator sees the deny
    in chat, and (b) — the load-bearing half — the resolution enters history, so
    the model's NEXT turn no longer reads a stale "awaiting your approval" line
    and re-narrates a pending state that no longer exists.

    DENY only: an APPROVE is already covered by the continuation message the
    client posts as a real turn (consentCard.ts continuationMessage), so posting
    here too would double up. A null conversation_id (a card raised outside any
    conversation) has nowhere to land, so this is a no-op rather than a crash.
    """
    if conversation_id is None or decision != "denied":
        return
    await _persist_assistant(
        pool, conversation_id, f"The request to {summary} was denied — I won't do that."
    )


async def _run_tool(
    turn: traces.Turn, ctx: tools.ToolContext, call: ToolCall
) -> tuple[str, bool, bool]:
    """One tool call, timed, recorded, and unable to raise.

    dispatch() decides ok; nothing here reads the result text to work out
    whether it worked, so the span and the activity frame say what actually
    happened rather than what the prose looked like.

    The third return value is `awaiting`: this call raised an approval card
    (REQUIRE_CONSENT). It is detected MECHANICALLY — the consent_sink GREW during
    dispatch — never by sniffing the result string (line 482's contract). An
    awaiting call is ok=False because nothing ran, but it is NOT a failure: the
    span records `consent_pending` and deliberately leaves `error` UNSET, so the
    Activity page renders it as pending, not as a red error (the funnel's own
    S3-T1 contract: REQUIRE_CONSENT → ok=False but not an Error).
    """
    sink = ctx.consent_sink
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        # Pre-set, and overwritten the moment dispatch answers. A turn the
        # client abandons mid-call still files this span on the way out, and
        # it must read as "never finished" rather than as an untested
        # success.
        span.meta["ok"] = False
        span.meta["result_head"] = "(the turn ended before this call returned)"
        before = len(sink) if sink is not None else 0
        result, ok = await tools.dispatch(call.name, call.arguments, ctx)
        span.meta["ok"] = ok
        span.meta["result_head"] = result[:SPAN_RESULT_HEAD_CHARS]
        awaiting = sink is not None and len(sink) > before
        if awaiting:
            # A card is waiting on the operator — not an error. ok stays False
            # (the executor never ran) but error is left unset on purpose.
            span.meta["consent_pending"] = True
        elif not ok:
            span.meta["error"] = result[:SPAN_RESULT_HEAD_CHARS]
    return result, ok, awaiting


async def _dispatch_calls(
    turn: traces.Turn,
    tool_ctx: tools.ToolContext,
    calls: Sequence[ToolCall],
    messages: list[dict],
    emit: Callable[[str | None], None],
    consents_emitted: int,
) -> tuple[int, bool, bool]:
    """Run one round's tool calls, append their results, stream what happened.

    Sequential, in the model's own order: concurrency is a later slice, and two
    tools writing the same file at once is not a problem worth having yet. The
    turn loop and the consent redirect share this ONE implementation, so a call
    made in a redirect is dispatched, recorded, framed and consent-gated exactly
    like a call made in a normal round — there is no second, weaker path.

    Returns (consents_emitted, ran_ephemeral, card_raised), each a MECHANICAL
    fact about this batch: how much of the consent sink has now been streamed,
    whether a successful call was an ephemeral (point-in-time) read, and whether
    any call raised an approval card. The caller ORs the two flags into its own.
    """
    ran_ephemeral = False
    card_raised = False
    for call in calls:
        emit(_frame({"activity": {"tool": call.name, "status": "start"}}))
        result, ok, awaiting = await _run_tool(turn, tool_ctx, call)
        ran_tool = tools.REGISTRY.get(call.name)
        if ok and ran_tool is not None and ran_tool.ephemeral:
            ran_ephemeral = True
        # A card-raising call is "awaiting", not "error": ok is False (nothing
        # ran) but the operator's decision is pending, so the live tile must
        # match the span rather than flashing a failure.
        status = "awaiting" if awaiting else ("ok" if ok else "error")
        emit(_frame({"activity": {"tool": call.name, "status": status}}))
        if awaiting:
            card_raised = True
        messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
        # One frame per card the policy kernel raised on THIS call — never more
        # than once each, even if the same card gets appended again
        # (raise_consent reuses an existing pending row, but the sink still
        # records every dispatch that hit it): the slice beyond
        # `consents_emitted` is exactly what is new since the last look.
        for card in tool_ctx.consent_sink[consents_emitted:]:
            emit(_frame({"consent": card}))
        consents_emitted = len(tool_ctx.consent_sink)
    return consents_emitted, ran_ephemeral, card_raised


def _refuse_pending(turn: traces.Turn, call: ToolCall) -> str:
    """A tool call made in the narration round after a card was raised: NOT
    dispatched. It is still recorded as a tool span — ok=False with the stated
    reason as `error` — so the trace shows the call the model made and why it
    did not run, rather than a silent drop (a reply is a claim, the span is the
    fact). Returns the stated result the call is answered with."""
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        span.meta["ok"] = False
        span.meta["result_head"] = PENDING_APPROVAL_REFUSAL[:SPAN_RESULT_HEAD_CHARS]
        span.meta["error"] = PENDING_APPROVAL_REFUSAL[:SPAN_RESULT_HEAD_CHARS]
        span.meta["refused_pending_approval"] = True
    return PENDING_APPROVAL_REFUSAL


# -- the opt-in responsiveness check ---------------------------------------
#
# A SOFT, LLM-JUDGED, OPT-IN quality guard — the first LLM-judgment control in a
# guard family that is otherwise mechanical (narration/consent/capability derive
# their verdict from spans/consent-state/the registry — facts). This one ASKS a
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
) -> tuple[str, list[ToolCall], str | None]:
    """ONE gateway round: its text, the tool calls it asked for, a failure or None.

    The turn loop's own round, lifted out verbatim so it has exactly one
    implementation — the loop below and the consent redirect (which must be able
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
    collected: list[str] = []
    buffer = ToolCallBuffer()
    failure: str | None = None
    with turn.span("llm_call", model or None) as span:
        span.meta["model"] = model
        span.meta["round"] = round_number
        span.meta["tools_advertised"] = bool(advertised)
        try:
            async with peers.client(app, peers.GATEWAY, GATEWAY_TIMEOUT) as client:
                async with client.stream(
                    "POST",
                    "/v1/chat/completions",
                    json=completion_payload(model, messages, advertised),
                ) as response:
                    served_by = response.headers.get("x-nova-served-by")
                    if served_by:
                        span.meta["served_by"] = served_by
                    if response.status_code != 200:
                        detail = (await response.aread()).decode(errors="replace")[:400]
                        raise GatewayFailure(
                            f"the gateway refused the request "
                            f"({response.status_code}): {detail}"
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
                            span.meta["malformed_chunks"] = (
                                span.meta.get("malformed_chunks", 0) + 1
                            )
                            continue
                        delta, usage, error, fragments = _chunk_parts(chunk)
                        if error is not None:
                            raise GatewayFailure(f"the gateway reported: {error}")
                        if usage is not None:
                            # Only what the gateway actually reported — a null
                            # token count is not a measurement.
                            for field in ("prompt_tokens", "completion_tokens"):
                                if usage.get(field) is not None:
                                    span.meta[field] = usage[field]
                        for fragment in fragments:
                            buffer.add(fragment)
                        if delta:
                            collected.append(delta)
                            if on_delta is not None:
                                on_delta(delta)
        except GatewayFailure as exc:
            failure = str(exc)
            span.meta["error"] = failure
        except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
            failure = f"could not reach the gateway — {peers.reason(exc)}"
            span.meta["error"] = failure
        calls = buffer.finished()
        span.meta["tool_calls"] = len(calls)
    return "".join(collected), calls, failure


async def _collect_completion(
    app, model: str, messages: Sequence[dict], *, max_tokens: int | None = None
) -> str:
    """One non-tool gateway call, every content delta concatenated into a string.

    A plain completion (no tools advertised): the judge wants a word, the
    redirect wants a focused reply, and neither needs the tool loop. Reuses the
    same peer client, bearer and SSE parsing as the turn's own rounds. Raises
    GatewayFailure/httpx errors on a bad round; the callers turn any raise into
    fail-open (ship the original reply), so this never has to swallow anything.
    """
    payload: dict = {"messages": list(messages), "stream": True}
    if model:
        # An empty chat.model means "the gateway default"; sending "" would ask
        # for a model literally named "".
        payload["model"] = model
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    collected: list[str] = []
    async with peers.client(app, peers.GATEWAY, JUDGE_TIMEOUT) as client:
        async with client.stream(
            "POST", "/v1/chat/completions", json=payload
        ) as response:
            if response.status_code != 200:
                detail = (await response.aread()).decode(errors="replace")[:200]
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
                delta, _usage, error, _fragments = _chunk_parts(chunk)
                if error is not None:
                    raise GatewayFailure(f"the gateway reported: {error}")
                if delta:
                    collected.append(delta)
    return "".join(collected)


def _parse_verdict(raw: str) -> str | None:
    """"on_topic" or "off_topic" from the judge's text, or None if neither is
    there. None is the unparseable case, which the caller treats as on_topic
    (fail-open): a judge that did not answer clearly must never trigger a
    redirect."""
    match = _VERDICT_RE.search(raw)
    if match is None:
        return None
    return "off_topic" if match.group(1).lower() == "off" else "on_topic"


async def _judge_verdict(app, model: str, message: str, reply: str) -> str:
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
        app, model, judge_messages, max_tokens=JUDGE_MAX_TOKENS
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
            verdict = await _judge_verdict(app, model, message, reply)
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
                await _collect_completion(app, model, [*messages, nudge])
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
            logger.warning(
                "responsiveness redirect produced no text, shipping the original reply"
            )
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
    'deferral' guard span.
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
            corrected = (await _collect_completion(app, model, [*messages, nudge])).strip()
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
                    guards.deferral_check(corrected, turn.spans, tools.tool_names())
                    is not None
                )
            except Exception:
                logger.exception(
                    "deferral re-check raised; treating the redirect as complete"
                )
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
) -> str | None:
    """Which mechanical guard, if any, REFUSES the regenerated reply.

    The redirect's output does not just stream — it REPLACES the durable record
    and (unlike a corrected turn) is INGESTED into per-person memory. So it must
    clear the same bar the model's own reply had to clear, not merely the
    consent re-check that motivated the redirect: the full mechanical set, over
    THIS turn's live spans and the live tool registry. Without that, a regen
    answering "Done — I've saved it to report.md" with no span behind it would
    persist unvetted and poison recall — trading a pending-state fabrication for
    a completed-action one, which is worse, because it is ingested.

    Returns the NAME of the first guard that fires (checked cheapest-first, in
    the same order the turn runs them), or None when the regen is clean. Each
    check is fail-OPEN on its own: a guard that raises is logged and does not
    reject, exactly as in the turn body.
    """
    checks: tuple[tuple[str, Callable[[], object | None]], ...] = (
        (
            "consent_claim",
            lambda: guards.consent_claim_check(corrected, bool(tool_ctx.consent_sink)),
        ),
        ("narration", lambda: guards.narration_check(corrected, turn.spans)),
        (
            "capability_claim",
            lambda: guards.capability_claim_check(corrected, tools.tool_names()),
        ),
        (
            "state_claim",
            lambda: guards.state_claim_check(corrected, turn.spans, device_names),
        ),
    )
    for name, check in checks:
        try:
            if check() is not None:
                return name
        except Exception:
            logger.exception(
                "%s re-check raised over the redirect; not rejecting on it", name
            )
    return None


@dataclass
class _ClaimRedirect:
    """What the one redirect produced, as facts the caller composes from."""

    text: str
    redirected: bool
    consents_emitted: int
    read_ephemeral: bool


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
    consents_emitted: int,
    emit: Callable[[str | None], None],
) -> _ClaimRedirect:
    """Regenerate ONCE, with tools, after a REPLACE-class guard fired.

    `claim_kind` names the guard span this owns ("consent_claim",
    "state_claim"); `span_meta` are the facts that guard measured, recorded as
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

    Either way the correction ships with a stated reason in the span.

    The regeneration is judged by the FULL mechanical set against LIVE facts,
    not the stale ones: if the redirect's own call raised a card, an "awaiting
    your approval" reply is then TRUE and must not be corrected; if it ran a
    device tool, a state report is then backed. The same booleans that make each
    guard fire or stay silent, read again after the tools ran.

    FAIL-OPEN throughout: any exception ships the correction, never an error
    frame and never a lost turn.
    """
    read_ephemeral = False
    with turn.span("guard", claim_kind) as span:
        span.meta.update(span_meta)
        # DERIVED from the turn's own spans, never from the reply's prose: a
        # successful tool span means the work already happened this turn.
        ran_a_tool = guards.ran_a_tool(turn.spans)
        span.meta["ran_a_tool"] = ran_a_tool
        blocked = (
            "tools_already_ran"
            if ran_a_tool
            else ("out_of_rounds" if out_of_rounds else None)
        )
        if blocked is not None:
            # No regeneration at all: doing the work twice, or past the cap, is
            # not a correction. The lie is still contradicted, as before.
            span.meta.update(redirected=False, not_redirected_because=blocked)
            logger.info(
                "%s redirect skipped (%s); shipping the correction", claim_kind, blocked
            )
            emit(_frame({"correction": correction_text}))
            return _ClaimRedirect(correction_text, False, consents_emitted, read_ephemeral)

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
            if calls:
                attempt.append(
                    {
                        "role": "assistant",
                        "content": regenerated,
                        "tool_calls": [call.as_openai() for call in calls],
                    }
                )
                consents_emitted, read_ephemeral, _raised = await _dispatch_calls(
                    turn, tool_ctx, calls, attempt, emit, consents_emitted
                )
                # One final round to say what happened, with the tool loop
                # CLOSED (no tools advertised) — the redirect gets one attempt at
                # the action, never a loop of its own.
                regenerated, _more, failure = await _gateway_round(
                    app, turn, model, attempt, (), round_number=0, on_delta=None
                )
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
            return _ClaimRedirect(correction_text, False, consents_emitted, read_ephemeral)

        corrected = regenerated.strip()
        # Judged ONCE by the FULL mechanical set — this text is about to replace
        # the durable record AND be ingested — and never re-redirected.
        rejected_by = (
            _regen_rejected_by(corrected, turn, tool_ctx, device_names)
            if corrected
            else None
        )
        if not corrected or rejected_by is not None:
            span.meta["redirected"] = False
            if rejected_by is not None:
                span.meta["regen_rejected_by"] = rejected_by
                logger.warning(
                    "%s redirect regenerated a reply the %s guard refused; "
                    "shipping the correction",
                    claim_kind,
                    rejected_by,
                )
            emit(_frame({"correction": correction_text}))
            return _ClaimRedirect(correction_text, False, consents_emitted, read_ephemeral)

        span.meta["redirected"] = True
        emit(_frame({"correction": redirect_note}))
        emit(_frame({"t": corrected}))
        return _ClaimRedirect(corrected, True, consents_emitted, read_ephemeral)


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
    message_kind: str = MESSAGE_KIND_CHAT,
) -> None:
    """The whole turn, run to completion regardless of who is still watching.

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
    try:
        emit(
            _frame(
                {
                    "meta": {
                        "conversation_id": str(conversation_id),
                        "model": model,
                        "turn_id": str(turn.id),
                    }
                }
            )
        )

        snippets = await _recall(app, turn, person, message)
        messages = base_messages(model, snippets, history, message)
        advertised = tools.advertised_tools()
        # conversation_id rides the context so a consent the policy kernel
        # raises this turn is bound to the conversation it was asked in, and
        # renders inline where the operator can see it (a NULL conversation_id
        # would hide the card). consent_sink is this turn's OWN list — the
        # funnel appends a card_spec to it on REQUIRE_CONSENT, and the loop
        # below diffs it after each tool call to emit the {consent} frame.
        tool_ctx = tools.context_for(
            app, person, conversation_id=conversation_id, consent_sink=[]
        )
        # How much of tool_ctx.consent_sink has already been streamed — a
        # count, not a "seen ids" set, because the sink is append-only for
        # this turn and nothing upstream ever removes an entry from it.
        consents_emitted = 0
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
        # Set the moment any call this turn raises a card (awaiting=True). From
        # then on the tool loop is CLOSED: the next gateway round is the LAST,
        # made with NO tools advertised so the model has to answer in text,
        # and a call it emits anyway is refused (never dispatched) and the
        # turn ends. Mechanical, not a prompt: the owner's walk had the model
        # wander through other tools to the round cap after a card, so his
        # approve landed mid-stream and the web's auto-continue never fired.
        card_raised = False

        def _stream_delta(delta: str) -> None:
            """Every content delta, live and accumulated: the turn's durable text
            is exactly what the watcher saw, in order, across every round."""
            parts.append(delta)
            emit(_frame({"t": delta}))

        for round_number in range(1, rounds_allowed + 1):
            round_text, calls, failure = await _gateway_round(
                app,
                turn,
                model,
                messages,
                () if card_raised else advertised,
                round_number=round_number,
                on_delta=_stream_delta,
            )

            if failure is not None:
                break
            if not calls:
                break
            if card_raised:
                # The narration round asked for tools anyway. Nothing is
                # dispatched: each call is answered with the stated pending
                # result, recorded as a refused span, and the turn ends here
                # — not at the round cap, and not with the cap's note.
                messages.append(
                    {
                        "role": "assistant",
                        "content": round_text,
                        "tool_calls": [call.as_openai() for call in calls],
                    }
                )
                for call in calls:
                    emit(_frame({"activity": {"tool": call.name, "status": "start"}}))
                    result = _refuse_pending(turn, call)
                    emit(_frame({"activity": {"tool": call.name, "status": "error"}}))
                    messages.append(
                        {"role": "tool", "tool_call_id": call.id, "content": result}
                    )
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
            consents_emitted, ran_ephemeral, raised = await _dispatch_calls(
                turn, tool_ctx, calls, messages, emit, consents_emitted
            )
            read_ephemeral = read_ephemeral or ran_ephemeral
            card_raised = card_raised or raised

        if failure is not None:
            stated = failure
            if _mentions_tools(failure):
                # Layered in front of the backend's own words, never
                # instead of them — and the turn still fails, because a
                # silent retry without tools would leave her looking
                # capable while having no hands at all.
                stated = f"the serving model/backend does not support tools — {failure}"
            logger.warning("chat turn %s failed: %s", turn.id, stated)
            decided = "error"
            emit(_frame({"error": stated}))
            emit(DONE_FRAME)
            return

        if out_of_rounds:
            note = (
                f"[stopped after {rounds_allowed} tool rounds without finishing]"
            )
            note = f"\n\n{note}" if parts else note
            parts.append(note)
            emit(_frame({"t": note}))
        elif card_raised and not "".join(parts).strip():
            # A card is pending and the model said nothing in text (it only
            # tried more tools, or went quiet). The turn must still END, ok,
            # so the operator's decision lands on a finished turn — the note
            # states the one true thing about it.
            parts.append(PENDING_APPROVAL_NOTE)
            emit(_frame({"t": PENDING_APPROVAL_NOTE}))

        text = "".join(parts)
        if not text:
            # Zero deltas and no error at all: still a failure, said out loud.
            # The floor judges the whole turn, so a tool round that said
            # nothing is fine as long as some round eventually did.
            logger.warning("chat turn %s: %s", turn.id, EMPTY_REPLY)
            decided = "error"
            emit(_frame({"error": EMPTY_REPLY}))
            emit(DONE_FRAME)
            return

        # The honesty guards: a reply is a claim, the spans (and the consent
        # state) are the fact. Both run on the model's ACTUAL streamed reply —
        # `text` is left untouched between them so each judges what the model
        # really said, not a copy already carrying the other's correction (a
        # correction sentence names no file/url and no pending state, so the
        # verdicts are the same either way; reading the raw reply just keeps
        # that guarantee obvious). Each is PURE and fail-OPEN: a guard that
        # crashes logs and yields no correction, never an error frame and never
        # a lost reply. Derived from the spans/consent state, never the prompt
        # (the prompt's honesty line still stands; this is the enforcement).
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
        #    an approval that does not exist. Appending and persisting BOTH
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

        try:
            correction = guards.narration_check(text, turn.spans)
        except Exception:
            logger.exception("narration guard raised; shipping the reply uncorrected")
            correction = None
        if correction is not None:
            with turn.span("guard", "narration") as span:
                span.meta["claims"] = [
                    {"kind": claim.kind, "target": claim.target}
                    for claim in correction.claims
                ]
                span.meta["backing_span"] = False
            emit(_frame({"correction": correction.text}))

        # The pending-approval fact is MECHANICAL — a card raised THIS turn (the
        # sink is non-empty), or one still pending in this conversation. A
        # lookup that RAISES fails toward has_pending=True, so a database blip
        # never turns an honest awaiting reply into a false correction (that
        # would make the guard the liar).
        this_turn_raised_a_card = bool(tool_ctx.consent_sink)
        if this_turn_raised_a_card:
            has_pending_consent = True
        else:
            try:
                has_pending_consent = bool(
                    await consents.pending_for_conversation(pool, conversation_id)
                )
            except Exception:
                logger.exception(
                    "pending-consent lookup failed; treating the turn as having "
                    "a pending card so an honest awaiting reply is not falsely "
                    "corrected"
                )
                has_pending_consent = True
        try:
            consent_correction = guards.consent_claim_check(text, has_pending_consent)
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
                # The fact the guard fired on, recorded as the caller measured
                # it (the guard only fires on False).
                span_meta={"has_pending_consent": has_pending_consent},
                nudge_for=lambda ran: consent_redirect_nudge(
                    has_pending_consent=has_pending_consent, ran_a_tool=ran
                ),
                redirect_note=CONSENT_REDIRECT_NOTE,
                # A turn already at its round cap gets no extra dispatch through
                # the redirect's side door.
                out_of_rounds=out_of_rounds,
                messages=messages,
                # Defensive, and mechanical: a turn that raised a card has
                # has_pending_consent True, so the guard cannot have fired —
                # but if it ever could, the tool loop stays closed.
                advertised=() if card_raised else advertised,
                tool_ctx=tool_ctx,
                device_names=device_names,
                consents_emitted=consents_emitted,
                emit=emit,
            )
            consent_text = outcome.text
            consent_redirected = outcome.redirected
            consents_emitted = outcome.consents_emitted
            read_ephemeral = read_ephemeral or outcome.read_ephemeral
        # The turn's single redirect budget: ONE regeneration per turn, first
        # claim wins, never two. Spent by TRYING, not by succeeding.
        redirect_spent = consent_correction is not None

        # The capability-denial guard, on the same raw reply, same fail-OPEN
        # contract. Derived from the live tool registry (tools.tool_names()): a
        # denial is only false when its satisfying tool is actually available, so
        # granting/removing a tool moves the verdict by itself.
        try:
            capability_correction = guards.capability_claim_check(text, tools.tool_names())
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
                logger.exception(
                    "state-claim guard raised; shipping the reply uncorrected"
                )
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
                    advertised=() if card_raised else advertised,
                    tool_ctx=tool_ctx,
                    device_names=device_names,
                    consents_emitted=consents_emitted,
                    emit=emit,
                )
                state_text = outcome.text
                state_redirected = outcome.redirected
                consents_emitted = outcome.consents_emitted
                read_ephemeral = read_ephemeral or outcome.read_ephemeral
                redirect_spent = True

        # Compose the DURABLE text once, from the outcome above. The consent,
        # capability and state guards are REPLACE-class: each catches a
        # whole-stance fabrication (a non-existent pending state, a disowned
        # capability, or an unchecked assertion about a live device) that must
        # not survive into the next turn's context, so a fired one DROPS the
        # model's prose and the record becomes the correction(s) alone.
        # If narration ALSO fired on the same turn (a doubly-fabricated reply),
        # its correction is kept too: the corrections stand adjacent, each once,
        # in a stable order, with NO lie between them — the coherent composition,
        # not blocks stacked around the fabrication. When ONLY narration fired,
        # its correction is APPENDED, preserving any real content the reply
        # carried. When none fired, the reply stands.
        replace_corrections = [
            c
            for c in (consent_correction, capability_correction, state_claim)
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
        elif replace_corrections:
            persisted = "\n\n".join(
                c.text
                for c in (
                    correction,
                    consent_correction,
                    capability_correction,
                    state_claim,
                )
                if c is not None
            )
        elif correction is not None:
            persisted = f"{text}\n\n{correction.text}"
        else:
            persisted = text

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
            or consent_correction is not None
            or capability_correction is not None
            or state_claim is not None
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
            deferral = guards.deferral_check(persisted, turn.spans, tools.tool_names())
        except Exception:
            logger.exception("deferral guard raised; shipping the reply uncorrected")
            deferral = None
        deferral_fired = deferral is not None
        if deferral is not None and not mechanical_guard_fired and not redirect_spent:
            # ONE redirect: _deferral_redirect regenerates once (do it now), and
            # REPLACES persisted with the corrected reply — or, if it still
            # defers/errors, appends an honest note. Either way it consumes the
            # turn's one redirect, so the responsiveness check below is skipped.
            persisted = await _deferral_redirect(
                app, turn, model, deferral, persisted, messages, emit
            )

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

        # A reply that is ONLY the pending-approval note is choreography: it says
        # the turn ended with a card up, nothing more. Persisted so the operator
        # sees it, marked so no later turn reads it back and learns to narrate a
        # pending state. Compared to the exact constant — the note is generated
        # HERE, so this is an identity check, never prose-sniffing.
        await _persist_assistant(
            pool,
            conversation_id,
            persisted,
            MESSAGE_KIND_PLUMBING
            if persisted.strip() == PENDING_APPROVAL_NOTE
            else MESSAGE_KIND_CHAT,
        )
        # Memory hygiene: a guarded consent/capability turn is interaction
        # PLUMBING, not knowledge. A turn that raised an approval card
        # (consent_sink non-empty), that the consent guard had to correct, or
        # that the capability guard had to correct is "awaiting approval" / "I
        # can't do that" noise; ingesting it makes /recall re-inject that noise
        # into later turns — even in other conversations, since memory is
        # per-person — which trains the model to narrate a pending state or
        # disown a tool instead of calling it (the cross-conversation poison the
        # owner's walk hit). The transcript still persists above; only the
        # durable MEMORY must not carry it. Nothing is lost: the funnel raises a
        # fresh card mechanically the next time the model calls the tool.
        # A consent guard whose REDIRECT succeeded is the exception: the durable
        # reply is then the regenerated one, which did the work instead of
        # narrating a pending state, so it is ordinary knowledge again. (A card
        # raised BY the redirect still lands in the sink and still marks the
        # turn plumbing, through the first clause.)
        #
        # And a turn whose USER MESSAGE is plumbing is plumbing whatever else
        # happens in it — including the happy path where the approved action
        # runs cleanly and no new card is raised. Otherwise the ingest carries
        # "You're approved: <summary>. Please go ahead now." into per-person
        # memory, where recall re-injects the choreography into later turns in
        # other conversations: exactly the poisoning the kind column exists to
        # stop, arriving by the other door.
        plumbing_turn = (
            bool(tool_ctx.consent_sink)
            or (consent_correction is not None and not consent_redirected)
            or capability_correction is not None
            # An unchecked live-state claim is the same kind of noise: ingesting
            # "the device is still offline" makes recall serve that falsehood
            # back as knowledge, which is exactly how the 23:51 parrot got its
            # line. A redirect that stood did the check (or said plainly it did
            # not), so THAT turn is ordinary knowledge again.
            or (state_claim is not None and not state_redirected)
            or message_kind == MESSAGE_KIND_PLUMBING
        )
        # A turn that only READ live external data (a web fetch — an ephemeral
        # tool) is a point-in-time snapshot, not durable knowledge. Ingesting it
        # makes recall serve a stale page as "the latest": the model regurgitates
        # the cached result instead of fetching again (byte-identical, same old
        # timestamp — the owner's walk caught exactly this). So skip it too; the
        # next "what's the latest?" re-fetches and raises a fresh card.
        if not plumbing_turn and not read_ephemeral:
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
        emit(_frame({"error": f"the turn failed — {peers.reason(exc)[:300]}"}))
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

    # A continuation the web sends after an approve is PLUMBING: the operator
    # clicked Approve, and this message exists so the turn can resume. It is
    # persisted and shown exactly like any other message — this turn even reads
    # it as `message` below, so "go ahead" still works — but it is marked so
    # LATER turns never read the choreography back (migration 014).
    #
    # VERIFIED against the consents table, never trusted: a continuation_of
    # naming no real consent is ignored and the row is an ordinary 'chat'
    # message. Fail-open by design — the flag only ever REMOVES a row from
    # future history, so a lookup that cannot confirm it must not turn a real
    # message into an error, and must not silently hide it either.
    kind = MESSAGE_KIND_CHAT
    resumed_id = _as_uuid(body.continuation_of)
    if resumed_id is not None:
        try:
            # SCOPED, never a bare existence check: citing an id is a request to
            # hide a message from every later history window, and every
            # authenticated caller can list ids (GET /api/v1/consents). The card
            # must be THIS conversation's, THIS person's, and APPROVED — the
            # only state a continuation can honestly resume.
            resumed = await consents.get_for_continuation(
                pool,
                resumed_id,
                conversation_id=conversation_id,
                person_id=person.id,
            )
        except Exception:
            logger.exception(
                "continuation_of lookup failed; persisting the message as ordinary chat"
            )
            resumed = None
        if resumed is not None:
            kind = MESSAGE_KIND_PLUMBING

    message_id = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content, kind) "
        "VALUES ($1, 'user', $2, $3) RETURNING id",
        conversation_id,
        message,
        kind,
    )
    # user/assistant only, because that is all the messages table holds. A
    # turn's tool calls and their results live in that turn's transcript and
    # in its spans, and are deliberately not replayed into the next turn: a
    # follow-up like "add milk to that list" works because she reads the
    # file again, not because a stale copy of it is still in the prompt.
    #
    # And never a PLUMBING row: approval choreography is how the system resumes
    # a turn, not conversation, and replaying it is what trains a small model to
    # narrate "awaiting approval" instead of acting (history_window drops them
    # too, so the property does not rest on this WHERE alone).
    history = history_window(
        await pool.fetch(
            "SELECT role, content, kind FROM messages "
            "WHERE conversation_id = $1 AND id <> $2 AND kind = $3 "
            "ORDER BY created_at DESC, id DESC LIMIT $4",
            conversation_id,
            message_id,
            MESSAGE_KIND_CHAT,
            HISTORY_MAX_MESSAGES,
        )
    )

    model = await settings_store.read_value(pool, "chat.model")
    max_tool_rounds = await settings_store.read_value(pool, "agents.max_tool_rounds")
    turn = await traces.open_turn(pool, conversation_id=conversation_id, model=model)

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
            person,
            conversation_id,
            message,
            history,
            model,
            max_tool_rounds,
            queue.put_nowait,
            message_kind=kind,
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
