"""Wizard passthroughs — the browser only ever talks to core (ruling R8)."""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import parse_qs

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import proxies, settings_store
from tests import fakes
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


async def _agent_coder(pool) -> None:
    """A live agent `coder`, so `agent_coder` passes the no-such-agent check."""
    await pool.execute(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, created_via) "
        "VALUES ('coder', 'writes code', 'be terse', ARRAY['workspace_write_file'], 8, 'page')"
    )


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
    await _agent_coder(pool)
    gateway = FakeGateway(
        admin_body={"role": "agent_coder", "chain": [ROUTER], "router": {"on": True, "kept": ""}}
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/agent_coder/jev-router", json={"on": True})

    assert resp.status_code == 200
    assert gateway.seen[-1] == ("/admin/routes/agent_coder/jev-router", {"on": True})


# chat_model is chat.model, a fact only core holds, and the gateway takes it as
# core's: it would keep a client's value as the pick the router replaced and
# hand it back on OFF as chat.model — a model chat.model never held. So a
# client's chat_model never reaches the gateway, whatever the role.
async def test_a_client_chat_model_never_reaches_the_gateway_for_an_agent_role(
    owner_client, mount_peers, pool
):
    await _agent_coder(pool)
    gateway = FakeGateway(
        admin_body={"role": "agent_coder", "chain": [ROUTER], "router": {"on": True, "kept": ""}}
    )
    mount_peers(gateway=gateway)

    resp = await owner_client.put(
        "/api/v1/routes/agent_coder/jev-router", json={"on": True, "chat_model": CHAT_PICK}
    )

    assert resp.status_code == 200
    assert gateway.seen[-1] == ("/admin/routes/agent_coder/jev-router", {"on": True})


async def test_a_client_chat_model_never_reaches_the_gateway_while_chat_model_is_empty(
    owner_client, mount_peers
):
    gateway = FakeGateway(
        admin_body={"role": "chat", "chain": [ROUTER], "router": {"on": True, "kept": ""}}
    )
    mount_peers(gateway=gateway)

    resp = await owner_client.put(
        "/api/v1/routes/chat/jev-router", json={"on": True, "chat_model": "openrouter:x/y"}
    )

    assert resp.status_code == 200
    assert gateway.seen[-1] == ("/admin/routes/chat/jev-router", {"on": True})


async def test_an_agent_roles_switch_never_writes_chat_model(owner_client, mount_peers, pool):
    """Only a role whose turns send chat.model can have its switch move it: an
    agent role's answer that names one writes nothing."""
    await _agent_coder(pool)
    gateway = FakeGateway(
        admin_body={
            "role": "agent_coder",
            "chain": [ROUTER],
            "router": {"on": True, "kept": ""},
            "chat_model": ROUTER,
        }
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/agent_coder/jev-router", json={"on": True})

    assert resp.status_code == 200
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK


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


def _switched(gateway: FakeGateway, role: str = "chat") -> list[tuple[str, dict | None]]:
    """Every switch request the gateway saw for `role`, in order."""
    return [seen for seen in gateway.seen if seen[0] == f"/admin/routes/{role}/jev-router"]


@dataclass
class _SwitchAnswersInTurn(FakeGateway):
    """A gateway whose switch answers each PUT with the next of
    `switch_answers` — (status, body) — so a test can make the second one
    differ from the first."""

    switch_answers: list[tuple[int, dict]] = field(default_factory=list)

    async def _admin(self, request):
        if not request.url.path.endswith("/jev-router"):
            return await super()._admin(request)
        await self._record(request)
        if not fakes._bearer_ok(request, fakes.GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        status, body = self.switch_answers.pop(0)
        return JSONResponse(body, status_code=status)


# An OFF on the chat model: the gateway names the pick chat.model must go back
# to, and reads the switch off once it has.
OFF_ANSWER = {
    "role": "chat",
    "chain": [],
    "router": {"on": False, "kept": None},
    "chat_model": CHAT_PICK,
}


async def test_once_an_offs_chat_model_is_written_the_off_is_asked_once_more(
    owner_client, mount_peers, pool
):
    """The gateway keeps the pick until core has written it, so a failed write
    can be retried. Once it is written, core asks the same OFF again: the
    switch reads off now, and the gateway's OFF-while-off forgets the pick, so
    a Jev Router picked by hand later never hands back a pick from this
    switch. The owner gets the first answer, which names the chat model."""
    gateway = FakeGateway(admin_body=OFF_ANSWER)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, ROUTER)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": False})

    assert resp.status_code == 200
    assert resp.json() == OFF_ANSWER
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK
    assert _switched(gateway) == [
        ("/admin/routes/chat/jev-router", {"on": False, "chat_model": ROUTER}),
        ("/admin/routes/chat/jev-router", {"on": False, "chat_model": CHAT_PICK}),
    ]


async def test_a_chat_model_that_cannot_be_written_never_asks_the_off_again(
    owner_client, mount_peers, pool, monkeypatch
):
    """A failed write is the stated 502, and the OFF is not asked again: the
    switch still reads on, the gateway still keeps the pick, and OFF can be
    retried."""
    gateway = FakeGateway(admin_body=OFF_ANSWER)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, ROUTER)

    async def refused(body):
        raise RuntimeError("the settings table is locked")

    monkeypatch.setattr(settings_store, "write_setting", refused)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": False})

    assert resp.status_code == 502
    assert resp.json()["error"] == (
        "the gateway switched Jev Router, but chat.model could not be written — "
        "RuntimeError: the settings table is locked"
    )
    assert _switched(gateway) == [
        ("/admin/routes/chat/jev-router", {"on": False, "chat_model": ROUTER}),
    ]
    assert await settings_store.read_value(pool, "chat.model") == ROUTER


async def test_an_on_that_writes_the_chat_model_is_asked_once(owner_client, mount_peers, pool):
    """ON puts the router in the chat model and keeps the pick it replaced:
    that pick is not stale, so nothing is asked again."""
    answer = {
        "role": "chat",
        "chain": [],
        "router": {"on": True, "kept": CHAT_PICK},
        "chat_model": ROUTER,
    }
    gateway = FakeGateway(admin_body=answer)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": True})

    assert resp.status_code == 200 and resp.json() == answer
    assert _switched(gateway) == [
        ("/admin/routes/chat/jev-router", {"on": True, "chat_model": CHAT_PICK}),
    ]


async def test_an_off_asked_again_that_fails_is_said_in_the_answers_note(
    owner_client, mount_peers, pool
):
    """The switch is off and chat.model is written, so the answer is still a
    200 — but the gateway did not forget the pick it kept, and the note says
    so, in the gateway's words, after any note of its own."""
    gone = "the chat model Jev Router replaced, x, names a provider that no longer exists"
    first = {**OFF_ANSWER, "note": gone}
    gateway = _SwitchAnswersInTurn(
        switch_answers=[(200, first), (500, {"error": "the routes table is locked"})]
    )
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, ROUTER)

    resp = await owner_client.put("/api/v1/routes/chat/jev-router", json={"on": False})

    assert resp.status_code == 200
    assert resp.json() == {
        **first,
        "note": f"{gone}; chat.model is written, but asking the gateway to forget the model Jev "
        "Router replaced failed — the routes table is locked",
    }
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK
    assert len(_switched(gateway)) == 2


