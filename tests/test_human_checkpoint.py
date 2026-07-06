"""Task #8 milestone B: request_human_checkpoint → park → decide → resume.

The checkpoint loop in four acts:
  1. The task-stage agent calls request_human_checkpoint → a pending
     approval_requests row (kind='checkpoint') is created.
  2. The pipeline executor parks the task: conversation snapshot into
     checkpoint['_human_checkpoint'], status → waiting_human.
  3. The operator decides via POST /approvals/{id}/decide with an optional
     response_text (verification code, instructions, decline reason).
  4. The approval worker (in the live orchestrator) injects the reply into
     the snapshot and re-queues the task, which resumes from checkpoints.

Acts 1–2 run in-process against the real DB (the LLM decision to call the
tool is the only piece faked). Acts 3–4 exercise the live orchestrator over
HTTP — the same worker path production uses. Stages are pre-checkpointed so
the resumed pipeline completes without any LLM calls.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO / "orchestrator"))
sys.path.insert(0, str(_REPO / "nova-contracts"))
sys.path.insert(0, str(_REPO / "nova-worker-common"))

import asyncio
import json
import time
from uuid import UUID, uuid4

import httpx
import pytest

TENANT = UUID("00000000-0000-0000-0000-000000000001")
USER = UUID("00000000-0000-0000-0000-000000000001")

# Every pipeline + post-pipeline role, pre-checkpointed so the resumed task
# skips every stage and completes without an LLM provider.
_ALL_STAGE_ROLES = [
    "context", "task", "critique_direction", "guardrail", "code_review",
    "critique_acceptance", "decision", "documentation", "diagramming",
    "security_review", "memory_extraction",
]


@pytest.fixture
async def app_db_pool(pool):
    """Patch the orchestrator's global db pool so in-process calls into
    app.* code (tool dispatch, park helper) hit the test database."""
    from app import db as app_db
    saved = app_db._pool
    app_db._pool = pool
    try:
        yield
    finally:
        app_db._pool = saved


async def _insert_running_task(pool) -> str:
    """Insert a task mid task-stage with all stages pre-checkpointed."""
    task_id = uuid4()
    checkpoint = {
        role: {"output": "nova-test synthetic output", "verdict": "pass"}
        for role in _ALL_STAGE_ROLES
    }
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO tasks (id, user_input, status, current_stage, checkpoint, metadata)
            VALUES ($1, $2, 'task_running', 'task', $3, '{}'::jsonb)
            """,
            task_id, "nova-test-checkpoint: sign up for the test service",
            checkpoint,
        )
    return str(task_id)


async def _park_task_on_checkpoint(pool, task_id: str) -> str:
    """Acts 1+2 in-process: tool call creates the approval, executor parks.

    Returns the approval_id.
    """
    from app.pipeline.executor import _park_for_checkpoint
    from app.tools import execute_tool
    from app.tools.checkpoint_tools import HumanCheckpointPending
    from nova_contracts import Message, ToolCallRef

    result = await execute_tool(
        "request_human_checkpoint",
        {
            "reason": "Email verification code needed",
            "instructions": "Reply with the 6-digit code sent to the test inbox",
            "context": "https://example.test/signup",
        },
        context={
            "tenant_id": str(TENANT),
            "user_id": str(USER),
            "task_id": task_id,
            "actor_kind": "agent",
            "actor_id": "task",
        },
    )
    parsed = json.loads(result)
    assert parsed.get("status") == "checkpoint_pending", f"tool returned {parsed}"
    approval_id = parsed["approval_id"]

    # The conversation the tool loop would have accumulated, minus the
    # checkpoint call's own result (the operator's reply becomes it).
    messages = [
        Message(role="system", content="nova-test system prompt"),
        Message(role="user", content="nova-test: sign up for the test service"),
        Message(
            role="assistant",
            content="I submitted the form and need the emailed code.",
            tool_calls=[ToolCallRef(
                id="call_checkpoint_1",
                name="request_human_checkpoint",
                arguments={"reason": "Email verification code needed",
                           "instructions": "Reply with the 6-digit code"},
            )],
        ),
    ]
    hcp = HumanCheckpointPending(
        approval_id=approval_id,
        tool_call_id="call_checkpoint_1",
        reason="Email verification code needed",
        instructions="Reply with the 6-digit code sent to the test inbox",
        messages=messages,
    )
    await _park_for_checkpoint(task_id, "task", hcp)
    return approval_id


async def _wait_for_task(pool, task_id: str, statuses: set[str], timeout_s: float = 30.0) -> str:
    """Poll until the task reaches one of the given statuses. Returns final status."""
    deadline = time.monotonic() + timeout_s
    status = "?"
    while time.monotonic() < deadline:
        async with pool.acquire() as conn:
            status = await conn.fetchval(
                "SELECT status FROM tasks WHERE id=$1::uuid", task_id,
            )
        if status in statuses:
            return status
        await asyncio.sleep(0.25)
    return status


async def _cleanup(pool, orchestrator, admin_headers, task_id: str, approval_id: str | None) -> None:
    await orchestrator.delete(
        f"/api/v1/pipeline/tasks/{task_id}?force=true", headers=admin_headers,
    )
    if approval_id:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM approval_requests WHERE id=$1::uuid", approval_id,
            )


