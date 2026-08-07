"""Generic executor for DB-defined http_call tools.

execution_spec shape:
    {
      "method": "GET" | "POST",
      "url_template": "https://api.example.com/v1/thing?q={query}",
      "headers": {"X-Api-Key": "{{secret:name}}"},  # optional, static only
      "body_template": {"field": "{arg_name}"}    # optional, POST only
    }

Placeholders {name} are substituted from the tool-call arguments (URL-quoted
in the URL; inside decoded string values in the body, never across JSON
syntax). {{secret:name}} references resolve from the STORED spec at the
moment of the outbound call — and never from an argument. Two checks run here
at execution time regardless of any creation-time validation, because the URL
is only known once the arguments and secrets are in it:

    the allow-list     the host must be a row in tool_host_allowlist
    the off-stack guard the host must not RESOLVE to this machine or to one
                       of this install's own services (net_guard)

The second one is the one that has to be here rather than at approval time:
allow-listing takes a name, and a name that pointed at the router when an
operator approved it can point at 127.0.0.1 by the time a tool call carries
it. See the comment block in net_guard for what that reached.
"""

import json
import logging
from urllib.parse import quote, urlparse

import httpx

from app import db, net_guard, redact, secret_store

log = logging.getLogger(__name__)

TIMEOUT_S = 15.0
MAX_RESPONSE_CHARS = 8000


class _QuotingDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"


async def host_allowed(host: str) -> bool:
    """Is this hostname a row in tool_host_allowlist?

    Matches the NAME only. The table has no port column, so an approved host
    is approved on every port it listens on — which is why the second check
    exists: what an operator is agreeing to is a machine, and the machines
    that must never be that machine are settled by resolution, not by name.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow("SELECT 1 FROM tool_host_allowlist WHERE host = $1", host)
        return row is not None


def _substitute(template: str, args: dict, url_quote: bool) -> str:
    values = {k: quote(str(v), safe="") if url_quote else str(v) for k, v in args.items()}
    return template.format_map(_QuotingDict(values))


def _substitute_body(node, args: dict):
    """Placeholders substituted INSIDE decoded strings, never across JSON.

    This used to be one format_map pass over json.dumps(template) — textual
    substitution over serialized JSON — so an argument of
    '","admin":true,"x":"' closed the string it was aimed at and wrote its
    own fields into an operator-approved body. Substituting into the parsed
    structure keeps a chosen value a value: whatever it contains is escaped
    by serialization when the request is sent.
    """
    if isinstance(node, str):
        return _substitute(node, args, url_quote=False)
    if isinstance(node, dict):
        return {_substitute_body(k, args): _substitute_body(v, args)
                for k, v in node.items()}
    if isinstance(node, list):
        return [_substitute_body(v, args) for v in node]
    return node


async def execute_http_tool(tool_row: dict, args: dict) -> str:
    spec = tool_row.get("execution_spec") or {}
    if isinstance(spec, str):
        spec = json.loads(spec)

    url_template = spec.get("url_template", "")
    method = (spec.get("method") or "GET").upper()
    if method not in ("GET", "POST"):
        return f"Error: unsupported method {method}"

    # {{secret:name}} is honoured from the STORED spec only. An argument is a
    # string the model chose this turn, and resolving one would let any
    # allow-listed host that echoes its request hand back a value the model
    # is promised it can never see.
    if secret_store.references(args):
        return ("Error: {{secret:...}} references are only resolved from the "
                "tool's stored execution_spec, never from call arguments. "
                "Nothing was sent.")

    # format_map eats a reference's doubled braces ({{ -> {), which is how DB
    # tools sent the literal placeholder out despite _list_secret_names
    # promising substitution: the mangled {secret:name} matched nothing.
    # Shield the braces through argument substitution, resolve after — and
    # keep `shown`, the reference form, for the error paths below: it is the
    # only spelling of this URL that is safe to echo at a model.
    shown = _substitute(url_template.replace("{{", "{{{{").replace("}}", "}}}}"),
                        args, url_quote=True)
    try:
        # Same order as mcp_client: resolve, THEN guard, so the allow-list
        # and the off-stack check rule on the host that will actually be
        # dialled. A SecretError carries the name only, never a value.
        url = await secret_store.resolve(shown)
        headers = await secret_store.resolve(spec.get("headers") or {})
    except secret_store.SecretError as exc:
        return f"Error: {exc}"

    host = urlparse(url).hostname or ""
    if not await host_allowed(host):
        return (f"Error: host '{host}' is not in the approved allowlist. "
                f"An operator must add it before this tool can run.")
    refusal = await net_guard.validate_offstack_target(url)
    if refusal:
        return (f"Error: {refusal}. Being on the approved host list does not "
                f"make a target reachable — an operator cannot approve this "
                f"one, and no tool call will reach it.")

    body = None
    if method == "POST" and spec.get("body_template"):
        tpl = spec["body_template"]
        if isinstance(tpl, str):
            # A template stored as a string: parse it so the JSON-aware walk
            # applies. Only genuinely non-JSON text keeps plain textual
            # substitution — there is no structure in it to inject into, and
            # it goes out as the string it is.
            try:
                tpl = json.loads(tpl)
            except ValueError:
                pass
        body = _substitute_body(tpl, args)

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False) as client:
            resp = await client.request(method, url, headers=headers, json=body)
    except httpx.HTTPError as e:
        # httpx embeds the full URL in its message, and after resolution that
        # URL carries the secret — put the reference form back, then scrub.
        return f"Error calling {host}: {redact.scrub_text(str(e).replace(url, shown), 500)}"

    text = resp.text[:MAX_RESPONSE_CHARS]
    if resp.status_code >= 400:
        # 4xx bodies love echoing the request that earned them
        return (f"HTTP {resp.status_code} from {host}: "
                f"{redact.scrub_text(text.replace(url, shown), 500)}")
    return text
