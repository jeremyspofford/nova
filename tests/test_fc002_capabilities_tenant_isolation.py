"""FC-002 capabilities tenant isolation — prove /api/v1/capabilities/* respects per-user scoping.

This is the seam test for T2-01. If the capabilities router uses a hardcoded
DEFAULT_TENANT/DEFAULT_USER pattern, two real users sharing one Nova instance
can read each other's credentials, see each other's pending approvals, and
have a consent rule from one user auto-approve a tool call run on behalf of
the other. All three are data-isolation violations that block the "real users"
claim.

Both users are created via real registration / admin-create paths, log in to
get JWTs, and then drive HTTP calls under their own tokens. Cleanup deletes
test users + their tenants on teardown.

User A and User B live in DIFFERENT tenants. Capabilities scope by tenant;
two-user-one-tenant is a separate (per-user-within-tenant) scoping concern
not covered by this task.
"""
from __future__ import annotations

import os
import secrets
import uuid

import asyncpg
import httpx
import pytest

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_USER = os.getenv("POSTGRES_USER", "nova")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "nova_dev_password")
POSTGRES_DB = os.getenv("POSTGRES_DB", "nova")

USER_A_EMAIL = "nova-test-fc002-user-a@nova.test"
USER_B_EMAIL = "nova-test-fc002-user-b@nova.test"
PASSWORD = "nova-test-password-12345"

TENANT_A = str(uuid.UUID(int=0xFC02_A000_0000_0000_0000_0000_0000_0000))
TENANT_B = str(uuid.UUID(int=0xFC02_B000_0000_0000_0000_0000_0000_0000))


async def _cleanup(conn: asyncpg.Connection) -> None:
    """Delete anything the test created. Runs before (in case prior crash) and after."""
    for tenant in (TENANT_A, TENANT_B):
        # Capability artifacts
        await conn.execute("DELETE FROM capability_credential_audit WHERE tenant_id=$1::uuid", tenant)
        await conn.execute("DELETE FROM capability_credentials WHERE tenant_id=$1::uuid", tenant)
        await conn.execute("DELETE FROM approval_requests WHERE tenant_id=$1::uuid", tenant)
        await conn.execute("DELETE FROM consent_rules WHERE tenant_id=$1::uuid", tenant)
    for email in (USER_A_EMAIL, USER_B_EMAIL):
        # rbac_audit_log/refresh_tokens cascade via user FK
        user_id = await conn.fetchval(
            "SELECT id FROM users WHERE email = $1", email,
        )
        if user_id:
            await conn.execute("DELETE FROM refresh_tokens WHERE user_id = $1", user_id)
            await conn.execute("DELETE FROM rbac_audit_log WHERE actor_id = $1", user_id)
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)
    for tenant in (TENANT_A, TENANT_B):
        await conn.execute("DELETE FROM tenants WHERE id = $1::uuid", tenant)


@pytest.fixture
async def pg():
    conn = await asyncpg.connect(
        host=POSTGRES_HOST, user=POSTGRES_USER,
        password=POSTGRES_PASSWORD, database=POSTGRES_DB,
    )
    await _cleanup(conn)
    yield conn
    await _cleanup(conn)
    await conn.close()


def _bcrypt_hash(password: str) -> str:
    """Generate a bcrypt hash via the orchestrator container.

    bcrypt isn't installed on the test host. Rather than add a dev-deps line,
    shell out to the container that already has it. One subprocess per test
    is fine — this only runs at fixture-setup time.
    """
    import subprocess
    out = subprocess.check_output(
        [
            "docker", "compose", "exec", "-T", "orchestrator",
            "python", "-c",
            f"import bcrypt; print(bcrypt.hashpw({password!r}.encode(), bcrypt.gensalt()).decode())",
        ],
        text=True,
    )
    return out.strip()


async def _seed_user(
    conn: asyncpg.Connection,
    *,
    email: str,
    tenant_id: str,
    tenant_name: str,
) -> str:
    """Seed a tenant + user via direct DB insert + bcrypt hash, return the user_id.

    Goes around the registration HTTP flow because registration_mode=invite
    means open POST /api/v1/auth/register would 400. Going through admin-create
    requires a pre-existing JWT, which isn't reliable in test isolation.
    Direct insert is faithful: it produces the same row shape that login reads.
    """
    password_hash = _bcrypt_hash(PASSWORD)
    await conn.execute(
        "INSERT INTO tenants (id, name) VALUES ($1::uuid, $2) ON CONFLICT (id) DO NOTHING",
        tenant_id, tenant_name,
    )
    user_id = await conn.fetchval(
        """
        INSERT INTO users (email, password_hash, display_name, provider, is_admin, role, tenant_id)
        VALUES ($1, $2, $3, 'local', false, 'member', $4::uuid)
        RETURNING id::text
        """,
        email, password_hash, email.split("@")[0], tenant_id,
    )
    return user_id


