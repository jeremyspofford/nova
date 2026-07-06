"""Capability credentials CRUD endpoints."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Literal
from uuid import UUID

import asyncpg
import httpx
from app.capabilities import audit, audit_query
from app.capabilities import consent as consent_db
from app.capabilities import consent_rules as cr_db
from app.capabilities import credentials as cred_db
from app.capabilities import watched_repos as wr_db
from app.capabilities.consent import ApprovalDecision
from app.capabilities.context import CapabilityCtxDep
from app.capabilities.models import (
    ConsentRule,
    ConsentRuleCreate,
    ConsentRuleUpdate,
    Credential,
    CredentialCreate,
    CredentialHealth,
    WatchedRepo,
    WatchedRepoCreate,
    WatchedRepoUpdate,
)
from app.db import get_pool
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


def _actor_for(ctx) -> str:
    """Audit actor string — admin for admin/trusted-network, user UUID for JWT."""
    return "admin" if ctx.is_admin else str(ctx.user_id)


class CredentialTestRequest(BaseModel):
    api_base: str | None = None  # admin-only override for tests pointing at fake-github


class CredentialTestResult(BaseModel):
    health: CredentialHealth


@router.post("/credentials", response_model=Credential, status_code=status.HTTP_201_CREATED)
async def create_credential(
    payload: CredentialCreate,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    return await cred_db.create_credential(
        pool,
        tenant_id=ctx.tenant_id,
        user_id=ctx.user_id,
        payload=payload,
        actor=_actor_for(ctx),
    )


@router.get("/credentials", response_model=list[Credential])
async def list_credentials(
    ctx: CapabilityCtxDep,
    provider_kind: str | None = Query(None),
):
    pool = get_pool()
    return await cred_db.list_credentials(
        pool, tenant_id=ctx.tenant_id, provider_kind=provider_kind
    )


@router.get("/credentials/{cred_id}", response_model=Credential)
async def get_credential(
    cred_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    cred = await cred_db.get_credential(
        pool, tenant_id=ctx.tenant_id, cred_id=cred_id, actor=_actor_for(ctx)
    )
    if not cred:
        raise HTTPException(404, "credential not found")
    return cred


@router.delete("/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    deleted = await cred_db.delete_credential(
        pool, tenant_id=ctx.tenant_id, cred_id=cred_id, actor=_actor_for(ctx)
    )
    if not deleted:
        raise HTTPException(404, "credential not found")


@router.get("/approvals", response_model=list[dict])
async def list_pending_approvals(
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    rows = await consent_db.list_pending(pool, tenant_id=ctx.tenant_id)
    return [dict(r) for r in rows]  # asyncpg Record → dict


@router.get("/approvals/{approval_id}", response_model=dict)
async def get_approval(
    approval_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    row = await consent_db.get_approval(pool, tenant_id=ctx.tenant_id, approval_id=approval_id)
    if not row:
        raise HTTPException(404, "approval not found")
    return dict(row)


class ApprovalDecisionRequest(BaseModel):
    decision: Literal["approve", "reject"]
    remember: bool = False
    rule_scope: dict | None = None
    # Operator's free-text reply — injected into a parked task as the
    # request_human_checkpoint tool result (kind='checkpoint' rows).
    response_text: str | None = None


@router.post("/approvals/{approval_id}/decide")
async def decide_approval(
    approval_id: UUID,
    payload: ApprovalDecisionRequest,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    decision = ApprovalDecision(
        decision=payload.decision,
        decided_by=_actor_for(ctx),
        decided_via="dashboard",
        remember=payload.remember,
        rule_scope=payload.rule_scope,
        response_text=payload.response_text,
    )
    ok = await consent_db.decide_approval(
        pool, tenant_id=ctx.tenant_id,
        approval_id=approval_id, decision=decision,
    )
    if not ok:
        raise HTTPException(409, "approval not pending or not found")
    return {"status": "ok"}


@router.post("/credentials/{cred_id}/test", response_model=CredentialTestResult)
async def test_credential(
    cred_id: UUID,
    ctx: CapabilityCtxDep,
    payload: CredentialTestRequest | None = None,
):
    """Validate a credential against its provider identity endpoint.

    api_base in the request body is an admin-only override for test environments
    pointing at a fake-github boundary fake. Production callers should not pass api_base.
    """
    pool = get_pool()
    api_base = payload.api_base if payload else None
    health = await cred_db.validate_credential(
        pool,
        tenant_id=ctx.tenant_id,
        cred_id=cred_id,
        actor=_actor_for(ctx),
        api_base=api_base,
    )
    return CredentialTestResult(health=health)


# ── Watched repos ────────────────────────────────────────────────────────────
# Per-repo CI triage configuration. A credential can watch multiple repos with
# different rules (trigger mode, polling interval, daily budget, active hours).
# Consumed by cortex.app.drives.ci_triage and orchestrator.app.polling_worker.


@router.get(
    "/credentials/{cred_id}/watched-repos",
    response_model=list[WatchedRepo],
)
async def list_credential_watched_repos(
    cred_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    return await wr_db.list_watched_repos(
        pool, tenant_id=ctx.tenant_id, credential_id=cred_id,
    )


@router.post(
    "/credentials/{cred_id}/watched-repos",
    response_model=WatchedRepo,
    status_code=status.HTTP_201_CREATED,
)
async def create_credential_watched_repo(
    cred_id: UUID,
    payload: WatchedRepoCreate,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    cred = await cred_db.get_credential(
        pool, tenant_id=ctx.tenant_id, cred_id=cred_id, actor=_actor_for(ctx),
    )
    if not cred:
        raise HTTPException(404, "credential not found")
    try:
        return await wr_db.create_watched_repo(
            pool,
            tenant_id=ctx.tenant_id,
            user_id=ctx.user_id,
            credential_id=cred_id,
            payload=payload,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "repo already watched for this tenant")


@router.patch("/watched-repos/{repo_id}", response_model=WatchedRepo)
async def update_watched_repo_endpoint(
    repo_id: UUID,
    payload: WatchedRepoUpdate,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    updated = await wr_db.update_watched_repo(
        pool, tenant_id=ctx.tenant_id, repo_id=repo_id, payload=payload,
    )
    if not updated:
        raise HTTPException(404, "watched repo not found")
    return updated


@router.delete(
    "/watched-repos/{repo_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_watched_repo_endpoint(
    repo_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    deleted = await wr_db.delete_watched_repo(
        pool, tenant_id=ctx.tenant_id, repo_id=repo_id,
    )
    if not deleted:
        raise HTTPException(404, "watched repo not found")


# ── Consent rules ────────────────────────────────────────────────────────────
# Auto-approve policies. Distinct from /approvals (per-call queue) — these are
# the saved rules that auto-approve future MUTATE/DESTRUCT calls without
# prompting. Created either by the user clicking "approve and remember" or
# proposed by cortex.


@router.get("/consent-rules", response_model=list[ConsentRule])
async def list_consent_rules_endpoint(
    ctx: CapabilityCtxDep,
    tool_name: str | None = Query(None),
    provider_kind: str | None = Query(None),
):
    pool = get_pool()
    return await cr_db.list_consent_rules(
        pool, tenant_id=ctx.tenant_id,
        tool_name=tool_name, provider_kind=provider_kind,
    )


@router.post(
    "/consent-rules",
    response_model=ConsentRule,
    status_code=status.HTTP_201_CREATED,
)
async def create_consent_rule_endpoint(
    payload: ConsentRuleCreate,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    return await cr_db.create_consent_rule(
        pool, tenant_id=ctx.tenant_id, user_id=ctx.user_id, payload=payload,
    )


@router.patch("/consent-rules/{rule_id}", response_model=ConsentRule)
async def update_consent_rule_endpoint(
    rule_id: UUID,
    payload: ConsentRuleUpdate,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    updated = await cr_db.update_consent_rule(
        pool, tenant_id=ctx.tenant_id, rule_id=rule_id, payload=payload,
    )
    if not updated:
        raise HTTPException(404, "consent rule not found")
    return updated


@router.delete(
    "/consent-rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_consent_rule_endpoint(
    rule_id: UUID,
    ctx: CapabilityCtxDep,
):
    pool = get_pool()
    deleted = await cr_db.delete_consent_rule(
        pool, tenant_id=ctx.tenant_id, rule_id=rule_id,
    )
    if not deleted:
        raise HTTPException(404, "consent rule not found")


# ── Audit log query ──────────────────────────────────────────────────────────
# Read-only. Writes flow through audit.write_audit_event; updates/deletes are
# blocked by the append-only RULE in migration 069. This endpoint only feeds
# the dashboard's audit log viewer with filterable, paginated rows.


@router.get("/audit", response_model=list[dict])
async def query_audit_endpoint(
    ctx: CapabilityCtxDep,
    from_ts: datetime | None = Query(None),
    to_ts: datetime | None = Query(None),
    actor_id: str | None = Query(None),
    actor_kind: str | None = Query(None),
    event_type: str | None = Query(None),
    tool_name: str | None = Query(None),
    tool_kind: str | None = Query(None),
    target: str | None = Query(None),
    blast_radius: str | None = Query(None),
    provider_kind: str | None = Query(None),
    credential_id: UUID | None = Query(None),
    task_id: UUID | None = Query(None),
    response_status: str | None = Query(None),
    limit: int = Query(50, ge=1, le=audit_query.MAX_LIMIT),
    offset: int = Query(0, ge=0),
):
    pool = get_pool()
    return await audit_query.query_audit(
        pool,
        tenant_id=ctx.tenant_id,
        from_ts=from_ts, to_ts=to_ts,
        actor_id=actor_id, actor_kind=actor_kind,
        event_type=event_type,
        tool_name=tool_name, tool_kind=tool_kind,
        target=target,
        blast_radius=blast_radius,
        provider_kind=provider_kind,
        credential_id=credential_id, task_id=task_id,
        response_status=response_status,
        limit=limit, offset=offset,
    )


@router.get("/audit/count")
async def count_audit_endpoint(
    ctx: CapabilityCtxDep,
    from_ts: datetime | None = Query(None),
    to_ts: datetime | None = Query(None),
):
    pool = get_pool()
    n = await audit_query.count_audit(
        pool, tenant_id=ctx.tenant_id,
        from_ts=from_ts, to_ts=to_ts,
    )
    return {"count": n}


# ── Audit chain verification (T2-03) ────────────────────────────────────────
# Admin-only. Walks each tenant's hash chain in `capability_audit` and reports
# per-tenant validity. Used by cortex's maintain drive (HTTP, not direct
# Python import) to surface tamper events as `security.audit_chain_broken`
# stimuli. See docs/work/2026-05-03-v1/T2-03-verify-chain-in-maintain-drive.md.


@router.post("/audit/verify-chain")
async def verify_audit_chain_all_tenants(
    ctx: CapabilityCtxDep,
):
    """Walk every tenant's audit chain and return per-tenant ChainResult.

    Admin-only. Cortex's maintain drive calls this nightly (or on-demand via
    a `security.verify_chain` stimulus) and emits a
    `security.audit_chain_broken` stimulus for any tenant whose chain is
    invalid.
    """
    if not ctx.is_admin:
        raise HTTPException(status_code=403, detail="admin required")

    pool = get_pool()
    async with pool.acquire() as conn:
        tenant_rows = await conn.fetch(
            "SELECT DISTINCT tenant_id FROM capability_audit ORDER BY tenant_id"
        )

    results: list[dict] = []
    for tr in tenant_rows:
        tenant_id = tr["tenant_id"]
        chain = await audit.verify_chain(pool, tenant_id=tenant_id)
        results.append({
            "tenant_id": str(tenant_id),
            "is_valid": chain.is_valid,
            "row_count": chain.row_count,
            "broken_at": str(chain.broken_at) if chain.broken_at else None,
        })

    return {"tenants": results}


# ── Webhook health ping (T2-04) ─────────────────────────────────────────────
# Admin-only. Pings every active/verified github_webhooks row at GitHub's
# `POST /repos/{owner}/{repo}/hooks/{hook_id}/pings`. Real GitHub returns 204
# on success. Anything else (404 hook deleted, 401/403 token revoked or
# missing admin:repo_hook scope) flips the row to status='failed' and
# surfaces in the response so cortex can emit a `github.webhook_failed`
# stimulus per failed hook. State machine is one-way: failed→verified is
# NOT allowed via ping (re-verification goes through the consent gate per
# T1-02).


@router.post("/webhooks/ping-all")
async def ping_all_webhooks(
    ctx: CapabilityCtxDep,
    api_base: str | None = Query(
        None,
        description="Admin-only override for tests pointing at fake-github. "
                    "Production callers must omit; uses settings.github_api_base_url.",
    ),
):
    """Ping every active/verified webhook to detect silent failures.

    Iterates ``github_webhooks`` rows with status IN ('active','verified'),
    decrypts each credential, and POSTs to the GitHub pings endpoint.

    * 204 → mark ``last_pinged_at = now()``, status unchanged.
    * 404 (hook not found / deleted) → status='failed'.
    * 401 / 403 (token revoked or missing ``admin:repo_hook`` scope) →
      status='failed'. The 403 case is surfaced as ``message='scope_missing'``
      so the user knows to fix the PAT scope.
    * Any other non-204 → status='failed'.

    Returns ``{"pinged": n_attempted, "failed": [{hook_id, repo, status_code, message?}, …]}``.
    """
    if not ctx.is_admin:
        raise HTTPException(status_code=403, detail="admin required")

    from app.config import settings as _settings
    base = (api_base or _settings.github_api_base_url).rstrip("/")

    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, tenant_id, credential_id, repo, hook_id, status "
            "FROM github_webhooks "
            "WHERE status IN ('active','verified')"
        )

    failed: list[dict] = []
    pinged = 0

    async with httpx.AsyncClient(timeout=15) as client:
        for row in rows:
            pinged += 1
            row_id = row["id"]
            tenant_id = row["tenant_id"]
            credential_id = row["credential_id"]
            repo = row["repo"]
            hook_id = row["hook_id"]

            secret = await cred_db.get_secret(
                pool, tenant_id=tenant_id, cred_id=credential_id, actor="cortex.maintain",
            )
            if not secret:
                # Credential disappeared — flip to failed. We can't ping
                # without a token; the hook is effectively orphaned.
                await _mark_webhook_failed(pool, row_id)
                failed.append({
                    "hook_id": hook_id,
                    "repo": repo,
                    "status_code": 0,
                    "message": "credential_missing",
                })
                continue

            try:
                resp = await client.post(
                    f"{base}/repos/{repo}/hooks/{hook_id}/pings",
                    headers={
                        "Authorization": f"token {secret}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                )
            except httpx.HTTPError as exc:
                logger.warning(
                    "ping for hook_id=%s repo=%s raised %s; marking failed",
                    hook_id, repo, type(exc).__name__,
                )
                await _mark_webhook_failed(pool, row_id)
                failed.append({
                    "hook_id": hook_id,
                    "repo": repo,
                    "status_code": 0,
                    "message": f"http_error:{type(exc).__name__}",
                })
                continue

            if resp.status_code == 204:
                # Healthy. Bump last_pinged_at; do NOT touch status (one-way
                # state machine: ping cannot promote failed→verified).
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE github_webhooks SET last_pinged_at=now() WHERE id=$1",
                        row_id,
                    )
                continue

            # Non-204: mark failed. Surface 403 with message='scope_missing'
            # so the user can fix their PAT (real GitHub requires
            # admin:repo_hook scope to ping).
            entry: dict = {
                "hook_id": hook_id,
                "repo": repo,
                "status_code": resp.status_code,
            }
            if resp.status_code == 403:
                entry["message"] = "scope_missing"
            elif resp.status_code == 401:
                entry["message"] = "auth_failure"
            elif resp.status_code == 404:
                entry["message"] = "hook_not_found"
            await _mark_webhook_failed(pool, row_id)
            failed.append(entry)

    return {"pinged": pinged, "failed": failed}


async def _mark_webhook_failed(pool: asyncpg.Pool, row_id) -> None:
    """Helper: flip status='failed' and set last_pinged_at=now() on a webhook
    row. Always-allowed transition (verified→failed, active→failed). The
    inverse failed→verified is intentionally NOT performed by this code path
    — re-verification requires re-registration through the consent gate.
    """
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE github_webhooks SET status='failed', last_pinged_at=now() "
            "WHERE id=$1",
            row_id,
        )
