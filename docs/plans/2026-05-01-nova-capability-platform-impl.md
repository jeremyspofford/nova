# Nova Capability Platform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the platform that lets Nova act on third-party systems (vault + consent + audit + blast-radius), prove it end-to-end with autonomous failed-GitHub-Actions triage on watched repos.

**Architecture:** Hybrid platform inside `orchestrator/` with native GitHub provider for v1 and pluggable MCP-server support. Capability platform spine: credential vault (extends existing `BuiltinCredentialProvider`), consent gate at executor boundary with READ/PROPOSE/MUTATE/DESTRUCT tiers, hash-chained per-tenant audit log, blast-radius classifier. Cortex `quality` drive triggers CI triage tasks via webhook (Nova self-bootstraps the hook) or polling fallback. Quartet pipeline runs the triage; consent gate sits in front of every external action.

**Tech Stack:** Python 3.12, FastAPI, asyncpg, async Redis, Pydantic, httpx, cryptography (Fernet, already in use). React 18 + TanStack Query + Tailwind for UI. PostgreSQL 16 (pgvector already installed; not used here). Tests: pytest async, FastAPI TestClient, custom `fake-github` boundary fake.

**Spec reference:** `docs/designs/2026-05-01-nova-capability-platform-design.md` (commits `1e971a6`, `90c9e1c`, `5dd9271`, `bf48e89`).

---

## Build sequence (11 milestones)

| # | Milestone | Ships when |
|---|---|---|
| 1 | Credential vault | Can store/retrieve/validate a GitHub PAT via API and dashboard |
| 2 | Audit log + redactor | Every credential op records a tamper-evident audit row with secrets masked |
| 3 | Consent gate + blast-radius | A MUTATE tool call creates an approval row and waits for one-click approve |
| 4 | GitHub native provider — READ tier | List workflow runs, fetch logs, compare-to-main against fake-github |
| 5 | GitHub provider — PROPOSE tier | Diagnose failures and draft fixes (no external mutation) |
| 6 | GitHub provider — MUTATE tier | Open fix PRs and comments through the consent gate |
| 7 | Webhook self-bootstrap | Adding a watched repo creates the webhook on GitHub via `register_webhook` |
| 8 | Cortex wiring + `ci_triage_agent` pod | End-to-end triage triggered by webhook, opens fix PR |
| 9 | Polling fallback | Singleton-leased poller catches dropped webhooks; budget caps enforced |
| 10 | Dashboard UI | Connected Services + Pending Approvals + CI Triage config + Audit Log panels |
| 11 | Smoke tests + acceptance | 10 v1-done criteria all pass; opt-in real-GitHub suite green |

Each milestone is independently shippable (or independently testable); commit at every passing test.

## File structure

### New files

| Path | Responsibility |
|---|---|
| `orchestrator/app/migrations/0XX_capability_credentials.sql` | `capability_credentials` + `capability_credential_audit` tables |
| `orchestrator/app/migrations/0XX_capability_audit.sql` | `capability_audit` table + append-only RULE constraints |
| `orchestrator/app/migrations/0XX_consent_and_approvals.sql` | `approval_requests` + `consent_rules` tables |
| `orchestrator/app/migrations/0XX_github_webhooks.sql` | `github_webhooks` table |
| `orchestrator/app/capabilities/__init__.py` | Capability platform package marker |
| `orchestrator/app/capabilities/credentials.py` | Credential CRUD, encryption, validation, health |
| `orchestrator/app/capabilities/audit.py` | Audit writer, hash chain, redactor |
| `orchestrator/app/capabilities/consent.py` | Consent gate, classifier, state machine |
| `orchestrator/app/capabilities/blast_radius.py` | Blast-radius enums, classifier heuristics |
| `orchestrator/app/capabilities/executor.py` | Executor boundary — wraps every tool call through consent + audit |
| `orchestrator/app/capabilities/router.py` | FastAPI router for `/api/v1/capabilities/*` endpoints |
| `orchestrator/app/tools/github_external_tools.py` | Native GitHub provider (READ/PROPOSE/MUTATE/SETUP) |
| `orchestrator/app/webhooks_router.py` | `POST /api/v1/webhooks/github` endpoint |
| `orchestrator/app/polling_worker.py` | Redis-leased GitHub polling singleton |
| `tests/fixtures/fake_github/__init__.py` | Test boundary fake — FastAPI app simulating GitHub REST |
| `tests/fixtures/fake_github/scenarios/` | JSON scenario files |
| `tests/test_capability_credentials.py` | Vault tests |
| `tests/test_capability_audit.py` | Audit + hash chain + redaction tests |
| `tests/test_capability_consent.py` | Consent gate tests |
| `tests/test_github_external_tools.py` | Provider tests (against fake-github) |
| `tests/test_capability_e2e.py` | End-to-end CI triage scenarios |
| `tests/test_capability_smoke_real_github.py` | Opt-in real-GitHub smoke tests |
| `dashboard/src/pages/settings/ConnectedServicesSection.tsx` | Connected Services panel |
| `dashboard/src/pages/PendingApprovals.tsx` | Pending approvals panel |
| `dashboard/src/pages/AuditLog.tsx` | Audit log viewer |
| `dashboard/src/components/ApprovalCard.tsx` | Inline approval card component |

### Files to modify

| Path | What changes |
|---|---|
| `nova-contracts/nova_contracts/tools.py` | Extend `ToolDefinition` with `blast_radius`, `reversible`, `rate_limit_per_hour` |
| `orchestrator/app/tools/__init__.py` | Add `github_external` tool group to `_REGISTRY` |
| `orchestrator/app/main.py` | Register capability + webhooks routers in lifespan; start polling worker |
| `orchestrator/app/pipeline/tools/registry.py` | Route every tool dispatch through `capabilities.executor` |
| `cortex/app/drives/quality.py` | Add CI-triage stimulus handling, dedup logic, budget integration |
| `cortex/app/drives/maintain.py` | Add weekly credential validation + webhook health check + audit chain verifier |
| `dashboard/src/pages/Settings.tsx` | Add Connected Services to Connections section |
| `dashboard/src/api.ts` | Add `apiFetch` typed clients for new endpoints |

---

## Cross-cutting conventions

- **Migrations:** Number sequentially after the highest existing (currently 066-ish per CLAUDE.md mention of "66 auto-run SQL migrations"). Use `IF NOT EXISTS` clauses; idempotent.
- **Test naming:** `tests/test_<feature>.py` per existing convention. Test resources prefixed `nova-test-`.
- **Async:** All DB and HTTP work is async (asyncpg, httpx.AsyncClient).
- **Logging:** `logger.warning` for recoverable, `logger.error` for unrecoverable, never log secrets.
- **Redis cleanup:** Every new `get_redis()` consumer adds a `close_redis()` to FastAPI lifespan.
- **Commit policy:** Each task ends with a focused commit. Stage *only the files touched in this task*, never `git add -A`. Push directly to `main` (per `~/.claude/projects/-home-jeremy-workspace-nova/memory/MEMORY.md`).
- **Commit message:** `feat(capability):`, `test(capability):`, etc. Conventional commits.
- **Skills to invoke before writing tests:** `superpowers:test-driven-development` if unsure of TDD discipline.

---

# Milestone 1: Credential Vault

**Ships when:** A GitHub PAT can be added via API, encrypted at rest, validated against fake-github `/user`, listed (masked), retrieved by ID, and deleted — every operation audited.

## Task 1.1: Migration — `capability_credentials` table

**Files:**
- Create: `orchestrator/app/migrations/068_capability_credentials.sql` (adjust number to next available)
- Test: `tests/test_capability_credentials.py`

- [ ] **Step 1: Confirm next migration number**

```bash
ls orchestrator/app/migrations/ | sort -n | tail -3
```

Use the next free integer prefix.

- [ ] **Step 2: Write the migration file**

```sql
-- Capability platform: credentials for third-party systems (GitHub, Cloudflare, AWS, ...)
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §6

CREATE TABLE IF NOT EXISTS capability_credentials (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    user_id           UUID,
    provider_kind     TEXT NOT NULL,
    auth_method       TEXT NOT NULL CHECK (auth_method IN ('pat','github_app','oauth')),
    label             TEXT NOT NULL,
    backend           TEXT NOT NULL DEFAULT 'builtin'
                        CHECK (backend IN ('builtin','vault','onepassword','bitwarden')),
    encrypted_data    BYTEA,
    external_ref      TEXT,
    key_version       INTEGER NOT NULL DEFAULT 1,
    scopes            JSONB,
    expires_at        TIMESTAMPTZ,
    last_validated_at TIMESTAMPTZ,
    health            TEXT NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('healthy','expired','revoked','invalid','unknown')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cap_creds_tenant ON capability_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cap_creds_kind ON capability_credentials(tenant_id, provider_kind);

CREATE TABLE IF NOT EXISTS capability_credential_audit (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id UUID NOT NULL REFERENCES capability_credentials(id) ON DELETE CASCADE,
    tenant_id     UUID NOT NULL,
    action        TEXT NOT NULL CHECK (action IN
                    ('store','retrieve','rotate','delete','validate','use')),
    actor         TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    success       BOOLEAN NOT NULL DEFAULT true,
    detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_cap_cred_audit_cred
    ON capability_credential_audit(credential_id);
```

- [ ] **Step 3: Verify migration applies cleanly**

```bash
docker compose restart orchestrator
docker compose logs orchestrator --tail 50 | grep -E "migration|capability_credentials"
```

Expected: Migration applies, no errors, two new tables created.

- [ ] **Step 4: Verify schema in DB**

```bash
docker compose exec postgres psql -U nova -d nova -c "\d capability_credentials"
```

Expected: Table with all columns shown.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/app/migrations/068_capability_credentials.sql
git commit -m "feat(capability): credentials and credential-audit tables"
```

## Task 1.2: Pydantic models for credentials

**Files:**
- Create: `orchestrator/app/capabilities/__init__.py` (empty package marker)
- Create: `orchestrator/app/capabilities/models.py`

- [ ] **Step 1: Create the package marker**

```python
# orchestrator/app/capabilities/__init__.py
"""Capability platform: vault, consent gate, audit, executor for external actions."""
```

- [ ] **Step 2: Create the models**

```python
# orchestrator/app/capabilities/models.py
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
```

- [ ] **Step 3: Smoke import**

```bash
docker compose exec orchestrator python -c "from app.capabilities.models import Credential, CredentialCreate; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/app/capabilities/__init__.py orchestrator/app/capabilities/models.py
git commit -m "feat(capability): pydantic models for credentials"
```

## Task 1.3: Test — credential CRUD roundtrip

**Files:**
- Create: `tests/test_capability_credentials.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_capability_credentials.py
"""Capability credential vault — CRUD roundtrip and audit."""
from __future__ import annotations
import pytest
import httpx

ORCH_URL = "http://localhost:8000"
ADMIN_HEADERS = {"X-Admin-Secret": "testsecret"}  # reads from .env in test env


