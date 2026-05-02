"""Capability credentials CRUD endpoints."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

import asyncpg
from app.auth import AdminDep
from datetime import datetime

from app.capabilities import audit_query
from app.capabilities import credentials as cred_db
from app.capabilities import consent as consent_db
from app.capabilities import consent_rules as cr_db
from app.capabilities import watched_repos as wr_db
from app.capabilities.consent import ApprovalDecision
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

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])

# v1 single-tenant: hardcoded; multi-tenant later derives from auth context
DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")
DEFAULT_USER = UUID("00000000-0000-0000-0000-000000000001")


class CredentialTestRequest(BaseModel):
    api_base: str | None = None  # admin-only override for tests pointing at fake-github


class CredentialTestResult(BaseModel):
    health: CredentialHealth


@router.post("/credentials", response_model=Credential, status_code=status.HTTP_201_CREATED)
async def create_credential(
    payload: CredentialCreate,
    _admin: AdminDep,
):
    pool = get_pool()
    return await cred_db.create_credential(
        pool,
        tenant_id=DEFAULT_TENANT,
        user_id=DEFAULT_USER,
        payload=payload,
        actor="admin",
    )


@router.get("/credentials", response_model=list[Credential])
async def list_credentials(
    provider_kind: str | None = Query(None),
    _admin: AdminDep = None,
):
    pool = get_pool()
    return await cred_db.list_credentials(
        pool, tenant_id=DEFAULT_TENANT, provider_kind=provider_kind
    )


@router.get("/credentials/{cred_id}", response_model=Credential)
async def get_credential(
    cred_id: UUID,
    _admin: AdminDep = None,
):
    pool = get_pool()
    cred = await cred_db.get_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin"
    )
    if not cred:
        raise HTTPException(404, "credential not found")
    return cred


@router.delete("/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: UUID,
    _admin: AdminDep = None,
):
    pool = get_pool()
    deleted = await cred_db.delete_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin"
    )
    if not deleted:
        raise HTTPException(404, "credential not found")


@router.get("/approvals", response_model=list[dict])
async def list_pending_approvals(
    _admin: AdminDep = None,
):
    pool = get_pool()
    rows = await consent_db.list_pending(pool, tenant_id=DEFAULT_TENANT)
    return [dict(r) for r in rows]  # asyncpg Record → dict


@router.get("/approvals/{approval_id}", response_model=dict)
async def get_approval(
    approval_id: UUID,
    _admin: AdminDep = None,
):
    pool = get_pool()
    row = await consent_db.get_approval(pool, tenant_id=DEFAULT_TENANT, approval_id=approval_id)
    if not row:
        raise HTTPException(404, "approval not found")
    return dict(row)


class ApprovalDecisionRequest(BaseModel):
    decision: Literal["approve", "reject"]
    remember: bool = False
    rule_scope: dict | None = None


@router.post("/approvals/{approval_id}/decide")
async def decide_approval(
    approval_id: UUID,
    payload: ApprovalDecisionRequest,
    _admin: AdminDep = None,
):
    pool = get_pool()
    decision = ApprovalDecision(
        decision=payload.decision,
        decided_by="admin",
        decided_via="dashboard",
        remember=payload.remember,
        rule_scope=payload.rule_scope,
    )
    ok = await consent_db.decide_approval(
        pool, tenant_id=DEFAULT_TENANT,
        approval_id=approval_id, decision=decision,
    )
    if not ok:
        raise HTTPException(409, "approval not pending or not found")
    return {"status": "ok"}


@router.post("/credentials/{cred_id}/test", response_model=CredentialTestResult)
async def test_credential(
    cred_id: UUID,
    payload: CredentialTestRequest | None = None,
    _admin: AdminDep = None,
):
    """Validate a credential against its provider identity endpoint.

    api_base in the request body is an admin-only override for test environments
    pointing at a fake-github boundary fake. Production callers should not pass api_base.
    """
    pool = get_pool()
    api_base = payload.api_base if payload else None
    health = await cred_db.validate_credential(
        pool,
        tenant_id=DEFAULT_TENANT,
        cred_id=cred_id,
        actor="admin",
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
    _admin: AdminDep = None,
):
    pool = get_pool()
    return await wr_db.list_watched_repos(
        pool, tenant_id=DEFAULT_TENANT, credential_id=cred_id,
    )


@router.post(
    "/credentials/{cred_id}/watched-repos",
    response_model=WatchedRepo,
    status_code=status.HTTP_201_CREATED,
)
async def create_credential_watched_repo(
    cred_id: UUID,
    payload: WatchedRepoCreate,
    _admin: AdminDep = None,
):
    pool = get_pool()
    cred = await cred_db.get_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin",
    )
    if not cred:
        raise HTTPException(404, "credential not found")
    try:
        return await wr_db.create_watched_repo(
            pool,
            tenant_id=DEFAULT_TENANT,
            user_id=DEFAULT_USER,
            credential_id=cred_id,
            payload=payload,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "repo already watched for this tenant")


@router.patch("/watched-repos/{repo_id}", response_model=WatchedRepo)
async def update_watched_repo_endpoint(
    repo_id: UUID,
    payload: WatchedRepoUpdate,
    _admin: AdminDep = None,
):
    pool = get_pool()
    updated = await wr_db.update_watched_repo(
        pool, tenant_id=DEFAULT_TENANT, repo_id=repo_id, payload=payload,
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
    _admin: AdminDep = None,
):
    pool = get_pool()
    deleted = await wr_db.delete_watched_repo(
        pool, tenant_id=DEFAULT_TENANT, repo_id=repo_id,
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
    tool_name: str | None = Query(None),
    provider_kind: str | None = Query(None),
    _admin: AdminDep = None,
):
    pool = get_pool()
    return await cr_db.list_consent_rules(
        pool, tenant_id=DEFAULT_TENANT,
        tool_name=tool_name, provider_kind=provider_kind,
    )


@router.post(
    "/consent-rules",
    response_model=ConsentRule,
    status_code=status.HTTP_201_CREATED,
)
async def create_consent_rule_endpoint(
    payload: ConsentRuleCreate,
    _admin: AdminDep = None,
):
    pool = get_pool()
    return await cr_db.create_consent_rule(
        pool, tenant_id=DEFAULT_TENANT, user_id=DEFAULT_USER, payload=payload,
    )


@router.patch("/consent-rules/{rule_id}", response_model=ConsentRule)
async def update_consent_rule_endpoint(
    rule_id: UUID,
    payload: ConsentRuleUpdate,
    _admin: AdminDep = None,
):
    pool = get_pool()
    updated = await cr_db.update_consent_rule(
        pool, tenant_id=DEFAULT_TENANT, rule_id=rule_id, payload=payload,
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
    _admin: AdminDep = None,
):
    pool = get_pool()
    deleted = await cr_db.delete_consent_rule(
        pool, tenant_id=DEFAULT_TENANT, rule_id=rule_id,
    )
    if not deleted:
        raise HTTPException(404, "consent rule not found")


# ── Audit log query ──────────────────────────────────────────────────────────
# Read-only. Writes flow through audit.write_audit_event; updates/deletes are
# blocked by the append-only RULE in migration 069. This endpoint only feeds
# the dashboard's audit log viewer with filterable, paginated rows.


@router.get("/audit", response_model=list[dict])
async def query_audit_endpoint(
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
    _admin: AdminDep = None,
):
    pool = get_pool()
    return await audit_query.query_audit(
        pool,
        tenant_id=DEFAULT_TENANT,
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
    from_ts: datetime | None = Query(None),
    to_ts: datetime | None = Query(None),
    _admin: AdminDep = None,
):
    pool = get_pool()
    n = await audit_query.count_audit(
        pool, tenant_id=DEFAULT_TENANT,
        from_ts=from_ts, to_ts=to_ts,
    )
    return {"count": n}
