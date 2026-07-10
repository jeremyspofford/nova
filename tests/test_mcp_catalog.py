"""Unit tests for the MCP integration catalog (Slice 1 — one-click integrations).

Pure logic — no services. Verifies template rendering, secret handling (secrets
become ${secret:...} refs + a persist list, never plaintext in env/args), and the
validation guards. Orchestrator's app.* is imported in isolation via
tests/_service_app.py.

Run:
    cd tests && uv run --with-requirements requirements.txt pytest test_mcp_catalog.py -v
"""
from __future__ import annotations

import pytest
from _service_app import service_app


@pytest.fixture
def cat():
    with service_app("orchestrator") as import_module:
        yield import_module("app.mcp_catalog")


def test_catalog_templates_well_formed(cat):
    valid_radii = {"read", "mutate", "destruct"}
    ids = set()
    for tpl in cat.list_catalog():
        assert tpl["id"] not in ids, f"duplicate id {tpl['id']}"
        ids.add(tpl["id"])
        assert tpl["transport"] in ("stdio", "http")
        assert tpl["category"] in cat.CATEGORIES
        # stdio needs a command; http needs a url
        if tpl["transport"] == "stdio":
            assert tpl.get("command"), tpl["id"]
        else:
            assert tpl.get("url"), tpl["id"]
        for val in (tpl.get("tool_blast_radius") or {}).values():
            assert val in valid_radii, f"{tpl['id']}: bad blast radius {val}"
        for f in tpl.get("fields") or []:
            assert "key" in f and "label" in f


def test_home_assistant_secret_becomes_reference(cat):
    tpl = cat.get_template("home-assistant")
    payload, secrets = cat.render_install(
        tpl, "home-assistant",
        {"base_url": "http://ha.local:8123", "token": "SECRET-TOKEN"},
    )
    # Plaintext secret is collected for platform_secrets, keyed by field.
    assert secrets == [("mcp.home-assistant.token", "SECRET-TOKEN")]
    # env holds a reference, never the plaintext.
    assert payload["env"]["HA_TOKEN"] == "${secret:mcp.home-assistant.token}"
    assert payload["env"]["HA_URL"] == "http://ha.local:8123"
    assert "SECRET-TOKEN" not in str(payload)
    assert payload["metadata"]["tool_blast_radius"]["unlock"] == "destruct"
    assert payload["metadata"]["catalog_id"] == "home-assistant"


def test_filesystem_no_secret_path_in_args(cat):
    tpl = cat.get_template("filesystem")
    payload, secrets = cat.render_install(tpl, "filesystem", {"root_path": "/workspace/data"})
    assert secrets == []
    assert "/workspace/data" in payload["args"]
    assert payload["env"] == {}


def test_missing_required_field_raises(cat):
    tpl = cat.get_template("home-assistant")
    with pytest.raises(ValueError, match="required"):
        cat.render_install(tpl, "ha", {"base_url": "http://ha.local"})  # token missing


def test_unknown_field_raises(cat):
    tpl = cat.get_template("brave-search")
    with pytest.raises(ValueError, match="Unknown"):
        cat.render_install(tpl, "brave", {"api_key": "k", "bogus": "x"})


def test_secret_in_args_is_rejected(cat):
    # A malformed template that puts a secret field into args must fail closed —
    # a secret in args would be stored plaintext and show in the process list.
    bad = {
        "id": "bad", "name": "Bad", "category": "dev", "transport": "stdio",
        "command": "run", "args": ["--key", "${api_key}"], "env_template": {},
        "fields": [{"key": "api_key", "label": "Key", "secret": True, "required": True}],
    }
    with pytest.raises(ValueError, match="Secret field"):
        cat.render_install(bad, "bad", {"api_key": "leak"})


def test_slugify(cat):
    assert cat.slugify("Home Assistant") == "home-assistant"
    assert cat.slugify("  n8n!! ") == "n8n"
    assert cat.slugify("@@@") == "integration"


def test_get_template_is_isolated_copy(cat):
    a = cat.get_template("n8n")
    a["name"] = "MUTATED"
    b = cat.get_template("n8n")
    assert b["name"] == "n8n"
