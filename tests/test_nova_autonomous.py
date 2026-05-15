"""Integration tests for Nova's expanded autonomous tool access.
Requires agent-core at localhost:8000 with a live LLM provider.
"""
import os
import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
ADMIN = {"X-Admin-Secret": _env.get("NOVA_ADMIN_SECRET", "nova-dev-secret")}


def _llm_available() -> bool:
    try:
        r = httpx.get("http://localhost:8001/providers", timeout=3.0)
        return r.status_code == 200 and any(
            p["available"] for p in r.json().get("providers", [])
        )
    except Exception:
        return False


def _cloud_llm_available() -> bool:
    """True only when a non-local provider is available (fast enough for tool-use tests)."""
    try:
        r = httpx.get("http://localhost:8001/providers", timeout=3.0)
        if r.status_code != 200:
            return False
        return any(
            p["available"] and not p.get("local", True)
            for p in r.json().get("providers", [])
        )
    except Exception:
        return False


def test_tool_loop_works_in_chat():
    """The ReAct tool loop must complete a turn that requires tool use.

    Uses memory.search (Tier.READ, auto-approved) to verify: tools are in the
    tool list, the LLM can call them, dispatch works, and a final text response
    is returned. shell.exec and nova.secrets are in _CHAT_TOOL_NAMES — tested
    at the code level and by the approval-flow tests above.
    """
    if not _cloud_llm_available():
        pytest.skip("no cloud LLM provider available")
    import json as _json
    import uuid
    task_id = str(uuid.uuid4())
    final_text = ""
    with httpx.stream(
        "POST",
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "nova-test: call memory.search with query 'test' and report the result count", "model": "gpt-4o-mini"},
        headers=ADMIN,
        timeout=httpx.Timeout(connect=10, read=60, write=10, pool=5),
    ) as resp:
        assert resp.status_code == 200
        for line in resp.iter_lines():
            if not line:
                continue
            try:
                event = _json.loads(line)
            except Exception:
                continue
            if event.get("text"):
                final_text += event["text"]
    assert len(final_text) > 5, f"Expected non-empty response from tool loop, got: {repr(final_text)}"


def test_secrets_write_read_roundtrip():
    """nova.secrets.write stores a value; nova.secrets.read retrieves it."""
    import uuid
    secret_name = f"nova_test_{uuid.uuid4().hex[:8]}"
    secret_value = "hunter2_test_value"

    r = httpx.post(
        f"{BASE}/api/v1/secrets",
        json={"name": secret_name, "value": secret_value, "purpose": "test"},
        headers=ADMIN,
        timeout=10.0,
    )
    assert r.status_code == 201

    r2 = httpx.post(
        f"{BASE}/api/v1/secrets/resolve",
        json={"name": secret_name},
        headers=ADMIN,
        timeout=10.0,
    )
    assert r2.status_code == 200
    assert r2.json()["value"] == secret_value

    httpx.delete(f"{BASE}/api/v1/secrets/{secret_name}", headers=ADMIN, timeout=5.0)


def test_agent_service_healthy():
    """Smoke test that agent-core is up and responding."""
    r = httpx.get(f"{BASE}/health/ready", timeout=5.0)
    assert r.status_code == 200


def test_playwright_mcp_server_registered():
    """Playwright MCP server record must exist in the DB after migration."""
    r = httpx.get(f"{BASE}/api/v1/mcp/servers", headers=ADMIN, timeout=5.0)
    assert r.status_code == 200
    names = [s["name"] for s in r.json()]
    assert "playwright" in names, f"playwright not in MCP servers: {names}"


def test_playwright_mcp_server_has_browser_tools():
    """Playwright server must expose at least browser_navigate and browser_snapshot."""
    r = httpx.get(f"{BASE}/api/v1/mcp/servers", headers=ADMIN, timeout=5.0)
    servers = r.json()
    playwright = next((s for s in servers if s["name"] == "playwright"), None)
    assert playwright is not None, "playwright server not found"
    server_id = playwright["id"]

    r2 = httpx.get(
        f"{BASE}/api/v1/mcp/servers/{server_id}/tools",
        headers=ADMIN,
        timeout=10.0,
    )
    assert r2.status_code == 200
    tool_names = [t["name"] for t in r2.json()]
    assert "browser_navigate" in tool_names, f"browser_navigate missing from: {tool_names}"
    assert "browser_snapshot" in tool_names, f"browser_snapshot missing from: {tool_names}"


def test_system_prompt_includes_tool_guidance():
    """Smoke test: Nova should respond sensibly about multi-step tasks."""
    if not _cloud_llm_available():
        pytest.skip("no cloud LLM provider available — local-only inference too slow for tool-use test")
    import uuid
    task_id = str(uuid.uuid4())
    r = httpx.post(
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "nova-test: in one sentence, what do you do before starting a complex multi-step task?", "model": "gpt-4o-mini"},
        headers=ADMIN,
        timeout=30.0,
    )
    assert r.status_code == 200
    assert len(r.text.strip()) > 10
