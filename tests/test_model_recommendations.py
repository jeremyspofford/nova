"""Recommended models: manifest, hardware profile, fit gating, pull lifecycle.

Runs against agent-core's proxies (the dashboard path). The pull test downloads
a deliberately tiny model (~46MB) and removes it afterwards.
"""
import json
import os

import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}

TINY_MODEL = "all-minilm:22m"


def _recommended() -> dict:
    r = httpx.get(f"{BASE}/api/v1/llm/models/recommended", headers=ADMIN, timeout=20.0)
    assert r.status_code == 200, r.text
    return r.json()


def test_requires_auth():
    assert httpx.get(f"{BASE}/api/v1/llm/models/recommended").status_code == 401
    assert httpx.get(f"{BASE}/api/v1/llm/hardware").status_code == 401


def test_recommended_shape_and_separation():
    body = _recommended()
    assert body["manifest_source"] in ("bundled", "remote")
    assert len(body["local"]) > 10
    assert len(body["cloud"]) > 5

    for e in body["local"]:
        assert e["cloud"] is False
        assert "installed" in e and "fits" in e and "deny_reason" in e
        assert e["category"] in ("general", "reasoning", "code", "vision", "embedding")
    for e in body["cloud"]:
        assert e["cloud"] is True
        assert e["provider"]
        assert "available" in e


def test_denylist_flags_no_tool_models():
    body = _recommended()
    r1 = [e for e in body["local"] if (e.get("ollama_id") or "").startswith("deepseek-r1")]
    assert r1, "deepseek-r1 entries should exist in the manifest"
    assert all(e["deny_reason"] for e in r1)
    assert all(e["capabilities"]["tools"] is False for e in r1)
    # Denylisted ≠ hidden — they're listed, flagged, and not completion-role models.
    assert all("completion" not in e["roles"] for e in r1)


def test_installed_state_reflects_ollama():
    # Compare against what's actually installed — hardcoding a model name makes
    # the test fail on any host that didn't pull that exact model.
    pulled = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN, timeout=20.0).json()
    installed_ids = {m["name"].removesuffix(":latest") for m in pulled}
    body = _recommended()
    overlap = [e for e in body["local"] if e["ollama_id"] and e["ollama_id"] in installed_ids]
    if not overlap:
        pytest.skip("no manifest-listed model installed on this host")
    assert all(e["installed"] for e in overlap), [e["ollama_id"] for e in overlap]
    absent = [e for e in body["local"] if e["ollama_id"] and e["ollama_id"] not in installed_ids]
    assert all(not e["installed"] for e in absent), [e["ollama_id"] for e in absent if e["installed"]]


def test_hardware_declare_gates_fit():
    original = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN).json()
    try:
        r = httpx.put(
            f"{BASE}/api/v1/llm/hardware",
            headers=ADMIN,
            json={"gpus": [{"name": "RTX 3090", "vram_gb": 24}], "ram_gb": 64},
        )
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "declared"

        body = _recommended()
        assert body["hardware_source"] == "declared"
        by_id = {e["ollama_id"]: e for e in body["local"] if e["ollama_id"]}
        assert by_id["qwen2.5:32b"]["fits"] is True      # 24GB VRAM fits min 24
        assert by_id["llama3.1:70b"]["fits"] is False    # needs 48
        assert by_id["qwen2.5:7b"]["slow_on_cpu"] is False
    finally:
        # Restore whatever was there before (declared profiles persist on disk).
        if original.get("source") == "declared":
            httpx.put(f"{BASE}/api/v1/llm/hardware", headers=ADMIN, json=original)


def test_pull_streams_progress_then_delete():
    # Pull (SSE stream through agent-core proxy).
    statuses = []
    with httpx.stream(
        "POST",
        f"{BASE}/api/v1/llm/models/pull",
        headers=ADMIN,
        json={"model": TINY_MODEL},
        timeout=300.0,
    ) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("data: "):
                evt = json.loads(line[len("data: "):])
                assert "error" not in evt, evt
                if evt.get("status"):
                    statuses.append(evt["status"])
    assert "success" in statuses, f"pull did not succeed: {statuses[-3:]}"
    assert any("pulling" in s or "downloading" in s or "verifying" in s for s in statuses), (
        "expected progress events before success"
    )

    pulled = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN).json()
    names = {m["name"] for m in pulled}
    assert TINY_MODEL in names

    # Delete and confirm gone.
    r = httpx.delete(f"{BASE}/api/v1/llm/models/{TINY_MODEL}", headers=ADMIN)
    assert r.status_code == 200, r.text
    pulled = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN).json()
    assert TINY_MODEL not in {m["name"] for m in pulled}


def test_delete_unknown_model_404():
    r = httpx.delete(f"{BASE}/api/v1/llm/models/definitely-not-a-model:1b", headers=ADMIN)
    assert r.status_code == 404


def test_gpu_check_end_to_end():
    """Nova verifies its own inference path: load model, read VRAM offload, verdict.

    This sandbox has no GPU, so the honest verdict here is 'cpu' — which is
    exactly the condition the check exists to expose.
    """
    r = httpx.post(f"{BASE}/api/v1/llm/hardware/gpu-check", headers=ADMIN, timeout=200.0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] in ("gpu", "partial", "cpu"), body
    assert body["model_tested"]
    assert body["loaded"], "a model must be loaded after the check generation"
    assert body["hint"]
    for m in body["loaded"]:
        assert "vram_pct" in m