@pytest.mark.asyncio
async def test_checkpoint_tool_is_task_stage_only(app_db_pool):
    """Outside a pipeline task (or from a non-task stage) the tool refuses."""
    from app.tools import execute_tool

    no_context = json.loads(await execute_tool(
        "request_human_checkpoint",
        {"reason": "x", "instructions": "y"},
    ))
    assert no_context["status"] == "error"
    assert "autonomous" in no_context["message"]

    wrong_stage = json.loads(await execute_tool(
        "request_human_checkpoint",
        {"reason": "x", "instructions": "y"},
        context={"tenant_id": str(TENANT), "task_id": str(uuid4()), "actor_id": "context"},
    ))
    assert wrong_stage["status"] == "error"
    assert "task stage" in wrong_stage["message"]


@pytest.mark.asyncio
async def test_checkpoint_park_approve_resume(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """The headline loop: park → approve with reply → task resumes and completes."""
    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)

        # Parked: waiting_human + snapshot + pending checkpoint approval
        async with pool.acquire() as conn:
            trow = await conn.fetchrow(
                "SELECT status, checkpoint, metadata FROM tasks WHERE id=$1::uuid", task_id,
            )
            arow = await conn.fetchrow(
                "SELECT status, kind, blast_radius, task_id FROM approval_requests WHERE id=$1::uuid",
                approval_id,
            )
        assert trow["status"] == "waiting_human"
        hc = trow["checkpoint"]["_human_checkpoint"]
        assert hc["approval_id"] == approval_id
        assert hc["tool_call_id"] == "call_checkpoint_1"
        assert hc["stage"] == "task"
        assert len(hc["messages"]) == 3
        assert trow["metadata"]["checkpoint_approval_id"] == approval_id
        assert arow["status"] == "pending"
        assert arow["kind"] == "checkpoint"
        assert arow["blast_radius"] == "propose"
        assert str(arow["task_id"]) == task_id

        # It shows up in the operator's pending list
        listing = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers,
        )
        assert listing.status_code == 200
        assert any(a["id"] == approval_id for a in listing.json())

        # Operator replies with the code
        decide = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "approve", "response_text": "the code is 493201"},
        )
        assert decide.status_code == 200, decide.text

        # Worker resumes the task; all stages are checkpointed → complete
        final = await _wait_for_task(pool, task_id, {"complete", "failed", "cancelled"})
        assert final == "complete", f"resumed task ended '{final}', expected complete"

        async with pool.acquire() as conn:
            trow = await conn.fetchrow(
                "SELECT checkpoint FROM tasks WHERE id=$1::uuid", task_id,
            )
            arow = await conn.fetchrow(
                "SELECT status, response_text, decided_by FROM approval_requests WHERE id=$1::uuid",
                approval_id,
            )
        hr = trow["checkpoint"]["_human_checkpoint"]["human_response"]
        assert hr["status"] == "approved"
        assert hr["operator_response"] == "the code is 493201"
        assert arow["status"] == "approved"
        assert arow["response_text"] == "the code is 493201"
        assert arow["decided_by"]
    finally:
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)


@pytest.mark.asyncio
async def test_checkpoint_reject_still_resumes(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """Decline must also resume the task (with a rejected result), not strand it."""
    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)

        decide = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "reject", "response_text": "not this service, use the staging one"},
        )
        assert decide.status_code == 200, decide.text

        final = await _wait_for_task(pool, task_id, {"complete", "failed", "cancelled"})
        assert final == "complete", f"rejected-resume task ended '{final}', expected complete"

        async with pool.acquire() as conn:
            trow = await conn.fetchrow(
                "SELECT checkpoint FROM tasks WHERE id=$1::uuid", task_id,
            )
        hr = trow["checkpoint"]["_human_checkpoint"]["human_response"]
        assert hr["status"] == "rejected"
        assert hr["operator_response"] == "not this service, use the staging one"
        assert "declined" in hr["note"]
    finally:
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)


@pytest.mark.asyncio
async def test_stale_checkpoint_decision_does_not_resume(
    pool, orchestrator: httpx.AsyncClient, admin_headers: dict, app_db_pool,
):
    """A decision for an approval that no longer matches the task's current
    park (e.g. the operator raced a cancel) must not touch the task."""
    task_id = await _insert_running_task(pool)
    approval_id = None
    try:
        approval_id = await _park_task_on_checkpoint(pool, task_id)

        # Simulate the park being superseded: point the task at a different approval
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE tasks
                SET checkpoint = checkpoint || jsonb_build_object(
                  '_human_checkpoint',
                  (checkpoint->'_human_checkpoint') || jsonb_build_object('approval_id', $2::text)
                )
                WHERE id = $1::uuid
                """,
                task_id, str(uuid4()),
            )

        decide = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={"decision": "approve", "response_text": "too late"},
        )
        assert decide.status_code == 200, decide.text

        # Give the worker a moment, then confirm the task did NOT resume
        await asyncio.sleep(3)
        async with pool.acquire() as conn:
            status = await conn.fetchval(
                "SELECT status FROM tasks WHERE id=$1::uuid", task_id,
            )
        assert status == "waiting_human", f"stale decision resumed the task ({status})"
    finally:
        await _cleanup(pool, orchestrator, admin_headers, task_id, approval_id)
