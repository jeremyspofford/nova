"""Task CRUD endpoints under /api/v1/tasks."""
import asyncio
import json
import logging
import uuid

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from nova_contracts import TaskCreateRequest
from pydantic import BaseModel

from .config import settings
from .db import get_pool
from .loop.main import run_task
from .tools import capability
from .tools.dispatcher import cleanup_task, dispatch
from .tools.registry import to_openai_tools

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/tasks", tags=["tasks"])

_SYSTEM_PROMPT_BASE = """\
You are Nova, an autonomous AI assistant. You can take real actions in the world using tools.

When given a complex or open-ended goal:
1. Think through the required steps before acting — what accounts, credentials, or information do you need first?
2. Execute step by step, using the right tool for each action.
3. Save any credentials or account details you create immediately using nova.secrets.write (name must be lowercase_with_underscores, e.g. reddit_password).
4. Use memory.write to remember important context for later in the conversation.
5. When no specific tool exists for what you need, improvise with code.execute (python or bash).

When answering simple questions, be concise. When executing multi-step tasks, briefly narrate what you're doing at each step."""

# One-line descriptions used to build the per-request "Tool selection guide"
# section. Keys are tool names (or prefixes ending with `_*`) that, when
# present in the offered tool list, contribute their line to the guide.
# Lines for tools NOT in the offered list are omitted — don't tell the model
# about tools it can't actually call.
_TOOL_GUIDE_LINES: list[tuple[str, str]] = [
    ("web.fetch",           "- web.fetch / web.search — read public web pages and search results"),
    ("browser_*",           "- browser_navigate / browser_click / browser_type / browser_snapshot — interact with web pages that require JavaScript or form submissions"),
    ("shell.exec",          "- shell.exec / code.execute — run commands and scripts locally (NOTE: these run in an isolated sandbox with no internet access — use web or browser tools for any HTTP requests)"),
    ("fs.write",            "- fs.read / fs.write — read and write files in the workspace"),
    ("nova.secrets.write",  "- nova.secrets.write / nova.secrets.read — store and retrieve passwords, tokens, and account credentials"),
    ("memory.search",       "- memory.search / memory.write — recall and record knowledge across conversations"),
]


def _build_tool_guide(offered_tool_names: set[str]) -> str:
    """Build the "Tool selection guide" section from the actually-offered tools.

    Each entry is keyed by a representative tool name (or `prefix_*` for MCP
    families). The line appears only if the keyed name is in the offered set,
    or — for prefix patterns — if any offered name matches the prefix.
    """
    lines: list[str] = []
    for key, line in _TOOL_GUIDE_LINES:
        if key.endswith("_*"):
            prefix = key[:-1]  # "browser_*" → "browser_"
            if any(n.startswith(prefix) for n in offered_tool_names):
                lines.append(line)
        elif key in offered_tool_names:
            lines.append(line)
    if not lines:
        return ""
    return "\n\nTool selection guide:\n" + "\n".join(lines)


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


_OUTPUT_STYLE_HINTS: dict[str, str] = {
    "concise": "Respond concisely. Prioritize brevity — omit preamble, summaries, and filler.",
    "detailed": "Provide detailed, comprehensive responses with full context and examples.",
    "technical": "Use precise technical language. Include implementation specifics and edge cases.",
    "creative": "Be expressive and imaginative. Vary sentence structure; avoid formulaic phrasing.",
    "eli5": "Explain simply, as if to someone with no background in the subject.",
}


def _build_system_prompt(
    memories: list[dict],
    *,
    offered_tool_names: set[str] | None = None,
    model: str | None = None,
    output_style: str | None = None,
    custom_instructions: str | None = None,
    web_search: bool = False,
    deep_research: bool = False,
) -> str:
    base = _SYSTEM_PROMPT_BASE
    if offered_tool_names is not None:
        base += _build_tool_guide(offered_tool_names)
    if model:
        base += f"\nYour language model is: {model}"
    if output_style:
        hint = _OUTPUT_STYLE_HINTS.get(output_style, f"Output style: {output_style}.")
        base += f"\n\nResponse style: {hint}"
    if custom_instructions:
        base += f"\n\nUser instructions: {custom_instructions}"
    if web_search:
        base += "\n\nWhen the user's question may benefit from current information, proactively use web.search and web.fetch."
    if deep_research:
        base += "\n\nConduct thorough multi-step research: search broadly, cross-reference multiple sources, and synthesize findings before responding."
    if not memories:
        return base
    lines = [base, "", "## What Nova remembers"]
    for m in memories:
        lines.append(f"- {m['content']}")
    return "\n".join(lines)


