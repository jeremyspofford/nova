"""Nova's MCP client (S37a): the wire (client.py), the rows (servers.py) and a
strict in-process server for tests and eval cases (fake.py).

This file imports nothing. `app.tools` imports `app.mcp.client` at import
time, and a package __init__ that pulled in the store would drag the notices
and checks — and through them `app.tools` itself — into that import.
"""