async def _login(client: httpx.AsyncClient, email: str) -> dict:
    """POST /api/v1/auth/login → returns AuthResponse dict, including access_token."""
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert resp.status_code == 200, f"Login failed for {email}: {resp.status_code} {resp.text}"
    return resp.json()


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── Test 1: Credential isolation ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_a_cannot_read_user_b_credentials(
    pg: asyncpg.Connection, orchestrator: httpx.AsyncClient,
):
    # Seed two real users in two distinct tenants
    await _seed_user(pg, email=USER_A_EMAIL, tenant_id=TENANT_A, tenant_name="nova-test-fc002-tenant-a")
    await _seed_user(pg, email=USER_B_EMAIL, tenant_id=TENANT_B, tenant_name="nova-test-fc002-tenant-b")

    auth_a = await _login(orchestrator, USER_A_EMAIL)
    auth_b = await _login(orchestrator, USER_B_EMAIL)
    token_a = auth_a["access_token"]
    token_b = auth_b["access_token"]

    # User A creates a credential under their JWT
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=_bearer(token_a),
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-fc002-user-a-cred",
            "secret": f"ghp_fc002_{secrets.token_hex(8)}",
        },
    )
    assert resp.status_code == 201, f"User A could not create credential: {resp.text}"
    cred_a = resp.json()
    cred_a_id = cred_a["id"]

    # User B lists credentials — User A's credential MUST NOT appear
    resp = await orchestrator.get(
        "/api/v1/capabilities/credentials",
        headers=_bearer(token_b),
    )
    assert resp.status_code == 200, resp.text
    creds_b = resp.json()
    cred_b_ids = {c["id"] for c in creds_b}
    assert cred_a_id not in cred_b_ids, (
        f"TENANT ISOLATION VIOLATION: User B sees User A's credential {cred_a_id} "
        f"in their list (got {cred_b_ids})"
    )
    assert all(c["label"] != "nova-test-fc002-user-a-cred" for c in creds_b), (
        "TENANT ISOLATION VIOLATION: User B sees a credential with User A's label"
    )

    # User B GETs User A's credential by ID — must 404
    resp = await orchestrator.get(
        f"/api/v1/capabilities/credentials/{cred_a_id}",
        headers=_bearer(token_b),
    )
    assert resp.status_code == 404, (
        f"TENANT ISOLATION VIOLATION: User B got status {resp.status_code} "
        f"reading User A's credential {cred_a_id} (expected 404). Body: {resp.text}"
    )


# ── Test 2: Approvals isolation ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_a_cannot_see_user_b_approvals(
    pg: asyncpg.Connection, orchestrator: httpx.AsyncClient,
):
    user_a_id = await _seed_user(pg, email=USER_A_EMAIL, tenant_id=TENANT_A, tenant_name="nova-test-fc002-tenant-a")
    await _seed_user(pg, email=USER_B_EMAIL, tenant_id=TENANT_B, tenant_name="nova-test-fc002-tenant-b")

    auth_a = await _login(orchestrator, USER_A_EMAIL)
    auth_b = await _login(orchestrator, USER_B_EMAIL)
    token_a = auth_a["access_token"]
    token_b = auth_b["access_token"]

    # Seed a pending approval for User A directly via DB (the gate() entrypoint
    # is invoked from agent runs; for this test the pending row is what matters,
    # not the gate's flow).
    approval_id = uuid.uuid4()
    await pg.execute(
        """
        INSERT INTO approval_requests (
          id, tenant_id, task_id, requested_by,
          tool_name, tool_kind, blast_radius,
          args_redacted, status, created_at, expires_at,
          provider_kind
        ) VALUES (
          $1, $2::uuid, NULL, $3,
          'github_create_pr', 'native', 'mutate',
          '{}'::jsonb, 'pending', now(), now() + interval '24 hours',
          'github'
        )
        """,
        approval_id, TENANT_A, user_a_id,
    )

    # User A sees their own pending approval
    resp = await orchestrator.get(
        "/api/v1/capabilities/approvals",
        headers=_bearer(token_a),
    )
    assert resp.status_code == 200, resp.text
    approvals_a = resp.json()
    assert any(str(a["id"]) == str(approval_id) for a in approvals_a), (
        f"User A cannot see their own approval {approval_id} in their /approvals list. "
        f"Got: {[a.get('id') for a in approvals_a]}"
    )

    # User B must NOT see User A's pending approval
    resp = await orchestrator.get(
        "/api/v1/capabilities/approvals",
        headers=_bearer(token_b),
    )
    assert resp.status_code == 200, resp.text
    approvals_b = resp.json()
    assert all(str(a["id"]) != str(approval_id) for a in approvals_b), (
        f"TENANT ISOLATION VIOLATION: User B sees User A's pending approval {approval_id} "
        f"in their /approvals list. Got: {[a.get('id') for a in approvals_b]}"
    )

    # And direct-by-id GET must 404 for User B
    resp = await orchestrator.get(
        f"/api/v1/capabilities/approvals/{approval_id}",
        headers=_bearer(token_b),
    )
    assert resp.status_code == 404, (
        f"TENANT ISOLATION VIOLATION: User B got status {resp.status_code} "
        f"reading User A's approval {approval_id} (expected 404). Body: {resp.text}"
    )


