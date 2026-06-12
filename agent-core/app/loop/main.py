"""ReAct-style agent loop.

run_task(): top-level task entry point. Owns lifecycle and routes tool calls
through the dispatcher.

run_subagent(): SPECIAL-tier dispatched sub-agent. Depth limit = 1.
"""
import asyncio
import json
import logging
import uuid
from typing import Any, Callable

import httpx

from ..config import settings
from ..tools import audit
from ..tools.dispatcher import cleanup_task, dispatch
from ..tools.registry import to_openai_tools
from ..tools.sandbox.manager import stop_sandbox

logger = logging.getLogger(__name__)


class GatewayUnreachableError(RuntimeError):
    """LLM gateway failed after retries — the task cannot make progress.

    Raised (not returned as a result) so run_task marks the task `failed`:
    a gateway outage must never be recorded as a completed task result.
    """


_llm_client: httpx.AsyncClient | None = None
_sleep = asyncio.sleep  # seam for tests — retries must not slow the suite

# Optional dispatch callback set by main.py lifespan.
# When set, task completions/failures trigger task_complete schedule checks.
_task_complete_dispatch_fn: Callable | None = None


def set_task_complete_dispatch_fn(fn: Callable) -> None:
    """Register the scheduler's dispatch function. Called from main.py lifespan."""
    global _task_complete_dispatch_fn
    _task_complete_dispatch_fn = fn


async def _notify_task_complete(pool, task_id: str, final_status: str) -> None:
    """Fire task_complete schedules if a dispatch_fn is registered."""
    if _task_complete_dispatch_fn is None:
        return
    try:
        from ..scheduler import fire_task_complete_schedules
        await fire_task_complete_schedules(pool, task_id, final_status, _task_complete_dispatch_fn)
    except Exception as exc:
        logger.warning("task_complete schedule hook failed for task %s: %s", task_id[:8], exc)


async def _surface_schedule_result(pool, task_id: str, final_status: str, result_text: str) -> None:
    """If this task was dispatched by a schedule, post its output to the schedule's chat thread."""
    try:
        schedule_id = await pool.fetchval("SELECT schedule_id FROM tasks WHERE id = $1", task_id)
        if schedule_id is None:
            return
        from ..scheduler import post_schedule_result
        await post_schedule_result(pool, task_id, schedule_id, final_status, result_text)
    except Exception as exc:
        logger.warning("schedule result hook failed for task %s: %s", task_id[:8], exc)


def get_llm_client() -> httpx.AsyncClient:
    global _llm_client
    if _llm_client is None:
        _llm_client = httpx.AsyncClient(timeout=120.0)
    return _llm_client


async def close_llm_client() -> None:
    global _llm_client
    if _llm_client:
        await _llm_client.aclose()
        _llm_client = None

MAX_ITERATIONS = 20
LLM_ATTEMPTS = 3
ALL_CAPS = ["*"]

# Tool results are audited in full, but the copy that enters the model's
# context is capped — a single web.fetch can be 50K chars, and 20 iterations
# of that drowns small-model context windows.
_RESULT_CONTEXT_CAP = 16_000


def clip_tool_result(text: str) -> str:
    """Cap a tool-result string destined for the model's context."""
    if len(text) <= _RESULT_CONTEXT_CAP:
        return text
    omitted = len(text) - _RESULT_CONTEXT_CAP
    return text[:_RESULT_CONTEXT_CAP] + f"\n[...truncated {omitted} chars]"


def _system_prompt(role: str) -> str:
    return (
        f"You are Nova, an autonomous AI agent (role: {role}). "
        "Decompose the user's goal into steps and use the available tools to make progress. "
        "Stop and return a concise final answer when the goal is complete or impossible. "
        "Prefer fewer tool calls. Never fabricate tool results."
    )


