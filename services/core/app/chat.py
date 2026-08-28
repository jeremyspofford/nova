"""POST /api/v1/chat/stream — one turn, streamed, and the trace it leaves.

Frame contract (each line is `data: <json>`):
    {"meta": {conversation_id, model, turn_id}}   exactly once, first
    {"t": "<delta>"}                              zero or more
    {"error": "<stated reason>"}                  at most one, on failure
    [DONE]                                        always last

Recall is best-effort, the turn is not: a memory service that is down
costs the turn its notes and nothing else. A gateway that fails is stated
in an error frame — never an empty success.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator, Iterable, Sequence
from datetime import UTC, datetime

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import conversations, db, identity, peers, settings_store, traces
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


class GatewayFailure(RuntimeError):
    """The gateway did not produce a completion, with a stated reason."""


class ChatRequest(BaseModel):
    message: str
    conversation_id: uuid.UUID | None = None


# Fire-and-forget work (memory ingest, closing an interrupted turn). Held so
# it can be awaited at shutdown instead of vanishing with the event loop.
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


def stable_system_prompt(model: str) -> str:
    """The half that does not change from turn to turn."""
    return (
        "You are Nova, a self-hosted assistant running on this household's own hardware. "
        f"The model answering is {model or 'the gateway default'}. Be direct and concrete, "
        "and say plainly when you do not know something."
    )


def volatile_system_prompt(snippets: Sequence[str]) -> str | None:
    """The half that changes every turn — omitted entirely when there is nothing in it."""
    if not snippets:
        return None
    notes = "\n".join(f"- {snippet}" for snippet in snippets)
    return f"Relevant notes:\n{notes}\n\nCurrent time: {datetime.now(UTC).isoformat()}"


def completion_payload(
    model: str, snippets: Sequence[str], history: Sequence[dict], message: str
) -> dict:
    messages = [{"role": "system", "content": stable_system_prompt(model)}]
    volatile = volatile_system_prompt(snippets)
    if volatile is not None:
        messages.append({"role": "system", "content": volatile})
    messages.extend(history)
    messages.append({"role": "user", "content": message})
    payload: dict = {"messages": messages, "stream": True}
    if model:
        # An empty chat.model means "whatever the gateway is configured for";
        # sending "" would ask for a model actually named "".
        payload["model"] = model
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


def _chunk_parts(data: dict) -> tuple[str, dict | None, str | None]:
    """(delta text, usage, error) out of one OpenAI-shaped stream chunk."""
    error = data.get("error")
    if error is not None:
        message = error.get("message") if isinstance(error, dict) else str(error)
        return "", None, message or "unspecified gateway error"
    delta = ""
    for choice in data.get("choices") or []:
        piece = (choice.get("delta") or {}).get("content")
        if piece:
            delta += piece
    usage = data.get("usage")
    return delta, usage if isinstance(usage, dict) else None, None


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


async def _finalize_interrupted(
    pool: asyncpg.Pool, turn: traces.Turn, conversation_id: uuid.UUID, text: str
) -> None:
    """The client hung up: keep what streamed, and record that it was cut off.

    Runs as its own task because the request's scope is already cancelled —
    awaiting anything there would be cancelled too.
    """
    try:
        if text:
            await _persist_assistant(pool, conversation_id, text)
        await traces.close_turn(pool, turn, "interrupted")
    except Exception:
        logger.exception("could not close interrupted turn %s", turn.id)


async def _turn_frames(
    app,
    pool: asyncpg.Pool,
    turn: traces.Turn,
    person: Person,
    conversation_id: uuid.UUID,
    message: str,
    history: Sequence[dict],
    model: str,
) -> AsyncIterator[str]:
    parts: list[str] = []
    status = "error"
    interrupted = False
    try:
        yield _frame(
            {
                "meta": {
                    "conversation_id": str(conversation_id),
                    "model": model,
                    "turn_id": str(turn.id),
                }
            }
        )

        snippets = await _recall(app, turn, person, message)
        payload = completion_payload(model, snippets, history, message)

        failure: str | None = None
        with turn.span("llm_call", model or None) as span:
            span.meta["model"] = model
            try:
                async with peers.client(app, peers.GATEWAY, GATEWAY_TIMEOUT) as client:
                    async with client.stream(
                        "POST", "/v1/chat/completions", json=payload
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
                            delta, usage, error = _chunk_parts(chunk)
                            if error is not None:
                                raise GatewayFailure(f"the gateway reported: {error}")
                            if usage is not None:
                                span.meta["prompt_tokens"] = usage.get("prompt_tokens")
                                span.meta["completion_tokens"] = usage.get("completion_tokens")
                            if delta:
                                parts.append(delta)
                                yield _frame({"t": delta})
            except GatewayFailure as exc:
                failure = str(exc)
                span.meta["error"] = failure
            except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
                failure = f"could not reach the gateway — {peers.reason(exc)}"
                span.meta["error"] = failure

        if failure is not None:
            logger.warning("chat turn %s failed: %s", turn.id, failure)
            yield _frame({"error": failure})
            yield DONE_FRAME
            return

        text = "".join(parts)
        if not text:
            # Zero deltas and no error at all: still a failure, said out loud.
            logger.warning("chat turn %s: %s", turn.id, EMPTY_REPLY)
            yield _frame({"error": EMPTY_REPLY})
            yield DONE_FRAME
            return

        await _persist_assistant(pool, conversation_id, text)
        _queue_ingest(app, turn, person, conversation_id, {"user": message, "assistant": text})
        status = "ok"
        yield DONE_FRAME
    except (asyncio.CancelledError, GeneratorExit):
        interrupted = True
        _spawn(_finalize_interrupted(pool, turn, conversation_id, "".join(parts)))
        raise
    finally:
        if not interrupted:
            try:
                await traces.close_turn(pool, turn, status)
            except Exception:
                # A trace that cannot be written is reported, never swallowed.
                logger.exception("could not close turn %s", turn.id)
                raise


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
    turn = await traces.open_turn(pool, conversation_id=conversation_id, model=model)

    return StreamingResponse(
        _turn_frames(
            request.app, pool, turn, person, conversation_id, message, history, model
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
