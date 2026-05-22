from audit_tool_use.availability import find_tool_in_mcp_response, is_builtin_tool


def test_builtin_tools_recognized():
    for t in ("fs.write", "fs.read", "shell.exec", "code.execute", "memory.search",
              "memory.write", "nova.secrets.write", "nova.secrets.read",
              "web.search", "web.fetch"):
        assert is_builtin_tool(t)


def test_non_builtin_not_recognized():
    assert not is_builtin_tool("browser_navigate")
    assert not is_builtin_tool("nonsense.thing")


def test_find_tool_in_mcp_response_present():
    payload = [
        {"id": "playwright", "tools": [{"name": "browser_navigate"}, {"name": "browser_click"}]},
    ]
    assert find_tool_in_mcp_response(payload, "browser_navigate") is True


def test_find_tool_in_mcp_response_absent():
    payload = [{"id": "other", "tools": [{"name": "thing"}]}]
    assert find_tool_in_mcp_response(payload, "browser_navigate") is False


def test_find_tool_in_mcp_response_no_servers():
    assert find_tool_in_mcp_response([], "browser_navigate") is False
