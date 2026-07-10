"""FU-009 — platform-secret hot-reload, end to end.

A key saved through the orchestrator's admin secrets API must reach the
running llm-gateway without a restart: PATCH → nova:secrets:invalidate
pubsub → gateway re-resolve → env overlay → provider availability flips
in the catalog. Removal must apply live the same way.

The probe provider is chosen at runtime: the first cloud provider that is
currently unavailable (no key in .env or platform_secrets), so both the
add flip (False→True) and the remove flip (True→False) are genuinely
observable and no real deployment key is ever touched. Skips only when
every candidate provider is already configured. No mocks per project
rule — real services.
"""
from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest

# slug → platform_secrets key; gemini is excluded (ADC can make it
# available without a key, which would break the flip assertions).
_CANDIDATES: dict[str, str] = {
    "nvidia": "NVIDIA_NIM_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "github": "GITHUB_TOKEN",
    "groq": "GROQ_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
}
_APPLY_TIMEOUT_S = 15.0


async def _availability(llm_gateway: httpx.AsyncClient) -> dict[str, bool]:
    r = await llm_gateway.get("/v1/health/providers")
    r.raise_for_status()
    return {p["slug"]: bool(p["available"]) for p in r.json()}


async def _wait_for_available(
    llm_gateway: httpx.AsyncClient, slug: str, expected: bool
) -> bool:
    deadline = asyncio.get_event_loop().time() + _APPLY_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        if (await _availability(llm_gateway)).get(slug) == expected:
            return True
        await asyncio.sleep(0.5)
    return False


@pytest.mark.asyncio
async def test_secret_patch_applies_to_gateway_without_restart(
    orchestrator: httpx.AsyncClient,
    llm_gateway: httpx.AsyncClient,
    admin_headers: dict,
):
    # Pick a provider that is genuinely unconfigured so both flips are real.
    available = await _availability(llm_gateway)
    probe_slug = next(
        (s for s in _CANDIDATES if available.get(s) is False), None
    )
    if probe_slug is None:
        pytest.skip("every candidate provider is configured on this instance")
    probe_key = _CANDIDATES[probe_slug]

    probe_value = f"nova-test-hotreload-{uuid.uuid4().hex[:12]}"
    try:
        # PATCH via the same endpoint the dashboard uses.
        r = await orchestrator.patch(
            "/api/v1/admin/secrets",
            headers=admin_headers,
            json={"updates": {probe_key: probe_value}},
        )
        assert r.status_code == 200, r.text

        # The gateway must pick the key up live — no restart.
        assert await _wait_for_available(llm_gateway, probe_slug, True), (
            f"gateway never marked {probe_slug} available after its key was "
            "saved — hot-reload did not propagate"
        )
    finally:
        r = await orchestrator.delete(
            f"/api/v1/admin/secrets/{probe_key}", headers=admin_headers
        )
        assert r.status_code in (204, 404), r.text

    # Revocation must apply live too: the provider drops back out.
    assert await _wait_for_available(llm_gateway, probe_slug, False), (
        f"gateway still reports {probe_slug} available after its key was "
        "removed — revocation did not propagate"
    )
