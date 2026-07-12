"""Tier resolution — tier hints must never resolve to a model that doesn't exist.

The gateway validates every tier-preference candidate against validated
discovery (real provider calls) instead of the hardcoded registry, and
exposes the verdicts at GET /v1/models/tiers. The orchestrator's assignments
check uses the same data so an unresolvable tier pin is a visible problem,
not a request-time surprise.
"""
import pytest

VALID_STATUSES = {"ok", "no_quota", "provider_unavailable", "unknown_model", "unregistered"}
TIER_NAMES = ("best", "mid", "cheap")


@pytest.mark.asyncio
async def test_tiers_endpoint_shape(llm_gateway, admin_headers):
    resp = await llm_gateway.get("/v1/models/tiers", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body["tiers"].keys()) == set(TIER_NAMES)
    for tier in TIER_NAMES:
        info = body["tiers"][tier]
        assert "resolved" in info
        assert info["preferences"], f"tier '{tier}' has an empty preference list"
        for entry in info["preferences"]:
            assert entry["model"]
            assert entry["status"] in VALID_STATUSES, entry


@pytest.mark.asyncio
async def test_resolved_model_is_a_validated_candidate(llm_gateway, admin_headers):
    """'resolved' must be a preference-list entry that checked out as ok —
    never a model discovery couldn't confirm."""
    resp = await llm_gateway.get("/v1/models/tiers", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    for tier, info in resp.json()["tiers"].items():
        resolved = info["resolved"]
        if resolved is None:
            continue
        ok_models = {
            e.get("resolves_to", e["model"])
            for e in info["preferences"]
            if e["status"] == "ok"
        }
        assert resolved in ok_models, (
            f"tier '{tier}' resolved to {resolved!r}, which is not a "
            f"validated candidate ({ok_models})"
        )


@pytest.mark.asyncio
async def test_tier_hint_completes_on_a_real_model(llm_gateway, admin_headers):
    """A tier-hinted /complete must answer via a model the tier system
    validated — the whole point of the guard."""
    resp = await llm_gateway.get("/v1/models/tiers", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    tiers = resp.json()["tiers"]
    target = next((t for t in ("cheap", "mid", "best") if tiers[t]["resolved"]), None)
    if target is None:
        pytest.skip("no tier resolves on this instance — no providers up")

    resp = await llm_gateway.post(
        "/complete",
        json={
            "tier": target,
            "messages": [{"role": "user", "content": "Reply with exactly: TIER-OK"}],
            "max_tokens": 20,
        },
        timeout=120,
    )
    if resp.status_code == 429:
        pytest.skip("provider quota exhausted mid-test")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("model"), body
    assert body.get("content"), body


@pytest.mark.asyncio
async def test_tier_pin_passes_write_guard_and_is_checked(
    orchestrator, admin_headers, create_test_pod
):
    """tier:* pins are always writable (they resolve at request time), and the
    assignments check reports them with a real verdict instead of a rubber stamp."""
    pod = await create_test_pod("tier-pin", agents=[
        {"name": "nova-test-tier-pin", "role": "context", "model": "tier:cheap"},
    ])
    assert pod["id"]

    resp = await orchestrator.get("/api/v1/models/assignments", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    entries = [
        a for a in resp.json()["assignments"]
        if a["scope"] == "pod_agent" and a["name"].startswith("nova-test-tier-pin")
        or "nova-test-tier-pin" in a["name"]
    ]
    assert entries, "tier-pinned test agent missing from assignments"
    entry = entries[0]
    # 'auto' when the tier (or a lower one) resolves; a problem status only
    # when nothing on any tier is usable.
    assert entry["status"] in ("auto", "provider_unavailable"), entry
    if entry["status"] == "auto":
        assert "resolves" in entry["note"] or "request time" in entry["note"], entry
