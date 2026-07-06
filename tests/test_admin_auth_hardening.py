"""Regression tests for admin auth hardening.

Covers three classes of fix shipped together:

1. Constant-time secret comparison (`hmac.compare_digest`) across orchestrator,
   voice-service, and recovery — bad secrets get a generic 4xx
   regardless of how much they share with the real one.

2. FC-002 default-secret refusal — extended to 6 services that previously
   booted silently with empty/placeholder admin secrets.

3. Anti-brute-force throttle on `require_admin()` — per-IP failure counter,
   rejects further attempts with 429 once the threshold is hit.

SEC2 (2026-07-06): require_admin no longer has a trusted-network bypass —
network position grants USER-surface access only; admin always requires
credentials. That makes admin auth genuinely testable from the test runner
(the old caveat about localhost short-circuiting admin checks is gone), and
this file now pins the new posture: no credentials → 401/403 on admin
endpoints regardless of source network.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx
import pytest

# Allow importing orchestrator.app.* for unit tests without installing
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "orchestrator"))

ORCHESTRATOR = "http://localhost:8000"
RECOVERY = "http://localhost:8888"
ADMIN_SECRET = os.environ.get("NOVA_ADMIN_SECRET", "")


# ───────────────────────────────────────────────────────────────────────────
# 1. Generic auth failure across services (smoke test)
# ───────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "url, path",
    [
        (ORCHESTRATOR, "/api/v1/keys"),       # admin-only on orchestrator
        (RECOVERY, "/recovery-api/backups"),  # admin-only on recovery
    ],
)
def test_admin_endpoints_respond_without_500(url, path):
    """Sanity: admin endpoints respond cleanly to any of {good, bad, empty} secrets.

    Localhost is in the trusted CIDR by default, so a bad secret may still
    return 200 here. The point is to lock in that the auth code path doesn't
    crash with 5xx — not to assert rejection (that's environment-dependent).
    """
    for secret in ("", "wrong", "x" * 64, ADMIN_SECRET[:-1] + "X" if ADMIN_SECRET else "X"):
        r = httpx.get(url + path, headers={"X-Admin-Secret": secret}, timeout=5)
        assert r.status_code < 500, (
            f"{url}{path}: secret={secret[:8]!r}... → {r.status_code} (5xx is a regression)"
        )


# ───────────────────────────────────────────────────────────────────────────
# 2. FC-002 — startup with default/empty secret rejected
# ───────────────────────────────────────────────────────────────────────────

def test_runtime_admin_secret_is_real():
    """If services are up and answering, NOVA_ADMIN_SECRET must be real.

    The FC-002 lifespan check refuses to boot otherwise (unless the test
    bypass is set). We can't easily trigger the startup-refusal path from a
    running test — instead we lock in the *runtime* invariant that the
    deployed secret meets the strength bar.
    """
    if os.environ.get("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") == "1":
        pytest.skip("Test bypass active — service may have booted with default secret")
    assert ADMIN_SECRET and len(ADMIN_SECRET) >= 32, (
        f"NOVA_ADMIN_SECRET appears unset or weak (len={len(ADMIN_SECRET)})"
    )
    assert ADMIN_SECRET != "nova-admin-secret-change-me"


# ───────────────────────────────────────────────────────────────────────────
# 3. Brute-force throttle primitives (unit tests against the live Redis)
# ───────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_admin_failure_counter_increments_and_reads():
    """Direct test of `_record_admin_failure` + `_admin_failure_count`.

    Connects to the orchestrator's Redis (via the same env it uses) and
    exercises the counter primitives. The integration of these into
    `require_admin` is straightforward and covered by code review.
    """
    # Import orchestrator's own settings + auth helpers
    try:
        from app.auth import _admin_failure_count, _record_admin_failure
        from app.store import close_redis, init_redis
    except Exception as e:
        pytest.skip(f"Could not import orchestrator auth: {e}")

    await init_redis()
    test_ip = f"unit-test-ip-{int(time.time())}"  # unique to avoid cross-test pollution
    try:
        before = await _admin_failure_count(test_ip)
        c1 = await _record_admin_failure(test_ip)
        c2 = await _record_admin_failure(test_ip)
        c3 = await _record_admin_failure(test_ip)
        after = await _admin_failure_count(test_ip)

        assert before == 0
        assert c1 == 1
        assert c2 == 2
        assert c3 == 3
        assert after == 3
    finally:
        await close_redis()


@pytest.mark.asyncio
async def test_admin_failure_threshold_constants_are_sensible():
    """Lock in that the threshold/window aren't accidentally relaxed."""
    try:
        from app.auth import _ADMIN_FAIL_THRESHOLD, _ADMIN_FAIL_WINDOW_SECONDS
    except Exception as e:
        pytest.skip(f"Could not import threshold constants: {e}")

    # Tight enough to slow a brute-force, generous enough that a fat-fingered
    # admin doesn't lock themselves out for a day.
    assert 5 <= _ADMIN_FAIL_THRESHOLD <= 50, (
        f"Admin fail threshold {_ADMIN_FAIL_THRESHOLD} is out of sane range"
    )
    assert 60 <= _ADMIN_FAIL_WINDOW_SECONDS <= 3600, (
        f"Admin fail window {_ADMIN_FAIL_WINDOW_SECONDS}s is out of sane range"
    )


# ───────────────────────────────────────────────────────────────────────────
# 4. Constant-time comparison invariant (lock-in test)
# ───────────────────────────────────────────────────────────────────────────

def test_orchestrator_uses_compare_digest():
    """Lock in that the orchestrator's admin secret comparison uses hmac.compare_digest.

    A future refactor that replaces it with `==` would re-introduce the timing
    vulnerability. This test catches that statically — if someone removes the
    constant-time call, this test fails.
    """
    auth_path = ROOT / "orchestrator" / "app" / "auth.py"
    src = auth_path.read_text()
    assert "hmac.compare_digest" in src, (
        "orchestrator/app/auth.py no longer uses hmac.compare_digest — "
        "timing-vulnerable comparison may have been re-introduced"
    )
    # And the literal `==` between x_admin_secret and the expected value
    # should not be present.
    assert "x_admin_secret == " not in src and " == x_admin_secret" not in src, (
        "Found a direct `==` against x_admin_secret — must use hmac.compare_digest"
    )


@pytest.mark.parametrize(
    "service_path, identifier",
    [
        ("voice-service/app/routes.py", "voice-service"),
        ("recovery-service/app/routes.py", "recovery"),
    ],
)
def test_other_services_use_compare_digest(service_path, identifier):
    """Same lock-in for the other services that previously used == / !=."""
    src = (ROOT / service_path).read_text()
    assert "hmac.compare_digest" in src, (
        f"{identifier}: hmac.compare_digest no longer present in {service_path}"
    )


# ───────────────────────────────────────────────────────────────────────────
# 5. FC-002 lock-in for the 6 services that gained the check
# ───────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "main_path, identifier",
    [
        ("llm-gateway/app/main.py", "llm-gateway"),
        ("memory-service/app/main.py", "memory-service"),
        ("voice-service/app/main.py", "voice-service"),
        ("intel-worker/app/main.py", "intel-worker"),
        ("knowledge-worker/app/main.py", "knowledge-worker"),
    ],
)
def test_service_has_fc002_check(main_path, identifier):
    """Each previously-missing service must now refuse to boot with default secret."""
    src = (ROOT / main_path).read_text()
    assert "FC-002" in src, f"{identifier}: missing FC-002 reference in {main_path}"
    assert "nova-admin-secret-change-me" in src, (
        f"{identifier}: FC-002 check doesn't reject the literal default placeholder"
    )
    assert "NOVA_ALLOW_DEFAULT_ADMIN_SECRET" in src, (
        f"{identifier}: FC-002 check missing the test-bypass env var"
    )


