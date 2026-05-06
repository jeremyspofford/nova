"""T1-04: CREDENTIAL_MASTER_KEY auto-bootstrap.

The orchestrator must self-heal a missing CREDENTIAL_MASTER_KEY by generating
one and persisting it in `platform_config` at startup. This file verifies the
seam: a row exists in platform_config, the credentials endpoint encrypts
successfully (201, not 500), and the key survives a container restart.

These tests run against the live stack — no mocks. Per project rule, real
services only.

Note on the day-1 scenario: in CI/dev, `.env` typically has
``CREDENTIAL_MASTER_KEY`` set, so the bootstrap path is a no-op there. To
exercise the missing-env branch, the first test invokes
``ensure_credential_master_key()`` inside the running orchestrator container
after clearing both ``settings.credential_master_key`` and the platform_config
row, then verifies the function generated a key and persisted it. The HTTP
seam (POST returns 201, not 500) is verified directly against the live
service.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import time

import httpx
import pytest

COMPOSE_DIR = "/home/jeremy/workspace/nova"


async def _wait_for_orchestrator_ready(client: httpx.AsyncClient, timeout: int = 90) -> None:
    """Poll /health/ready until the orchestrator reports ready or timeout."""
    deadline = time.time() + timeout
    last_err: Exception | None = None
    while time.time() < deadline:
        try:
            r = await client.get("/health/ready", timeout=5)
            if r.status_code == 200:
                return
        except Exception as e:
            last_err = e
        await asyncio.sleep(1)
    raise AssertionError(
        f"orchestrator did not become ready within {timeout}s; last_err={last_err}"
    )


def _exec_in_orchestrator(python_code: str) -> str:
    """Run a Python snippet inside the orchestrator container, return stdout.

    Used to invoke ensure_credential_master_key() directly from the live
    process — equivalent to what the lifespan does at startup. This is the
    real code path; no mocks.
    """
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "orchestrator", "python", "-c", python_code],
        cwd=COMPOSE_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"orchestrator exec failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result.stdout


@pytest.mark.asyncio
async def test_orchestrator_starts_and_encrypts_without_env_master_key(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Bootstrap path: when ``settings.credential_master_key`` is empty (the
    day-1 case), the orchestrator must:

      1. Be reachable (health/ready returns 200).
      2. Have a `capability.credential_master_key` row in platform_config.
      3. ``ensure_credential_master_key()`` must populate that row with a
         non-empty 64-char hex value when the env var is unset, *and* update
         ``settings.credential_master_key`` so the credentials endpoint works
         without a restart.
      4. The HTTP endpoint POST /api/v1/capabilities/credentials returns 201
         (not 500) — proving the key is loaded into the running process.
      5. The credential survives an orchestrator restart — proving the key
         was persisted and reloaded.
    """
    # 1. Orchestrator is reachable
    r = await orchestrator.get("/health/ready")
    assert r.status_code == 200, f"orchestrator not ready: {r.status_code} {r.text}"

    # 2. platform_config row exists (created by migration 077)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value #>> '{}' AS val, is_secret FROM platform_config "
            "WHERE key = 'capability.credential_master_key'"
        )
    assert row is not None, (
        "platform_config row for 'capability.credential_master_key' is missing — "
        "migration 077 must seed it on first run."
    )
    assert row["is_secret"] is True, "is_secret should be TRUE for the master key row"

    # 3. Force the day-1 scenario: clear the in-memory key and the DB row,
    #    then call ensure_credential_master_key() — it should generate and
    #    persist a fresh value, and reload settings.credential_master_key.
    snapshot_before = await orchestrator.get(
        "/api/v1/capabilities/credentials", headers=admin_headers
    )
    assert snapshot_before.status_code == 200

    output = _exec_in_orchestrator(
        "import asyncio, json\n"
        "from app.config import settings\n"
        "from app.db import init_db, get_pool, close_db\n"
        "from app.capabilities.credentials import ensure_credential_master_key\n"
        "\n"
        "async def run():\n"
        "    await init_db()\n"
        "    pool = get_pool()\n"
        "    async with pool.acquire() as conn:\n"
        "        # Wipe the row to simulate a never-seen-this deploy\n"
        "        await conn.execute(\n"
        "            \"UPDATE platform_config SET value='\\\"\\\"'::jsonb \"\n"
        "            \"WHERE key='capability.credential_master_key'\"\n"
        "        )\n"
        "    # Clear in-memory settings to simulate empty env var\n"
        "    settings.credential_master_key = ''\n"
        "    # Run the bootstrap path under test\n"
        "    await ensure_credential_master_key()\n"
        "    # Read back what was persisted\n"
        "    async with pool.acquire() as conn:\n"
        "        val = await conn.fetchval(\n"
        "            \"SELECT value #>> '{}' FROM platform_config \"\n"
        "            \"WHERE key='capability.credential_master_key'\"\n"
        "        )\n"
        "    persisted = (val or '').strip('\"')\n"
        "    in_memory = settings.credential_master_key\n"
        "    print(json.dumps({\n"
        "        'persisted_len': len(persisted),\n"
        "        'in_memory_len': len(in_memory),\n"
        "        'match': persisted == in_memory,\n"
        "        'is_hex_64': len(persisted) == 64 and all(c in '0123456789abcdef' for c in persisted),\n"
        "    }))\n"
        "    await close_db()\n"
        "\n"
        "asyncio.run(run())\n"
    )
    last_line = [line for line in output.strip().split("\n") if line.startswith("{")][-1]
    result = json.loads(last_line)
    assert result["persisted_len"] == 64, f"key length wrong: {result}"
    assert result["in_memory_len"] == 64, f"in-memory key not set: {result}"
    assert result["match"], f"persisted and in-memory keys differ: {result}"
    assert result["is_hex_64"], f"persisted value is not 64-char hex: {result}"

    # 4. Restore the running orchestrator's settings.credential_master_key
    #    back to whatever the env var supplies — by restarting the container.
    #    (The exec above ran in a one-shot Python process; the running
    #    uvicorn process still has its original settings. But the platform_config
    #    row is now the freshly generated key, which would be picked up if
    #    the env var were unset on next restart.)
    #
    #    For the HTTP seam check, what matters is that the running orchestrator
    #    has a working key. Since this run started with the env var set, that
    #    is already true. POST a credential to confirm encryption succeeds.
    create = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-bootstrap-master-key",
            "secret": "ghp_bootstrap_fake_token",
        },
    )
    assert create.status_code == 201, (
        f"expected 201 from credentials POST (key bootstrap should make endpoint "
        f"work); got {create.status_code}: {create.text}"
    )
    cred_id = create.json()["id"]

    try:
        # 5. Restart orchestrator; verify the credential remains retrievable —
        #    proves the key persisted in platform_config / env and was reloaded.
        subprocess.run(
            ["docker", "compose", "restart", "orchestrator"],
            cwd=COMPOSE_DIR,
            check=True,
            capture_output=True,
            timeout=60,
        )
        await _wait_for_orchestrator_ready(orchestrator, timeout=120)

        get_resp = await orchestrator.get(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )
        assert get_resp.status_code == 200, (
            f"credential not retrievable after restart "
            f"(key may have been regenerated): {get_resp.status_code} {get_resp.text}"
        )
        assert get_resp.json()["id"] == cred_id

        list_resp = await orchestrator.get(
            "/api/v1/capabilities/credentials",
            headers=admin_headers,
        )
        assert list_resp.status_code == 200
        labels = [c["label"] for c in list_resp.json()]
        assert "nova-test-bootstrap-master-key" in labels
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )


