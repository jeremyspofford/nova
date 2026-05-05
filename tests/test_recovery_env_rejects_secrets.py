"""SEC-006a — recovery-service must reject secret keys on the .env patch path.

Once secrets live in `platform_secrets` (orchestrator), they must NOT be
writable via `recovery-service`'s `.env` patch endpoint. The dashboard / any
caller that wants to set a provider key must use the orchestrator's
`/api/v1/admin/secrets` endpoint instead.

Infra-level keys (Cloudflare tunnel token, Tailscale auth key, compose
profiles, vLLM model selection) are still legitimate `.env` writes — those
are consumed by Docker / sidecar containers and have to live there.
"""
from __future__ import annotations

import httpx
import pytest


@pytest.mark.asyncio
async def test_patch_env_rejects_provider_secret_keys(admin_headers):
    """ANTHROPIC_API_KEY (and the rest of the LLM provider keys) must 400."""
    async with httpx.AsyncClient(base_url="http://localhost:8888", timeout=10) as recovery:
        resp = await recovery.patch(
            "/api/v1/recovery/env",
            headers=admin_headers,
            json={"updates": {"ANTHROPIC_API_KEY": "sk-ant-fake-rejected"}},
        )
    assert resp.status_code == 400, (
        f"expected 400 (whitelist rejection), got {resp.status_code}: {resp.text}"
    )


@pytest.mark.asyncio
async def test_patch_env_rejects_chat_bridge_tokens(admin_headers):
    """Telegram + Slack tokens belong in platform_secrets, not .env."""
    async with httpx.AsyncClient(base_url="http://localhost:8888", timeout=10) as recovery:
        resp = await recovery.patch(
            "/api/v1/recovery/env",
            headers=admin_headers,
            json={"updates": {"TELEGRAM_BOT_TOKEN": "fake-rejected-token"}},
        )
    assert resp.status_code == 400, resp.text


@pytest.mark.asyncio
async def test_patch_env_still_accepts_infra_keys(admin_headers):
    """COMPOSE_PROFILES is consumed by docker compose and stays in .env.

    Use a no-op idempotent value so the test doesn't actually shift profiles.
    """
    async with httpx.AsyncClient(base_url="http://localhost:8888", timeout=10) as recovery:
        # Read current value first so we can write it back unchanged.
        before = await recovery.get(
            "/api/v1/recovery/env",
            headers=admin_headers,
        )
        assert before.status_code == 200, before.text
        current = before.json().get("COMPOSE_PROFILES", "")

        resp = await recovery.patch(
            "/api/v1/recovery/env",
            headers=admin_headers,
            json={"updates": {"COMPOSE_PROFILES": current}},
        )
    assert resp.status_code == 200, (
        f"infra key should still write through; got {resp.status_code}: {resp.text}"
    )
