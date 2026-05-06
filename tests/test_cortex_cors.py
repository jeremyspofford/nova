"""FC-004: cortex must not return wildcard CORS for arbitrary origins."""
from __future__ import annotations

import os

import httpx
import pytest

CORTEX_URL = os.getenv("NOVA_CORTEX_URL", "http://localhost:8100")


@pytest.mark.asyncio
async def test_cortex_cors_not_wildcard_for_arbitrary_origin():
    async with httpx.AsyncClient(base_url=CORTEX_URL, timeout=10.0) as client:
        resp = await client.options(
            "/health/ready",
            headers={
                "Origin": "http://evil.example.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        allow_origin = resp.headers.get("access-control-allow-origin", "")
        assert allow_origin != "*", (
            f"Cortex CORS still wildcard for arbitrary origin; got '{allow_origin}'"
        )