async def run_task(task_id: str, goal: str, pool) -> dict:
    """Execute one task end-to-end. Updates `tasks` row + emits audit events."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE tasks SET status = 'running', started_at = now() WHERE id = $1",
            task_id,
        )
    await audit.write_event(pool, task_id, "task_started", {"goal": goal})

    try:
        result = await _loop(task_id, goal, caller_role="main", caps=ALL_CAPS, pool=pool)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE tasks SET status = 'completed', result = $2, completed_at = now() WHERE id = $1",
                task_id, result.get("final", ""),
            )
        await audit.write_event(pool, task_id, "task_completed", result)
        await _surface_schedule_result(pool, task_id, "completed", result.get("final", ""))
        await _notify_task_complete(pool, task_id, "completed")
        return result
    except Exception as exc:
        logger.warning("task %s failed: %s", task_id[:8], exc)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE tasks SET status = 'failed', result = $2, completed_at = now() WHERE id = $1",
                task_id, str(exc),
            )
        await audit.write_event(pool, task_id, "task_failed", {"error": str(exc)})
        await _surface_schedule_result(pool, task_id, "failed", str(exc))
        await _notify_task_complete(pool, task_id, "failed")
        return {"error": str(exc)}
    finally:
        cleanup_task(task_id)
        try:
            await stop_sandbox(task_id)
        except Exception:
            pass


async def run_subagent(
    role: str, capabilities: list, goal: str, parent_task_id, parent_call_id, pool,
) -> dict:
    """Sub-agent task. Records a parent_task_id linkage and a separate audit chain."""
    sub_task_id = str(uuid.uuid4())
    async with pool.acquire() as conn:
        # Reuse goal as prompt to satisfy NOT NULL constraint on prompt column.
        await conn.execute(
            "INSERT INTO tasks (id, prompt, goal, status, source, parent_task_id, created_at, started_at) "
            "VALUES ($1, $2, $2, 'running', $3, $4, now(), now())",
            sub_task_id, goal, f"subagent:{role}", str(parent_task_id),
        )
    await audit.write_event(pool, sub_task_id, "subagent_started", {
        "role": role, "capabilities": capabilities, "goal": goal,
        "parent_task_id": str(parent_task_id),
    })
    try:
        result = await _loop(sub_task_id, goal, caller_role=role, caps=capabilities, pool=pool)
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE tasks SET status = 'completed', result = $2, completed_at = now() WHERE id = $1",
                sub_task_id, result.get("final", ""),
            )
        await audit.write_event(pool, sub_task_id, "subagent_completed", result)
        return result
    except Exception as exc:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE tasks SET status = 'failed', result = $2, completed_at = now() WHERE id = $1",
                sub_task_id, str(exc),
            )
        await audit.write_event(pool, sub_task_id, "subagent_failed", {"error": str(exc)})
        return {"error": str(exc)}
    finally:
        cleanup_task(sub_task_id)


async def _loop(task_id: str, goal: str, caller_role: str, caps: list, pool) -> dict:
    """ReAct loop. Returns {final, iterations, ...}."""
    messages: list[dict] = [
        {"role": "system", "content": _system_prompt(caller_role)},
        {"role": "user", "content": goal},
    ]
    tools = _filter_by_caps(to_openai_tools(), caps)

    for i in range(MAX_ITERATIONS):
        resp = await _llm_complete(messages, tools)
        if resp is None:
            raise GatewayUnreachableError("LLM gateway unreachable after retries")

        tool_calls = resp.get("tool_calls") or []
        content = resp.get("content") or ""

        if not tool_calls:
            return {"final": content, "iterations": i}

        # Record the assistant turn (with tool calls) for context across iterations
        messages.append({
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name", "")
            raw_args = fn.get("arguments", "{}") or "{}"
            # Bad arguments are reported back as the tool result, not silently
            # coerced to {} — the model can only correct what it can see.
            try:
                args = json.loads(raw_args)
                if not isinstance(args, dict):
                    raise ValueError("arguments must be a JSON object")
            except Exception as exc:
                args = None
                result = {"error": f"invalid tool arguments ({exc}): {raw_args[:200]}"}

            if args is not None:
                try:
                    result = await dispatch(
                        name=name, args=args, task_id=task_id,
                        caller_role=caller_role, caller_caps=caps, pool=pool,
                    )
                except PermissionError as exc:
                    result = {"error": str(exc)}
                except Exception as exc:
                    # A tool (or dispatcher) bug must not kill the task — hand
                    # the failure to the model so it can route around it.
                    logger.warning("dispatch %s crashed in task %s: %s", name, task_id[:8], exc)
                    result = {"error": str(exc)}

            messages.append({
                "role": "tool",
                "tool_call_id": tc.get("id", ""),
                "content": clip_tool_result(
                    json.dumps(result) if not isinstance(result, str) else result
                ),
            })

    # Budget exhausted — one final no-tools pass so the task ends with a real
    # account of what happened, not a bare "max iterations" marker.
    messages.append({
        "role": "user",
        "content": (
            "You have reached the tool-call limit for this task. Using only what "
            "you already learned above, give your final answer now: state what "
            "was completed and what remains."
        ),
    })
    resp = await _llm_complete(messages, [])
    if resp is None:
        raise GatewayUnreachableError("LLM gateway unreachable after retries")
    final = resp.get("content") or "Stopped at the tool-call limit before reaching a final answer."
    return {"final": final, "iterations": MAX_ITERATIONS, "exhausted": True}


async def _llm_complete(messages: list[dict], tools: list[dict]) -> dict | None:
    """Call llm-gateway /complete with tools[]. Returns response dict or None.

    Transport errors and 5xx are retried with backoff (LLM_ATTEMPTS total) —
    a single transient hiccup must not kill a 19-step task. 4xx means the
    request itself is wrong and is not retried.
    """
    body: dict[str, Any] = {"messages": messages, "max_tokens": 2000, "temperature": 0.7}
    if tools:
        body["tools"] = tools
    for attempt in range(1, LLM_ATTEMPTS + 1):
        try:
            r = await get_llm_client().post(f"{settings.llm_gateway_url}/complete", json=body)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code < 500:
                logger.warning("llm gateway /complete rejected request: %s", exc)
                return None
            err: Exception = exc
        except httpx.HTTPError as exc:
            err = exc
        except Exception as exc:
            logger.warning("llm gateway /complete failed: %s", exc)
            return None
        logger.warning("llm gateway /complete attempt %d/%d failed: %s", attempt, LLM_ATTEMPTS, err)
        if attempt < LLM_ATTEMPTS:
            await _sleep(2 ** (attempt - 1))
    return None


def _filter_by_caps(openai_tools: list[dict], caps: list[str]) -> list[dict]:
    """Filter the openai-format tools list by an agent's capability set.

    `caps == ["*"]` permits everything. Otherwise the capability strings are
    matched literally against the tool name (or prefix with trailing colon).
    """
    if "*" in caps:
        return openai_tools
    cap_set = set(caps)
    out: list[dict] = []
    for t in openai_tools:
        name = t["function"]["name"]
        # exact match or prefix:<name> match
        if name in cap_set or any(c.split(":")[0] == name.split(".")[0] for c in cap_set):
            out.append(t)
    return out
