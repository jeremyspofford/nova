"""
Soul sync — Settings → Nova Identity and the memory bundle's self/soul.md
are two-way bound (orchestrator/app/soul_sync.py). The soul body IS
nova.persona, verbatim.

Forward: PATCHing nova.persona rewrites the soul file inline.
Reverse: editing the soul via the memory API is written back into
platform_config by the orchestrator's poll loop (POLL_SECONDS=20).

The original persona is restored on teardown, which also re-exercises the
forward sync.
"""

import asyncio
import uuid

import httpx
import pytest
import pytest_asyncio

SOUL_ID = "self/soul.md"
# Reverse sync is polled (20s interval) — allow two cycles plus slack.
REVERSE_SYNC_TIMEOUT = 50


@pytest_asyncio.fixture
async def restore_persona(orchestrator: httpx.AsyncClient, admin_headers: dict):
    """Snapshot nova.persona and restore it (re-syncing the soul) at teardown."""
    resp = await orchestrator.get("/api/v1/config/nova.persona", headers=admin_headers)
    if resp.status_code != 200:
        pytest.skip(f"Could not read nova.persona: {resp.status_code}")
    original = resp.json()["value"] or ""
    yield original
    await orchestrator.patch(
        "/api/v1/config/nova.persona",
        json={"value": original},
        headers=admin_headers,
    )


@pytest.mark.asyncio
async def test_persona_save_updates_soul(
    orchestrator: httpx.AsyncClient,
    memory: httpx.AsyncClient,
    admin_headers: dict,
    restore_persona: str,
):
    marker = f"nova-test-soul-{uuid.uuid4().hex[:8]}"
    persona = f"{marker} — direct, concise, allergic to flattery."

    resp = await orchestrator.patch(
        "/api/v1/config/nova.persona",
        json={"value": persona},
        headers=admin_headers,
    )
    assert resp.status_code == 200

    item = await memory.get(f"/api/v1/memory/item/{SOUL_ID}")
    assert item.status_code == 200
    body = item.json()
    # The soul body is the persona, verbatim — no template decoration.
    assert body["content"].strip() == persona
    assert body["frontmatter"].get("nova_synced_with") == "settings:nova.persona"
    assert "nova_managed_by" not in body["frontmatter"]


@pytest.mark.asyncio
async def test_soul_edit_flows_back_to_settings(
    orchestrator: httpx.AsyncClient,
    memory: httpx.AsyncClient,
    admin_headers: dict,
    restore_persona: str,
):
    """Reverse path: an edit to soul.md (Brain page / file tools) becomes
    the persona in platform_config within one poll cycle."""
    marker = f"nova-test-soul-{uuid.uuid4().hex[:8]}"
    edited = f"{marker} — edited in the soul file, not in Settings."

    put = await memory.put(
        f"/api/v1/memory/item/{SOUL_ID}", json={"content": edited}
    )
    assert put.status_code == 200

    deadline = asyncio.get_event_loop().time() + REVERSE_SYNC_TIMEOUT
    value = None
    while asyncio.get_event_loop().time() < deadline:
        resp = await orchestrator.get(
            "/api/v1/config/nova.persona", headers=admin_headers
        )
        assert resp.status_code == 200
        value = resp.json()["value"] or ""
        if value.strip() == edited:
            break
        await asyncio.sleep(2)
    assert value.strip() == edited, (
        "soul.md edit was not written back to nova.persona within "
        f"{REVERSE_SYNC_TIMEOUT}s"
    )


@pytest.mark.asyncio
async def test_persona_restore_resyncs_soul(
    orchestrator: httpx.AsyncClient,
    memory: httpx.AsyncClient,
    admin_headers: dict,
    restore_persona: str,
):
    """After restoring the original persona, the soul mirrors it again."""
    marker = f"nova-test-soul-{uuid.uuid4().hex[:8]}"
    await orchestrator.patch(
        "/api/v1/config/nova.persona",
        json={"value": f"{marker} temporary"},
        headers=admin_headers,
    )
    await orchestrator.patch(
        "/api/v1/config/nova.persona",
        json={"value": restore_persona},
        headers=admin_headers,
    )
    item = await memory.get(f"/api/v1/memory/item/{SOUL_ID}")
    assert item.status_code == 200
    assert item.json()["content"].strip() == restore_persona.strip()