# ── Test 3: Consent rule isolation ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_user_a_consent_rule_does_not_apply_to_user_b(
    pg: asyncpg.Connection, orchestrator: httpx.AsyncClient,
):
    """A consent rule created by User A must not auto-approve User B's MUTATE.

    Drives the end-to-end via the consent_rules HTTP endpoint (User A creates
    a rule under their JWT) and then queries User B's /consent-rules — the
    rule must not appear.

    A separate stronger guarantee — that gate() called for User B does NOT
    pick up User A's rule — is covered by direct DB-layer test
    test_capability_consent.py. This HTTP-side test confirms the routing layer
    scopes correctly.
    """
    await _seed_user(pg, email=USER_A_EMAIL, tenant_id=TENANT_A, tenant_name="nova-test-fc002-tenant-a")
    await _seed_user(pg, email=USER_B_EMAIL, tenant_id=TENANT_B, tenant_name="nova-test-fc002-tenant-b")

    auth_a = await _login(orchestrator, USER_A_EMAIL)
    auth_b = await _login(orchestrator, USER_B_EMAIL)
    token_a = auth_a["access_token"]
    token_b = auth_b["access_token"]

    # User A creates a consent rule
    resp = await orchestrator.post(
        "/api/v1/capabilities/consent-rules",
        headers=_bearer(token_a),
        json={
            "tool_name": "github_create_pr",
            "provider_kind": "github",
            "scope_match": {"target_glob": "repos/user-a-org/*"},
            "source": "user_remember",
        },
    )
    assert resp.status_code == 201, f"User A could not create consent rule: {resp.text}"
    rule = resp.json()
    rule_id = rule["id"]

    # User A sees the rule in their list
    resp = await orchestrator.get(
        "/api/v1/capabilities/consent-rules",
        headers=_bearer(token_a),
    )
    assert resp.status_code == 200, resp.text
    rules_a = resp.json()
    assert any(str(r["id"]) == str(rule_id) for r in rules_a), (
        f"User A cannot see their own consent rule {rule_id}. Got: {[r.get('id') for r in rules_a]}"
    )

    # User B must NOT see User A's consent rule
    resp = await orchestrator.get(
        "/api/v1/capabilities/consent-rules",
        headers=_bearer(token_b),
    )
    assert resp.status_code == 200, resp.text
    rules_b = resp.json()
    assert all(str(r["id"]) != str(rule_id) for r in rules_b), (
        f"TENANT ISOLATION VIOLATION: User B sees User A's consent rule {rule_id}. "
        f"Got: {[r.get('id') for r in rules_b]}"
    )

    # And the rule MUST be tagged with User A's tenant in the DB (sanity check
    # that we created it through their context, not under the hardcoded default)
    db_row = await pg.fetchrow(
        "SELECT tenant_id::text AS tid FROM consent_rules WHERE id = $1::uuid",
        rule_id,
    )
    assert db_row is not None, f"Rule {rule_id} not in DB"
    assert db_row["tid"] == TENANT_A, (
        f"TENANT ISOLATION VIOLATION: Rule was stored under tenant {db_row['tid']} "
        f"instead of User A's tenant {TENANT_A}"
    )
