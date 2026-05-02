"""Capability credentials CRUD endpoints."""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from app.auth import AdminDep
from app.capabilities import credentials as cred_db
from app.capabilities import consent as consent_db
from app.capabilities.consent import ApprovalDecision
from app.capabilities.models import Credential, CredentialCreate, CredentialHealth
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
