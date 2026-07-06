"""First-boot owner account: registration bootstraps identity, not .env.

The first account on an instance is the owner creating their own instance —
invite/admin registration modes must not apply to them (there is nobody to
invite them; pre-fix, an invite-mode instance could never create its first
account through the UI). Every later registration goes through the
configured mode as usual.

State-sensitivity: this test runs against the live stack. If the instance
has no users, it registers a throwaway first owner to prove the exemption,
verifies the SECOND registration is invite-gated, then deletes the
throwaway so the real operator keeps the first-owner slot. If users already
exist, it verifies only the invite gate.
"""
from __future__ import annotations

import os
import uuid

import httpx
import pytest

ORCHESTRATOR = "http://localhost:8000"
ADMIN_SECRET = os.environ.get("NOVA_ADMIN_SECRET", "")


async def _has_users(c: httpx.AsyncClient) -> bool:
    resp = await c.get(f"{ORCHESTRATOR}/api/v1/auth/providers")
    resp.raise_for_status()
    return bool(resp.json().get("has_users"))


@pytest.mark.asyncio
async def test_first_user_registers_without_invite_then_gate_closes():
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set — cleanup would be impossible")

    async with httpx.AsyncClient(timeout=15) as c:
        if await _has_users(c):
            # Instance already has accounts: only the closed-gate half is testable.
            resp = await c.post(
                f"{ORCHESTRATOR}/api/v1/auth/register",
                json={
                    "email": f"nova-test-{uuid.uuid4().hex[:8]}@test.local",
                    "password": "nova-test-password",
                },
            )
            assert resp.status_code in (400, 403), (
                f"registration without invite must stay gated once users exist: {resp.status_code}"
            )
            return

        # ── No users: prove the first-boot exemption end to end ──────────
        email = f"nova-test-owner-{uuid.uuid4().hex[:8]}@test.local"
        resp = await c.post(
            f"{ORCHESTRATOR}/api/v1/auth/register",
            json={"email": email, "password": "nova-test-password", "display_name": "nova-test-owner"},
        )
        assert resp.status_code == 200, f"first-user registration failed: {resp.text}"
        body = resp.json()
        user = body.get("user") or {}
        assert user.get("role") == "owner", f"first user must be owner, got {user}"
        user_id = user.get("id")
        assert user_id

        try:
            # Second registration without an invite must now be gated.
            resp2 = await c.post(
                f"{ORCHESTRATOR}/api/v1/auth/register",
                json={
                    "email": f"nova-test-{uuid.uuid4().hex[:8]}@test.local",
                    "password": "nova-test-password",
                },
            )
            assert resp2.status_code in (400, 403), (
                f"invite gate must close after the first user: {resp2.status_code}"
            )
        finally:
            # Give the first-owner slot back to the real operator.
            deleted = await c.delete(
                f"{ORCHESTRATOR}/api/v1/admin/users/{user_id}",
                headers={"X-Admin-Secret": ADMIN_SECRET},
            )
            assert deleted.status_code in (200, 204), (
                f"cleanup failed — a nova-test owner account is left behind: {deleted.text}"
            )
