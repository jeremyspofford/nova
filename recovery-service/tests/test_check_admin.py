"""Tests for the recovery service's _check_admin auth dependency.

The recovery container sits behind the dashboard's `/recovery-api` proxy and
must accept requests from trusted networks (loopback, Docker bridge, LAN,
Tailscale) without an explicit X-Admin-Secret or JWT — this is symmetric with
the orchestrator and the other internal services (memory, cortex, llm-gateway)
which all rely on `nova_worker_common.service_auth.TrustedNetworkMiddleware`.

Without the bypass, dashboard sessions opened via trusted-network bypass
on the orchestrator (no JWT minted) get a 401 from recovery on every call —
which is exactly the bug we're fixing.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routes import _check_admin


def fake_request(*, is_trusted: bool) -> SimpleNamespace:
    """Build a stand-in for fastapi.Request that exposes only request.state."""
    return SimpleNamespace(state=SimpleNamespace(is_trusted_network=is_trusted))


@pytest.mark.asyncio
async def test_check_admin_bypasses_on_trusted_network():
    """A request from a trusted CIDR passes auth even with no headers."""
    await _check_admin(
        request=fake_request(is_trusted=True),
        authorization="",
        x_admin_secret="",
    )


@pytest.mark.asyncio
async def test_check_admin_rejects_untrusted_with_no_credentials():
    """Untrusted requests with no credentials are still 401'd."""
    with pytest.raises(HTTPException) as exc_info:
        await _check_admin(
            request=fake_request(is_trusted=False),
            authorization="",
            x_admin_secret="",
        )
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_check_admin_treats_missing_state_as_untrusted():
    """If the middleware never ran (e.g., wrong mount order), default to deny."""
    bare = SimpleNamespace(state=SimpleNamespace())  # no is_trusted_network attr
    with pytest.raises(HTTPException) as exc_info:
        await _check_admin(request=bare, authorization="", x_admin_secret="")
    assert exc_info.value.status_code == 401
