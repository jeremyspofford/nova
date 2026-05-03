"""Maintain drive — keep Nova healthy.

Urgency is based on:
- Service health check results
- health.degraded stimulus events

Side-effects:
- Triages newly-created goals (goal.created stimuli) and routes complex
  goals into the maturation pipeline by setting maturation_status='scoping'.
  Triage is dispatched as a background task so the LLM call (up to 30s)
  doesn't gate the drive cycle.
- Walks the per-tenant capability_audit hash chain via
  POST /api/v1/capabilities/audit/verify-chain on the orchestrator. Runs:
    * nightly between 02:00–04:59 UTC (low-traffic window), OR
    * on-demand when a `security.verify_chain` stimulus is observed.
  Any broken chain is logged at ERROR and re-emitted as a
  `security.audit_chain_broken` stimulus (see T2-03).
- Pings every active/verified GitHub webhook via
  POST /api/v1/capabilities/webhooks/ping-all on the orchestrator. Runs on
  the same schedule as the chain check (nightly 02:00–04:59 UTC OR on a
  `security.verify_chain` stimulus). Each failed ping is re-emitted as a
  `github.webhook_failed` stimulus carrying {hook_id, repo, status_code}
  (see T2-04).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from ..clients import get_llm, get_memory, get_orchestrator
from ..config import settings
from ..db import get_pool
from ..maturation.triage import triage_goal_complexity
from ..stimulus import GOAL_CREATED, emit
from . import DriveContext, DriveResult

log = logging.getLogger(__name__)

SERVICES = [
    ("orchestrator", get_orchestrator),
    ("llm_gateway", get_llm),
    ("memory_service", get_memory),
]

# Stimulus types this drive listens for and emits. Defined here (not in
# stimulus.py) because they're scoped to the maintain drive's nightly
# audit-chain check + webhook health sweep.
SECURITY_VERIFY_CHAIN = "security.verify_chain"
SECURITY_AUDIT_CHAIN_BROKEN = "security.audit_chain_broken"
GITHUB_WEBHOOK_FAILED = "github.webhook_failed"

# Module-level latch so we run the nightly chain check at most once per
# UTC date during the 02:00–04:59 window. Stimulus-triggered runs bypass
# this latch.
_last_chain_check_date: str | None = None

# Same latch concept for the webhook health sweep. Separate so the two
# nightly jobs don't clobber each other if one runs before the other.
_last_webhook_ping_date: str | None = None


# Module-level dedupe — prevents duplicate in-flight triages when the same
# goal_id stimulus is observed across overlapping cycles.
_inflight_triages: set[str] = set()


async def _triage_one(goal_id: str) -> None:
    """Triage a single goal in the background. Safe to fire-and-forget."""
    if goal_id in _inflight_triages:
        return
    _inflight_triages.add(goal_id)
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT title, description, maturation_status FROM goals WHERE id = $1::uuid",
                goal_id,
            )
            if not row:
                log.debug("Triage: goal %s not found", goal_id)
                return
            if row["maturation_status"] is not None:
                # Already triaged or in a phase — skip
                return
            verdict = await triage_goal_complexity(row["title"], row["description"])
            # `scoping` is the first active phase. Simple goals stay at NULL
            # maturation_status (legacy fast path).
            new_status = "scoping" if verdict == "complex" else None
            if new_status:
                await conn.execute(
                    "UPDATE goals SET maturation_status = $1, complexity = $2, updated_at = NOW() "
                    "WHERE id = $3::uuid",
                    new_status, verdict, goal_id,
                )
                log.info("Triage: goal %s classified %s → maturation=%s",
                         goal_id, verdict, new_status)
            else:
                await conn.execute(
                    "UPDATE goals SET complexity = $1, updated_at = NOW() WHERE id = $2::uuid",
                    verdict, goal_id,
                )
                log.info("Triage: goal %s classified %s (no maturation)", goal_id, verdict)
    except Exception as e:
        log.warning("Triage failed for goal %s: %s", goal_id, e)
    finally:
        _inflight_triages.discard(goal_id)


def _dispatch_triage(ctx: DriveContext) -> None:
    """Spawn background triage tasks for any goal.created stimuli.

    Returns immediately — the actual LLM call runs in a detached task so it
    never blocks the drive evaluate() cadence.
    """
    for stim in ctx.stimuli_of_type(GOAL_CREATED):
        payload = stim.get("payload") or {}
        goal_id = payload.get("goal_id")
        if not goal_id:
            continue
        # Don't await — run triage in the background.
        asyncio.create_task(_triage_one(goal_id))


async def _run_verify_chain(ctx: DriveContext | None = None) -> dict:
    """Walk every tenant's capability_audit chain via the orchestrator HTTP
    endpoint and emit a `security.audit_chain_broken` stimulus for any
    tenant whose chain is invalid.

    Returns ``{"checked": n_tenants, "broken": n_broken}``. Logs ERROR for
    each broken tenant. Errors during the call itself (orchestrator down,
    auth failure, etc.) are logged and surfaced as ``status="error"`` —
    they never raise so the drive cycle can keep going.

    Stays out of the orchestrator's audit module by design: cortex talks to
    the audit data ONLY via HTTP. This preserves service boundaries even
    though both services share the same Postgres instance.
    """
    orch = get_orchestrator()
    try:
        resp = await orch.post(
            "/api/v1/capabilities/audit/verify-chain",
            headers={"X-Admin-Secret": settings.admin_secret},
            timeout=30.0,
        )
    except Exception as e:
        log.warning("verify_chain HTTP call failed: %s", e)
        return {"status": "error", "error": str(e), "checked": 0, "broken": 0}

    if resp.status_code != 200:
        log.warning(
            "verify_chain endpoint returned %d: %s",
            resp.status_code, resp.text[:200],
        )
        return {
            "status": "error",
            "http_status": resp.status_code,
            "checked": 0,
            "broken": 0,
        }

    body = resp.json()
    tenants = body.get("tenants") or []
    broken_tenants: list[dict] = []

    for t in tenants:
        if t.get("is_valid"):
            continue
        tenant_id = str(t.get("tenant_id"))
        broken_at = t.get("broken_at")
        log.error(
            "audit_chain_broken: tenant_id=%s broken_at=%s row_count=%s",
            tenant_id, broken_at, t.get("row_count"),
        )
        broken_tenants.append({
            "tenant_id": tenant_id,
            "broken_at_id": broken_at,
            "row_count": t.get("row_count"),
        })
        # Emit a stimulus so any subscriber (dashboard alert, downstream
        # security drive) can react. emit() is fire-and-forget; failures
        # are swallowed so a broken Redis can't mask the ERROR log above.
        await emit(
            SECURITY_AUDIT_CHAIN_BROKEN,
            source="cortex.maintain",
            payload={
                "tenant_id": tenant_id,
                "broken_at_id": broken_at,
            },
            priority=2,
        )

    log.info(
        "verify_chain swept %d tenants; %d broken",
        len(tenants), len(broken_tenants),
    )
    return {
        "status": "ok",
        "checked": len(tenants),
        "broken": len(broken_tenants),
        "broken_tenants": broken_tenants,
    }


def _should_run_chain_check(ctx: DriveContext | None) -> bool:
    """Decide whether `_run_verify_chain` should fire this cycle.

    Two trigger paths:
      * Nightly window (02:00–04:59 UTC) — at most once per UTC date.
        Latched via _last_chain_check_date so cortex's drive cadence
        doesn't hammer the DB across the full 3-hour window.
      * `security.verify_chain` stimulus in ctx — bypasses the latch and
        the time-gate. Lets ops (and tests) trigger an on-demand check.
    """
    global _last_chain_check_date
    if ctx and ctx.stimuli_of_type(SECURITY_VERIFY_CHAIN):
        return True

    now = datetime.now(timezone.utc)
    if 2 <= now.hour <= 4:
        today = now.date().isoformat()
        if _last_chain_check_date != today:
            _last_chain_check_date = today
            return True

    return False


async def _ping_webhooks(
    ctx: DriveContext | None = None,
    *,
    api_base: str | None = None,
) -> dict:
    """Sweep every active/verified github_webhooks row via the orchestrator
    and emit a ``github.webhook_failed`` stimulus for each failed entry.

    Returns the orchestrator response augmented with ``status``:
      ``{"status": "ok"|"error", "pinged": n, "failed": [...]}``.

    ``api_base`` is an admin-only test seam — production callers omit it and
    let the orchestrator default to ``settings.github_api_base_url``. Tests
    point it at fake-github (host.docker.internal:{port}).

    Mirrors ``_run_verify_chain`` style: errors during the HTTP call itself
    are logged WARNING and surfaced as ``status="error"`` — they never raise
    so the drive cycle keeps going.
    """
    orch = get_orchestrator()
    try:
        resp = await orch.post(
            "/api/v1/capabilities/webhooks/ping-all",
            headers={"X-Admin-Secret": settings.admin_secret},
            params={"api_base": api_base} if api_base else None,
            timeout=60.0,
        )
    except Exception as e:
        log.warning("ping_webhooks HTTP call failed: %s", e)
        return {"status": "error", "error": str(e), "pinged": 0, "failed": []}

    if resp.status_code != 200:
        log.warning(
            "ping_webhooks endpoint returned %d: %s",
            resp.status_code, resp.text[:200],
        )
        return {
            "status": "error",
            "http_status": resp.status_code,
            "pinged": 0,
            "failed": [],
        }

    body = resp.json()
    failed = body.get("failed") or []
    pinged = int(body.get("pinged") or 0)

    for entry in failed:
        hook_id = entry.get("hook_id")
        repo = entry.get("repo")
        status_code = entry.get("status_code")
        message = entry.get("message")
        log.error(
            "webhook_failed: hook_id=%s repo=%s status_code=%s message=%s",
            hook_id, repo, status_code, message,
        )
        # Fire-and-forget stimulus so any subscriber (dashboard banner,
        # downstream re-bootstrap drive) can react. emit() swallows Redis
        # failures so a broken queue can't mask the ERROR log above.
        await emit(
            GITHUB_WEBHOOK_FAILED,
            source="cortex.maintain",
            payload={
                "hook_id": hook_id,
                "repo": repo,
                "status_code": status_code,
                "message": message,
            },
            priority=2,
        )

    log.info(
        "ping_webhooks swept %d webhooks; %d failed", pinged, len(failed)
    )
    return {
        "status": "ok",
        "pinged": pinged,
        "failed": failed,
    }


def _should_run_webhook_ping(ctx: DriveContext | None) -> bool:
    """Decide whether ``_ping_webhooks`` should fire this cycle.

    Same trigger semantics as ``_should_run_chain_check`` (nightly 02–04 UTC
    window OR on-demand via ``security.verify_chain`` stimulus). The two
    drives intentionally share a stimulus type because both are "audit your
    capability surface tonight" jobs and there's no reason to cycle them
    independently. They use separate latches so a failure in one doesn't
    skip the other.
    """
    global _last_webhook_ping_date
    if ctx and ctx.stimuli_of_type(SECURITY_VERIFY_CHAIN):
        return True

    now = datetime.now(timezone.utc)
    if 2 <= now.hour <= 4:
        today = now.date().isoformat()
        if _last_webhook_ping_date != today:
            _last_webhook_ping_date = today
            return True

    return False


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """Assess maintain drive urgency based on service health and stimuli."""
    # Side-effect: dispatch background triage for newly-created goals.
    # Non-blocking — the LLM call runs detached so it can't gate the cycle.
    if ctx:
        _dispatch_triage(ctx)

    # Side-effect: nightly (or stimulus-driven) audit-chain verification.
    # Detached so the HTTP call can't gate the drive cadence. Internal
    # exceptions are swallowed inside _run_verify_chain.
    if _should_run_chain_check(ctx):
        log.info("Triggering verify_chain (stimulus or nightly window)")
        asyncio.create_task(_run_verify_chain(ctx))

    # Side-effect: nightly (or stimulus-driven) webhook health sweep.
    # Same detach-and-fire pattern; production callers don't pass api_base
    # so the orchestrator uses its configured GitHub base URL.
    if _should_run_webhook_ping(ctx):
        log.info("Triggering ping_webhooks (stimulus or nightly window)")
        asyncio.create_task(_ping_webhooks(ctx))

    checks: dict[str, str] = {}

    for name, get_client in SERVICES:
        try:
            client = get_client()
            resp = await client.get("/health/live", timeout=5.0)
            checks[name] = "ok" if resp.status_code == 200 else f"http_{resp.status_code}"
        except Exception as e:
            checks[name] = f"error: {type(e).__name__}"

    degraded = [name for name, status in checks.items() if status != "ok"]
    urgency = 0.0

    if degraded:
        urgency = min(1.0, len(degraded) / len(SERVICES) + 0.3)

    # Stimulus boost (before early return so external signals aren't missed)
    if ctx and ctx.stimuli_of_type("health.degraded"):
        urgency = max(urgency, 0.7)

    if urgency == 0.0:
        return DriveResult(
            name="maintain", priority=2, urgency=0.0,
            description="All services healthy",
            context={"checks": checks},
        )

    return DriveResult(
        name="maintain",
        priority=2,
        urgency=round(urgency, 2),
        description=f"Degraded: {', '.join(degraded)}" if degraded else "External health alert",
        proposed_action=f"Investigate {degraded[0]} health issue" if degraded else "Check health alert",
        context={"checks": checks, "degraded": degraded},
    )
