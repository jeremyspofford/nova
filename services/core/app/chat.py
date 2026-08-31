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

from app import consents, conversations, db, guards, identity, peers, settings_store, tools, traces
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


def _frame(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


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
        "said and present it as current."
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


async def _persist_assistant(pool: asyncpg.Pool, conversation_id: uuid.UUID, text: str) -> None:
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)",
        conversation_id,
        text,
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

        for round_number in range(1, rounds_allowed + 1):
            round_parts: list[str] = []
            buffer = ToolCallBuffer()
            with turn.span("llm_call", model or None) as span:
                span.meta["model"] = model
                span.meta["round"] = round_number
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
                                    # Only what the gateway actually reported —
                                    # a null token count is not a measurement.
                                    for field in ("prompt_tokens", "completion_tokens"):
                                        if usage.get(field) is not None:
                                            span.meta[field] = usage[field]
                                for fragment in fragments:
                                    buffer.add(fragment)
                                if delta:
                                    parts.append(delta)
                                    round_parts.append(delta)
                                    emit(_frame({"t": delta}))
                except GatewayFailure as exc:
                    failure = str(exc)
                    span.meta["error"] = failure
                except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
                    failure = f"could not reach the gateway — {peers.reason(exc)}"
                    span.meta["error"] = failure
                calls = buffer.finished()
                span.meta["tool_calls"] = len(calls)

            if failure is not None:
                break
            if not calls:
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
                    "content": "".join(round_parts),
                    "tool_calls": [call.as_openai() for call in calls],
                }
            )
            # Sequential, in the model's own order: concurrency is a later
            # slice, and two tools writing the same file at once is not a
            # problem worth having yet.
            for call in calls:
                emit(_frame({"activity": {"tool": call.name, "status": "start"}}))
                result, ok, awaiting = await _run_tool(turn, tool_ctx, call)
                ran_tool = tools.REGISTRY.get(call.name)
                if ok and ran_tool is not None and ran_tool.ephemeral:
                    read_ephemeral = True
                # A card-raising call is "awaiting", not "error": ok is False
                # (nothing ran) but the operator's decision is pending, so the
                # live tile must match the span rather than flashing a failure.
                status = "awaiting" if awaiting else ("ok" if ok else "error")
                emit(_frame({"activity": {"tool": call.name, "status": status}}))
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": result}
                )
                # One frame per card the policy kernel raised on THIS call —
                # never more than once each, even if the same card gets
                # appended again (raise_consent reuses an existing pending
                # row, but the sink still records every dispatch that hit
                # it): the slice beyond `consents_emitted` is exactly what is
                # new since the last time this loop looked.
                new_cards = tool_ctx.consent_sink[consents_emitted:]
                for card in new_cards:
                    emit(_frame({"consent": card}))
                consents_emitted = len(tool_ctx.consent_sink)

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
        if consent_correction is not None:
            with turn.span("guard", "consent_claim") as span:
                span.meta["has_pending_consent"] = has_pending_consent
            emit(_frame({"correction": consent_correction.text}))

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

        # Compose the DURABLE text once, from the outcome above. The consent and
        # capability guards are REPLACE-class: each catches a whole-stance
        # fabrication (a non-existent pending state, or a disowned capability)
        # that must not survive into the next turn's context, so a fired one
        # DROPS the model's prose and the record becomes the correction(s) alone.
        # If narration ALSO fired on the same turn (a doubly-fabricated reply),
        # its correction is kept too: the corrections stand adjacent, each once,
        # in a stable order, with NO lie between them — the coherent composition,
        # not blocks stacked around the fabrication. When ONLY narration fired,
        # its correction is APPENDED, preserving any real content the reply
        # carried. When none fired, the reply stands.
        replace_corrections = [
            c for c in (consent_correction, capability_correction) if c is not None
        ]
        if replace_corrections:
            persisted = "\n\n".join(
                c.text
                for c in (correction, consent_correction, capability_correction)
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
        if deferral is not None and not mechanical_guard_fired:
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
        if responsiveness_on and not mechanical_guard_fired and not deferral_fired:
            # The redirect REPLACES persisted on drift; its redirected flag is
            # recorded in the span it files, not needed further here.
            persisted, _redirected = await _responsiveness_redirect(
                app, turn, model, message, persisted, messages, emit
            )

        await _persist_assistant(pool, conversation_id, persisted)
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
        plumbing_turn = (
            bool(tool_ctx.consent_sink)
            or consent_correction is not None
            or capability_correction is not None
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

    message_id = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) "
        "RETURNING id",
        conversation_id,
        message,
    )
    # user/assistant only, because that is all the messages table holds. A
    # turn's tool calls and their results live in that turn's transcript and
    # in its spans, and are deliberately not replayed into the next turn: a
    # follow-up like "add milk to that list" works because she reads the
    # file again, not because a stale copy of it is still in the prompt.
    history = history_window(
        await pool.fetch(
            "SELECT role, content FROM messages WHERE conversation_id = $1 AND id <> $2 "
            "ORDER BY created_at DESC, id DESC LIMIT $3",
            conversation_id,
            message_id,
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