def _is_serialized_tool_call(content: str) -> bool:
    """True when a small model returned a garbled or JSON-encoded tool call.

    Small local models (llama3.2, qwen2.5-coder, etc.) often output the
    tool call as raw JSON in the content field, in `{"name": ..., "arguments": ...}`
    or `{"name": ..., "parameters": ...}` shape, sometimes wrapped in a
    markdown code fence (```python ... ``` or ```json ... ```).

    Returns True when we can parse a tool-call-shaped object out of content.
    Use `_extract_serialized_tool_call` to get the parsed call (or None).
    """
    return _extract_serialized_tool_call(content) is not None


def _extract_serialized_tool_call(content: str) -> dict | None:
    """Try to parse a tool-call-shaped JSON object out of content.

    Returns {"name": str, "arguments": dict} if found; else None. Tolerates:
    - bare JSON: `{"name": "fs.write", "arguments": {...}}`
    - parameters key (used by qwen): `{"name": "fs.write", "parameters": {...}}`
    - code fences: `\\`\\`\\`json\\n{...}\\n\\`\\`\\`` or `\\`\\`\\`python\\n{...}\\n\\`\\`\\``
    """
    if not content:
        return None
    stripped = content.strip()
    # Unwrap a code fence if present
    if stripped.startswith("```"):
        # drop the first line (fence + optional language tag) and the trailing fence
        lines = stripped.splitlines()
        if len(lines) >= 2:
            lines = lines[1:]  # drop opener
            # drop trailing fence if present
            while lines and lines[-1].strip() == "```":
                lines.pop()
            stripped = "\n".join(lines).strip()
    if not stripped.startswith("{"):
        return None
    try:
        obj = json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    if not isinstance(name, str) or not name:
        return None
    # Accept either "arguments" or "parameters" — qwen and some others use parameters
    args = obj.get("arguments")
    if args is None:
        args = obj.get("parameters")
    if not isinstance(args, dict):
        args = {}
    return {"name": name, "arguments": args}


def _sanitize_tool_name(name: str) -> str:
    """OpenAI requires tool names to match ^[a-zA-Z0-9_-]+$. Replace dots."""
    return name.replace(".", "_")


def _all_known_tool_names(tools: list[dict]) -> list[str]:
    """Original (un-sanitized) tool names from an openai-format tools list."""
    return [t.get("function", {}).get("name", "") for t in tools]


def _unsanitize_tool_name(sanitized: str, tools: list[dict]) -> str:
    """Reverse _sanitize_tool_name by matching against the tools list.

    If `sanitized` matches some `_sanitize_tool_name(orig)`, return `orig`.
    Otherwise return `sanitized` unchanged.
    """
    for orig in _all_known_tool_names(tools):
        if _sanitize_tool_name(orig) == sanitized:
            return orig
    return sanitized


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
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(f"{settings.llm_gateway_url}/complete", json=body)
            r.raise_for_status()
            resp = r.json()
    except httpx.ReadTimeout:
        logger.warning("llm /complete timed out (model=%s)", model)
        return {"_error": "The model took too long to respond. Local models can be slow with many tools — try a cloud model or send a simpler message."}
    except Exception as exc:
        logger.warning("llm /complete failed: %r", exc)
        return {"_error": "LLM gateway unreachable"}

    # Restore original tool names in any tool_calls the LLM returned
    if resp.get("tool_calls") and name_map:
        for tc in resp["tool_calls"]:
            fn = tc.get("function") or {}
            safe = fn.get("name", "")
            if safe in name_map:
                fn["name"] = name_map[safe]
    return resp


MAX_CHAT_ITERATIONS = 25

# Tools available to Nova in conversational turns.
# Exact names for built-ins; prefix patterns cover MCP tool families
# (e.g. browser_* from Playwright) without enumerating every name.
_CHAT_TOOL_NAMES = frozenset({
    "memory.search", "memory.write",
    "fs.read", "fs.write", "fs.delete",
    "shell.exec",
    "code.execute",
    "nova.secrets.write", "nova.secrets.read",
})
_WEB_TOOL_NAMES = frozenset({"web.search", "web.fetch"})
_CHAT_TOOL_PREFIXES = ("browser_",)


