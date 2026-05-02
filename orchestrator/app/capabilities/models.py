from __future__ import annotations
from datetime import datetime, time
from enum import Enum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class CredentialBackend(str, Enum):
    BUILTIN = "builtin"
    VAULT = "vault"
    ONEPASSWORD = "onepassword"
    BITWARDEN = "bitwarden"


class AuthMethod(str, Enum):
    PAT = "pat"
    GITHUB_APP = "github_app"
    OAUTH = "oauth"


class CredentialHealth(str, Enum):
    HEALTHY = "healthy"
    EXPIRED = "expired"
    REVOKED = "revoked"
    INVALID = "invalid"
    UNKNOWN = "unknown"


class CredentialCreate(BaseModel):
    """Inbound payload to create a credential."""
    provider_kind: str = Field(..., examples=["github", "cloudflare", "aws"])
    auth_method: AuthMethod
    label: str
    secret: str  # raw — never persisted, encrypted before storage
    scopes: dict | None = None
    backend: CredentialBackend = CredentialBackend.BUILTIN
    external_ref: str | None = None  # for non-builtin backends


class Credential(BaseModel):
    """Outbound model — never includes secret."""
    id: UUID
    tenant_id: UUID
    user_id: UUID | None
    provider_kind: str
    auth_method: AuthMethod
    label: str
    backend: CredentialBackend
    scopes: dict | None
    expires_at: datetime | None
    last_validated_at: datetime | None
    health: CredentialHealth
    created_at: datetime


class CredentialAuditEntry(BaseModel):
    id: UUID
    credential_id: UUID
    action: Literal["store", "retrieve", "rotate", "delete", "validate", "use"]
    actor: str
    timestamp: datetime
    success: bool
    detail: str | None


class TriggerMode(str, Enum):
    WEBHOOK_WITH_POLLING_FALLBACK = "webhook_with_polling_fallback"
    WEBHOOK_ONLY = "webhook_only"
    POLLING_ONLY = "polling_only"


class WatchedRepoCreate(BaseModel):
    """Inbound payload — credential_id comes from the URL path."""
    repo: str = Field(..., examples=["owner/repo"], pattern=r"^[\w.-]+/[\w.-]+$")
    trigger_mode: TriggerMode = TriggerMode.WEBHOOK_WITH_POLLING_FALLBACK
    polling_interval_min: int = Field(15, ge=1, le=1440)
    workflow_pattern: str | None = None
    active_hours_start: time | None = None
    active_hours_end: time | None = None
    daily_budget: int = Field(20, ge=1, le=1000)
    enabled: bool = True


class WatchedRepoUpdate(BaseModel):
    """All fields optional. Use exclude_unset semantics — fields not present
    are left untouched; fields explicitly set to None are cleared (for nullable
    columns) or rejected (for non-nullable columns)."""
    trigger_mode: TriggerMode | None = None
    polling_interval_min: int | None = Field(None, ge=1, le=1440)
    workflow_pattern: str | None = None
    active_hours_start: time | None = None
    active_hours_end: time | None = None
    daily_budget: int | None = Field(None, ge=1, le=1000)
    enabled: bool | None = None


class WatchedRepo(BaseModel):
    id: UUID
    tenant_id: UUID
    user_id: UUID | None
    credential_id: UUID
    repo: str
    trigger_mode: TriggerMode
    polling_interval_min: int
    workflow_pattern: str | None
    active_hours_start: time | None
    active_hours_end: time | None
    daily_budget: int
    enabled: bool
    created_at: datetime
