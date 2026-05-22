"""The per-(probe, model, trial) run loop. Wires env + availability + stream +
events + verifiers + cleanups. Returns a TrialResult."""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from audit_tool_use.availability import check_tool_available
from audit_tool_use.constants import MUTATE_DEADLINE_S, READ_DEADLINE_S
from audit_tool_use.events import derive_outcome, fetch_task_events
from audit_tool_use.stream import consume_stream_with_approval_grant
from audit_tool_use.types import Cleanup, Outcome, Probe, Setup, TrialResult, Verifier

AGENT_CORE = os.getenv("NOVA_AGENT_CORE_URL", "http://localhost:8000")


async def _grant_approval(base_url: str, admin_headers: dict, tool_call_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{base_url}/api/v1/approvals/{tool_call_id}/grant",
                json={"remember": False, "remember_ttl": 0},
                headers=admin_headers,
            )
    except Exception:
        pass


def _render(probe: Probe, run_id: str, token: str) -> tuple[str, dict | None]:
    """Substitute {run_id} and {token} placeholders in the prompt and args_subset."""
    def subst(s: str) -> str:
        return s.format(run_id=run_id, token=token)
    prompt = subst(probe.prompt_template)
    args = None
    if probe.expected_args_subset:
        args = {k: (subst(v) if isinstance(v, str) else v) for k, v in probe.expected_args_subset.items()}
    return prompt, args


async def run_trial(
    probe: Probe,
    model: dict,
    trial_n: int,
    admin_headers: dict,
    trace_dir: Path,
) -> TrialResult:
    run_id = uuid.uuid4().hex[:8]
    token = f"AUDIT-TOK-{uuid.uuid4().hex[:12]}"
    prompt, _args = _render(probe, run_id, token)
    deadline = MUTATE_DEADLINE_S if probe.tier == "MUTATE" else READ_DEADLINE_S
    start = time.monotonic()
    trace: dict[str, Any] = {
        "probe_id": probe.id, "tool": probe.tool, "model": model["model_id"],
        "trial_n": trial_n, "run_id": run_id, "token": token, "prompt": prompt,
        "stream_events": [], "task_events": [], "verifier_result": None,
        "cleanup_result": None,
    }

    ok, reason = await check_tool_available(AGENT_CORE, probe.tool, admin_headers)
    if not ok:
        trial = TrialResult(
            probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
            outcome=Outcome.NOT_CALLED, latency_ms=0, error_msg=None,
            trace_path=None, cleanup_failed=False, run_id=run_id,
            skipped_reason=reason or "tool-unavailable",
        )
        _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
        return trial

    if probe.setup is not None and probe.setup is not Setup.NONE:
        setup_inst = _instantiate_verifier(probe.setup, run_id, token)
        try:
            s_ok, s_reason = await setup_inst.run({"admin_headers": admin_headers})
            trace["setup_result"] = {"ok": s_ok, "reason": s_reason}
            if not s_ok:
                return _infra_failure(probe, model, trial_n, run_id, trace_dir, trace,
                                      f"setup failed: {s_reason}")
        except Exception as e:
            trace["setup_result"] = {"ok": False, "reason": str(e)}
            return _infra_failure(probe, model, trial_n, run_id, trace_dir, trace,
                                  f"setup raised: {e}")

    # IMPORTANT: do NOT call POST /api/v1/tasks here.
    # That endpoint fires `run_task` (loop/main.py) — a DIFFERENT autonomous
    # code path from the conversational ReAct loop in tasks_router.generate().
    # Earlier audit runs hit this trap and saw run_task's iterations=0 events
    # (with hallucinated tool-call JSON as text) instead of conversational
    # tool_call_proposed events. The audit is specifically testing the chat
    # loop, so we generate a task_id ourselves and let post_message auto-
    # create the task without triggering run_task.
    task_id = str(uuid.uuid4())
    trace["task_id"] = task_id

    async def grant_fn(call_id: str) -> None:
        await _grant_approval(AGENT_CORE, admin_headers, call_id)

    try:
        async with httpx.AsyncClient(timeout=deadline + 10) as client:
            async with client.stream(
                "POST",
                f"{AGENT_CORE}/api/v1/tasks/{task_id}/message",
                # web_search=True opts web.fetch + web.search into the tool list
                # offered to the LLM. Without it Nova excludes web tools, which
                # makes the web-fetch / web-search probes a no-op — the model
                # was never told the tools exist. The audit's purpose is to
                # test what's available; we ask for everything.
                json={"text": prompt, "model": model["model_id"], "web_search": True},
                headers=admin_headers,
            ) as resp:
                final = await asyncio.wait_for(
                    consume_stream_with_approval_grant(resp.aiter_bytes(), grant_fn),
                    timeout=deadline,
                )
        trace["final_stream_event"] = final
    except asyncio.TimeoutError:
        trace["wall_clock_timeout"] = True
        events = await fetch_task_events(AGENT_CORE, task_id, admin_headers)
        trace["task_events"] = events
        await _run_cleanup(probe, run_id, token, admin_headers, trace)
        _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
        return TrialResult(
            probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
            outcome=Outcome.AUDIT_INFRA_TIMEOUT,
            latency_ms=int((time.monotonic() - start) * 1000),
            error_msg=f"wall-clock {deadline}s exceeded",
            trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
            cleanup_failed=False, run_id=run_id,
        )

    events = await fetch_task_events(AGENT_CORE, task_id, admin_headers)
    trace["task_events"] = events
    outcome = derive_outcome(events, expected_tool=probe.tool)

    verifier_failed_reason = None
    if outcome == Outcome.CALLED_OK and probe.verifier is not Verifier.SKIP:
        v = _instantiate_verifier(probe.verifier, run_id, token)
        ctx = {
            "final_response": (final or {}).get("text", ""),
            "admin_headers": admin_headers,
        }
        v_ok, v_reason = await v.verify(ctx)
        trace["verifier_result"] = {"ok": v_ok, "reason": v_reason}
        if v_ok:
            outcome = Outcome.SIDE_EFFECT_VERIFIED
        else:
            verifier_failed_reason = v_reason

    cleanup_failed = not await _run_cleanup(probe, run_id, token, admin_headers, trace)

    _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
    return TrialResult(
        probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
        outcome=outcome,
        latency_ms=int((time.monotonic() - start) * 1000),
        error_msg=None,
        trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
        cleanup_failed=cleanup_failed, run_id=run_id,
        verifier_failed_reason=verifier_failed_reason,
    )


