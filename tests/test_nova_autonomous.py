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


def test_shell_exec_in_chat_tools():
    """shell.exec must be accessible to Nova in conversational turns."""
    if not _llm_available():
        pytest.skip("no LLM provider configured")
    import uuid
    task_id = str(uuid.uuid4())
    r = httpx.post(
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "nova-test: use shell.exec (not code.execute) to run: echo SHELL_TEST"},
        headers=ADMIN,
        timeout=60.0,
    )
    assert r.status_code == 200
    assert "SHELL_TEST" in r.text


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
    if not _llm_available():
        pytest.skip("no LLM provider configured")
    import uuid
    task_id = str(uuid.uuid4())
    r = httpx.post(
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "nova-test: in one sentence, what do you do before starting a complex multi-step task?"},
        headers=ADMIN,
        timeout=60.0,
    )
    assert r.status_code == 200
    assert len(r.text.strip()) > 10
