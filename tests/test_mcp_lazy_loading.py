"""Lazy MCP tool loading — capability index, meta-tool, and composition.

Connected MCP servers contribute a one-line capability index entry (carried
in the load_integration_tools meta-tool description) instead of injecting
every tool schema into every LLM call; metadata.always_inject opts a server
back into the old behavior. These tests exercise the composition logic by
injecting fake connected clients into the registry module — no subprocess,
no DB, no LLM.

Orchestrator's `app.*` is imported in isolation (see tests/_service_app.py).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from _service_app import service_app


def _fake_client(server: str, tool_names: list[str], connected: bool = True):
    return SimpleNamespace(
        connected=connected,
        tools=[
            SimpleNamespace(
                server_name=server,
                name=n,
                description=f"{n} does things",
                input_schema={"type": "object", "properties": {}},
            )
            for n in tool_names
        ],
    )


@pytest.fixture
def mcp_env():
    """Orchestrator tool modules with two fake connected MCP servers.

    `lazy-srv` uses the default (lazy) behavior; `hot-srv` sets
    metadata.always_inject. Registry state is restored on teardown.
    """
    with service_app("orchestrator") as import_module:
        registry = import_module("app.pipeline.tools.registry")
        tools_pkg = import_module("app.tools")
        integration = import_module("app.tools.integration_tools")
        permissions = import_module("app.tool_permissions")

        saved_clients = dict(registry._active_clients)
        saved_meta = dict(registry._server_meta)
        registry._active_clients.clear()
        registry._server_meta.clear()

        registry._active_clients["lazy-srv"] = _fake_client(
            "lazy-srv", ["alpha", "beta", "gamma"])
        registry._server_meta["lazy-srv"] = {
            "transport": "stdio", "metadata": {},
            "description": "A lazy test integration",
        }
        registry._active_clients["hot-srv"] = _fake_client("hot-srv", ["delta"])
        registry._server_meta["hot-srv"] = {
            "transport": "stdio", "metadata": {"always_inject": True},
            "description": "An always-injected test integration",
        }

        try:
            yield SimpleNamespace(
                registry=registry,
                tools=tools_pkg,
                integration=integration,
                permissions=permissions,
            )
        finally:
            registry._active_clients.clear()
            registry._active_clients.update(saved_clients)
            registry._server_meta.clear()
            registry._server_meta.update(saved_meta)


# ── Registry: index + per-server split ────────────────────────────────────────

class TestCapabilityIndex:
    def test_index_lists_lazy_servers_only(self, mcp_env):
        index = mcp_env.registry.get_capability_index()
        assert [e["server"] for e in index] == ["lazy-srv"]
        assert index[0]["tool_count"] == 3
        assert index[0]["description"] == "A lazy test integration"

    def test_injected_definitions_are_always_inject_only(self, mcp_env):
        names = {t.name for t in mcp_env.registry.get_injected_mcp_tool_definitions()}
        assert names == {"mcp__hot-srv__delta"}

    def test_full_definitions_still_cover_everything(self, mcp_env):
        # Management surfaces (permission UI, tool picker) keep the full list.
        names = {t.name for t in mcp_env.registry.get_mcp_tool_definitions()}
        assert names == {
            "mcp__lazy-srv__alpha", "mcp__lazy-srv__beta",
            "mcp__lazy-srv__gamma", "mcp__hot-srv__delta",
        }

    def test_server_tool_definitions_single_server(self, mcp_env):
        defs = mcp_env.registry.get_server_tool_definitions("lazy-srv")
        assert {t.name for t in defs} == {
            "mcp__lazy-srv__alpha", "mcp__lazy-srv__beta", "mcp__lazy-srv__gamma",
        }
        assert mcp_env.registry.get_server_tool_definitions("nope") == []

    def test_disconnected_server_drops_out(self, mcp_env):
        mcp_env.registry._active_clients["lazy-srv"].connected = False
        assert mcp_env.registry.get_capability_index() == []
        assert mcp_env.registry.get_server_tool_definitions("lazy-srv") == []


# ── Meta-tool ─────────────────────────────────────────────────────────────────

class TestLoadIntegrationTool:
    def test_description_carries_index_and_enum(self, mcp_env):
        meta = mcp_env.integration.build_load_integration_tool()
        assert meta is not None
        assert "lazy-srv" in meta.description
        assert "3 tools" in meta.description
        assert "hot-srv" not in meta.description
        assert meta.parameters["properties"]["server"]["enum"] == ["lazy-srv"]

    def test_none_when_no_lazy_servers(self, mcp_env):
        mcp_env.registry._active_clients["lazy-srv"].connected = False
        assert mcp_env.integration.build_load_integration_tool() is None

    def test_disabled_group_removes_server(self, mcp_env):
        meta = mcp_env.integration.build_load_integration_tool({"MCP: lazy-srv"})
        assert meta is None

    async def test_load_returns_receipt_and_defs(self, mcp_env):
        text, defs = await mcp_env.integration.load_server_tools(
            "lazy-srv", disabled_groups=set())
        assert "Loaded 3 tools from 'lazy-srv'" in text
        assert "mcp__lazy-srv__alpha" in text
        assert {t.name for t in defs} == {
            "mcp__lazy-srv__alpha", "mcp__lazy-srv__beta", "mcp__lazy-srv__gamma",
        }

    async def test_load_unknown_server_names_alternatives(self, mcp_env):
        text, defs = await mcp_env.integration.load_server_tools(
            "nope", disabled_groups=set())
        assert defs == []
        assert "not connected" in text
        assert "lazy-srv" in text

    async def test_load_disabled_server_refused(self, mcp_env):
        text, defs = await mcp_env.integration.load_server_tools(
            "lazy-srv", disabled_groups={"MCP: lazy-srv"})
        assert defs == []
        assert "disabled" in text


# ── LLM-facing composition ────────────────────────────────────────────────────

class TestToolListComposition:
    def test_get_all_tools_lazy_by_default(self, mcp_env):
        names = {t.name for t in mcp_env.tools.get_all_tools()}
        # Lazy server: index only, no schemas
        assert not any(n.startswith("mcp__lazy-srv__") for n in names)
        # always_inject server: schemas ride along
        assert "mcp__hot-srv__delta" in names
        assert "load_integration_tools" in names

    def test_disabling_lazy_server_removes_meta_tool(self, mcp_env):
        names = {t.name for t in mcp_env.tools.get_permitted_tools({"MCP: lazy-srv"})}
        assert "load_integration_tools" not in names
        assert "mcp__hot-srv__delta" in names

    def test_disabling_hot_server_removes_its_schemas(self, mcp_env):
        names = {t.name for t in mcp_env.tools.get_permitted_tools({"MCP: hot-srv"})}
        assert "mcp__hot-srv__delta" not in names
        assert "load_integration_tools" in names

    def test_pod_allowlist_pin_reinjects_lazy_schema(self, mcp_env):
        # A pod that explicitly allowlists a lazy server's tool gets its
        # schema directly — no load call required.
        pinned = mcp_env.permissions._pinned_mcp_tools(
            {"mcp__lazy-srv__alpha", "read_file"}, {"read_file"}, set())
        assert {t.name for t in pinned} == {"mcp__lazy-srv__alpha"}

    def test_pinned_tool_respects_disabled_group(self, mcp_env):
        pinned = mcp_env.permissions._pinned_mcp_tools(
            {"mcp__lazy-srv__alpha"}, set(), {"MCP: lazy-srv"})
        assert pinned == []


class TestDefaultAllowlist:
    """The global default allowlist (chat surface) must not hide integrations.

    Chat turns run on a deliberately tiny tool allowlist; installed
    integrations stay reachable through the meta-tool (lazy servers) or
    their schemas (always_inject servers). Explicit pod allowlists stay
    exact.
    """

    @pytest.fixture
    def resolve(self, mcp_env, monkeypatch):
        async def _no_disabled():
            return set()

        async def _default_allowlist():
            return ["read_file", "run_shell"]

        monkeypatch.setattr(
            mcp_env.permissions, "get_disabled_tool_groups", _no_disabled)
        monkeypatch.setattr(
            mcp_env.permissions, "get_default_allowed_tools", _default_allowlist)
        return mcp_env.permissions.resolve_effective_tools

    async def test_chat_surface_keeps_integrations_reachable(self, resolve):
        tools, _ = await resolve()
        names = {t.name for t in tools}
        assert "read_file" in names and "run_shell" in names
        assert "load_integration_tools" in names
        assert "mcp__hot-srv__delta" in names
        # Lazy schemas still load-on-demand, and the allowlist still filters
        # the rest of the built-ins.
        assert not any(n.startswith("mcp__lazy-srv__") for n in names)
        assert "write_file" not in names

    async def test_explicit_pod_allowlist_stays_exact(self, resolve):
        tools, _ = await resolve(["read_file"])
        names = {t.name for t in tools}
        assert names == {"read_file"}
