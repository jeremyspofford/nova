"""Wizard passthroughs — the browser only ever talks to core (ruling R8)."""

from __future__ import annotations

from urllib.parse import parse_qs

import httpx
import pytest

from app import proxies, settings_store
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
    ("POST", "/api/v1/models/catalog/drift", "/admin/catalog/drift", {"model": "qwen3:8b"}),
    ("DELETE", "/api/v1/models", "/admin/models", None),
    # S10: the ledger's events, caps and owner prices (GET /api/v1/spend
    # itself is a real handler — test_spend_api.py).
    ("GET", "/api/v1/spend/events", "/admin/spend/events", None),
    ("GET", "/api/v1/spend/caps", "/admin/spend/caps", None),
    ("PUT", "/api/v1/spend/caps", "/admin/spend/caps", {"provider": "*", "monthly_usd": 20}),
    ("GET", "/api/v1/spend/prices", "/admin/spend/prices", None),
    ("PUT", "/api/v1/spend/prices", "/admin/spend/prices", {"provider": "x", "model": "m"}),
    ("DELETE", "/api/v1/spend/prices", "/admin/spend/prices", None),
    # S10-2: routing.
    ("GET", "/api/v1/routes", "/admin/routes", None),
    ("PUT", "/api/v1/routes/chat", "/admin/routes/chat", {"chain": ["ollama:qwen3:8b"]}),
    ("GET", "/api/v1/routes/explain", "/admin/route/explain", None),
    ("DELETE", "/api/v1/routes/walls/openrouter", "/admin/routes/walls/openrouter", None),
    # S12-2: a role's chain row can be dropped (a stray agent role).
    ("DELETE", "/api/v1/routes/agent_coder", "/admin/routes/agent_coder", None),
    # The decision role (spec §4): the Jev Router switch, an edit to a chain.
    ("PUT", "/api/v1/routes/chat/jev-router", "/admin/routes/chat/jev-router", {"on": False}),
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


async def test_an_agent_role_with_no_agent_is_refused_before_the_gateway(owner_client, mount_peers):
    """S12-2: `agent_<name>` is refused by core, by name, when no such agent
    exists — the Routing page is the only production caller, so a typo is
    refused where the owner types it instead of becoming a chain nobody
    walks. Every other role stays the gateway's to judge."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    resp = await owner_client.put("/api/v1/routes/agent_nobody", json={"chain": []})

    assert resp.status_code == 400
    assert "no agent named 'nobody'" in resp.json()["error"]
    assert gateway.seen == []

    resp = await owner_client.put("/api/v1/routes/chat", json={"chain": []})
    assert resp.status_code == 200
    assert gateway.seen[-1] == ("/admin/routes/chat", {"chain": []})


async def test_the_router_switch_on_an_agent_role_with_no_agent_is_refused_here(
    owner_client, mount_peers
):
    """The same rule as PUT /routes/{role}: a typo'd agent role is refused where
    the owner types it, by name, and the gateway is never asked."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    resp = await owner_client.put("/api/v1/routes/agent_nobody/jev-router", json={"on": False})

    assert resp.status_code == 400
    assert "no agent named 'nobody'" in resp.json()["error"]
    assert gateway.seen == []


# chat.model and the Jev Router switch (decision-role spec §4). The gateway
# reads none of core's settings, yet chat.model is link 1 of every role whose
# turns send it — Nova's own turn kinds — so core states it to the switch, and
# writes it when the switch's answer says what it must become.
CHAT_PICK = "openrouter:anthropic/claude-sonnet-5"
ROUTER = "openrouter:typesafe/jev-router"


async def _chat_model_is(owner_client, value: str) -> None:
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": value})
    assert resp.status_code == 200


