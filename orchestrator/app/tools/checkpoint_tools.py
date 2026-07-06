"""Human checkpoint tool — mid-task human-in-the-loop resume.

request_human_checkpoint lets the Task Agent stop mid-flow and wait for the
operator: CAPTCHAs, emailed verification codes, judgment calls. It creates a
pending approval_requests row (kind='checkpoint'), and the tool loop parks the
task in waiting_human. The operator's decision — with an optional free-text
reply — flows back through the approval worker, which re-queues the task with
the reply injected as this tool's result.

Only the pipeline task stage may call this: parking requires the executor's
resume machinery, which only the task stage implements. Interactive chat has
the human right there; other stages are analysis-only.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from nova_contracts import BlastRadius, ToolDefinition

logger = logging.getLogger(__name__)

CHECKPOINT_TOOL_NAME = "request_human_checkpoint"


class HumanCheckpointPending(Exception):
    """Raised by the tool loop when a checkpoint was created.

    Carries everything the pipeline executor needs to park the task: the
    approval row id, the tool_use id awaiting a result, and the conversation
    so far (every tool_use answered except the checkpoint call itself — the
    operator's reply becomes that result on resume).
    """

    def __init__(
        self,
        approval_id: str,
        tool_call_id: str,
        reason: str,
        instructions: str,
        messages: list,
    ) -> None:
        super().__init__(f"human checkpoint pending (approval {approval_id})")
        self.approval_id = approval_id
        self.tool_call_id = tool_call_id
        self.reason = reason
        self.instructions = instructions
        self.messages = messages


CHECKPOINT_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name=CHECKPOINT_TOOL_NAME,
        description=(
            "Pause this task and ask the human operator for something you "
            "cannot do yourself: solve a CAPTCHA, provide an emailed "
            "verification code, or make a judgment call. The task parks until "
            "the operator responds (on their phone or dashboard); their reply "
            "is returned as this tool's result and you continue exactly where "
            "you left off. Use sparingly — every call interrupts a human."
        ),
        parameters={
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Short why, e.g. 'CAPTCHA on signup page'",
                },
                "instructions": {
                    "type": "string",
                    "description": (
                        "Exactly what the operator should do or provide, "
                        "e.g. 'Open example.com/signup, solve the CAPTCHA, "
                        "then approve' or 'Reply with the 6-digit code sent "
                        "to nova@example.com'"
                    ),
                },
                "context": {
                    "type": "string",
                    "description": "Optional extra detail: page URL, account name, current state",
                },
            },
            "required": ["reason", "instructions"],
        },
        blast_radius=BlastRadius.PROPOSE,
    ),
]


async def execute_tool(name: str, args: dict, context: dict | None = None) -> str:
    """Create a pending checkpoint approval. Returns JSON for the tool loop.

    The tool itself only writes the approval row + audit; parking the task
    (status transition, conversation snapshot, notification) happens in the
    pipeline executor, which sees the checkpoint_pending result and raises
    HumanCheckpointPending from the tool loop.
    """
    if name != CHECKPOINT_TOOL_NAME:
        return json.dumps({"status": "error", "message": f"Unknown checkpoint tool '{name}'"})

    ctx = context or {}
    task_id = ctx.get("task_id")
    if not task_id:
        return json.dumps({
            "status": "error",
            "message": (
                "request_human_checkpoint is only available inside an "
                "autonomous pipeline task. In interactive chat, just ask "
                "the user directly."
            ),
        })
    if ctx.get("actor_id") != "task":
        return json.dumps({
            "status": "error",
            "message": (
                "request_human_checkpoint is only available to the task "
                "stage — other pipeline stages cannot park and resume."
            ),
        })

    reason = str(args.get("reason") or "").strip()
    instructions = str(args.get("instructions") or "").strip()
    if not reason or not instructions:
        return json.dumps({
            "status": "error",
            "message": "Both 'reason' and 'instructions' are required.",
        })

    from app.capabilities import audit
    from app.config import settings
    from app.db import get_pool

    tenant_id = UUID(str(ctx.get("tenant_id") or "00000000-0000-0000-0000-000000000001"))
    approval_id = uuid4()
    expires_at = datetime.now(timezone.utc) + timedelta(hours=settings.checkpoint_timeout_hours)
    checkpoint_args = {
        "reason": reason[:500],
        "instructions": instructions[:2000],
        "context": str(args.get("context") or "")[:2000],
    }
    tool_context = {
        "tenant_id": str(tenant_id),
        "user_id": ctx.get("user_id"),
        "task_id": str(task_id),
        "actor_kind": ctx.get("actor_kind", "agent"),
        "actor_id": ctx.get("actor_id", "task"),
    }

    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO approval_requests (
              id, tenant_id, task_id, requested_by,
              tool_name, tool_kind, blast_radius,
              args_redacted, status, kind,
              created_at, expires_at, tool_context
            ) VALUES (
              $1,$2,$3,$4,$5,'native','propose',$6,'pending','checkpoint',now(),$7,$8
            )
            """,
            approval_id, tenant_id, UUID(str(task_id)),
            ctx.get("actor_id", "task"), CHECKPOINT_TOOL_NAME,
            checkpoint_args, expires_at, tool_context,
        )

    await audit.write_audit_event(
        pool,
        tenant_id=tenant_id,
        task_id=UUID(str(task_id)),
        actor_kind=ctx.get("actor_kind", "agent"),
        actor_id=ctx.get("actor_id", "task"),
        event_type="consent_request",
        tool_name=CHECKPOINT_TOOL_NAME,
        tool_kind="native",
        blast_radius="propose",
        args_redacted=checkpoint_args,
        response_status="pending",
        response_summary=f"checkpoint approval_id={approval_id}",
    )

    logger.info(
        "Checkpoint requested for task %s: %s (approval %s)",
        task_id, reason, approval_id,
    )
    return json.dumps({
        "status": "checkpoint_pending",
        "approval_id": str(approval_id),
        "reason": reason,
        "instructions": instructions,
    })