async def test_the_routes_page_never_forwards_a_browsers_chat_model(owner_client, mount_peers):
    """chat.model and the roles whose turns send it are core's to state, as on
    the switch: a browser's `chat_model` or `chat_model_roles` — spelled
    plainly or percent-encoded — never reaches the gateway, whether core
    states its own or has none to state. Every other parameter goes byte for
    byte."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)
    planted = (
        "chat_model=openrouter%3Aevil&keep=a+b&chat_model_roles=agent_coder"
        "&chat%5Fmodel=openrouter%3Aevil&chat_model_roles"
    )

    assert (await owner_client.get(f"/api/v1/routes?{planted}")).status_code == 200
    assert gateway.queries[-1] == b"keep=a+b"

    await _chat_model_is(owner_client, CHAT_PICK)
    assert (await owner_client.get(f"/api/v1/routes?{planted}")).status_code == 200
    query = gateway.queries[-1]
    assert query.startswith(b"keep=a+b&")
    sent = parse_qs(query.decode())
    assert sent["chat_model"] == [CHAT_PICK]
    (roles,) = sent["chat_model_roles"]
    assert sorted(roles.split(",")) == ["beat", "chat", "scheduled"]


async def test_the_switchs_refusal_comes_back_in_the_gateways_words(
    owner_client, mount_peers, pool
):
    """Relayed as it came, and only a 200 writes chat.model: this refusal names
    one, which the gateway's never do, so nothing but the status stops it."""
    refusal = {
        "error": (
            f"scheduled's first link is the chat model, {CHAT_PICK}, a cloud model it shares "
            "with chat — switch Jev Router on for chat"
        ),
        "chat_model": ROUTER,
    }
    gateway = FakeGateway(admin_status=400, admin_body=refusal)
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, CHAT_PICK)

    resp = await owner_client.put("/api/v1/routes/scheduled/jev-router", json={"on": True})

    assert resp.status_code == 400
    assert resp.json() == refusal
    assert await settings_store.read_value(pool, "chat.model") == CHAT_PICK