@pytest.mark.asyncio
async def test_create_and_retrieve_credential():
    async with httpx.AsyncClient(timeout=10) as client:
        # Create
        resp = await client.post(
            f"{ORCH_URL}/api/v1/capabilities/credentials",
            headers=ADMIN_HEADERS,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-pat-1",
                "secret": "ghp_abc12345_test_token",
                "scopes": {"repo": True, "workflow": True},
            },
        )
        assert resp.status_code == 201, resp.text
        cred = resp.json()
        cred_id = cred["id"]
        assert "secret" not in cred  # secret NEVER returned
        assert cred["health"] in ("unknown", "healthy", "invalid")
        assert cred["label"] == "nova-test-pat-1"

        # Retrieve
        resp = await client.get(
            f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["id"] == cred_id
        assert "secret" not in resp.json()

        # Cleanup
        resp = await client.delete(
            f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 204
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/jeremy/workspace/nova && pytest tests/test_capability_credentials.py::test_create_and_retrieve_credential -v
```

Expected: 404 Not Found — endpoint doesn't exist yet.

- [ ] **Step 3: Commit the test**

```bash
git add tests/test_capability_credentials.py
git commit -m "test(capability): credential CRUD roundtrip (failing — wires next)"
```

## Task 1.4: Implement credential vault — DB layer

**Files:**
- Create: `orchestrator/app/capabilities/credentials.py`

- [ ] **Step 1: Implement the credential DB layer**

```python
# orchestrator/app/capabilities/credentials.py
from __future__ import annotations
import logging
from uuid import UUID, uuid4
from typing import Any

import asyncpg
from cryptography.fernet import Fernet

from app.capabilities.models import (
    AuthMethod, Credential, CredentialBackend, CredentialCreate, CredentialHealth,
)
from app.config import settings

logger = logging.getLogger(__name__)


def _fernet() -> Fernet:
    """Build Fernet from the existing platform encryption key."""
    return Fernet(settings.NOVA_FERNET_KEY.encode())


def _encrypt(value: str) -> bytes:
    return _fernet().encrypt(value.encode())


def _decrypt(blob: bytes) -> str:
    return _fernet().decrypt(blob).decode()


async def create_credential(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    payload: CredentialCreate,
    actor: str,
) -> Credential:
    """Insert a credential; encrypt secret if backend=builtin."""
    encrypted = None
    if payload.backend == CredentialBackend.BUILTIN:
        encrypted = _encrypt(payload.secret)

    cred_id = uuid4()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO capability_credentials (
                    id, tenant_id, user_id, provider_kind, auth_method, label,
                    backend, encrypted_data, external_ref, scopes
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                RETURNING *
                """,
                cred_id, tenant_id, user_id, payload.provider_kind,
                payload.auth_method.value, payload.label,
                payload.backend.value, encrypted, payload.external_ref,
                payload.scopes,
            )
            await conn.execute(
                """
                INSERT INTO capability_credential_audit
                  (credential_id, tenant_id, action, actor)
                VALUES ($1, $2, 'store', $3)
                """,
                cred_id, tenant_id, actor,
            )
    return _row_to_model(row)


async def get_credential(
    pool: asyncpg.Pool, *, tenant_id: UUID, cred_id: UUID, actor: str
) -> Credential | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM capability_credentials WHERE id=$1 AND tenant_id=$2",
            cred_id, tenant_id,
        )
        if not row:
            return None
        await conn.execute(
            """
            INSERT INTO capability_credential_audit
              (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'retrieve', $3)
            """,
            cred_id, tenant_id, actor,
        )
    return _row_to_model(row)


async def get_secret(
    pool: asyncpg.Pool, *, tenant_id: UUID, cred_id: UUID, actor: str
) -> str | None:
    """Returns the decrypted secret value; records 'use' audit event.
    Caller is responsible for never logging the return value.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT backend, encrypted_data, external_ref FROM capability_credentials "
            "WHERE id=$1 AND tenant_id=$2", cred_id, tenant_id,
        )
        if not row:
            return None
        await conn.execute(
            """
            INSERT INTO capability_credential_audit
              (credential_id, tenant_id, action, actor)
            VALUES ($1, $2, 'use', $3)
            """,
            cred_id, tenant_id, actor,
        )
    backend = row["backend"]
    if backend == "builtin":
        return _decrypt(row["encrypted_data"]) if row["encrypted_data"] else None
    raise NotImplementedError(f"backend {backend} not implemented in v1")


async def list_credentials(
    pool: asyncpg.Pool, *, tenant_id: UUID, provider_kind: str | None = None
) -> list[Credential]:
    async with pool.acquire() as conn:
        if provider_kind:
            rows = await conn.fetch(
                "SELECT * FROM capability_credentials "
                "WHERE tenant_id=$1 AND provider_kind=$2 ORDER BY created_at DESC",
                tenant_id, provider_kind,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM capability_credentials "
                "WHERE tenant_id=$1 ORDER BY created_at DESC",
                tenant_id,
            )
    return [_row_to_model(r) for r in rows]


async def delete_credential(
    pool: asyncpg.Pool, *, tenant_id: UUID, cred_id: UUID, actor: str
) -> bool:
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO capability_credential_audit
                  (credential_id, tenant_id, action, actor)
                VALUES ($1, $2, 'delete', $3)
                """,
                cred_id, tenant_id, actor,
            )
            result = await conn.execute(
                "DELETE FROM capability_credentials WHERE id=$1 AND tenant_id=$2",
                cred_id, tenant_id,
            )
    return result.endswith(" 1")


def _row_to_model(row: asyncpg.Record) -> Credential:
    return Credential(
        id=row["id"], tenant_id=row["tenant_id"], user_id=row["user_id"],
        provider_kind=row["provider_kind"],
        auth_method=AuthMethod(row["auth_method"]),
        label=row["label"],
        backend=CredentialBackend(row["backend"]),
        scopes=row["scopes"],
        expires_at=row["expires_at"],
        last_validated_at=row["last_validated_at"],
        health=CredentialHealth(row["health"]),
        created_at=row["created_at"],
    )
```

**Note on `NOVA_FERNET_KEY`:** check `orchestrator/app/config.py` for an existing platform encryption key. If one already exists (knowledge service uses one), reuse it. If not, add to `Settings`:

```python
NOVA_FERNET_KEY: str = ""  # generate via: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

And document in `.env.example`.

- [ ] **Step 2: Smoke import**

```bash
docker compose exec orchestrator python -c "from app.capabilities import credentials; print('ok')"
```

- [ ] **Step 3: Commit**

```bash
git add orchestrator/app/capabilities/credentials.py
git commit -m "feat(capability): credential vault DB layer with audit hooks"
```

## Task 1.5: Implement credential router

**Files:**
- Create: `orchestrator/app/capabilities/router.py`
- Modify: `orchestrator/app/main.py`

- [ ] **Step 1: Write the router**

```python
# orchestrator/app/capabilities/router.py
from __future__ import annotations
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth import require_admin
from app.capabilities import credentials as cred_db
from app.capabilities.models import Credential, CredentialCreate
from app.db import get_pool

router = APIRouter(prefix="/api/v1/capabilities", tags=["capabilities"])


# v1 single-tenant: hardcode tenant/user; multi-tenant later derives from auth context
DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")
DEFAULT_USER = UUID("00000000-0000-0000-0000-000000000001")


@router.post("/credentials", response_model=Credential, status_code=status.HTTP_201_CREATED)
async def create_credential(
    payload: CredentialCreate,
    _: None = Depends(require_admin),
    pool=Depends(get_pool),
):
    return await cred_db.create_credential(
        pool,
        tenant_id=DEFAULT_TENANT,
        user_id=DEFAULT_USER,
        payload=payload,
        actor="admin",
    )


@router.get("/credentials", response_model=list[Credential])
async def list_credentials(
    provider_kind: str | None = None,
    _: None = Depends(require_admin),
    pool=Depends(get_pool),
):
    return await cred_db.list_credentials(
        pool, tenant_id=DEFAULT_TENANT, provider_kind=provider_kind
    )


@router.get("/credentials/{cred_id}", response_model=Credential)
async def get_credential(
    cred_id: UUID,
    _: None = Depends(require_admin),
    pool=Depends(get_pool),
):
    cred = await cred_db.get_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin"
    )
    if not cred:
        raise HTTPException(404, "credential not found")
    return cred


@router.delete("/credentials/{cred_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(
    cred_id: UUID,
    _: None = Depends(require_admin),
    pool=Depends(get_pool),
):
    deleted = await cred_db.delete_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin"
    )
    if not deleted:
        raise HTTPException(404, "credential not found")
```

- [ ] **Step 2: Register router in main**

Open `orchestrator/app/main.py`, find the section where routers are registered (search `app.include_router`), and add:

```python
from app.capabilities.router import router as capabilities_router
# ... existing routers ...
app.include_router(capabilities_router)
```

- [ ] **Step 3: Restart orchestrator and run the test**

```bash
docker compose restart orchestrator && sleep 3
pytest tests/test_capability_credentials.py::test_create_and_retrieve_credential -v
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/app/capabilities/router.py orchestrator/app/main.py
git commit -m "feat(capability): credentials router with create/list/get/delete"
```

## Task 1.6: Test — secret never returned via API

**Files:**
- Modify: `tests/test_capability_credentials.py`

- [ ] **Step 1: Add a hardening test**

```python
@pytest.mark.asyncio
async def test_secret_never_returned():
    """Secret value must never appear in any API response, even error responses."""
    async with httpx.AsyncClient(timeout=10) as client:
        secret_value = "ghp_uniquetestsecret_77777777"
        resp = await client.post(
            f"{ORCH_URL}/api/v1/capabilities/credentials",
            headers=ADMIN_HEADERS,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-secret-leak-check",
                "secret": secret_value,
            },
        )
        assert resp.status_code == 201
        cred_id = resp.json()["id"]

        # Hit every endpoint that returns the credential
        list_resp = await client.get(
            f"{ORCH_URL}/api/v1/capabilities/credentials", headers=ADMIN_HEADERS
        )
        get_resp = await client.get(
            f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}",
            headers=ADMIN_HEADERS,
        )

        for r in (list_resp, get_resp):
            assert secret_value not in r.text, f"SECRET LEAKED in {r.url}"

        await client.delete(
            f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}",
            headers=ADMIN_HEADERS,
        )
```

- [ ] **Step 2: Run all credential tests**

```bash
pytest tests/test_capability_credentials.py -v
```

Expected: 2/2 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/test_capability_credentials.py
git commit -m "test(capability): assert secret never leaks via API responses"
```

## Task 1.7: Credential validation against fake-github

This task wires up health-check validation. We need fake-github first — implement a minimal version inline; expand it in Milestone 4.

**Files:**
- Create: `tests/fixtures/fake_github/__init__.py`
- Create: `tests/fixtures/fake_github/server.py`
- Modify: `orchestrator/app/capabilities/credentials.py` — add `validate_credential`
- Modify: `orchestrator/app/capabilities/router.py` — add `POST /credentials/{id}/test`
- Modify: `tests/test_capability_credentials.py`

- [ ] **Step 1: Minimal fake-github**

```python
# tests/fixtures/fake_github/__init__.py
"""Test boundary fake for the GitHub REST API."""
from tests.fixtures.fake_github.server import FakeGitHubServer

__all__ = ["FakeGitHubServer"]
```

```python
# tests/fixtures/fake_github/server.py
from __future__ import annotations
import asyncio
import contextlib
import socket

import uvicorn
from fastapi import FastAPI, Header, HTTPException


def _build_app(scenarios: dict | None = None) -> FastAPI:
    app = FastAPI()
    state = {"scenarios": scenarios or {}}

    @app.get("/user")
    async def get_user(authorization: str = Header(None)):
        if not authorization or not authorization.startswith("Bearer ghp_"):
            raise HTTPException(401, "Bad credentials")
        # Specific test tokens that should return specific outcomes
        token = authorization.removeprefix("Bearer ")
        if token == "ghp_revoked_token":
            raise HTTPException(401, "Bad credentials")
        if token == "ghp_invalid_scope":
            raise HTTPException(403, "Token has insufficient scopes")
        return {"login": "fake-user", "id": 1}

    return app


class FakeGitHubServer:
    """Run a fake GitHub API on a local ephemeral port for tests."""

    def __init__(self, scenarios: dict | None = None):
        self.scenarios = scenarios or {}
        self.port = self._free_port()
        self._task: asyncio.Task | None = None
        self._server: uvicorn.Server | None = None

    @staticmethod
    def _free_port() -> int:
        with contextlib.closing(socket.socket()) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self):
        config = uvicorn.Config(
            _build_app(self.scenarios),
            host="127.0.0.1", port=self.port, log_level="warning",
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        # Wait until startup
        for _ in range(50):
            await asyncio.sleep(0.05)
            if self._server.started:
                return
        raise RuntimeError("fake-github failed to start")

    async def stop(self):
        if self._server:
            self._server.should_exit = True
        if self._task:
            await self._task
```

- [ ] **Step 2: Add `validate_credential` function**

In `orchestrator/app/capabilities/credentials.py`, add:

```python
async def validate_credential(
    pool: asyncpg.Pool, *, tenant_id: UUID, cred_id: UUID, actor: str,
    api_base: str | None = None,  # for tests, override against fake-github
) -> CredentialHealth:
    """Ping the provider's identity endpoint; record health + last_validated_at."""
    cred = await get_credential(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    if not cred:
        return CredentialHealth.UNKNOWN
    secret = await get_secret(pool, tenant_id=tenant_id, cred_id=cred_id, actor=actor)
    if not secret:
        health = CredentialHealth.INVALID
    else:
        if cred.provider_kind == "github":
            base = api_base or "https://api.github.com"
            health = await _validate_github(base, secret)
        else:
            health = CredentialHealth.UNKNOWN

    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE capability_credentials SET health=$1, last_validated_at=now() "
            "WHERE id=$2",
            health.value, cred_id,
        )
        await conn.execute(
            "INSERT INTO capability_credential_audit (credential_id, tenant_id, action, actor, success) "
            "VALUES ($1, $2, 'validate', $3, $4)",
            cred_id, tenant_id, actor, health == CredentialHealth.HEALTHY,
        )
    return health


async def _validate_github(base: str, token: str) -> CredentialHealth:
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/user",
                                    headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 200:
            return CredentialHealth.HEALTHY
        if resp.status_code == 401:
            return CredentialHealth.REVOKED
        if resp.status_code == 403:
            return CredentialHealth.INVALID
        return CredentialHealth.UNKNOWN
    except httpx.HTTPError as e:
        logger.warning("github validate failed: %s", e)
        return CredentialHealth.UNKNOWN
```

- [ ] **Step 3: Add the test endpoint**

In `orchestrator/app/capabilities/router.py`:

```python
from app.capabilities.models import CredentialHealth
from pydantic import BaseModel


class CredentialTestResult(BaseModel):
    health: CredentialHealth


@router.post("/credentials/{cred_id}/test", response_model=CredentialTestResult)
async def test_credential(
    cred_id: UUID,
    _: None = Depends(require_admin),
    pool=Depends(get_pool),
):
    health = await cred_db.validate_credential(
        pool, tenant_id=DEFAULT_TENANT, cred_id=cred_id, actor="admin"
    )
    return CredentialTestResult(health=health)
```

- [ ] **Step 4: Test — credential validation roundtrip (env-var pattern)**

`monkeypatch` does not reach a Dockerized orchestrator process. Use an env-var override instead:

a) Add to `orchestrator/app/config.py`:
   ```python
   GITHUB_API_BASE_URL: str = "https://api.github.com"  # tests override to fake-github
   ```
b) In `credentials.py`, `_validate_github` reads from `settings.GITHUB_API_BASE_URL` when `api_base` arg is None. Add a docstring noting this env is **for testing only**.
c) The test starts fake-github, restarts the orchestrator with `GITHUB_API_BASE_URL=http://host.docker.internal:<fake-port>` set, runs the API call, then restores.

```python
# tests/test_capability_credentials.py
from tests.fixtures.fake_github import FakeGitHubServer


@pytest.mark.asyncio
async def test_credential_health_healthy_via_fake_github():
    """Validation against fake-github with a good token returns HEALTHY."""
    fake = FakeGitHubServer()
    await fake.start()
    try:
        # Tell the running orchestrator to use fake-github for the duration
        # (Use a per-test override endpoint OR docker compose exec to set env.)
        # Simplest: orchestrator exposes an admin-only POST /api/v1/__test/override-env
        # that sets settings.GITHUB_API_BASE_URL temporarily. Implement as part of this task.
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{ORCH_URL}/api/v1/__test/override-env",
                headers=ADMIN_HEADERS,
                json={"GITHUB_API_BASE_URL": fake.base_url},
            )
            create = await client.post(
                f"{ORCH_URL}/api/v1/capabilities/credentials",
                headers=ADMIN_HEADERS,
                json={
                    "provider_kind": "github",
                    "auth_method": "pat",
                    "label": "nova-test-validate-1",
                    "secret": "ghp_validtoken",
                },
            )
            cred_id = create.json()["id"]
            test = await client.post(
                f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}/test",
                headers=ADMIN_HEADERS,
            )
            assert test.json()["health"] == "healthy"
            await client.delete(
                f"{ORCH_URL}/api/v1/capabilities/credentials/{cred_id}",
                headers=ADMIN_HEADERS,
            )
            await client.post(
                f"{ORCH_URL}/api/v1/__test/override-env",
                headers=ADMIN_HEADERS,
                json={"GITHUB_API_BASE_URL": "https://api.github.com"},
            )
    finally:
        await fake.stop()
```

The `__test/override-env` endpoint is a small admin-gated test seam — only enabled when `settings.NOVA_TEST_MODE` is true. Document this in the route.

- [ ] **Step 5: Run all credential tests**

```bash
pytest tests/test_capability_credentials.py -v
```

Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/fake_github/ orchestrator/app/capabilities/credentials.py orchestrator/app/capabilities/router.py tests/test_capability_credentials.py
git commit -m "feat(capability): credential health validation + fake-github boundary fake"
```

**Milestone 1 done when:** all three tests pass; you can `curl POST /api/v1/capabilities/credentials` with a real PAT and see `health=healthy` after `/test`.

---

# Milestone 2: Audit log + redactor

**Ships when:** Every credential operation produces a `capability_audit` row with the secret masked. Hash chain validates. Tampering is detectable.

## Task 2.1: Migration — `capability_audit` table

**Files:**
- Create: `orchestrator/app/migrations/069_capability_audit.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Capability platform: tamper-evident audit log
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §8

CREATE TABLE IF NOT EXISTS capability_audit (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),

    actor_kind      TEXT NOT NULL CHECK (actor_kind IN
                       ('agent','human','cortex_drive','cron','webhook','system')),
    actor_id        TEXT NOT NULL,
    task_id         UUID,

    event_type      TEXT NOT NULL CHECK (event_type IN
                       ('tool_call','consent_request','consent_decision',
                        'credential_use','mcp_register','tier_override',
                        'rule_apply','budget_exceeded')),
    tool_name       TEXT,
    tool_kind       TEXT CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT,

    provider_kind   TEXT,
    target          TEXT,
    credential_id   UUID,

    args_redacted   JSONB,
    response_status TEXT NOT NULL CHECK (response_status IN
                       ('success','rejected','error','rate_limited','timeout','pending')),
    response_summary TEXT,
    error_class     TEXT,
    duration_ms     INTEGER,

    prev_hash       BYTEA NOT NULL,
    content_hash    BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time
    ON capability_audit(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_task
    ON capability_audit(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_target ON capability_audit(target);
CREATE INDEX IF NOT EXISTS idx_audit_credential
    ON capability_audit(credential_id) WHERE credential_id IS NOT NULL;

-- Append-only enforcement: silently reject UPDATE and DELETE from app code
CREATE OR REPLACE RULE capability_audit_no_update AS
  ON UPDATE TO capability_audit DO INSTEAD NOTHING;
CREATE OR REPLACE RULE capability_audit_no_delete AS
  ON DELETE TO capability_audit DO INSTEAD NOTHING;
```

- [ ] **Step 2: Apply and verify**

```bash
docker compose restart orchestrator && sleep 5
docker compose exec postgres psql -U nova -d nova -c "\d capability_audit"
```

Expected: table with all columns, two RULES listed.

- [ ] **Step 3: Commit**

```bash
git add orchestrator/app/migrations/069_capability_audit.sql
git commit -m "feat(capability): audit log table with append-only RULE constraints"
```

## Task 2.2: Redactor

**Files:**
- Create: `orchestrator/app/capabilities/redactor.py`
- Create: `tests/test_capability_redactor.py`

- [ ] **Step 1: Test — redaction patterns**

```python
# tests/test_capability_redactor.py
from app.capabilities.redactor import redact_value, redact_dict


def test_redacts_github_token():
    out = redact_value("ghp_abcdefghijklmnop12345")
    assert out == "ghp_abcd…2345"
    assert "ghijklmnop" not in out


def test_redacts_authorization_header():
    out = redact_value("Bearer ghp_secrettoken_77777777")
    assert "secrettoken" not in out


def test_redacts_field_named_token():
    payload = {"label": "fine", "token": "supersecret_value", "url": "https://safe"}
    out = redact_dict(payload)
    assert out["label"] == "fine"
    assert out["url"] == "https://safe"
    assert "supersecret_value" not in str(out)


def test_redacts_nested():
    payload = {"creds": {"api_key": "abc123def456ghi789jkl"}}
    out = redact_dict(payload)
    assert "abc123def456" not in str(out)
```

- [ ] **Step 2: Run — fail**

```bash
pytest tests/test_capability_redactor.py -v
```

- [ ] **Step 3: Implement**

```python
# orchestrator/app/capabilities/redactor.py
"""Insert-time redaction. Masks secret-shaped values before audit storage."""
from __future__ import annotations
import re
from typing import Any

# Token patterns (high-confidence)
_TOKEN_PATTERNS = [
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"ghu_[A-Za-z0-9]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[A-Z0-9]{16}"),
    re.compile(r"xoxb-[A-Za-z0-9-]+"),
    re.compile(r"Bearer\s+[A-Za-z0-9._\-+/]+"),
]

# Field-name patterns: keys that should always be masked regardless of value
_SENSITIVE_KEY = re.compile(
    r"(token|secret|password|api[_-]?key|credential|auth|bearer)",
    re.IGNORECASE,
)


def _short_mask(value: str) -> str:
    if len(value) <= 12:
        return "***"
    return f"{value[:8]}…{value[-4:]}"


def redact_value(value: str) -> str:
    """Mask matched token patterns within a string."""
    if not isinstance(value, str):
        return value
    out = value
    for pat in _TOKEN_PATTERNS:
        def repl(m):
            return _short_mask(m.group(0))
        out = pat.sub(repl, out)
    return out


def redact_dict(obj: Any) -> Any:
    """Walk a JSON-like structure; mask sensitive keys' values entirely
    and apply pattern redaction to all string values."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if _SENSITIVE_KEY.search(k):
                out[k] = "***"
            else:
                out[k] = redact_dict(v)
        return out
    if isinstance(obj, list):
        return [redact_dict(x) for x in obj]
    if isinstance(obj, str):
        return redact_value(obj)
    return obj
```

- [ ] **Step 4: Run — pass**

```bash
pytest tests/test_capability_redactor.py -v
```

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/app/capabilities/redactor.py tests/test_capability_redactor.py
git commit -m "feat(capability): insert-time redactor for token patterns and sensitive keys"
```

## Task 2.3: Audit writer with hash chain

**Files:**
- Create: `orchestrator/app/capabilities/audit.py`

- [ ] **Step 1: Write tests first**

```python
# tests/test_capability_audit.py
"""Audit log: insert, hash chain integrity, tamper detection, RULE enforcement."""
from __future__ import annotations
import hashlib
import json
from uuid import UUID, uuid4

import asyncpg
import pytest

from app.capabilities.audit import write_audit_event, verify_chain
from app.capabilities.models import CredentialHealth  # noqa


TENANT = UUID("00000000-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_audit_insert_and_chain(pool):
    # Insert N rows
    for i in range(5):
        await write_audit_event(
            pool,
            tenant_id=TENANT, actor_kind="system", actor_id="test",
            event_type="tool_call", tool_name=f"test_tool_{i}",
            blast_radius="read", response_status="success",
            args_redacted={"i": i},
        )
    # Verify chain
    result = await verify_chain(pool, tenant_id=TENANT)
    assert result.is_valid
    assert result.row_count >= 5


@pytest.mark.asyncio
async def test_audit_tampering_detected(pool):
    """Tampering with content_hash breaks chain verification."""
    await write_audit_event(
        pool,
        tenant_id=TENANT, actor_kind="system", actor_id="tamper-test",
        event_type="tool_call", tool_name="tamper_target",
        blast_radius="read", response_status="success",
    )
    # Tamper: corrupt one row's content_hash
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE capability_audit SET content_hash=$1 "
            "WHERE actor_id='tamper-test'",
            b'\x00' * 32,
        )
        # Note: RULE blocks UPDATE — so verify_chain runs against UNCHANGED data.
        # This test validates the RULE itself.
        row = await conn.fetchrow(
            "SELECT content_hash FROM capability_audit WHERE actor_id='tamper-test'"
        )
        # Should NOT be all zeros (UPDATE was blocked)
        assert row["content_hash"] != b'\x00' * 32


@pytest.mark.asyncio
async def test_audit_delete_blocked(pool):
    await write_audit_event(
        pool,
        tenant_id=TENANT, actor_kind="system", actor_id="delete-test",
        event_type="tool_call", tool_name="delete_target",
        blast_radius="read", response_status="success",
    )
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM capability_audit WHERE actor_id='delete-test'"
        )
        # Result should be DELETE 0 (RULE rejected)
        assert "0" in result
```

- [ ] **Step 2: Implement audit writer**

```python
# orchestrator/app/capabilities/audit.py
"""Capability audit log writer with per-tenant tamper-evident hash chain."""
from __future__ import annotations
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from app.capabilities.redactor import redact_dict


GENESIS_HASH = b'\x00' * 32


def _canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, default=str, separators=(",", ":"))


async def write_audit_event(
    pool: asyncpg.Pool,
    *,
    tenant_id: UUID,
    actor_kind: str,
    actor_id: str,
    event_type: str,
    user_id: UUID | None = None,
    task_id: UUID | None = None,
    tool_name: str | None = None,
    tool_kind: str | None = None,
    blast_radius: str | None = None,
    provider_kind: str | None = None,
    target: str | None = None,
    credential_id: UUID | None = None,
    args_redacted: dict | None = None,
    response_status: str = "success",
    response_summary: str | None = None,
    error_class: str | None = None,
    duration_ms: int | None = None,
) -> UUID:
    """Insert a single audit row, computing the per-tenant hash chain."""
    args = redact_dict(args_redacted or {}) if args_redacted else None
    summary = response_summary[:512] if response_summary else None
    audit_id = uuid4()
    timestamp = datetime.utcnow()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Lock the tenant chain to serialize chain extension
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                f"capability_audit:{tenant_id}",
            )
            prev_hash_row = await conn.fetchval(
                "SELECT content_hash FROM capability_audit "
                "WHERE tenant_id=$1 ORDER BY timestamp DESC, id DESC LIMIT 1",
                tenant_id,
            )
            prev_hash = prev_hash_row or GENESIS_HASH

            content = _canonical_json({
                "id": str(audit_id),
                "tenant_id": str(tenant_id),
                "user_id": str(user_id) if user_id else None,
                "timestamp": timestamp.isoformat(),
                "actor_kind": actor_kind,
                "actor_id": actor_id,
                "task_id": str(task_id) if task_id else None,
                "event_type": event_type,
                "tool_name": tool_name,
                "tool_kind": tool_kind,
                "blast_radius": blast_radius,
                "provider_kind": provider_kind,
                "target": target,
                "credential_id": str(credential_id) if credential_id else None,
                "args_redacted": args,
                "response_status": response_status,
                "response_summary": summary,
                "error_class": error_class,
                "duration_ms": duration_ms,
                "prev_hash": prev_hash.hex(),
            })
            content_hash = hashlib.sha256(content.encode()).digest()

            await conn.execute(
                """
                INSERT INTO capability_audit (
                  id, tenant_id, user_id, timestamp,
                  actor_kind, actor_id, task_id,
                  event_type, tool_name, tool_kind, blast_radius,
                  provider_kind, target, credential_id,
                  args_redacted, response_status, response_summary,
                  error_class, duration_ms,
                  prev_hash, content_hash
                ) VALUES (
                  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  $15::jsonb,$16,$17,$18,$19,$20,$21
                )
                """,
                audit_id, tenant_id, user_id, timestamp,
                actor_kind, actor_id, task_id,
                event_type, tool_name, tool_kind, blast_radius,
                provider_kind, target, credential_id,
                args, response_status, summary,
                error_class, duration_ms,
                prev_hash, content_hash,
            )
    return audit_id


@dataclass
class ChainResult:
    is_valid: bool
    row_count: int
    broken_at: UUID | None = None


async def verify_chain(pool: asyncpg.Pool, *, tenant_id: UUID) -> ChainResult:
    """Walk the tenant's chain from genesis; return ChainResult."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM capability_audit WHERE tenant_id=$1 "
            "ORDER BY timestamp ASC, id ASC",
            tenant_id,
        )
    if not rows:
        return ChainResult(is_valid=True, row_count=0)
    expected_prev = GENESIS_HASH
    for row in rows:
        if row["prev_hash"] != expected_prev:
            return ChainResult(is_valid=False, row_count=len(rows),
                               broken_at=row["id"])
        # Recompute content_hash and compare
        recomputed_content = _canonical_json({
            "id": str(row["id"]),
            "tenant_id": str(row["tenant_id"]),
            "user_id": str(row["user_id"]) if row["user_id"] else None,
            "timestamp": row["timestamp"].isoformat(),
            "actor_kind": row["actor_kind"],
            "actor_id": row["actor_id"],
            "task_id": str(row["task_id"]) if row["task_id"] else None,
            "event_type": row["event_type"],
            "tool_name": row["tool_name"],
            "tool_kind": row["tool_kind"],
            "blast_radius": row["blast_radius"],
            "provider_kind": row["provider_kind"],
            "target": row["target"],
            "credential_id": str(row["credential_id"]) if row["credential_id"] else None,
            "args_redacted": row["args_redacted"],
            "response_status": row["response_status"],
            "response_summary": row["response_summary"],
            "error_class": row["error_class"],
            "duration_ms": row["duration_ms"],
            "prev_hash": expected_prev.hex(),
        })
        recomputed_hash = hashlib.sha256(recomputed_content.encode()).digest()
        if recomputed_hash != row["content_hash"]:
            return ChainResult(is_valid=False, row_count=len(rows),
                               broken_at=row["id"])
        expected_prev = row["content_hash"]
    return ChainResult(is_valid=True, row_count=len(rows))
```

- [ ] **Step 3: `pool` fixture in conftest**

If `tests/conftest.py` doesn't already provide an asyncpg `pool` fixture, add one. Check first:

```bash
grep -n "def pool" tests/conftest.py 2>/dev/null
```

If absent, add to `tests/conftest.py`:

```python
import asyncpg
import os
import pytest


@pytest.fixture
async def pool():
    dsn = os.getenv("DATABASE_URL", "postgresql://nova:novapass@localhost:5432/nova")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
    yield pool
    await pool.close()
```

- [ ] **Step 4: Run audit tests**

```bash
pytest tests/test_capability_audit.py -v
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/app/capabilities/audit.py tests/test_capability_audit.py tests/conftest.py
git commit -m "feat(capability): hash-chained audit writer + chain verification"
```

## Task 2.4: Wire audit into credential operations

**Files:**
- Modify: `orchestrator/app/capabilities/credentials.py`

- [ ] **Step 1: Add capability_audit calls alongside the existing credential_audit calls**

In `credentials.py`, after each existing `INSERT INTO capability_credential_audit ...`, also call `write_audit_event` for the broader capability_audit:

```python
from app.capabilities.audit import write_audit_event
# After each cred_audit INSERT:
await write_audit_event(
    pool,
    tenant_id=tenant_id, actor_kind="human", actor_id=actor,
    event_type="credential_use",  # or 'credential_store' as appropriate
    credential_id=cred_id,
    response_status="success",
)
```

(Keep the credential-specific audit table for backward-compat; the broader `capability_audit` is the security record.)

- [ ] **Step 2: Test — credential ops emit audit**

Add to `tests/test_capability_credentials.py`:

```python
@pytest.mark.asyncio
async def test_credential_create_writes_audit(pool):
    """Creating a credential produces a capability_audit row with credential_id set."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{ORCH_URL}/api/v1/capabilities/credentials",
            headers=ADMIN_HEADERS,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": "nova-test-audit-trail",
                "secret": "ghp_audittrail_test",
            },
        )
        cred_id = resp.json()["id"]

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT event_type FROM capability_audit WHERE credential_id=$1",
            UUID(cred_id),
        )
    assert any(r["event_type"] == "credential_use" for r in rows)
```

- [ ] **Step 3: Run + commit**

```bash
pytest tests/test_capability_credentials.py -v
git add orchestrator/app/capabilities/credentials.py tests/test_capability_credentials.py
git commit -m "feat(capability): credential ops emit capability_audit events"
```

**Milestone 2 done when:** all audit tests pass; tampering tests confirm the RULE blocks UPDATE/DELETE; credential ops produce audit rows.

---

# Milestone 3: Consent gate + blast-radius

**Ships when:** A MUTATE-tagged tool call creates an `approval_requests` row, a dashboard endpoint can approve/reject it, and the executor blocks until the decision lands (or 24h timeout).

## Task 3.1: Migration — `approval_requests` and `consent_rules`

**Files:**
- Create: `orchestrator/app/migrations/070_consent_and_approvals.sql`

- [ ] **Step 1: Write migration**

```sql
-- Capability platform: approval queue and consent rules
-- See docs/designs/2026-05-01-nova-capability-platform-design.md §7.4

CREATE TABLE IF NOT EXISTS approval_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    task_id         UUID,
    requested_by    TEXT NOT NULL,
    tool_name       TEXT NOT NULL,
    tool_kind       TEXT NOT NULL CHECK (tool_kind IN ('native','mcp_http','mcp_stdio')),
    blast_radius    TEXT NOT NULL CHECK (blast_radius IN ('mutate','destruct')),
    args_redacted   JSONB NOT NULL,
    diff_preview    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','timeout','superseded')),
    decided_by      TEXT,
    decided_via     TEXT,                                  -- 'dashboard','slack','telegram','sms','voice','cli'
    decided_at      TIMESTAMPTZ,
    rule_id         UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_approval_pending
    ON approval_requests(tenant_id, status, expires_at)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS consent_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID NOT NULL,
    tool_name       TEXT NOT NULL,
    provider_kind   TEXT NOT NULL,
    scope_match     JSONB NOT NULL,
    source          TEXT NOT NULL CHECK (source IN ('user_remember','cortex_proposed')),
    proposed_at     TIMESTAMPTZ,
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    last_applied_at TIMESTAMPTZ,
    apply_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_consent_rules_lookup
    ON consent_rules(tenant_id, user_id, tool_name) WHERE enabled = true;
```

The three v1 matcher kinds in `scope_match` are `target_glob`, `max_diff_lines`, `failure_signature`. Evaluator implementation lives in `consent.py` (Task 3.3).

- [ ] **Step 2: Apply, verify, commit**

```bash
docker compose restart orchestrator && sleep 5
docker compose exec postgres psql -U nova -d nova -c "\d approval_requests"
docker compose exec postgres psql -U nova -d nova -c "\d consent_rules"
git add orchestrator/app/migrations/070_consent_and_approvals.sql
git commit -m "feat(capability): approval_requests and consent_rules tables"
```

## Task 3.2: Extend `ToolDefinition` with blast_radius

**Files:**
- Modify: `nova-contracts/nova_contracts/tools.py`

- [ ] **Step 1: Add fields**

In `nova-contracts/nova_contracts/tools.py`:

```python
from enum import Enum


class BlastRadius(str, Enum):
    READ = "read"
    PROPOSE = "propose"
    MUTATE = "mutate"
    DESTRUCT = "destruct"


# Extend ToolDefinition:
class ToolDefinition(BaseModel):
    # ... existing fields ...
    blast_radius: BlastRadius = BlastRadius.MUTATE  # safe default
    reversible: bool = True
    rate_limit_per_hour: int | None = None
```

- [ ] **Step 2: Verify existing tools still parse**

```bash
docker compose restart orchestrator && sleep 3
docker compose logs orchestrator --tail 30 | grep -iE "error|tool"
```

Expected: no Pydantic validation errors. Existing tools default to MUTATE, which is safe but over-prompts. Next step fixes that.

- [ ] **Step 3: Tag existing tool definitions**

For each existing tool group in `orchestrator/app/tools/*_tools.py`, tag tools with the right tier. Most existing tools are READ (e.g., `git status`, `read_file`, `web_search`); only specific ones are MUTATE (`git commit`, `write_file`, `open_pr`, etc.). Audit each file and add `blast_radius=BlastRadius.READ` (or MUTATE/PROPOSE) to each `ToolDefinition(...)` constructor call.

- [ ] **Step 4: Smoke test**

```bash
docker compose restart orchestrator && sleep 5
curl -s http://localhost:8000/api/v1/capabilities/tools 2>/dev/null || echo "endpoint not yet — skip"
```

- [ ] **Step 5: Commit**

```bash
git add nova-contracts/ orchestrator/app/tools/
git commit -m "feat(capability): add blast_radius/reversible/rate_limit to ToolDefinition"
```

## Task 3.3: Consent gate + state machine

**Files:**
- Create: `orchestrator/app/capabilities/consent.py`
- Create: `tests/test_capability_consent.py`

(See spec §7.5 for the state machine. Implement: `request_approval`, `decide_approval`, `check_rules` for auto-approve, `gate(tool_call)` that returns `ALLOW | DENY | PENDING(approval_id)`.)

- [ ] **Step 1: Test — MUTATE creates pending approval; READ does not**

```python
# tests/test_capability_consent.py
import pytest
from uuid import uuid4
from app.capabilities.consent import gate, ConsentDecision
from nova_contracts import BlastRadius


TENANT = uuid4()


@pytest.mark.asyncio
async def test_read_tier_auto_allows(pool):
    decision = await gate(
        pool, tenant_id=TENANT, user_id=None, task_id=None,
        tool_name="list_workflow_runs", tool_kind="native",
        blast_radius=BlastRadius.READ, args={"repo": "x/y"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="ci_triage_agent",
    )
    assert decision.action == "allow"


@pytest.mark.asyncio
async def test_mutate_tier_creates_pending(pool):
    decision = await gate(
        pool, tenant_id=TENANT, user_id=None, task_id=None,
        tool_name="open_fix_pr", tool_kind="native",
        blast_radius=BlastRadius.MUTATE, args={"repo": "x/y", "branch": "fix"},
        provider_kind="github", target="repos/x/y", reversible=True,
        actor_kind="agent", actor_id="ci_triage_agent",
    )
    assert decision.action == "pending"
    assert decision.approval_id is not None
```

- [ ] **Step 2: Implement `gate`, `request_approval`, `decide_approval`**

(Pattern: `gate` evaluates `consent_rules` first; if none match and tier is MUTATE/DESTRUCT, insert `approval_requests` row and return PENDING. Caller polls or registers a callback.)

- [ ] **Step 3: Add consent endpoints to router**

```
GET    /api/v1/capabilities/approvals?status=pending       # list
GET    /api/v1/capabilities/approvals/{id}                 # detail
POST   /api/v1/capabilities/approvals/{id}/decide          # body: {decision: 'approve'|'reject', remember: bool}
```

The `remember` flag inserts a `consent_rules` row scoped to the same tool/target.

- [ ] **Step 4: Run, commit**

```bash
pytest tests/test_capability_consent.py -v
git add orchestrator/app/capabilities/consent.py tests/test_capability_consent.py
git commit -m "feat(capability): consent gate with approval state machine"
```

## Task 3.4: Executor — wraps every tool call through gate + audit

**Files:**
- Create: `orchestrator/app/capabilities/executor.py`
- Modify: `orchestrator/app/pipeline/tools/registry.py`

- [ ] **Step 1: Implement executor**

```python
# orchestrator/app/capabilities/executor.py
"""Capability platform executor — every tool call passes through here.
   - Resolves credential
   - Runs blast-radius classifier
   - Hits consent gate
   - Calls underlying tool
   - Writes capability_audit row
"""
from __future__ import annotations
import time
from uuid import UUID

from app.capabilities import audit, consent, credentials as cred_db
from nova_contracts import BlastRadius


async def execute_tool(
    pool,
    *,
    tenant_id: UUID,
    user_id: UUID | None,
    task_id: UUID | None,
    actor_kind: str,
    actor_id: str,
    tool_name: str,
    tool_kind: str,  # 'native' | 'mcp_http' | 'mcp_stdio'
    blast_radius: BlastRadius,
    reversible: bool,
    provider_kind: str | None,
    target: str | None,
    credential_id: UUID | None,
    args: dict,
    underlying: callable,  # async fn(args, secret) → result
) -> dict:
    """Single boundary for every tool call."""
    decision = await consent.gate(
        pool, tenant_id=tenant_id, user_id=user_id, task_id=task_id,
        tool_name=tool_name, tool_kind=tool_kind,
        blast_radius=blast_radius, args=args,
        provider_kind=provider_kind, target=target,
        reversible=reversible,
        actor_kind=actor_kind, actor_id=actor_id,
    )
    if decision.action == "pending":
        await audit.write_audit_event(
            pool, tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="consent_request",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="pending",
        )
        return {"status": "consent_pending", "approval_id": str(decision.approval_id)}
    if decision.action == "deny":
        await audit.write_audit_event(
            pool, tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            response_status="rejected",
        )
        return {"status": "user_rejected"}

    # ALLOW: resolve secret if needed, call underlying, audit
    secret = None
    if credential_id:
        secret = await cred_db.get_secret(
            pool, tenant_id=tenant_id, cred_id=credential_id, actor=actor_id
        )
    started = time.monotonic()
    try:
        result = await underlying(args, secret)
        duration_ms = int((time.monotonic() - started) * 1000)
        await audit.write_audit_event(
            pool, tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="success",
            response_summary=str(result)[:500] if result else None,
            duration_ms=duration_ms,
        )
        return result
    except Exception as e:
        duration_ms = int((time.monotonic() - started) * 1000)
        await audit.write_audit_event(
            pool, tenant_id=tenant_id, user_id=user_id, task_id=task_id,
            actor_kind=actor_kind, actor_id=actor_id,
            event_type="tool_call",
            tool_name=tool_name, tool_kind=tool_kind,
            blast_radius=blast_radius.value,
            provider_kind=provider_kind, target=target,
            credential_id=credential_id, args_redacted=args,
            response_status="error", error_class=type(e).__name__,
            response_summary=str(e)[:500],
            duration_ms=duration_ms,
        )
        raise
```

- [ ] **Step 2: Wire into pipeline/tools/registry.py**

The existing registry merges static + dynamic (MCP) tools. Find the dispatch function (search `execute_tool` in `pipeline/tools/registry.py`) and route through `app.capabilities.executor.execute_tool`.

- [ ] **Step 3: Test — executor end-to-end**

```python
@pytest.mark.asyncio
async def test_executor_read_tier_runs_and_audits(pool):
    async def fake_tool(args, secret):
        return {"runs": [{"id": 1}]}

    result = await execute_tool(
        pool,
        tenant_id=TENANT, user_id=None, task_id=None,
        actor_kind="agent", actor_id="test",
        tool_name="list_runs", tool_kind="native",
        blast_radius=BlastRadius.READ, reversible=True,
        provider_kind="github", target="repos/x/y", credential_id=None,
        args={"repo": "x/y"},
        underlying=fake_tool,
    )
    assert result == {"runs": [{"id": 1}]}
    # Verify audit row exists
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM capability_audit WHERE tool_name='list_runs' "
            "ORDER BY timestamp DESC LIMIT 1"
        )
        assert row["response_status"] == "success"
        assert row["blast_radius"] == "read"
```

- [ ] **Step 4: Run, commit**

```bash
pytest tests/test_capability_consent.py -v
git add orchestrator/app/capabilities/executor.py orchestrator/app/pipeline/tools/registry.py tests/test_capability_consent.py
git commit -m "feat(capability): executor wraps all tool calls through consent gate + audit"
```

**Milestone 3 done when:** READ-tier tools auto-execute, MUTATE-tier creates pending approval, decide endpoint flips status and unblocks (or rejects), audit rows are present for every event.

---

# Milestone 4: GitHub provider — READ tier

**Ships when:** Against fake-github, `list_workflow_runs`, `get_workflow_run`, `get_run_logs`, `get_run_diff`, `compare_to_main` all return correctly typed results.

## Task 4.1: Expand fake-github with workflow endpoints

**Files:**
- Modify: `tests/fixtures/fake_github/server.py`
- Create: `tests/fixtures/fake_github/scenarios/lint_failure_in_pr.json`
- Create: `tests/fixtures/fake_github/scenarios/bug_on_main.json`

- [ ] **Step 1: Add scenario JSON**

```json
// tests/fixtures/fake_github/scenarios/lint_failure_in_pr.json
{
  "repo": "test-org/test-repo",
  "workflow_runs": [
    {"id": 12345, "conclusion": "failure", "head_sha": "abc123",
     "head_branch": "feature-x", "created_at": "2026-04-30T12:00:00Z"}
  ],
  "logs": {
    "12345": "ESLint: 3 errors\n  src/utils.ts:12:5 'foo' is not defined\n  src/utils.ts:14:1 ..."
  },
  "main_status": "passing"
}
```

```json
// tests/fixtures/fake_github/scenarios/bug_on_main.json
{
  "repo": "test-org/test-repo",
  "workflow_runs": [
    {"id": 12346, "conclusion": "failure", "head_sha": "def456",
     "head_branch": "feature-y"}
  ],
  "logs": {"12346": "Test failed: unrelated_module.test_thing"},
  "main_status": "failing",
  "main_failure_signature": "Test failed: unrelated_module.test_thing"
}
```

- [ ] **Step 2: Expand fake-github server**

Add endpoints to `tests/fixtures/fake_github/server.py`:

```python
@app.get("/repos/{owner}/{repo}/actions/runs")
async def list_runs(owner: str, repo: str, status: str | None = None):
    runs = state["scenarios"].get("workflow_runs", [])
    if status:
        runs = [r for r in runs if r["conclusion"] == status or status == "all"]
    return {"total_count": len(runs), "workflow_runs": runs}


@app.get("/repos/{owner}/{repo}/actions/runs/{run_id}/logs")
async def get_logs(owner: str, repo: str, run_id: int):
    log_text = state["scenarios"].get("logs", {}).get(str(run_id), "")
    return {"text": log_text}  # GitHub real API returns zip; we return text for tests


@app.get("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs")
async def list_workflow_runs(owner: str, repo: str, workflow_id: str, branch: str | None = None):
    return {"workflow_runs": state["scenarios"].get("workflow_runs", [])}
```

- [ ] **Step 3: Test fake-github responds**

```python
@pytest.mark.asyncio
async def test_fake_github_list_runs():
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{fake.base_url}/repos/test-org/test-repo/actions/runs")
        assert resp.status_code == 200
        assert resp.json()["workflow_runs"][0]["id"] == 12345
    finally:
        await fake.stop()
```

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake_github/
git commit -m "test: expand fake-github with workflow endpoints + scenario JSON"
```

## Task 4.2: Implement GitHub READ tools

**Files:**
- Create: `orchestrator/app/tools/github_external_tools.py`
- Create: `tests/test_github_external_tools.py`

- [ ] **Step 1: Test — list_workflow_runs against fake-github**

(Test pattern: start fake-github, write a credential pointing at fake-github base URL, call the tool, assert.)

- [ ] **Step 2: Implement READ tools**

```python
# orchestrator/app/tools/github_external_tools.py
"""Native GitHub provider for arbitrary repos.
Distinguished from app.tools.github_tools (Self-Modification, Nova's own repo).
See docs/designs/2026-05-01-nova-capability-platform-design.md §5.
"""
from __future__ import annotations
import logging
from typing import Any

import httpx
from nova_contracts import BlastRadius, ToolDefinition

logger = logging.getLogger(__name__)

# Tools — declared with explicit blast_radius
GITHUB_EXTERNAL_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="list_workflow_runs",
        description="List recent workflow runs for a repo, optionally filtered by status",
        schema={
            "type": "object",
            "properties": {
                "repo": {"type": "string", "description": "owner/name"},
                "status": {"type": "string", "enum": ["completed","in_progress","failure","success","all"]},
                "branch": {"type": "string"},
            },
            "required": ["repo"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    # ... get_workflow_run, get_run_logs, get_run_diff, compare_to_main ...
]


async def _http_client(api_base: str, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=api_base,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )


async def _list_workflow_runs(args: dict, secret: str, *, api_base: str) -> dict:
    repo = args["repo"]
    status = args.get("status")
    branch = args.get("branch")
    async with await _http_client(api_base, secret) as client:
        params = {}
        if status: params["status"] = status
        if branch: params["branch"] = branch
        resp = await client.get(f"/repos/{repo}/actions/runs", params=params)
        resp.raise_for_status()
        return resp.json()


# ... implement get_workflow_run, get_run_logs, get_run_diff, compare_to_main ...


async def execute_tool(name: str, args: dict, *, secret: str, api_base: str) -> Any:
    """Dispatch — called by the executor wrapper."""
    if name == "list_workflow_runs":
        return await _list_workflow_runs(args, secret, api_base=api_base)
    if name == "get_workflow_run":
        return await _get_workflow_run(args, secret, api_base=api_base)
    if name == "get_run_logs":
        return await _get_run_logs(args, secret, api_base=api_base)
    if name == "get_run_diff":
        return await _get_run_diff(args, secret, api_base=api_base)
    if name == "compare_to_main":
        return await _compare_to_main(args, secret, api_base=api_base)
    raise ValueError(f"Unknown tool: {name}")
```

`compare_to_main` is the bug-locator. Implementation logic:
1. Fetch the failing run's `head_sha` and the test signature (failing job name + first error line).
2. Query main's recent runs for the same workflow.
3. If main also has a failing run with matching signature → return `{"bug_location": "main"}`.
4. Else → return `{"bug_location": "branch"}`.

- [ ] **Step 3: Add to tool registry**

In `orchestrator/app/tools/__init__.py`:

```python
from app.tools.github_external_tools import GITHUB_EXTERNAL_TOOLS, execute_tool as _exec_github_external

_REGISTRY.append(
    ToolGroup("github_external", "GitHub (External Repos)",
              "Read CI/PRs/issues on arbitrary repos; open fix PRs (with consent)",
              GITHUB_EXTERNAL_TOOLS, _exec_github_external)
)
```

- [ ] **Step 4: Test all READ tools**

```bash
pytest tests/test_github_external_tools.py::test_list_workflow_runs -v
pytest tests/test_github_external_tools.py::test_compare_to_main_bug_in_pr -v
pytest tests/test_github_external_tools.py::test_compare_to_main_bug_on_main -v
```

- [ ] **Step 5: Commit**

```bash
git add orchestrator/app/tools/github_external_tools.py orchestrator/app/tools/__init__.py tests/test_github_external_tools.py
git commit -m "feat(capability): GitHub external provider — READ tier (5 tools)"
```

**Milestone 4 done when:** all 5 READ tools work against fake-github; tool group is registered; permissions UI shows it as a separate group.

---

# Milestone 5: GitHub provider — PROPOSE tier

**Ships when:** `diagnose_failure` and `draft_fix` produce structured outputs from logs without any external mutation.

## Task 5.1: `diagnose_failure` tool

**Files:**
- Modify: `orchestrator/app/tools/github_external_tools.py`

- [ ] **Step 1: Test — diagnoses lint failure**

```python
@pytest.mark.asyncio
async def test_diagnose_lint_failure():
    """Given lint-failure logs, diagnose returns root cause + suspected files."""
    diagnosis = await _diagnose_failure(
        {"run_id": 12345, "logs": "ESLint: 3 errors\n  src/utils.ts:12:5 'foo' is not defined"},
        secret=None, api_base=None,
    )
    assert diagnosis["category"] == "lint"
    assert "src/utils.ts" in diagnosis["suspected_files"]
```

- [ ] **Step 2: Implement**

`diagnose_failure` calls the LLM gateway with a structured prompt extracting:
- `category` (lint, type, test, build, dependency, infra, unknown)
- `suspected_files` (list of paths)
- `root_cause` (one-paragraph explanation)
- `severity` (low/medium/high)
- `confidence` (0.0–1.0)

```python
async def _diagnose_failure(args: dict, secret: str | None, *, api_base: str | None) -> dict:
    """Pure reasoning — calls LLM gateway, no external mutation."""
    from app.clients import call_gateway
    prompt = f"""Analyze this CI failure log and return JSON with keys:
  category (one of: lint, type, test, build, dependency, infra, unknown),
  suspected_files (list of file paths),
  root_cause (one paragraph),
  severity (low/medium/high),
  confidence (0.0-1.0).

Logs:
{args['logs'][:8000]}
"""
    resp = await call_gateway(prompt, model_classification="reasoning")
    # parse JSON from resp
    import json
    return json.loads(resp)
```

- [ ] **Step 3: `draft_fix` tool**

Takes a `diagnosis` dict + relevant file content, returns a `ProposedPatch` (in-memory; not committed):

```python
{
  "files": [
    {"path": "src/utils.ts", "diff": "@@ -12,5 +12,5 @@\n-foo\n+bar"}
  ],
  "summary": "Fix undefined 'foo' by importing or renaming",
  "confidence": 0.85
}
```

- [ ] **Step 4: Tag both as PROPOSE tier in `GITHUB_EXTERNAL_TOOLS`**

- [ ] **Step 5: Test, commit**

```bash
pytest tests/test_github_external_tools.py -v
git add orchestrator/app/tools/github_external_tools.py tests/test_github_external_tools.py
git commit -m "feat(capability): GitHub provider — PROPOSE tier (diagnose + draft_fix)"
```

**Milestone 5 done when:** `diagnose_failure` produces classifications matching scenario expectations; `draft_fix` produces a patch that lint-clean against scenario fixtures.

---

# Milestone 6: GitHub provider — MUTATE tier

**Ships when:** `open_fix_pr` and `comment_on_pr` execute through the consent gate. Approval flow tested against fake-github.

## Task 6.1: Implement MUTATE tools

**Files:**
- Modify: `orchestrator/app/tools/github_external_tools.py`

- [ ] **Step 1: Test — open_fix_pr requires consent**

```python
@pytest.mark.asyncio
async def test_open_fix_pr_creates_pending_approval(pool, fake_github):
    """MUTATE call returns consent_pending with an approval_id."""
    cred = await create_test_credential_pointing_at(fake_github)
    result = await execute_tool(
        pool,
        tenant_id=TENANT, ..., 
        tool_name="open_fix_pr", blast_radius=BlastRadius.MUTATE,
        credential_id=cred.id,
        args={"repo": "test-org/test-repo", "branch": "fix-1", "patch": [...], "base": "feature-x"},
        underlying=lambda args, secret: open_fix_pr_impl(args, secret, fake_github.base_url),
    )
    assert result["status"] == "consent_pending"
    assert "approval_id" in result
```

- [ ] **Step 2: Implement `_open_fix_pr` and `_comment_on_pr`**

`_open_fix_pr` flow:
1. Clone the target repo into `/tmp/nova-fix/<task_id>/` via git subprocess. Authenticate via PAT-in-URL: `git clone https://x-access-token:{pat}@github.com/{owner}/{repo}.git`. Set `core.askPass=/bin/echo` to prevent interactive prompt blocking. **Never log the URL** — use the same redactor.
2. Checkout `base` branch.
3. Apply the patch with `git apply --check` first (validates), then `git apply --3way` (applies). Patch input shape: `ProposedPatch.files[]` where each file has `path` and `diff` (unified-diff string from `draft_fix`).
4. Commit with message: `nova: <diagnosis category> fix — <root_cause one-line>` and `Co-Authored-By: Nova <noreply@arialabs.ai>`.
5. Push to `branch` via `git push origin <branch>` (force-create new branch with `-u`).
6. Open PR via GitHub API: `POST /repos/{owner}/{repo}/pulls` with title, body containing the diagnosis, base, head.
7. Cleanup tmp dir in `finally:` block — even on failure, never leak `/tmp/nova-fix/*` directories.

**Cleanup safety:** wrap the entire flow in a context manager that always rmtrees the tmp dir on exit. If the patch fails to apply, we log the failure, return `{"status": "patch_apply_failed", "stderr": ...}` (redacted), still cleanup, and let the agent retry with a different patch.

`_comment_on_pr` is just `POST /repos/{owner}/{repo}/issues/{number}/comments`.

- [ ] **Step 3: Test approval-then-execute path**

```python
@pytest.mark.asyncio
async def test_open_fix_pr_after_approval(pool, fake_github):
    """After admin approves the pending request, the PR actually gets opened."""
    # ... create credential, call execute_tool, get approval_id
    # decide approve via consent endpoint
    # assert: PR was created on fake-github
```

This requires the consent flow to invoke a callback once approval lands. Implementation: the executor's `gate` returns PENDING; on approval, a background task (or a polling loop) re-invokes the underlying tool.

**Architecture note for executor:** for v1, simplest model is **polling-based pickup**. The agent's `execute_tool` returns `consent_pending` immediately; the agent's pipeline state machine re-issues the call once the approval is `approved`. This keeps execution synchronous within an agent turn but lets the agent wait between turns. Document this clearly in `executor.py` docstring.

- [ ] **Step 4: Run, commit**

```bash
pytest tests/test_github_external_tools.py -v
git add orchestrator/app/tools/github_external_tools.py tests/test_github_external_tools.py
git commit -m "feat(capability): GitHub provider — MUTATE tier (open_fix_pr + comment_on_pr)"
```

**Milestone 6 done when:** mutate tools fail-open at consent gate, approval endpoint flips status, on next call the underlying op runs.

---

# Milestone 7: Webhook self-bootstrap

**Ships when:** Adding a watched repo via API creates a webhook on fake-github (with secret); ping-event verification flips status to `verified`; `github_webhooks` row tracks the relationship.

## Task 7.1: Migration + tools + endpoint

**Files:**
- Create: `orchestrator/app/migrations/071_github_webhooks.sql` (per spec §9.1.1)
- Create: `orchestrator/app/webhooks_router.py`
- Modify: `orchestrator/app/tools/github_external_tools.py` — add `register_webhook`, `unregister_webhook`, `verify_webhook` (all SETUP tier)
- Modify: `orchestrator/app/main.py` — register webhooks router
- Modify: `tests/fixtures/fake_github/server.py` — add `POST /repos/.../hooks` endpoint
- Create: `tests/test_capability_webhooks.py`

- [ ] **Step 1: Migration** — see spec §9.1.1.

- [ ] **Step 2: fake-github webhook endpoints**

```python
@app.post("/repos/{owner}/{repo}/hooks")
async def create_hook(owner, repo, body: dict):
    hook_id = state["next_hook_id"]
    state["next_hook_id"] += 1
    state.setdefault("hooks", {})[(owner, repo, hook_id)] = body
    return {"id": hook_id, "url": body.get("url"), "active": True}


@app.delete("/repos/{owner}/{repo}/hooks/{hook_id}")
async def delete_hook(owner, repo, hook_id: int):
    state["hooks"].pop((owner, repo, hook_id), None)
    return {}


@app.post("/repos/{owner}/{repo}/hooks/{hook_id}/pings")
async def ping_hook(owner, repo, hook_id: int):
    """Trigger a ping event — fake-github calls back to the hook URL."""
    hook = state["hooks"].get((owner, repo, hook_id))
    if not hook:
        raise HTTPException(404)
    # In tests, the hook URL points back at orchestrator's webhooks router
    import httpx
    async with httpx.AsyncClient() as client:
        await client.post(hook["url"], json={"zen": "test ping"},
                          headers={"X-GitHub-Event": "ping",
                                   "X-Hub-Signature-256": _sign(hook["secret"], '{"zen":"test ping"}')})
    return {"ok": True}
```

- [ ] **Step 3: SETUP tier tools**

`register_webhook` flow:
1. Generate HMAC secret (32 random bytes)
2. Encrypt with Fernet, store in `github_webhooks.encrypted_secret`
3. Call `POST /repos/.../hooks` with `events:['workflow_run']`, `secret`, `content_type:'json'`
4. Insert `github_webhooks` row with `status='active'`
5. Return `hook_id`

`verify_webhook` (READ): GET the hook from GitHub, confirm `active:true`.

`unregister_webhook`: DELETE the hook from GitHub, set row `status='revoked'`.

- [ ] **Step 4: Webhooks router**

```python
# orchestrator/app/webhooks_router.py
from fastapi import APIRouter, Header, HTTPException, Request
import hmac
import hashlib

router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])


@router.post("/github")
async def github_webhook(
    request: Request,
    x_github_event: str = Header(...),
    x_hub_signature_256: str = Header(...),
):
    body = await request.body()
    # Look up the hook by signature — try each active hook's secret
    pool = request.app.state.pool
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, encrypted_secret, repo, tenant_id FROM github_webhooks "
            "WHERE status IN ('active','verified')"
        )
    matching_hook = None
    for row in rows:
        secret = _decrypt(row["encrypted_secret"])
        sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        if hmac.compare_digest(sig, x_hub_signature_256):
            matching_hook = row
            break
    if not matching_hook:
        raise HTTPException(401, "signature did not match any registered webhook")

    if x_github_event == "ping":
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE github_webhooks SET status='verified', last_event_at=now() "
                "WHERE id=$1", matching_hook["id"]
            )
        return {"ok": True, "status": "verified"}

    if x_github_event == "workflow_run":
        # Parse payload, check conclusion=='failure', dispatch stimulus to cortex
        import json
        payload = json.loads(body)
        if payload.get("workflow_run", {}).get("conclusion") == "failure":
            await _dispatch_failure_stimulus(matching_hook, payload)
        return {"ok": True}

    return {"ok": True}
```

- [ ] **Step 5: Test — bootstrap end-to-end against fake-github**

```python
@pytest.mark.asyncio
async def test_webhook_self_bootstrap_e2e(pool, fake_github):
    """register_webhook creates the hook, ping verifies it."""
    cred = await create_test_credential_pointing_at(fake_github)
    result = await register_webhook_via_executor(
        pool, cred=cred, repo="test-org/test-repo",
        target_url="http://localhost:8000/api/v1/webhooks/github",
    )
    assert "hook_id" in result
    # Now trigger the ping
    async with httpx.AsyncClient() as client:
        await client.post(f"{fake_github.base_url}/repos/test-org/test-repo/hooks/{result['hook_id']}/pings")
    # Wait briefly, then check status
    await asyncio.sleep(0.5)
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT status FROM github_webhooks WHERE hook_id=$1",
                                   result["hook_id"])
    assert row["status"] == "verified"
```

- [ ] **Step 6: Run, commit**

```bash
pytest tests/test_capability_webhooks.py -v
git add orchestrator/app/migrations/071_github_webhooks.sql orchestrator/app/webhooks_router.py orchestrator/app/tools/github_external_tools.py orchestrator/app/main.py tests/fixtures/fake_github/server.py tests/test_capability_webhooks.py
git commit -m "feat(capability): webhook self-bootstrap — register, verify, dispatch"
```

**Milestone 7 done when:** registering a webhook on fake-github creates the hook, ping verifies it, fake workflow_run.failure events get dispatched to a stimulus row.

---

# Milestone 8: Cortex wiring + `ci_triage_agent` pod

**Ships when:** End-to-end test: fake-github fires a failed workflow_run → orchestrator receives webhook → cortex creates triage task → ci_triage_agent runs Quartet pipeline → opens PR (after approval) → audit trail intact.

## Task 8.1: Cortex `quality` drive — CI triage handler

**Files:**
- Modify: `cortex/app/drives/quality.py`
- Create: `tests/test_capability_e2e.py`

- [ ] **Step 1: Add stimulus consumer**

`quality.py` polls (or subscribes to) the stimulus queue. For each `ci_failure` stimulus:
1. Check repo is in watchlist (table `cortex_watched_repos` — new)
2. Dedup by `run_id` (don't triage same run twice)
3. Check daily budget (existing `cortex/app/budget.py`)
4. Check active hours window (config-driven)
5. Create a Goal with `pod=ci_triage_agent` and the failure context
6. Cortex maturation pipeline takes it from there

- [ ] **Step 2: New `cortex_watched_repos` schema (in cortex)**

```sql
-- cortex/app/migrations/0XX_watched_repos.sql (numbered per cortex's migration sequence)
CREATE TABLE IF NOT EXISTS cortex_watched_repos (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL,
    user_id               UUID,
    credential_id         UUID NOT NULL,                          -- ref to capability_credentials
    repo                  TEXT NOT NULL,                          -- 'jeremyspofford/nova'
    trigger_mode          TEXT NOT NULL DEFAULT 'webhook_with_polling_fallback'
                            CHECK (trigger_mode IN ('webhook_with_polling_fallback','webhook_only','polling_only')),
    polling_interval_min  INTEGER NOT NULL DEFAULT 15,
    workflow_pattern      TEXT,                                   -- glob; NULL = all workflows
    active_hours_start    TIME,                                   -- NULL = always
    active_hours_end      TIME,
    daily_budget          INTEGER NOT NULL DEFAULT 20,
    enabled               BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_repos_unique
    ON cortex_watched_repos(tenant_id, repo);
```

These columns line up 1:1 with the dashboard CI Triage form fields in spec §9.6 — the dashboard reads/writes this table directly.

- [ ] **Step 3: Pod definition seed**

Insert `ci_triage_agent` into the pods table via a migration in orchestrator (since pods live there per CLAUDE.md). Migration `072_ci_triage_agent_pod.sql`:

```sql
INSERT INTO agent_pods (
    name, display_name, description,
    allowed_tool_groups, model_classification, max_turns, system_prompt
) VALUES (
    'ci_triage_agent',
    'CI Triage Agent',
    'Triages failed GitHub Actions runs and proposes fixes',
    ARRAY['github_external','Code','Memory','Diagnosis'],
    'code',
    12,
    'You triage failed CI runs on GitHub repos. First, call compare_to_main to locate where the bug lives. Read logs with get_run_logs to identify the failing step. Diagnose the root cause. Recall past triages from Memory for similar failures. Draft a minimal patch (touch only files implicated by the failure). Open a PR with the fix targeting the correct base branch. If diagnosis is uncertain or patch is risky, comment on the PR with diagnosis only.'
)
ON CONFLICT (name) DO UPDATE SET
    allowed_tool_groups = EXCLUDED.allowed_tool_groups,
    system_prompt = EXCLUDED.system_prompt;
```

- [ ] **Step 4: E2E test**

```python
@pytest.mark.asyncio
async def test_e2e_triage_bug_in_pr(pool, fake_github):
    """Full path: webhook → stimulus → quality drive → triage task → PR opened (after auto-approve via test rule)."""
    # Setup: insert a consent_rule that auto-approves open_fix_pr in test-org/test-repo
    # Register webhook against fake-github
    # Fire a workflow_run.failure event on fake-github
    # Wait for cortex pipeline to complete (poll task status)
    # Assert: PR was created on fake-github
    # Assert: audit trail has full provenance
```

- [ ] **Step 5: Run, commit**

```bash
pytest tests/test_capability_e2e.py::test_e2e_triage_bug_in_pr -v
git add cortex/app/drives/quality.py orchestrator/app/migrations/072_ci_triage_agent_pod.sql tests/test_capability_e2e.py
git commit -m "feat(capability): cortex quality drive triages CI failures end-to-end"
```

## Task 8.2: Bug-on-main scenario

- [ ] **Step 1: E2E test for bug-on-main**

(Same pattern, scenario `bug_on_main.json`. Assert the PR opens against `main` branch, not `feature-y`.)

- [ ] **Step 2: Run, commit**

```bash
pytest tests/test_capability_e2e.py -v
git commit -m "test(capability): bug-on-main e2e scenario"
```

## Task 8.3: Ambiguous & unfixable scenarios

(Per acceptance criteria 3 & 4 in spec §13. Test that Context agent pauses, that unfixable failures result in comment-only path.)

```bash
git commit -m "test(capability): ambiguous + unfixable e2e scenarios"
```

**Milestone 8 done when:** all 4 e2e scenarios pass; budget cap enforced; audit trail complete.

---

# Milestone 9: Polling fallback

**Ships when:** Singleton-elected polling worker fires every 15 min on watched repos that don't have webhooks; finds failures; creates same stimulus rows as webhooks would.

## Task 9.1: Redis-leased polling worker

**Files:**
- Create: `orchestrator/app/polling_worker.py`
- Modify: `orchestrator/app/main.py` — start the worker in lifespan

- [ ] **Step 1: Implement lease + loop**

```python
# orchestrator/app/polling_worker.py
import asyncio
import logging
from uuid import uuid4

from redis.asyncio import Redis

logger = logging.getLogger(__name__)
LEASE_KEY = "nova:poll:github:lease"
LEASE_TTL = 300  # 5 minutes
REFRESH_INTERVAL = 60


class GitHubPoller:
    def __init__(self, redis: Redis, pool):
        self.redis = redis
        self.pool = pool
        self.instance_id = str(uuid4())

    async def run(self):
        while True:
            try:
                acquired = await self._acquire_lease()
                if acquired:
                    await self._poll_once()
                    await self._refresh_lease()
            except Exception:
                logger.exception("polling cycle failed")
            await asyncio.sleep(REFRESH_INTERVAL)

    async def _acquire_lease(self) -> bool:
        return await self.redis.set(LEASE_KEY, self.instance_id, nx=True, ex=LEASE_TTL)

    async def _refresh_lease(self):
        if await self.redis.get(LEASE_KEY) == self.instance_id.encode():
            await self.redis.expire(LEASE_KEY, LEASE_TTL)

    async def _poll_once(self):
        # Enumerate watched repos that DON'T have a verified webhook
        # OR are configured for polling-only OR webhook+fallback
        # For each, query workflow runs since last poll
        # If new failures: insert stimulus rows (dedup by run_id)
        ...
```

- [ ] **Step 2: Test — singleton election**

```python
@pytest.mark.asyncio
async def test_only_one_poller_runs_at_a_time(redis):
    """Two pollers contend for the lease; only one acquires."""
    p1 = GitHubPoller(redis, pool=None)
    p2 = GitHubPoller(redis, pool=None)
    a1 = await p1._acquire_lease()
    a2 = await p2._acquire_lease()
    assert a1 is True
    assert a2 is False
    await redis.delete(LEASE_KEY)
```

- [ ] **Step 3: Run, commit**

```bash
pytest tests/test_polling_worker.py -v
git add orchestrator/app/polling_worker.py orchestrator/app/main.py tests/test_polling_worker.py
git commit -m "feat(capability): singleton-leased GitHub polling worker"
```

**Milestone 9 done when:** polling fires on watched repos without webhooks; budget cap enforced; lease handover under 5 min.

---

# Milestone 10: Dashboard UI

**Ships when:** Dashboard has Connected Services, Pending Approvals, CI Triage config tab, and Audit Log views all functional against the real backend.

## Task 10.1: Connected Services panel

**Files:**
- Create: `dashboard/src/pages/settings/ConnectedServicesSection.tsx`
- Modify: `dashboard/src/pages/Settings.tsx`

(Follow the existing settings-section pattern per Jeremy's memory; Section + ConfigField + useConfigValue from `settings/shared.tsx`.)

- [ ] **Step 1: List view** — calls `GET /api/v1/capabilities/credentials`, renders rows with health dot.
- [ ] **Step 2: Add credential modal** — provider picker, paste token form, validates before save.
- [ ] **Step 3: Watched repos sub-section** — under each GitHub credential, list watched repos with trigger config.
- [ ] **Step 4: Test in browser; commit.**

## Task 10.2: Pending Approvals panel

**Files:**
- Create: `dashboard/src/pages/PendingApprovals.tsx`
- Create: `dashboard/src/components/ApprovalCard.tsx`

- [ ] List pending approvals with diff preview, approve/reject/approve+remember buttons.
- [ ] Inline rendering in chat (when approval was triggered conversationally).
- [ ] Top-nav badge with count.

## Task 10.3: CI Triage config tab

Per spec §9.6 mockup. Per-repo: trigger mode, polling interval, workflow pattern, active hours, daily budget, auto-approve rules manager.

## Task 10.4: Audit Log viewer

- [ ] List with filters (time range, actor, tool, target, status, blast-radius).
- [ ] Per-row expand to show args_redacted and response_summary.
- [ ] "View task trail" link from tasks panel.
- [ ] Export to JSON / CSV.

```bash
git commit -m "feat(capability): dashboard UI — connected services, approvals, ci config, audit log"
```

**Milestone 10 done when:** all four panels work; you can drive the entire v1 happy path through the UI.

---

# Milestone 11: Smoke tests + acceptance

**Ships when:** All 10 acceptance criteria from spec §13 pass; opt-in real-GitHub smoke suite green.

## Task 11.1: Real-GitHub smoke tests

**Files:**
- Create: `tests/test_capability_smoke_real_github.py`

- [ ] Gated by `REQUIRES_GITHUB=1`.
- [ ] Run against dedicated test repo `jeremyspofford/nova-test-cap` (create the repo first).
- [ ] 5 tests: list runs, open + close test PR, comment + delete, credential validation, webhook delivery → triage.

```bash
REQUIRES_GITHUB=1 pytest tests/test_capability_smoke_real_github.py -v
git commit -m "test(capability): opt-in real-GitHub smoke suite"
```

## Task 11.2: Acceptance criteria walkthrough

Run each of the 10 criteria in spec §13 manually (or as an integration test). Check off:

- [ ] 1. Add a GitHub PAT (scopes: `repo`, `workflow:read`, `admin:repo_hook`)
- [ ] 2. Configure watched repo with Webhook+polling fallback → consent → register_webhook → verified
- [ ] 3. Push a commit that breaks CI on that repo
- [ ] 4. Within seconds (webhook) or 16 min (polling), approval card appears
- [ ] 5. Approve → PR opens against failing branch with fix
- [ ] 6. CI on the fix-PR passes
- [ ] 7. View audit trail; full provenance with intact hash chain
- [ ] 8. Repeat with bug-on-main scenario; PR opens against main instead
- [ ] 9. Daily budget=1, trigger 2 failures; second skipped with `event_type=budget_exceeded`
- [ ] 10. All 75-90 unit/component/E2E tests pass; 5 smoke tests pass with `REQUIRES_GITHUB=1`

```bash
git commit -m "feat(capability): v1 acceptance — all 10 criteria met"
```

**Milestone 11 done when:** Nova autonomously triaged at least one real failed CI run on `jeremyspofford/nova-test-cap`, opened a PR, the fix PR's CI passed, and you merged it without manual intervention beyond the consent click.

---

# Post-v1 follow-ups (sketched, not in this plan)

**Explicitly out of v1 scope (spec §6.4 mentions but plan does not implement):**
- **MCP credential injection plumbing** — `ALTER TABLE mcp_servers ADD COLUMN credential_kind, credential_id`, plus the per-call header injection (HTTP MCP) and stdio process pool keyed by `(server_id, credential_id, key_version)`. Spec describes this as load-bearing for the future Cloudflare/GitLab MCP work but v1 ships only native GitHub. Defer the schema change and the injection logic until the first MCP-based provider is added.

**Future slices each gets its own design doc + plan when ready** (per spec §11):

- Repo creation tools
- Cloudflare DNS via MCP
- AWS hybrid (read-MCP / mutate-native)
- Per-task containerized workspace (browser/build/test/deploy)
- Tier E auto-approve rules — proposed by cortex from outcome data
- Managed webhook proxy (v2 — solves no-public-ingress)
- Multi-event-type webhooks per repo
- Phone number for Nova (v3 — Twilio)

---

# Quick reference

**Skills to invoke during execution:**
- `superpowers:test-driven-development` — when writing test→fail→implement loops
- `superpowers:systematic-debugging` — when a test fails and the cause isn't obvious
- `superpowers:verification-before-completion` — before marking any milestone done

**Useful commands:**

```bash
# Run all capability tests
pytest tests/test_capability_*.py -v

# Run a specific milestone's tests
pytest tests/test_capability_credentials.py tests/test_capability_audit.py -v

# Run e2e suite
pytest tests/test_capability_e2e.py -v

# Run smoke tests against real GitHub (after creating jeremyspofford/nova-test-cap)
REQUIRES_GITHUB=1 pytest tests/test_capability_smoke_real_github.py -v

# Inspect audit chain
docker compose exec postgres psql -U nova -d nova -c \
  "SELECT timestamp, event_type, tool_name, response_status FROM capability_audit ORDER BY timestamp DESC LIMIT 20;"

# Verify chain integrity (one-shot)
docker compose exec orchestrator python -c \
  "import asyncio; from app.capabilities.audit import verify_chain; from uuid import UUID; from app.db import get_pool; ..."

# Watch logs for capability events
docker compose logs -f orchestrator | grep -iE "capability|consent|audit"
```

**Common gotchas:**

- The `RULE ... DO INSTEAD NOTHING` clauses on `capability_audit` mean UPDATE/DELETE return `0 rows affected` silently. If a test expects "deletion failed," check row count, not exceptions.
- Fernet keys must be 32-byte URL-safe base64 — generate with `Fernet.generate_key()`. Don't reuse SECRET_KEY-style strings.
- `httpx.AsyncClient` must be used as `async with` context manager OR explicitly closed; otherwise asyncpg/Redis get sad about leaked sockets.
- Per-tenant hash chain serialization is via Postgres advisory lock (`pg_advisory_xact_lock`). Concurrent writes from different tenants are unaffected; same-tenant writes serialize.
- The dashboard Settings sections live in `dashboard/src/pages/settings/` per Jeremy's memory — follow that structure, don't invent a new layout.
- `git add -A` is forbidden per memory. Stage explicitly.
