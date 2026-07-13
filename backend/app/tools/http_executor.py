"""Generic executor for DB-defined http_call tools.

execution_spec shape:
    {
      "method": "GET" | "POST",
      "url_template": "https://api.example.com/v1/thing?q={query}",
      "headers": {"X-Static": "value"},          # optional, static only
      "body_template": {"field": "{arg_name}"}    # optional, POST only
    }

Placeholders {name} are substituted from the tool-call arguments (URL-quoted in
the URL). The target host must be present in tool_host_allowlist — checked here
at execution time regardless of any creation-time validation.
"""

import json
import logging
from urllib.parse import quote, urlparse

import httpx

from app import db

log = logging.getLogger(__name__)

TIMEOUT_S = 15.0
MAX_RESPONSE_CHARS = 8000


class _QuotingDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"


async def host_allowed(host: str) -> bool:
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT 1 FROM tool_host_allowlist WHERE host = $1", host)
        return row is not None


def _substitute(template: str, args: dict, url_quote: bool) -> str:
    values = {k: quote(str(v), safe="") if url_quote else str(v) for k, v in args.items()}
    return template.format_map(_QuotingDict(values))


async def execute_http_tool(tool_row: dict, args: dict) -> str:
    spec = tool_row.get("execution_spec") or {}
    if isinstance(spec, str):
        spec = json.loads(spec)

    url_template = spec.get("url_template", "")
    method = (spec.get("method") or "GET").upper()
    if method not in ("GET", "POST"):
        return f"Error: unsupported method {method}"

    url = _substitute(url_template, args, url_quote=True)
    host = urlparse(url).hostname or ""
    if not await host_allowed(host):
        return (f"Error: host '{host}' is not in the approved allowlist. "
                f"An operator must add it before this tool can run.")

    headers = spec.get("headers") or {}
    body = None
    if method == "POST" and spec.get("body_template"):
        body = json.loads(_substitute(json.dumps(spec["body_template"]), args, url_quote=False))

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False) as client:
            resp = await client.request(method, url, headers=headers, json=body)
    except httpx.HTTPError as e:
        return f"Error calling {host}: {e}"

    text = resp.text[:MAX_RESPONSE_CHARS]
    if resp.status_code >= 400:
        return f"HTTP {resp.status_code} from {host}: {text[:500]}"
    return text
