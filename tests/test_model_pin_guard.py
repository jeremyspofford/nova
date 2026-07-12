"""Model pin guard — nothing may ever point at a model that doesn't exist.

Two enforcement points, both exercised against real services:
  * write-time: pod / agent model pins are validated against the gateway's
    discovered catalog (422 for a model no provider serves)
  * delete-time: the gateway refuses to delete a local Ollama model while any
    pod, agent, or config knob still references it (409 naming the pinners),
    and passes through normally when nothing does
"""
import pytest

BOGUS_MODEL = "nova-test-no-such-model-xyz"


async def _local_backend_up(llm_gateway) -> bool:
    """The 422 tests need discovery to positively rule the bogus model out,
    which requires a reachable local backend (otherwise validation fails open)."""
    resp = await llm_gateway.get("/v1/models/discover")
    if resp.status_code != 200:
        return False
    return any(p.get("type") == "local" and p.get("available") for p in resp.json())


@pytest.mark.asyncio
async def test_references_empty_for_unknown_model(orchestrator, admin_headers):
    resp = await orchestrator.get(
        "/api/v1/models/references",
        params={"model": BOGUS_MODEL},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["count"] == 0
    assert body["references"] == []


@pytest.mark.asyncio
async def test_agent_pin_to_nonexistent_model_rejected(
    orchestrator, llm_gateway, admin_headers, create_test_pod
):
    if not await _local_backend_up(llm_gateway):
        pytest.skip("no local backend up — existence validation fails open")
    pod = await create_test_pod("pin-guard", agents=[])
    resp = await orchestrator.post(
        f"/api/v1/pods/{pod['id']}/agents",
        json={"name": "nova-test-agent", "role": "task", "model": BOGUS_MODEL},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    assert BOGUS_MODEL in resp.json()["detail"]


@pytest.mark.asyncio
async def test_pod_default_to_nonexistent_model_rejected(
    orchestrator, llm_gateway, admin_headers
):
    if not await _local_backend_up(llm_gateway):
        pytest.skip("no local backend up — existence validation fails open")
    resp = await orchestrator.post(
        "/api/v1/pods",
        json={"name": "nova-test-bogus-default", "default_model": BOGUS_MODEL},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_auto_and_tier_pins_always_pass(
    orchestrator, admin_headers, create_test_pod
):
    """'auto' and 'tier:*' resolve at request time — never blocked."""
    pod = await create_test_pod("pin-guard-auto", agents=[
        {"name": "nova-test-auto", "role": "task", "model": "auto", "position": 0},
        {"name": "nova-test-tier", "role": "context", "model": "tier:cheap", "position": 1},
    ])
    assert pod["id"]


@pytest.mark.asyncio
async def test_delete_referenced_model_blocked(
    orchestrator, llm_gateway, admin_headers, create_test_pod
):
    """Pin a real pulled model, then try to delete it: the gateway must 409."""
    resp = await llm_gateway.get("/v1/models/ollama/pulled")
    if resp.status_code != 200 or not resp.json():
        pytest.skip("no local Ollama models pulled")
    # Smallest model on disk — if the guard were broken, the cheapest to re-pull.
    model = min(resp.json(), key=lambda m: m.get("size", 0))["name"]

    await create_test_pod("delete-guard", agents=[
        {"name": "nova-test-pinned", "role": "task", "model": model},
    ])

    refs = await orchestrator.get(
        "/api/v1/models/references", params={"model": model}, headers=admin_headers,
    )
    assert refs.status_code == 200
    assert any(r["name"].startswith("nova-test-") for r in refs.json()["references"])

    resp = await llm_gateway.delete(f"/v1/models/ollama/{model}")
    assert resp.status_code == 409, f"expected 409, got {resp.status_code}: {resp.text}"
    assert "nova-test-" in resp.json()["detail"]

    # Nothing was deleted.
    resp = await llm_gateway.get("/v1/models/ollama/pulled")
    assert model in {m["name"] for m in resp.json()}


@pytest.mark.asyncio
async def test_delete_unreferenced_model_passes_through(llm_gateway):
    """No references → the guard steps aside (Ollama answers 404 for a bogus name)."""
    resp = await llm_gateway.delete(f"/v1/models/ollama/{BOGUS_MODEL}")
    assert resp.status_code in (404, 502), resp.text
