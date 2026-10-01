"""The fake MCP server holds the client to the specification (S37a).

A fake that accepts any request proves nothing about the client — S10-pre's
FakeAnthropic lesson. These pin that the fake refuses what a real 2026-07-28
server must refuse, and speaks the two legacy refusals measured in the wild.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.mcp import fake

URL = "http://fake.mcp.invalid/mcp"
META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
}
MODERN_HEADERS = {"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover"}


async def _post(server: fake.FakeServer, body: dict, headers: dict | None = None) -> httpx.Response:
    sent = {"Accept": "application/json, text/event-stream", **(headers or {})}
    async with httpx.AsyncClient(transport=fake.transport(server)) as http:
        return await http.post(URL, json=body, headers=sent)


def _discover(meta: dict = META) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": meta}}


async def test_a_well_formed_modern_discover_is_answered_with_the_title():
    server = fake.FakeServer(fake.FakeSpec(title="GitHub"))
    response = await _post(server, _discover(), MODERN_HEADERS)
    assert response.status_code == 200
    result = response.json()["result"]
    assert result["supportedVersions"] == ["2026-07-28"]
    assert result["_meta"]["io.modelcontextprotocol/serverInfo"]["title"] == "GitHub"
    assert server.calls[0]["method"] == "server/discover"


async def test_a_missing_method_header_is_a_header_mismatch():
    server = fake.FakeServer(fake.FakeSpec())
    response = await _post(server, _discover(), {"MCP-Protocol-Version": "2026-07-28"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32020


async def test_missing_request_meta_is_refused_by_name():
    server = fake.FakeServer(fake.FakeSpec())
    response = await _post(server, _discover(meta={}), MODERN_HEADERS)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == -32602


async def test_a_legacy_fake_refuses_discovery_in_all_three_measured_shapes():
    home_assistant = fake.FakeServer(fake.FakeSpec(era="legacy", legacy_refusal="200"))
    response = await _post(home_assistant, _discover(), MODERN_HEADERS)
    assert response.status_code == 200 and response.json()["error"]["code"] == -32601

    deepwiki = fake.FakeServer(fake.FakeSpec(era="legacy", legacy_refusal="400"))
    response = await _post(deepwiki, _discover(), MODERN_HEADERS)
    assert response.status_code == 400 and response.json()["error"]["code"] == -32600
    assert "Supported versions" in response.json()["error"]["message"]

    playwright = fake.FakeServer(fake.FakeSpec(era="legacy", legacy_refusal="playwright"))
    response = await _post(playwright, _discover(), MODERN_HEADERS)
    assert response.status_code == 400 and response.json()["error"]["code"] == -32000
    assert "not initialized" in response.json()["error"]["message"]


async def test_a_legacy_fake_demands_the_session_it_handed_out():
    server = fake.FakeServer(fake.FakeSpec(era="legacy", tools=(fake.FakeTool("echo"),)))
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    }
    response = await _post(server, init)
    assert response.headers["mcp-session-id"] == fake.SESSION
    listing = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    no_session = await _post(server, listing, {"MCP-Protocol-Version": "2025-11-25"})
    assert no_session.status_code == 400
    with_session = await _post(
        server, listing, {"MCP-Protocol-Version": "2025-11-25", "Mcp-Session-Id": fake.SESSION}
    )
    assert [t["name"] for t in with_session.json()["result"]["tools"]] == ["echo"]
    server.expire_session()
    expired = await _post(
        server, listing, {"MCP-Protocol-Version": "2025-11-25", "Mcp-Session-Id": fake.SESSION}
    )
    assert expired.status_code == 404


async def test_pages_carry_a_cursor_and_sse_frames_the_answer():
    tools = tuple(fake.FakeTool(f"t{i}") for i in range(3))
    server = fake.FakeServer(fake.FakeSpec(page_size=2, respond="sse", tools=tools))
    body = {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {"_meta": META}}
    response = await _post(
        server, body, {"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list"}
    )
    assert response.headers["content-type"].startswith("text/event-stream")
    data = [line[6:] for line in response.text.splitlines() if line.startswith("data: ")]
    result = json.loads(data[-1])["result"]
    assert [t["name"] for t in result["tools"]] == ["t0", "t1"]
    assert result["nextCursor"] == "2"


async def test_a_token_is_demanded_when_the_spec_names_one():
    server = fake.FakeServer(fake.FakeSpec(token="right"))
    assert (await _post(server, _discover(), MODERN_HEADERS)).status_code == 401
    ok = await _post(server, _discover(), {**MODERN_HEADERS, "Authorization": "Bearer right"})
    assert ok.status_code == 200


async def test_an_unreachable_fixture_refuses_the_connection():
    async with httpx.AsyncClient(transport=fake.Unreachable()) as http:
        with pytest.raises(httpx.ConnectError):
            await http.post(URL, json={})


async def test_progress_fires_only_when_the_request_carries_a_token_and_echoes_it():
    """The spec sends notifications/progress only for a request whose _meta
    carried a progressToken, echoing that same value — never one the server
    invents (fix round 1, R2-6)."""
    server = fake.FakeServer(
        fake.FakeSpec(respond="sse", progress=True, tools=(fake.FakeTool("echo"),))
    )
    call_headers = {**MODERN_HEADERS, "Mcp-Method": "tools/call", "Mcp-Name": "echo"}

    def events(response: httpx.Response) -> list[dict]:
        lines = [line[6:] for line in response.text.splitlines() if line.startswith("data: ")]
        return [json.loads(line) for line in lines]

    no_token = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "echo", "arguments": {}, "_meta": META},
    }
    response = await _post(server, no_token, call_headers)
    assert all(e.get("method") != "notifications/progress" for e in events(response))

    with_token = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "echo", "arguments": {}, "_meta": {**META, "progressToken": "tok-1"}},
    }
    response = await _post(server, with_token, call_headers)
    found = [e for e in events(response) if e.get("method") == "notifications/progress"]
    assert len(found) == 1 and found[0]["params"]["progressToken"] == "tok-1"
