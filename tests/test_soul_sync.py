"""
Soul sync — Settings → Nova Identity must be the source of truth for the
memory bundle's self/soul.md (orchestrator/app/soul_sync.py).

PATCHing nova.persona through the config API must rewrite the soul file so
the Brain graph and memory retrieval present the operator-set identity, not
whatever template seeded the bundle. The original persona is restored on
teardown, which also exercises the sync a second time.
"""

import uuid

import httpx
import pytest
import pytest_asyncio

SOUL_ID = "self/soul.md"


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
    assert marker in body["content"], (
        "soul.md did not pick up the persona saved in Settings"
    )
    assert body["frontmatter"].get("nova_managed_by") == "settings:nova.persona"


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
    content = item.json()["content"]
    assert marker not in content
    if restore_persona:
        # Persona text is mirrored verbatim into the soul body
        assert restore_persona.strip()[:60] in content
