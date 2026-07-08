"""
Browser Tools — drive a real browser to navigate, read, and act on the web.

Backed by the browser-worker service (Playwright). The agent runner loop IS
the agentic loop: browser_snapshot returns numbered elements, browser_act
operates on them by ref, repeat. Form submits / account creation are marked
MUTATE so they route through the capability consent gate (human approval)
rather than firing unattended.

Credential capture (store_web_credential / get_web_credential) uses the same
encrypted vault as other capability credentials.
"""
from __future__ import annotations

import logging
from uuid import UUID

import httpx
from nova_contracts import BlastRadius, ToolDefinition
from nova_worker_common.url_validator import validate_url

log = logging.getLogger(__name__)

BROWSER_BASE = "http://browser-worker:8150/api/v1/browser"
_TIMEOUT = httpx.Timeout(45.0)
_DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")

BROWSER_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="browser_open",
        description=(
            "Open a browser session at a URL and return a session_id. Logins "
            "persist per-domain across sessions. Reuse the session_id for all "
            "follow-up actions, then browser_close when done."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to open"},
            },
            "required": ["url"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="browser_snapshot",
        description=(
            "Read the current page as a numbered list of interactive elements "
            "(links, buttons, inputs). Act on elements by their [ref] number "
            "with browser_act. Take a fresh snapshot after any navigation or "
            "action, since refs change. Set screenshot=true to also get an image."
        ),
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "screenshot": {"type": "boolean", "description": "Include a screenshot (default false)"},
            },
            "required": ["session_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="browser_navigate",
        description="Navigate an existing session to a new URL.",
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "url": {"type": "string"},
            },
            "required": ["session_id", "url"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="browser_click",
        description="Click an element by its [ref] number from the latest snapshot.",
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "ref": {"type": "integer", "description": "Element ref from snapshot"},
            },
            "required": ["session_id", "ref"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="browser_type",
        description="Type text into an input/textarea element by its [ref] number.",
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "ref": {"type": "integer"},
                "text": {"type": "string"},
            },
            "required": ["session_id", "ref", "text"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="browser_submit",
        description=(
            "Submit a form or complete a sign-up by clicking a submit/continue "
            "button by its [ref]. Use this (not browser_click) for the final "
            "action that creates an account, sends a message, makes a purchase, "
            "or otherwise commits a change — it is gated for human approval. "
            "Before submitting an account creation, briefly state what you are "
            "signing up for and what credentials you will store."
        ),
        parameters={
            "type": "object",
            "properties": {
                "session_id": {"type": "string"},
                "ref": {"type": "integer", "description": "Ref of the submit button"},
            },
            "required": ["session_id", "ref"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
    ToolDefinition(
        name="browser_close",
        description="Close a browser session and free its resources.",
        parameters={
            "type": "object",
            "properties": {"session_id": {"type": "string"}},
            "required": ["session_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="store_web_credential",
        description=(
            "Securely store a credential you created or were given (login, "
            "generated API key, etc.) in Nova's encrypted vault, keyed by site. "
            "Use this immediately after creating an account or generating a key "
            "so it isn't lost."
        ),
        parameters={
            "type": "object",
            "properties": {
                "site": {"type": "string", "description": "Site/domain the credential is for"},
                "kind": {"type": "string", "enum": ["login", "api_key", "token"], "description": "Credential kind"},
                "username": {"type": "string", "description": "Username/email (optional for api_key)"},
                "secret": {"type": "string", "description": "The password / API key / token"},
            },
            "required": ["site", "kind", "secret"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
    ToolDefinition(
        name="get_web_credential",
        description=(
            "Retrieve a previously stored web credential for a site. Returns the "
            "username and secret so you can log in. Gated for human approval."
        ),
        parameters={
            "type": "object",
            "properties": {
                "site": {"type": "string"},
            },
            "required": ["site"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
]


async def execute_tool(name: str, arguments: dict) -> str:
    try:
        if name == "browser_open":
            return await _open(arguments)
        elif name == "browser_snapshot":
            return await _snapshot(arguments)
        elif name == "browser_navigate":
            return await _navigate(arguments)
        elif name == "browser_click":
            return await _act(arguments, "click")
        elif name == "browser_type":
            return await _act(arguments, "type")
        elif name == "browser_submit":
            return await _act(arguments, "click")
        elif name == "browser_close":
            return await _close(arguments)
        elif name == "store_web_credential":
            return await _store_credential(arguments)
        elif name == "get_web_credential":
            return await _get_credential(arguments)
        return f"Unknown browser tool: {name}"
    except httpx.TimeoutException:
        return "Browser worker timed out. The page may be slow — try again or take a snapshot."
    except httpx.HTTPStatusError as e:
        return f"Browser action failed: {e.response.status_code} {e.response.text[:200]}"
    except Exception as e:
        log.warning("Browser tool '%s' failed: %s", name, e)
        return f"Browser tool error: {e}"


async def _open(args: dict) -> str:
    url = args.get("url", "")
    ssrf_error = validate_url(url)
    if ssrf_error:
        return f"Blocked: {ssrf_error}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.post(f"{BROWSER_BASE}/sessions", json={"url": url})
        r.raise_for_status()
        d = r.json()
    return f"Opened session {d['session_id']} at {d['url']}. Take a browser_snapshot to see the page."


async def _snapshot(args: dict) -> str:
    sid = args["session_id"]
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.post(
            f"{BROWSER_BASE}/sessions/{sid}/snapshot",
            json={"include_screenshot": bool(args.get("screenshot", False))},
        )
        r.raise_for_status()
        d = r.json()
    lines = [f"Page: {d['title']}", f"URL: {d['url']}", "", "Interactive elements:"]
    lines.extend(d.get("elements", []) or ["(none found)"])
    if d.get("screenshot_b64"):
        lines.append("\n[screenshot captured]")
    return "\n".join(lines)


async def _navigate(args: dict) -> str:
    sid = args["session_id"]
    ssrf_error = validate_url(args["url"])
    if ssrf_error:
        return f"Blocked: {ssrf_error}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.post(f"{BROWSER_BASE}/sessions/{sid}/navigate", json={"url": args["url"]})
        r.raise_for_status()
        d = r.json()
    return f"Navigated to {d['url']} ({d['title']}). Take a snapshot."


async def _act(args: dict, action: str) -> str:
    sid = args["session_id"]
    body = {"ref": args["ref"], "action": action, "value": args.get("text", "")}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        r = await c.post(f"{BROWSER_BASE}/sessions/{sid}/act", json=body)
        r.raise_for_status()
        d = r.json()
    return f"Done ({action}). Now at {d['url']} ({d['title']}). Take a fresh snapshot to see the result."


async def _close(args: dict) -> str:
    sid = args["session_id"]
    async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
        await c.delete(f"{BROWSER_BASE}/sessions/{sid}")
    return f"Closed session {sid}."


async def _store_credential(args: dict) -> str:
    import json as _json

    from app.capabilities import credentials as cred
    from app.capabilities.models import (
        AuthMethod,
        CredentialBackend,
        CredentialCreate,
    )
    from app.db import get_pool

    site = args["site"]
    kind = args.get("kind", "login")
    username = args.get("username", "")
    secret = args["secret"]
    # Store username + secret as a single JSON payload so get returns both.
    payload_secret = _json.dumps({"username": username, "secret": secret})

    create = CredentialCreate(
        provider_kind=f"web:{site}",
        auth_method=AuthMethod.API_KEY if kind == "api_key" else AuthMethod.PASSWORD,
        label=f"{kind} for {site}",
        backend=CredentialBackend.BUILTIN,
        secret=payload_secret,
        scopes={"kind": kind},
    )
    result = await cred.create_credential(
        get_pool(), tenant_id=_DEFAULT_TENANT, user_id=None,
        payload=create, actor="agent:browser",
    )
    return f"Stored {kind} credential for {site} (id {result.id})."


async def _get_credential(args: dict) -> str:
    import json as _json

    from app.capabilities import credentials as cred
    from app.db import get_pool

    site = args["site"]
    creds = await cred.list_credentials(
        get_pool(), tenant_id=_DEFAULT_TENANT,
        provider_kind=f"web:{site}",
    )
    if not creds:
        return f"No stored credential for {site}."
    latest = creds[0]
    plaintext = await cred.get_secret(
        get_pool(), tenant_id=_DEFAULT_TENANT, cred_id=latest.id, actor="agent:browser",
    )
    try:
        data = _json.loads(plaintext)
        username, secret = data.get("username", ""), data.get("secret", "")
    except Exception:
        username, secret = "", plaintext
    return f"Credential for {site}: username={username or '(none)'} secret={secret}"