async def test_the_routes_page_is_read_with_chat_model_as_link_one_of_the_roles_that_send_it(
    owner_client, mount_peers
):
    """GET /routes names chat.model and the roles whose turns send it — chat,
    scheduled and beat, Nova's own turn kinds (an agent's turn sends no model)
    — so each switch reads what those roles' turns actually reach. Neither is
    sent while chat.model is empty."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    assert (await owner_client.get("/api/v1/routes")).status_code == 200
    assert gateway.queries[-1] == b""

    await _chat_model_is(owner_client, CHAT_PICK)
    resp = await owner_client.get("/api/v1/routes")

    assert resp.status_code == 200
    sent = parse_qs(gateway.queries[-1].decode())
    assert set(sent) == {"chat_model", "chat_model_roles"}
    assert sent["chat_model"] == [CHAT_PICK]
    (roles,) = sent["chat_model_roles"]
    assert sorted(roles.split(",")) == ["beat", "chat", "scheduled"]


@pytest.mark.parametrize("role", ["chat", "scheduled", "beat"])
async def test_the_switch_is_told_chat_model_for_a_role_whose_turns_send_it(
    owner_client, mount_peers, role
):
    gateway = FakeGateway(
        admin_body={"role": role, "chain": [], "router": {"on": False, "kept": None}}
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put(f"/api/v1/routes/{role}/jev-router", json={"on": False})

    assert resp.status_code == 200
    assert gateway.seen[-1] == (
        f"/admin/routes/{role}/jev-router",
        {"on": False, "chat_model": CHAT_PICK},
    )


async def test_an_agent_roles_switch_is_never_told_chat_model(owner_client, mount_peers, pool):
    """An agent's turn sends no model, so its chain's first link is its own:
    chat.model is never stated for it, even while one is set."""
    await pool.execute(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, created_via) "
        "VALUES ('coder', 'writes code', 'be terse', ARRAY['workspace_write_file'], 8, 'page')"
    )
    gateway = FakeGateway(
        admin_body={"role": "agent_coder", "chain": [ROUTER], "router": {"on": True, "kept": ""}}
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/agent_coder/jev-router", json={"on": True})

    assert resp.status_code == 200
    assert gateway.seen[-1] == ("/admin/routes/agent_coder/jev-router", {"on": True})


async def test_the_switch_writes_chat_model_when_its_answer_names_it(
    owner_client, mount_peers, pool
):
    """Chat's cloud link is chat.model: ON makes the router chat's model, and
    the answer says so. Core writes it through the settings writer and hands
    back the gateway's answer as it came."""
    answer = {
        "role": "chat",
        "chain": ["hub:qwen3:8b"],
        "router": {"on": True, "kept": CHAT_PICK},
        "chat_model": ROUTER,
    }
    gateway = FakeGateway(admin_body=answer)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": True})

    assert resp.status_code == 200
    assert resp.json() == answer
    assert gateway.seen[-1] == (
        "/admin/routes/chat/jev-router",
        {"on": True, "chat_model": CHAT_PICK},
    )
    assert await settings_store.read_value(pool, "chat.model") == ROUTER


async def test_an_empty_chat_model_in_the_answer_is_written_as_the_gateways_default(
    owner_client, mount_peers, pool
):
    """OFF when the pick the router replaced names a provider that is gone:
    the answer's chat_model is '' — the gateway's default — with a note saying
    why. An empty string is a value to write, not the absence of one."""
    answer = {
        "role": "chat",
        "chain": [],
        "router": {"on": False, "kept": None},
        "chat_model": "",
        "note": (
            f"the chat model Jev Router replaced, {CHAT_PICK}, names a provider that no longer "
            "exists, so the chat model is cleared — pick one in chat"
        ),
    }
    gateway = FakeGateway(admin_body=answer)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, ROUTER)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": False})

    assert resp.status_code == 200
    assert resp.json() == answer
    assert await settings_store.read_value(pool, "chat.model") == ""


async def test_an_answer_that_names_no_chat_model_leaves_it_alone(owner_client, mount_peers, pool):
    """A local chat model is not the cloud link, so the switch edits the
    stored chain and its answer names no chat model: nothing is written."""
    gateway = FakeGateway(
        admin_body={"role": "chat", "chain": [ROUTER], "router": {"on": True, "kept": ""}}
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, "hub:qwen3:8b")

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": True})

    assert resp.status_code == 200
    assert await settings_store.read_value(pool, "chat.model") == "hub:qwen3:8b"


async def test_a_chat_model_that_cannot_be_written_is_a_502_in_words(
    owner_client, mount_peers, pool, monkeypatch
):
    """The gateway has switched, but for chat the switch IS chat.model — a
    write that fails must never read as a 200. The gateway keeps the link it
    needs to put back, so the switch still reads what the turns reach and can
    be flipped again."""
    gateway = FakeGateway(
        admin_body={
            "role": "chat",
            "chain": [],
            "router": {"on": True, "kept": CHAT_PICK},
            "chat_model": ROUTER,
        }
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    async def refused(body):
        raise RuntimeError("the settings table is locked")

    # The switch writes through the settings writer and nothing else, so this
    # is the one write it can make.
    monkeypatch.setattr(settings_store, "write_setting", refused)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": True})

    assert resp.status_code == 502
    assert resp.json()["error"] == (
        "the gateway switched Jev Router, but chat.model could not be written — "
        "RuntimeError: the settings table is locked"
    )
    assert gateway.seen[-1][0] == "/admin/routes/chat/jev-router"
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK


async def test_the_switchs_refusal_comes_back_in_the_gateways_words(
    owner_client, mount_peers, pool
):
    refusal = {
        "error": (
            f"scheduled's first link is the chat model, {CHAT_PICK}, a cloud model it shares "
            "with chat — switch Jev Router on for chat"
        )
    }
    gateway = FakeGateway(admin_status=400, admin_body=refusal)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/scheduled/jev-router", json={"on": True})

    assert resp.status_code == 400
    assert resp.json() == refusal
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK
