"""Wizard passthroughs — the browser only ever talks to core (ruling R8)."""

from __future__ import annotations

import httpx
import pytest

from app import proxies
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

# (method, core path, the gateway path it must land on, body)
ROUTES = [
    ("GET", "/api/v1/system/hardware", "/admin/hardware", None),
    ("GET", "/api/v1/models/suggest", "/admin/suggest", None),
    ("POST", "/api/v1/models/probe", "/admin/probe", {"model": "qwen3:8b"}),
    ("GET", "/api/v1/inference/backend", "/admin/backend", None),
    ("PUT", "/api/v1/inference/backend", "/admin/backend", {"kind": "ollama"}),
    # The Settings "Models" section's installed-models list (S2e T1): the
    # gateway's OpenAI-compat GET /v1/models, not an /admin/* route — the
    # browser still only ever reaches it through core (ruling R8).
    ("GET", "/api/v1/models", "/v1/models", None),
    # The provider registry (S10-pre): Settings -> Providers reaches the
    # gateway's /admin/providers surface only through core.
    ("GET", "/api/v1/providers", "/admin/providers", None),
    ("GET", "/api/v1/providers/presets", "/admin/providers/presets", None),
    ("POST", "/api/v1/providers", "/admin/providers", {"name": "openrouter"}),
    ("GET", "/api/v1/providers/openrouter", "/admin/providers/openrouter", None),
    ("PUT", "/api/v1/providers/openrouter", "/admin/providers/openrouter", {"model_note": "x"}),
    ("DELETE", "/api/v1/providers/openrouter", "/admin/providers/openrouter", None),
    ("PUT", "/api/v1/providers/openrouter/default", "/admin/providers/openrouter/default", None),
    ("GET", "/api/v1/providers/openrouter/models", "/admin/providers/openrouter/models", None),
    # The model catalogue (S10a): Hugging Face search + repo quants, and a
    # typed ref resolved live. GET /models/catalog itself is a real handler
    # (it adds eval measurements) — pinned in test_models_catalog.py.
    ("GET", "/api/v1/models/catalog/hf", "/admin/catalog/hf", None),
    (
        "GET",
        "/api/v1/models/catalog/hf/unsloth/Qwen3-GGUF",
        "/admin/catalog/hf/unsloth/Qwen3-GGUF",
        None,
    ),
    ("GET", "/api/v1/models/catalog/resolve", "/admin/catalog/resolve", None),
]


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_passthrough_reaches_the_gateway_and_returns_it_verbatim(
    owner_client, mount_peers, method, path, gateway_path, body
):
    gateway = FakeGateway(admin_body={"gpus": [{"name": "RTX 3090", "vram_gb": 24}]})
    mount_peers(gateway=gateway)

    resp = await owner_client.request(method, path, json=body)

    assert resp.status_code == 200
    assert resp.json() == {"gpus": [{"name": "RTX 3090", "vram_gb": 24}]}
    assert gateway.seen[-1] == (gateway_path, body)


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_an_unreachable_gateway_is_a_stated_502(
    owner_client, mount_peers, monkeypatch, method, path, gateway_path, body
):
    mount_peers(gateway=FakeGateway())
    # Nothing is mounted on this URL and nothing listens on port 1.
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")

    resp = await owner_client.request(method, path, json=body)

    assert resp.status_code == 502
    assert "gateway" in resp.json()["error"].lower()


# Percent- and plus-encoded pieces that must survive the hop untouched.
RAW_QUERY = "refresh=true&model=qwen3%3A8b&note=a+b"


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_a_query_string_reaches_the_gateway_byte_identical(
    owner_client, mount_peers, method, path, gateway_path, body
):
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    resp = await owner_client.request(method, f"{path}?{RAW_QUERY}", json=body)

    assert resp.status_code == 200
    assert gateway.queries[-1] == RAW_QUERY.encode()


