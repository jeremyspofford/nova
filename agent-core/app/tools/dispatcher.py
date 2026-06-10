"""Central tool dispatch: gate -> execute -> audit."""
import asyncio
import logging
import uuid
from typing import Any

import anyio

from . import audit, capability
from .registry import lookup

logger = logging.getLogger(__name__)

_global_sem = asyncio.Semaphore(20)
_task_sems: dict[str, asyncio.Semaphore] = {}


async def dispatch(
    name: str,
    args: dict,
    task_id: str,
    caller_role: str,
    caller_caps: list[str],
    pool,
) -> Any:
    """Dispatch one tool call. Returns result. Raises PermissionError on denial."""
    tool_def = lookup(name)
    call_id = str(uuid.uuid4())

    _task_sems.setdefault(task_id, asyncio.Semaphore(5))

    async with _global_sem, _task_sems[task_id]:
        await audit.write_event(pool, task_id, "tool_call_proposed", {
            "call_id": call_id,
            "tool_name": name,
            "args": args,
            "caller_role": caller_role,
        })

        try:
            await capability.gate(tool_def, args, task_id, call_id, pool)
        except PermissionError as exc:
            await audit.write_event(pool, task_id, "tool_call_denied", {
                "call_id": call_id, "reason": str(exc),
            })
            raise

        await audit.write_event(pool, task_id, "tool_call_started", {"call_id": call_id})

        from .context import ToolContext
        ctx = ToolContext(
            idempotency_key=call_id,
            task_id=uuid.UUID(task_id),
            call_id=uuid.UUID(call_id),
            caller_role=caller_role,
            caller_caps=caller_caps,
            pool=pool,
            snapshot=_make_snapshot() if tool_def.reversible else None,
            request_approval=capability._request_approval,
        )

        try:
            with anyio.fail_after(tool_def.timeout_s):
                result = await _invoke(tool_def, args, ctx)
        except TimeoutError:
            msg = f"Timed out after {tool_def.timeout_s}s"
            await audit.write_event(pool, task_id, "tool_call_error", {
                "call_id": call_id, "error": msg,
            })
            return {"error": msg}
        except Exception as exc:
            await audit.write_event(pool, task_id, "tool_call_error", {
                "call_id": call_id, "error": str(exc),
            })
            return {"error": str(exc)}

        result_payload = result if isinstance(result, dict) else {"output": str(result)}
        await audit.write_event(pool, task_id, "tool_call_result", {
            "call_id": call_id, "result": result_payload,
        })
        return result


async def _invoke(tool_def, args: dict, ctx) -> Any:
    if tool_def.source == "builtin":
        return await tool_def.fn(**args, ctx=ctx)
    if tool_def.source == "mcp":
        from .mcp import client as mcp_client
        return await mcp_client.call_tool(tool_def.server_id, tool_def.remote_name, args, ctx)
    raise ValueError(f"Unknown tool source: {tool_def.source!r}")


def _make_snapshot():
    import os
    import shutil

    async def snapshot(resource: str) -> str:
        snap_id = str(uuid.uuid4())
        dest = f"/tmp/nova-snapshots/{snap_id}"
        os.makedirs(dest, exist_ok=True)
        if os.path.isfile(resource):
            shutil.copy2(resource, dest)
        elif os.path.isdir(resource):
            shutil.copytree(resource, os.path.join(dest, os.path.basename(resource)))
        return snap_id

    return snapshot


def cleanup_task(task_id: str) -> None:
    _task_sems.pop(task_id, None)