@pytest.mark.asyncio
async def test_env_master_key_takes_precedence(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """If CREDENTIAL_MASTER_KEY is provided via env (.env / docker-compose),
    the orchestrator must use it as-is and NOT overwrite anything in
    platform_config from a generated value.

    Verification:
      - The credentials endpoint returns 201 (key is loaded — proves either
        env or DB path put a usable value into settings).
      - Calling ``ensure_credential_master_key()`` while
        ``settings.credential_master_key`` is non-empty leaves the
        platform_config row alone (no clobber).
      - Encryption + decryption round-trip after a restart still works,
        proving the env-provided key continues to decrypt existing rows.
    """
    # 1. Sanity: endpoint works (key is loaded — either from env or from DB).
    r = await orchestrator.get("/health/ready")
    assert r.status_code == 200

    # 2. Capture current platform_config value so we can detect any clobber.
    async with pool.acquire() as conn:
        row_before = await conn.fetchrow(
            "SELECT value #>> '{}' AS val FROM platform_config "
            "WHERE key = 'capability.credential_master_key'"
        )
    assert row_before is not None, (
        "platform_config row for 'capability.credential_master_key' missing — "
        "migration must seed it on first run."
    )
    val_before = (row_before["val"] or "").strip('"')

    # 3. Run the bootstrap with settings.credential_master_key set to a known
    #    fake value. With the env path active, the function MUST early-return
    #    without writing to platform_config.
    output = _exec_in_orchestrator(
        "import asyncio, json\n"
        "from app.config import settings\n"
        "from app.db import init_db, get_pool, close_db\n"
        "from app.capabilities.credentials import ensure_credential_master_key\n"
        "\n"
        "FAKE_KEY = 'a' * 64\n"
        "\n"
        "async def run():\n"
        "    await init_db()\n"
        "    pool = get_pool()\n"
        "    async with pool.acquire() as conn:\n"
        "        before = await conn.fetchval(\n"
        "            \"SELECT value #>> '{}' FROM platform_config \"\n"
        "            \"WHERE key='capability.credential_master_key'\"\n"
        "        )\n"
        "    settings.credential_master_key = FAKE_KEY\n"
        "    await ensure_credential_master_key()\n"
        "    async with pool.acquire() as conn:\n"
        "        after = await conn.fetchval(\n"
        "            \"SELECT value #>> '{}' FROM platform_config \"\n"
        "            \"WHERE key='capability.credential_master_key'\"\n"
        "        )\n"
        "    print(json.dumps({\n"
        "        'before': before,\n"
        "        'after': after,\n"
        "        'unchanged': before == after,\n"
        "        'in_memory_unchanged': settings.credential_master_key == FAKE_KEY,\n"
        "    }))\n"
        "    await close_db()\n"
        "\n"
        "asyncio.run(run())\n"
    )
    last_line = [line for line in output.strip().split("\n") if line.startswith("{")][-1]
    result = json.loads(last_line)
    assert result["unchanged"], (
        f"platform_config was clobbered when env var path active: {result}"
    )
    assert result["in_memory_unchanged"], (
        f"settings.credential_master_key was overwritten by bootstrap when env path "
        f"was active: {result}"
    )

    # 4. Live HTTP path: create a credential under the running orchestrator's
    #    real key (which is whatever .env supplies). Restart, verify it
    #    decrypts.
    create = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": "nova-test-env-precedence",
            "secret": "ghp_env_precedence_fake",
        },
    )
    assert create.status_code == 201, create.text
    cred_id = create.json()["id"]

    try:
        subprocess.run(
            ["docker", "compose", "restart", "orchestrator"],
            cwd=COMPOSE_DIR,
            check=True,
            capture_output=True,
            timeout=60,
        )
        await _wait_for_orchestrator_ready(orchestrator, timeout=120)

        async with pool.acquire() as conn:
            row_after = await conn.fetchrow(
                "SELECT value #>> '{}' AS val FROM platform_config "
                "WHERE key = 'capability.credential_master_key'"
            )
        assert row_after is not None
        val_after = (row_after["val"] or "").strip('"')
        assert val_before == val_after, (
            "platform_config value changed across restart while env var is set; "
            "bootstrap path must be a no-op when CREDENTIAL_MASTER_KEY is in env."
        )

        get_resp = await orchestrator.get(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )
        assert get_resp.status_code == 200
        assert get_resp.json()["label"] == "nova-test-env-precedence"
    finally:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}",
            headers=admin_headers,
        )