async def test_pull_forwards_its_query_string_too(owner_client, mount_peers):
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    resp = await owner_client.post(f"/api/v1/models/pull?{RAW_QUERY}", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert gateway.queries[-1] == RAW_QUERY.encode()


async def test_a_gateway_refusal_passes_through_with_its_reason(owner_client, mount_peers):
    mount_peers(
        gateway=FakeGateway(admin_status=502, admin_body={"error": "ollama did not answer"})
    )
    resp = await owner_client.put("/api/v1/inference/backend", json={"kind": "ollama"})
    assert resp.status_code == 502
    assert resp.json() == {"error": "ollama did not answer"}


async def test_pull_streams_the_gateways_progress_lines_through(owner_client, mount_peers):
    gateway = FakeGateway(pull_lines=('{"status":"pulling","completed":1}', '{"status":"success"}'))
    mount_peers(gateway=gateway)

    resp = await owner_client.post("/api/v1/models/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    assert resp.text.splitlines() == [
        '{"status":"pulling","completed":1}',
        '{"status":"success"}',
    ]
    assert gateway.seen[-1] == ("/admin/pull", {"model": "qwen3:8b"})


async def test_pull_with_an_unreachable_gateway_is_a_stated_502(
    owner_client, mount_peers, monkeypatch
):
    mount_peers(gateway=FakeGateway())
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")
    resp = await owner_client.post("/api/v1/models/pull", json={"model": "qwen3:8b"})
    assert resp.status_code == 502
    assert "gateway" in resp.json()["error"].lower()


async def test_an_unconfigured_gateway_link_is_a_stated_502(owner_client, monkeypatch):
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    monkeypatch.delenv("CORE_GATEWAY_TOKEN", raising=False)
    resp = await owner_client.get("/api/v1/system/hardware")
    assert resp.status_code == 502
    assert "GATEWAY_URL" in resp.json()["error"]


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_the_proxies_need_an_identity(client, mount_peers, method, path, gateway_path, body):
    mount_peers(gateway=FakeGateway())
    resp = await client.request(method, path, json=body)
    assert resp.status_code == 401


async def test_a_slow_probe_succeeds_within_its_own_larger_budget(
    owner_client, mount_peers, monkeypatch
):
    """The probe route's own work (a cold-model load through the gateway,
    ruling: proxies.py timeouts must dominate the gateway's downstream
    budget) can legitimately take longer than the generic admin timeout —
    it must wait on its own PROBE_TIMEOUT, not the 5s one that bounds plain
    hardware/suggest/backend-get calls."""
    monkeypatch.setattr(proxies, "PROBE_TIMEOUT", httpx.Timeout(0.3))
    gateway = FakeGateway(admin_body={"id": 1, "ok": True})
    mount_peers(gateway=gateway, gateway_delay=0.15)

    resp = await owner_client.post("/api/v1/models/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert resp.json() == {"id": 1, "ok": True}


async def test_a_probe_past_its_budget_times_out_naming_the_route_not_unreachable(
    owner_client, mount_peers, monkeypatch
):
    monkeypatch.setattr(proxies, "PROBE_TIMEOUT", httpx.Timeout(0.05))
    mount_peers(gateway=FakeGateway(), gateway_delay=0.2)

    resp = await owner_client.post("/api/v1/models/probe", json={"model": "qwen3:8b"})

    assert resp.status_code == 502
    detail = resp.json()["error"].lower()
    assert "timed out" in detail
    assert "unreachable" not in detail
    assert "/admin/probe" in detail


async def test_a_slow_backend_put_succeeds_within_its_own_larger_budget(
    owner_client, mount_peers, monkeypatch
):
    monkeypatch.setattr(proxies, "BACKEND_PUT_TIMEOUT", httpx.Timeout(0.3))
    gateway = FakeGateway(admin_body={"kind": "ollama"})
    mount_peers(gateway=gateway, gateway_delay=0.15)

    resp = await owner_client.put("/api/v1/inference/backend", json={"kind": "ollama"})

    assert resp.status_code == 200
    assert resp.json() == {"kind": "ollama"}


async def test_a_backend_put_past_its_budget_times_out_naming_the_route_not_unreachable(
    owner_client, mount_peers, monkeypatch
):
    monkeypatch.setattr(proxies, "BACKEND_PUT_TIMEOUT", httpx.Timeout(0.05))
    mount_peers(gateway=FakeGateway(), gateway_delay=0.2)

    resp = await owner_client.put("/api/v1/inference/backend", json={"kind": "ollama"})

    assert resp.status_code == 502
    detail = resp.json()["error"].lower()
    assert "timed out" in detail
    assert "unreachable" not in detail
    assert "/admin/backend" in detail


# The two tests above monkeypatch these constants away to drive the dynamic
# timing cases, which means a revert of the split timeout budgets themselves
# (connect/write/pool tight at 5s, only read wide enough to dominate the
# gateway's own downstream work) would not fail anything else in this file.
# Pinned directly instead (S2 seam-hygiene: slice-01-carries.md "S2
# follow-ups").
def test_probe_timeout_shape_is_pinned():
    assert proxies.PROBE_TIMEOUT.connect == 5.0
    assert proxies.PROBE_TIMEOUT.read == 35.0
    assert proxies.PROBE_TIMEOUT.write == 5.0
    assert proxies.PROBE_TIMEOUT.pool == 5.0


def test_backend_put_timeout_shape_is_pinned():
    assert proxies.BACKEND_PUT_TIMEOUT.connect == 5.0
    assert proxies.BACKEND_PUT_TIMEOUT.read == 10.0
    assert proxies.BACKEND_PUT_TIMEOUT.write == 5.0
    assert proxies.BACKEND_PUT_TIMEOUT.pool == 5.0


def test_timed_out_states_an_unbounded_read_for_a_timeout_with_no_read_bound():
    """PULL_TIMEOUT sets read=None on purpose (a slow download between
    progress lines is not a hang), which means httpx can never actually
    raise ReadTimeout against it — there is no bound left to exceed. That
    makes _timed_out's `timeout.read is None` branch unreachable through any
    real request; a direct call is the only way to prove the message it
    would produce if it were ever wired to a bounded-differently timeout."""
    exc = proxies._timed_out("/admin/pull", proxies.PULL_TIMEOUT)
    assert exc.status_code == 502
    assert "an unbounded read" in exc.detail
    assert "/admin/pull" in exc.detail