# The decision role's two switches (decision-role spec §6). The walk a
# decision call takes follows them, and the gateway reads none of core's
# settings — so explaining the decisions role states them, as a decision call
# does, and no browser can state its own.


async def _switch_is(owner_client, key: str, on: bool) -> None:
    resp = await owner_client.put("/api/v1/settings", json={"key": key, "value": on})
    assert resp.status_code == 200, resp.text


async def test_the_decisions_walk_is_explained_with_the_kinds_he_switched_on(
    owner_client, mount_peers
):
    """So "right now: X would answer" names the link that would: local (alpha)
    ships off and cloud (beta) on, and both off names none."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)

    assert (await owner_client.get("/api/v1/routes/explain?role=decisions")).status_code == 200
    assert gateway.queries[-1] == b"role=decisions&decision_kinds=cloud"

    await _switch_is(owner_client, "decisions.local", True)
    await owner_client.get("/api/v1/routes/explain?role=decisions")
    assert parse_qs(gateway.queries[-1].decode())["decision_kinds"] == ["cloud,local"]

    await _switch_is(owner_client, "decisions.local", False)
    await _switch_is(owner_client, "decisions.cloud", False)
    await owner_client.get("/api/v1/routes/explain?role=decisions")
    assert gateway.queries[-1] == b"role=decisions&decision_kinds="


async def test_explain_never_forwards_a_browsers_decision_kinds(owner_client, mount_peers):
    """Only core states the switches — spelled plainly or percent-encoded, a
    browser's copy is taken out for every role, and core adds its own only for
    the decisions role. Every other parameter goes byte for byte."""
    gateway = FakeGateway()
    mount_peers(gateway=gateway)
    planted = "decision_kinds=local&keep=a+b&decision%5Fkinds=local"

    assert (
        await owner_client.get(f"/api/v1/routes/explain?role=decisions&{planted}")
    ).status_code == 200
    assert gateway.queries[-1] == b"role=decisions&keep=a+b&decision_kinds=cloud"

    await owner_client.get(f"/api/v1/routes/explain?role=chat&{planted}")
    assert gateway.queries[-1] == b"role=chat&keep=a+b"


# One write path for "chat answers with this model" (2026-10-05). The chat
# picker, Models and Settings each wrote chat.model alone, so a pick replaced
# link 1 and the model it replaced was in no chain at all: one pick in chat
# dropped the Dell's model, and nothing anywhere showed it was gone.
GEMINI = "openrouter:google/gemini-3.8-flash"
GLM = "openrouter:z-ai/glm-5.3-flash"
DELL = "dell:qwen3:8b"


class RoutesGateway:
    """The three gateway answers a pick reads and writes, shaped as the real
    gateway shapes them:

    * GET /admin/routes reads chat's Jev Router switch as ON only when core
      states chat.model (`?chat_model=`), as routing.role_state does — a
      switch holding the chat-model slot is invisible without it;
    * PUT /admin/routes/chat refuses a link whose prefix names no registered
      provider, in routing._clean_chain's words — a bare id included;
    * GET /admin/providers lists the registered names and the default.
    """

    def __init__(self, chain, *, router_when_stated=None, names=("hub", "dell", "openrouter")):
        self.chain = list(chain)
        self.router_when_stated = router_when_stated
        self.names = names
        self.puts: list[list[str]] = []
        self.route_queries: list[dict] = []
        self.app = Starlette(
            routes=[
                Route("/admin/routes", self._routes, methods=["GET"]),
                Route("/admin/routes/chat", self._put, methods=["PUT"]),
                Route("/admin/providers", self._providers, methods=["GET"]),
            ]
        )

    async def _routes(self, request):
        query = parse_qs(request.url.query)
        self.route_queries.append(query)
        stated = self.router_when_stated is not None and "chat_model" in query
        router = self.router_when_stated if stated else {"on": False, "kept": None}
        return JSONResponse(
            {"roles": [{"role": "chat", "chain": self.chain, "router": router}], "walls": []}
        )

    async def _put(self, request):
        chain = (await request.json())["chain"]
        for link in chain:
            if link.partition(":")[0] not in self.names:
                return JSONResponse(
                    {"error": f"link {link!r} does not name a registered provider"},
                    status_code=400,
                )
        self.puts.append(chain)
        self.chain = chain
        return JSONResponse({"role": "chat", "chain": chain})

    async def _providers(self, request):
        return JSONResponse(
            {"providers": [{"name": n, "is_default": n == "hub"} for n in self.names]}
        )


async def test_a_pick_becomes_link_one_and_the_pick_it_replaces_the_first_fallback(
    owner_client, mount_peers, pool
):
    gateway = RoutesGateway([GEMINI])
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, DELL)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": GLM})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"chat_model": GLM, "chain": [DELL, GEMINI]}
    assert gateway.puts == [[DELL, GEMINI]]
    assert await settings_store.read_value(pool, "chat.model") == GLM


async def test_a_fallback_picked_leaves_the_fallbacks_and_is_never_listed_twice(
    owner_client, mount_peers, pool
):
    gateway = RoutesGateway([GEMINI, DELL])
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, GEMINI)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": DELL})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"chat_model": DELL, "chain": [GEMINI]}
    assert gateway.puts == [[GEMINI]]
    assert await settings_store.read_value(pool, "chat.model") == DELL


async def test_picking_the_current_pick_only_takes_its_repeat_out_of_the_fallbacks(
    owner_client, mount_peers, pool
):
    # The live state that day: link 1 and link 2 were both Gemini.
    gateway = RoutesGateway([GEMINI])
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, GEMINI)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": GEMINI})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"chat_model": GEMINI, "chain": []}
    assert gateway.puts == [[]]


async def test_a_bare_pick_is_carried_as_the_default_providers_model(
    owner_client, mount_peers, pool
):
    # Onboarding writes the curated slug bare (`qwen3:8b`): the gateway reads
    # it as the DEFAULT provider's model and refuses it bare in a chain, so it
    # is carried qualified — and a qualified copy already in the chain is the
    # same model, never a second link.
    gateway = RoutesGateway(["hub:qwen3:8b", GEMINI])
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, "qwen3:8b")

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": GLM})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"chat_model": GLM, "chain": ["hub:qwen3:8b", GEMINI]}
    assert await settings_store.read_value(pool, "chat.model") == GLM


async def test_a_chain_that_cannot_be_stored_still_makes_the_pick_and_says_what_was_not_kept(
    owner_client, mount_peers, pool
):
    # A fallback whose provider was removed since: every chain PUT is refused.
    # A stale chain must never make every pick fail — the pick is made as it
    # was before this write existed, and the answer says what was not kept.
    gateway = RoutesGateway(["gone:old-model"])
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, DELL)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": GLM})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["chat_model"] == GLM and body["chain"] == ["gone:old-model"]
    assert "does not name a registered provider" in body["note"]
    assert f"{DELL} was not kept as a fallback" in body["note"]
    assert gateway.puts == []
    assert await settings_store.read_value(pool, "chat.model") == GLM


async def test_a_pick_cannot_run_while_jev_router_holds_chats_cloud_link(
    owner_client, mount_peers, pool
):
    # The switch in the chat-model slot is visible only when chat.model is
    # stated on the read — the case the first version of this missed.
    gateway = RoutesGateway([GEMINI], router_when_stated={"on": True, "kept": GLM})
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, "openrouter:typesafe/jev-router")

    resp = await owner_client.put(
        "/api/v1/routes/chat/primary?chat_model=steered", json={"model": DELL}
    )

    assert resp.status_code == 409
    assert "Jev Router" in resp.json()["error"]
    (query,) = gateway.route_queries
    # core states its own chat.model; a caller's copy never reaches the gateway
    assert query["chat_model"] == ["openrouter:typesafe/jev-router"]
    assert gateway.puts == []
    assert await settings_store.read_value(pool, "chat.model") == ("openrouter:typesafe/jev-router")


async def test_a_router_picked_by_hand_is_replaced_like_any_pick(owner_client, mount_peers, pool):
    # On, with nothing kept: the owner picked Jev Router in chat himself. The
    # switch's OFF refuses that case ("pick a chat model in chat"), so a pick
    # refusing it too would leave no way out.
    router = "openrouter:typesafe/jev-router"
    gateway = RoutesGateway([GEMINI], router_when_stated={"on": True, "kept": None})
    mount_peers(gateway=gateway)
    await _chat_model_is(owner_client, router)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json={"model": DELL})

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"chat_model": DELL, "chain": [router, GEMINI]}
    assert await settings_store.read_value(pool, "chat.model") == DELL


@pytest.mark.parametrize("body", [{}, {"model": ""}, {"model": "  "}, {"model": 3}, ["x"]])
async def test_a_pick_names_a_model(owner_client, mount_peers, body):
    gateway = RoutesGateway([])
    mount_peers(gateway=gateway)

    resp = await owner_client.put("/api/v1/routes/chat/primary", json=body)

    assert resp.status_code == 400
    assert gateway.route_queries == [] and gateway.puts == []