def _is_chat_tool(name: str, include_web: bool = True) -> bool:
    if name in _WEB_TOOL_NAMES:
        return include_web
    return name in _CHAT_TOOL_NAMES or any(name.startswith(p) for p in _CHAT_TOOL_PREFIXES)


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
            "SELECT id, prompt, goal, status, source, created_at FROM tasks ORDER BY created_at DESC LIMIT $1",
            limit,
        )
    return [
        {
            "id": str(r["id"]),
            "prompt": r["prompt"] or r["goal"],
            "goal": r["goal"],
            "status": r["status"],
            "source": r["source"] or "",
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
    content: list[dict] | None = None  # multimodal content blocks (text/image_url)
    model: str | None = None
    web_search: bool = False
    deep_research: bool = False
    output_style: str | None = None
    custom_instructions: str | None = None


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
        # Set title from first user message when task was pre-created with empty goal
        await conn.execute(
            "UPDATE tasks SET goal = $1, prompt = $1 "
            "WHERE id = $2::uuid AND (goal IS NULL OR goal = '')",
            body.text[:200], task_id,
        )

    # Build the offered tool list FIRST so the system prompt can advertise
    # only what's actually available. Previously the prompt advertised
    # web.fetch / web.search even when they weren't in the offered tool list
    # (web_search=False default), confusing small models into emitting
    # serialized tool calls for tools they couldn't actually call.
    all_tools = to_openai_tools()
    offered_tools = [t for t in all_tools if _is_chat_tool(t["function"]["name"], include_web=body.web_search)]
    offered_tool_names: set[str] = {t["function"]["name"] for t in offered_tools}

    memories = await _search_memory(body.text)
    system_prompt = _build_system_prompt(
        memories,
        offered_tool_names=offered_tool_names,
        model=body.model,
        output_style=body.output_style,
        custom_instructions=body.custom_instructions,
        web_search=body.web_search,
        deep_research=body.deep_research,
    )

    # Use multimodal content blocks if provided (e.g. images, file text); else plain text
    user_content: list[dict] | str = body.content if body.content else body.text

    base_messages: list[dict] = [{"role": "system", "content": system_prompt}]
    base_messages += [{"role": r["role"], "content": r["content"]} for r in history_rows]
    base_messages.append({"role": "user", "content": user_content})

    async def generate():
        approval_queue: asyncio.Queue = asyncio.Queue()
        capability.register_approval_notifier(task_id, approval_queue)
        messages = list(base_messages)
        tools = offered_tools
        final_text = ""
        meta_emitted = False

        try:
            for _ in range(MAX_CHAT_ITERATIONS):
                resp = await _llm_complete_chat(messages, tools, model=body.model)
                if resp is None or "_error" in resp:
                    err_msg = (resp or {}).get("_error", "LLM gateway unreachable")
                    yield json.dumps({"text": err_msg}) + "\n"
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
                    # Small models (qwen2.5-coder, llama3.2, etc.) often serialize
                    # the tool call as JSON in the content field instead of using
                    # the proper tool_calls structure. Parse it and synthesize a
                    # tool_call so the ReAct loop can execute it — much better
                    # than the previous behavior of falling back to no-tools.
                    parsed = _extract_serialized_tool_call(content)
                    # Only honor parsed serialized tool calls if the name maps
                    # to a tool actually in the offered set. Without this filter
                    # the parser could dispatch ANY tool the model hallucinates
                    # — even ones excluded by web_search=False, or tools the
                    # model invented entirely. Closes a latent security shape.
                    if parsed is not None:
                        synth_name = parsed["name"]
                        offered_sanitized = {_sanitize_tool_name(n) for n in offered_tool_names}
                        if synth_name in offered_tool_names:
                            synth_name_orig = synth_name
                        elif synth_name in offered_sanitized:
                            synth_name_orig = _unsanitize_tool_name(synth_name, offered_tools)
                        else:
                            # Tool isn't in the offered set — refuse to dispatch.
                            # Treat as plain text so the loop terminates cleanly.
                            parsed = None
                        if parsed is not None:
                            synth_tc = {
                                "id": f"call_{uuid.uuid4().hex[:12]}",
                                "type": "function",
                                "function": {
                                    "name": synth_name_orig,
                                    "arguments": json.dumps(parsed["arguments"]),
                                },
                            }
                            # Append assistant turn + synth tool_calls to history,
                            # then drop into the same dispatch loop the structured
                            # path uses below.
                            tool_calls = [synth_tc]
                            # fall through to the structured tool_calls dispatch
                    if parsed is None:
                        final_text = content
                        yield json.dumps({"text": content}) + "\n"
                        break

                # History must use sanitized names — OpenAI rejects dotted names like
                # "memory.search" in tool_calls history.  We use originals only for dispatch.
                history_tool_calls = [
                    {
                        **tc,
                        "function": {
                            **tc.get("function", {}),
                            "name": _sanitize_tool_name(tc.get("function", {}).get("name", "")),
                        },
                    }
                    for tc in tool_calls
                ]
                messages.append({
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": history_tool_calls,
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
            cleanup_task(task_id)

    return StreamingResponse(generate(), media_type="text/plain")
