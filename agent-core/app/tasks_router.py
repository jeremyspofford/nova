"""Task CRUD endpoints under /api/v1/tasks."""
import asyncio
import json
import logging
import uuid

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from nova_contracts import TaskCreateRequest

from .config import settings
from .db import get_pool
from .loop.main import run_task

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])

SYSTEM_PROMPT = (
    "You are Nova, a helpful AI assistant. "
    "Answer concisely and remember context from earlier in the conversation. "
    "When memory context is provided, use it naturally — don't announce that you're "
    "recalling a memory, just incorporate what you know."
)


async def _search_memory(query: str, limit: int = 5) -> list[dict]:
    """Return top-k memories relevant to query. Returns [] on any failure."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{settings.memory_service_url}/memories/search",
                json={"query": query, "limit": limit, "min_similarity": 0.3},
            )
            if r.status_code == 200:
                return r.json().get("results", [])
    except Exception as exc:
        logger.warning("memory search failed: %s", exc)
    return []


async def _ingest_memory(content: str) -> None:
    """Push a completed exchange into the memory store. Fire-and-forget."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{settings.memory_service_url}/memories",
                json={"content": content, "source_kind": "chat"},
            )
    except Exception as exc:
        logger.warning("memory ingest failed: %s", exc)


def _build_system_prompt(memories: list[dict]) -> str:
    if not memories:
        return SYSTEM_PROMPT
    lines = [SYSTEM_PROMPT, "", "## What Nova remembers"]
    for m in memories:
        lines.append(f"- {m['content']}")
    return "\n".join(lines)


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


@router.get("")
async def list_tasks(limit: int = 20, _: None = Depends(_require_admin)) -> list:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, goal, status, created_at FROM tasks ORDER BY created_at DESC LIMIT $1",
            limit,
        )
    return [
        {
            "id": str(r["id"]),
            "goal": r["goal"],
            "status": r["status"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        }
        for r in rows
    ]


@router.post("")
async def create_task(body: TaskCreateRequest, _: None = Depends(_require_admin)) -> dict:
    task_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO tasks (id, prompt, goal, status, created_at) VALUES ($1, $2, $2, 'pending', now())",
            task_id, body.goal,
        )

    def _on_done(fut: asyncio.Future) -> None:
        if not fut.cancelled() and fut.exception():
            logger.error("run_task %s unhandled exception: %s", task_id[:8], fut.exception())

    t = asyncio.create_task(run_task(task_id, body.goal, pool))
    t.add_done_callback(_on_done)
    return {"id": task_id, "goal": body.goal, "status": "pending"}


@router.get("/{task_id}")
async def get_task(task_id: str, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, goal, status, result, created_at, started_at, completed_at "
            "FROM tasks WHERE id = $1",
            task_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {
        "id": str(row["id"]),
        "goal": row["goal"],
        "status": row["status"],
        "result": row["result"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "started_at": row["started_at"].isoformat() if row["started_at"] else None,
        "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
    }


@router.get("/{task_id}/events")
async def list_events(task_id: str, _: None = Depends(_require_admin)) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, task_id, event_type, payload, occurred_at, chain_hash "
            "FROM task_events WHERE task_id = $1 AND chain_hash != '' "
            "ORDER BY occurred_at",
            task_id,
        )
    events = []
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        except Exception:
            payload = {}
        events.append({
            "id": str(row["id"]),
            "task_id": str(row["task_id"]),
            "event_type": row["event_type"],
            "payload": payload or {},
            "occurred_at": row["occurred_at"].isoformat() if row["occurred_at"] else "",
            "chain_hash": row["chain_hash"],
        })
    return {"events": events}


@router.get("/{task_id}/messages")
async def get_messages(task_id: str, _: None = Depends(_require_admin)) -> list:
    """Return the full conversation history for a chat task."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT role, content, created_at FROM task_messages "
            "WHERE task_id = $1::uuid ORDER BY created_at",
            task_id,
        )
    return [
        {
            "role": r["role"],
            "content": r["content"],
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]


class MessageRequest(BaseModel):
    text: str


@router.post("/{task_id}/message")
async def post_message(task_id: str, body: MessageRequest) -> StreamingResponse:
    """Conversational turn — streams JSON lines {"text": "..."} back to caller."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM tasks WHERE id = $1::uuid", task_id)
        if not exists:
            await conn.execute(
                "INSERT INTO tasks (id, prompt, goal, status, created_at) "
                "VALUES ($1, $2, $2, 'running', now())",
                task_id, body.text[:500],
            )

        # Load existing history for this task
        history_rows = await conn.fetch(
            "SELECT role, content FROM task_messages "
            "WHERE task_id = $1::uuid ORDER BY created_at",
            task_id,
        )
        # Persist the new user turn immediately so it's in history even on error
        await conn.execute(
            "INSERT INTO task_messages (task_id, role, content) VALUES ($1::uuid, 'user', $2)",
            task_id, body.text,
        )

    memories = await _search_memory(body.text)
    system_prompt = _build_system_prompt(memories)

    messages = [{"role": "system", "content": system_prompt}]
    messages += [{"role": r["role"], "content": r["content"]} for r in history_rows]
    messages.append({"role": "user", "content": body.text})

    async def generate():
        assistant_chunks: list[str] = []
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{settings.llm_gateway_url}/stream",
                    json={"messages": messages, "max_tokens": 2000, "temperature": 0.7},
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            data = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue
                        chunk = data.get("chunk", "")
                        if chunk:
                            assistant_chunks.append(chunk)
                            yield json.dumps({"text": chunk}) + "\n"
        except Exception as exc:
            logger.error("message stream failed task=%s: %s", task_id, exc)
            yield json.dumps({"text": "", "error": str(exc)}) + "\n"
            return

        # Persist the full assistant response once streaming is done
        if assistant_chunks:
            full_response = "".join(assistant_chunks)
            try:
                async with pool.acquire() as conn:
                    await conn.execute(
                        "INSERT INTO task_messages (task_id, role, content) "
                        "VALUES ($1::uuid, 'assistant', $2)",
                        task_id, full_response,
                    )
            except Exception as exc:
                logger.warning("failed to persist assistant message task=%s: %s", task_id, exc)

            # Ingest the exchange into long-term memory (fire-and-forget)
            exchange = f"User: {body.text}\nNova: {full_response}"
            asyncio.create_task(_ingest_memory(exchange))

    return StreamingResponse(generate(), media_type="text/plain")