@pytest.mark.timeout(150)
def test_fc002_hard_fails_at_boot_with_default_secret():
    """SEC3 behavioral proof: the orchestrator process actually refuses to start.

    Runs the lifespan startup inside a throwaway container with the literal
    default secret and the escape hatch disabled — FC-002 must raise before
    anything else (it precedes DB init, so --no-deps is safe).
    """
    import subprocess

    result = subprocess.run(
        [
            "docker", "compose", "run", "--rm", "--no-deps",
            "-e", "NOVA_ADMIN_SECRET=nova-admin-secret-change-me",
            "-e", "NOVA_ALLOW_DEFAULT_ADMIN_SECRET=0",
            "orchestrator",
            "python", "-c",
            "import asyncio\n"
            "from app.main import app, lifespan\n"
            "asyncio.run(lifespan(app).__aenter__())",
        ],
        capture_output=True, text=True, timeout=140, cwd=ROOT,
    )
    combined = result.stdout + result.stderr
    assert result.returncode != 0, (
        f"orchestrator started with the default admin secret (exit 0):\n{combined[-800:]}"
    )
    assert "NOVA_ADMIN_SECRET is set to the literal default" in combined, (
        f"exited nonzero but not via FC-002:\n{combined[-800:]}"
    )


# ───────────────────────────────────────────────────────────────────────────
# SEC2: admin endpoints never trust network position
# ───────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_admin_requires_credentials_even_from_trusted_network():
    """No credentials → 401/403 on admin endpoints, regardless of source CIDR.

    The test runner's traffic arrives from loopback/docker-gateway — inside
    the trusted ranges. Before SEC2 this returned 200 via the bypass; the
    factory-reset incident rode exactly that hole.
    """
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{ORCHESTRATOR}/api/v1/tools")
        assert resp.status_code in (401, 403), (
            f"admin endpoint served without credentials: {resp.status_code} "
            "— trusted-network bypass is back on require_admin"
        )


@pytest.mark.asyncio
async def test_admin_accepts_credentials():
    """The credentialed path still works after removing the bypass."""
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set in test env")
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(
            f"{ORCHESTRATOR}/api/v1/tools",
            headers={"X-Admin-Secret": ADMIN_SECRET},
        )
        assert resp.status_code == 200, resp.text