def _instantiate_verifier(verifier: Any, run_id: str, token: str) -> Any:
    """Substitute {run_id}/{token} placeholders in any string fields of a verifier/setup/cleanup dataclass.
    Works for Verifier, Setup, Cleanup objects — they share the same shape (frozen dataclass with str/dict fields).
    """
    if verifier is Verifier.SKIP or verifier is Setup.NONE or verifier is Cleanup.NONE or verifier is None:
        return verifier
    from dataclasses import fields, replace
    new_fields = {}
    for f in fields(verifier):
        val = getattr(verifier, f.name)
        if isinstance(val, str):
            new_fields[f.name] = val.format(run_id=run_id, token=token)
        elif isinstance(val, dict):
            new_fields[f.name] = {k: (v.format(run_id=run_id, token=token) if isinstance(v, str) else v) for k, v in val.items()}
        else:
            new_fields[f.name] = val
    return replace(verifier, **new_fields)


async def _run_cleanup(probe: Probe, run_id: str, token: str, admin_headers: dict, trace: dict) -> bool:
    if probe.cleanup is None or probe.cleanup is Cleanup.NONE:
        return True
    c = _instantiate_verifier(probe.cleanup, run_id, token)
    try:
        ok, reason = await c.cleanup({"admin_headers": admin_headers})
        trace["cleanup_result"] = {"ok": ok, "reason": reason}
        return ok
    except Exception as e:
        trace["cleanup_result"] = {"ok": False, "reason": str(e)}
        return False


def _trace_path(trace_dir: Path, probe_id: str, model_id: str, trial_n: int) -> str:
    safe_model = model_id.replace("/", "_")
    return str(trace_dir / f"{probe_id}__{safe_model}__t{trial_n}.json")


def _save_trace(trace_dir: Path, probe_id: str, model_id: str, trial_n: int, trace: dict) -> None:
    trace_dir.mkdir(parents=True, exist_ok=True)
    Path(_trace_path(trace_dir, probe_id, model_id, trial_n)).write_text(
        json.dumps(trace, default=str, indent=2)
    )


def _infra_failure(probe: Probe, model: dict, trial_n: int, run_id: str, trace_dir: Path, trace: dict, msg: str) -> TrialResult:
    _save_trace(trace_dir, probe.id, model["model_id"], trial_n, trace)
    return TrialResult(
        probe_id=probe.id, tool=probe.tool, model=model["model_id"], trial_n=trial_n,
        outcome=Outcome.AUDIT_INFRA_TIMEOUT, latency_ms=0, error_msg=msg,
        trace_path=_trace_path(trace_dir, probe.id, model["model_id"], trial_n),
        cleanup_failed=False, run_id=run_id,
    )
