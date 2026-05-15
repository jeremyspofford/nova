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
from .tools import capability
from .tools.dispatcher import dispatch
from .tools.registry import to_openai_tools

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


def _build_system_prompt(memories: list[dict], model: str | None = None) -> str:
    base = SYSTEM_PROMPT
    if model:
        base += f"\nYour language model is: {model}"
    if not memories:
        return base
    lines = [base, "", "## What Nova remembers"]
    for m in memories:
        lines.append(f"- {m['content']}")
    return "\n".join(lines)


def _is_serialized_tool_call(content: str) -> bool:
    """True when a model returned a tool call as JSON text instead of tool_calls.
    Happens with small local models (llama3.2) when given 2+ tools."""
    stripped = content.strip()
    if not stripped.startswith("{"):
        return False
    try:
        obj = json.loads(stripped)
        return isinstance(obj, dict) and "name" in obj and "arguments" in obj
    except (json.JSONDecodeError, ValueError):
        return False


def _sanitize_tool_name(name: str) -> str:
    """OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$. Replace dots."""
    return name.replace(".", "_")


def _sanitize_tools_for_openai(tools: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Return (sanitized_tools, {safe_name → original_name}) for round-trip."""
    sanitized = []
    mapping: dict[str, str] = {}
    for t in tools:
        orig_name = t["function"]["name"]
        safe_name = _sanitize_tool_name(orig_name)
        mapping[safe_name] = orig_name
        sanitized.append({
            **t,
            "function": {**t["function"], "name": safe_name},
        })
    return sanitized, mapping


async def _llm_complete_chat(messages: list[dict], tools: list[dict], model: str | None = None) -> dict | None:
    safe_tools, name_map = _sanitize_tools_for_openai(tools)
    body: dict = {"messages": messages, "max_tokens": 2000, "temperature": 0.7}
    if safe_tools:
        body["tools"] = safe_tools
    if model:
        body["model"] = model
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{settings.llm_gateway_url}/complete", json=body)
            r.raise_for_status()
            resp = r.json()
    except Exception as exc:
        logger.warning("llm /complete failed: %s", exc)
        return None

    # Restore original tool names in any tool_calls the LLM returned
    if resp.get("tool_calls") and name_map:
        for tc in resp["tool_calls"]:
            fn = tc.get("function") or {}
            safe = fn.get("name", "")
            if safe in name_map:
                fn["name"] = name_map[safe]
    return resp


MAX_CHAT_ITERATIONS = 10

# Limit tools exposed in conversational chat — small local models (llama3.2 etc.)
# fail to produce structured tool_calls when given the full 14-tool list.
# These cover recall, web lookup, and code help which are the common chat actions.
_CHAT_TOOL_NAMES = frozenset({
    "memory.search", "memory.write",
    "web.search", "web.fetch",
    "fs.read", "code.execute",
})


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
    model: str | None = None


@router.post("/{task_id}/message")
async def post_message(task_id: str, body: MessageRequest) -> StreamingResponse:
    """Conversational turn with tool use — streams JSON lines back to caller."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        exists = await conn.fetchval("SELECT 1 FROM tasks WHERE id = $1::uuid", task_id)
        if not exists:
            await conn.execute(
                "INSERT INTO tasks (id, prompt, goal, status, created_at) "
                "VALUES ($1, $2, $2, 'running', now())",
                task_id, body.text[:500],
            )

        history_rows = await conn.fetch(
            "SELECT role, content FROM task_messages "
            "WHERE task_id = $1::uuid ORDER BY created_at",
            task_id,
        )
        await conn.execute(
            "INSERT INTO task_messages (task_id, role, content) VALUES ($1::uuid, 'user', $2)",
            task_id, body.text,
        )

    memories = await _search_memory(body.text)
    system_prompt = _build_system_prompt(memories, model=body.model)

    base_messages: list[dict] = [{"role": "system", "content": system_prompt}]
    base_messages += [{"role": r["role"], "content": r["content"]} for r in history_rows]
    base_messages.append({"role": "user", "content": body.text})

    async def generate():
        approval_queue: asyncio.Queue = asyncio.Queue()
        capability.register_approval_notifier(task_id, approval_queue)
        messages = list(base_messages)
        all_tools = to_openai_tools()
        tools = [t for t in all_tools if t["function"]["name"] in _CHAT_TOOL_NAMES]
        final_text = ""
        meta_emitted = False

        try:
            for _ in range(MAX_CHAT_ITERATIONS):
                resp = await _llm_complete_chat(messages, tools, model=body.model)
                if resp is None:
                    yield json.dumps({"error": "LLM gateway unreachable"}) + "\n"
                    return

                tool_calls = resp.get("tool_calls") or []
                content = resp.get("content") or ""

                if not tool_calls:
                    # Emit meta event once so the client knows which model responded
                    if not meta_emitted:
                        actual_model = resp.get("model") or body.model
                        if actual_model:
                            yield json.dumps({"type": "meta", "model": actual_model}) + "\n"
                        meta_emitted = True
                    # If the model serialized a tool call as text (small-model
                    # anti-pattern), fall back to a no-tools streaming response.
                    if _is_serialized_tool_call(content):
                        stream_body: dict = {"messages": messages, "max_tokens": 2000, "temperature": 0.7}
                        if body.model:
                            stream_body["model"] = body.model
                        async with httpx.AsyncClient(timeout=120.0) as client:
                            async with client.stream(
                                "POST",
                                f"{settings.llm_gateway_url}/stream",
                                json=stream_body,
                            ) as resp_s:
                                async for line in resp_s.aiter_lines():
                                    if not line.startswith("data: "):
                                        continue
                                    try:
                                        data = json.loads(line[6:])
                                    except json.JSONDecodeError:
                                        continue
                                    chunk = data.get("chunk", "")
                                    if chunk:
                                        final_text += chunk
                                        yield json.dumps({"text": chunk}) + "\n"
                    else:
                        final_text = content
                        yield json.dumps({"text": content}) + "\n"
                    break

                messages.append({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tool_calls,
                })

                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    name = fn.get("name", "")
                    try:
                        args = json.loads(fn.get("arguments", "{}") or "{}")
                    except Exception:
                        args = {}

                    # Run dispatch as a background task so we can concurrently
                    # drain approval events while it may be blocked waiting.
                    dispatch_task = asyncio.create_task(
                        dispatch(
                            name=name, args=args, task_id=task_id,
                            caller_role="chat", caller_caps=["*"], pool=pool,
                        )
                    )

                    while not dispatch_task.done():
                        get_task = asyncio.create_task(approval_queue.get())
                        done, _ = await asyncio.wait(
                            {dispatch_task, get_task},
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if get_task in done:
                            yield json.dumps(get_task.result()) + "\n"
                        else:
                            if not get_task.done():
                                get_task.cancel()
                                try:
                                    await get_task
                                except asyncio.CancelledError:
                                    pass
                            break

                    # Drain any events queued after dispatch finished
                    while not approval_queue.empty():
                        yield json.dumps(approval_queue.get_nowait()) + "\n"

                    try:
                        result = await dispatch_task
                    except PermissionError as exc:
                        result = {"error": str(exc)}
                    except Exception as exc:
                        result = {"error": str(exc)}

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": json.dumps(result) if not isinstance(result, str) else result,
                    })
            else:
                final_text = "I've reached the maximum number of steps for this turn."
                yield json.dumps({"text": final_text}) + "\n"

            if final_text:
                try:
                    async with pool.acquire() as conn:
                        await conn.execute(
                            "INSERT INTO task_messages (task_id, role, content) "
                            "VALUES ($1::uuid, 'assistant', $2)",
                            task_id, final_text,
                        )
                except Exception as exc:
                    logger.warning("failed to persist assistant message task=%s: %s", task_id, exc)
                asyncio.create_task(_ingest_memory(f"User: {body.text}\nNova: {final_text}"))

        except Exception as exc:
            logger.error("message turn failed task=%s: %s", task_id, exc)
            yield json.dumps({"error": str(exc)}) + "\n"
        finally:
            capability.deregister_approval_notifier(task_id)

    return StreamingResponse(generate(), media_type="text/plain")
