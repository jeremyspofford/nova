from __future__ import annotations
from datetime import datetime
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
