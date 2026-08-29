"""POST /api/v1/chat/stream — one turn, streamed, and the trace it leaves.

Frame contract (each line is `data: <json>`):
    {"meta": {conversation_id, model, turn_id}}   exactly once, first
    {"t": "<delta>"}                              zero or more
    {"activity": {"tool", "status"}}              zero or more, while tools run
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
import uuid
from collections.abc import AsyncIterator, Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import conversations, db, guards, identity, peers, settings_store, tools, traces
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
        "After writing a file, read it back before you say it worked. "
        "When a tool answers with a line starting 'Error:', say plainly what failed "
        "and do not claim the work was done."
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


async def _run_tool(
    turn: traces.Turn, ctx: tools.ToolContext, call: ToolCall
) -> tuple[str, bool]:
    """One tool call, timed, recorded, and unable to raise.

    dispatch() decides ok; nothing here reads the result text to work out
    whether it worked, so the span and the activity frame say what actually
    happened rather than what the prose looked like.
    """
    with turn.span("tool", call.name) as span:
        span.meta["args_redacted"] = _span_arguments(call.arguments)
        # Pre-set, and overwritten the moment dispatch answers. A turn the
        # client abandons mid-call still files this span on the way out, and
        # it must read as "never finished" rather than as an untested
        # success.
        span.meta["ok"] = False
        span.meta["result_head"] = "(the turn ended before this call returned)"
        result, ok = await tools.dispatch(call.name, call.arguments, ctx)
        span.meta["ok"] = ok
        span.meta["result_head"] = result[:SPAN_RESULT_HEAD_CHARS]
        if not ok:
            span.meta["error"] = result[:SPAN_RESULT_HEAD_CHARS]
    return result, ok


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
        tool_ctx = tools.context_for(app, person)

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
                result, ok = await _run_tool(turn, tool_ctx, call)
                emit(_frame({"activity": {"tool": call.name, "status": "ok" if ok else "error"}}))
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": result}
                )

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

        # The honesty guard: a reply is a claim, the spans are the fact. A
        # completed-action claim (created/read a file, fetched a URL) that no
        # successful span backs is contradicted before it reaches the
        # operator — appended to the text that persists AND streamed as its
        # own frame, so the durable record and the screen both carry it. The
        # correction rides the FINAL text on purpose: the ingest below then
        # remembers the corrected reply, never the lie. Derived from spans,
        # never the prompt (the prompt's honesty line still stands; this is
        # the enforcement).
        try:
            correction = guards.narration_check(text, turn.spans)
        except Exception:
            # Fail OPEN: a guard that crashes the reply is worse than the lie
            # it might have caught. A matcher bug must never turn an honest
            # turn into an error frame or lose the text — it is logged and the
            # reply ships unchanged.
            logger.exception("narration guard raised; shipping the reply uncorrected")
            correction = None
        if correction is not None:
            with turn.span("guard", "narration") as span:
                span.meta["claims"] = [
                    {"kind": claim.kind, "target": claim.target}
                    for claim in correction.claims
                ]
                span.meta["backing_span"] = False
            text = f"{text}\n\n{correction.text}"
            emit(_frame({"correction": correction.text}))

        await _persist_assistant(pool, conversation_id, text)
        _queue_ingest(app, turn, person, conversation_id, {"user": message, "assistant": text})
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
