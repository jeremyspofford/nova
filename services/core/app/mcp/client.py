"""The MCP client: one HTTP endpoint, tools only (S37a).

Everything Nova says to an MCP server goes through here — her four tools
(app/tools/mcp.py), the store's probe when a server is connected
(app/mcp/servers.py), and S38's browser tools, which drive the Playwright
engine with `call` directly. It speaks two eras of the protocol:

  * MODERN — 2026-07-28, stateless. Every POST carries the version in a
    header and in `params._meta`, plus `Mcp-Method` (and `Mcp-Name` on a
    tools/call). No handshake, no session.
  * LEGACY — 2025-11-25 and earlier. An `initialize` and a
    `notifications/initialized` first; the server may hand out an
    `Mcp-Session-Id` that every later request echoes, and a 404 on it means
    "start again".

Which era a server speaks is FOUND, once per endpoint per process, by the
specification's own probe (2026-07-28 transports, "Backward Compatibility"):
POST `server/discover`. A result that omits its supported versions, or
names 2026-07-28 among them, means modern; so does a recognised modern
error (-32020, -32021 or -32022 on a 400; -32601 on a 404). Anything else —
an empty or unrecognised body, a JSON-RPC error inside an HTTP 200 (Home
Assistant's /api/mcp), a 400 with -32600 (DeepWiki, probed 2026-09-30) or
-32000 (the Playwright MCP engine S38 drives, v0.0.82, measured 2026-10-01)
— means legacy, spoken to through the `initialize` handshake below, never
refused for being old. A result or a -32022 naming only OLDER versions
follows the newest one named, through that same handshake. 401 and 403 are
neither: they refuse the credentials, and say so.

Hand-rolled on httpx rather than the official SDK: measured 2026-09-30,
`mcp` 2.2.0 adds twelve packages to core including a second HTTP stack, and
takes auth headers only through that stack's client.

Nothing here reads the database, a setting or a person. An `Endpoint` is an
address and its credentials; callers build one from a row (servers.py) or a
constant (S38's engine).

THE FIXTURE SEAM. `plant({origin: transport})` makes every request to that
origin, in this task and the tasks it spawns, go to the given httpx transport
instead of the network. It is a ContextVar, so an eval case can plant a fake
at a real address (S38 plants its fake engine at http://browser:8931)
without any real turn seeing it. The caches are keyed by the plant as well,
so a fake's era or tool list never answers for the real server behind the
same address.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import itertools
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterator, Mapping
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("core")

MODERN = "2026-07-28"
# What the legacy handshake offers first; the server answers with the version
# it will speak, which may be older.
LEGACY_OFFER = "2025-11-25"
KNOWN_LEGACY = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
CLIENT_INFO = {"name": "nova", "version": "4"}

CONNECT_TIMEOUT_S = 10.0
PROBE_TIMEOUT_S = 15.0
CALL_TIMEOUT_S = 60.0
# A safety bound on one response, not what she is shown: the callers cap what
# reaches a model (mcp_call at 64 KiB; S38's reader splits a page into parts).
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_LIST_PAGES = 20
MAX_STATE_ROUNDS = 3
# A legacy server states no lifetime for its tool list; this is how long it is
# trusted before a tool that needs it reads it again (plan decision P20).
LEGACY_TOOLS_TTL_MS = 300_000

_MODERN_400_CODES = frozenset({-32020, -32021, -32022})
_TCHAR = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_SENTINEL = re.compile(r"^=\?base64\?.*\?=$", re.DOTALL)
_ids = itertools.count(1)


class ClientError(Exception):
    """A call that could not be made, or that the server refused, in words.

    `reachable` says whether the server HAD the request: True means the
    connection succeeded and the request was sent — a refusal it then SENT
    BACK (a 401, a JSON-RPC error) is reachable, and so is a transport
    failure or the deadline once sending began, because the call may or may
    not have run. False means the server was never contacted at all, or
    nothing was sent — a bad credential, an unsupported URL scheme, a
    header this transport cannot encode, a failed connection. The store
    stamps it on the row and the tools file it as a fact, which is what the
    guards read."""

    def __init__(self, reason: str, *, reachable: bool) -> None:
        super().__init__(reason)
        self.reason = reason
        self.reachable = reachable


class RpcError(ClientError):
    """The server answered with a JSON-RPC error object."""

    def __init__(self, endpoint_name: str, code: int, message: str, data: Any = None) -> None:
        super().__init__(
            f"{endpoint_name} answered with an error: {message} ({code})", reachable=True
        )
        self.code = code
        self.message = message
        self.data = data


def _normalize_origin(url: str) -> str:
    """scheme://host:port — scheme and host lowercased, IPv6 bracketed, no
    userinfo and no path (ruling R2-3). THE single derivation: `Endpoint.origin`
    and `plant()` both go through this, so a plant's key always matches a
    request's origin regardless of how either was cased or decorated, and
    neither can carry a credential that rode in the URL's userinfo."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if ":" in host:  # urlsplit's .hostname strips IPv6 brackets; put them back
        host = f"[{host}]"
    port = f":{parts.port}" if parts.port is not None else ""
    return f"{(parts.scheme or '').lower()}://{host}{port}"


@dataclass(frozen=True, eq=False, repr=False)
class Endpoint:
    """Where a server is and what to send it. `name` is for sentences only.

    `token`, `headers` and `url` never appear in `repr`/`str` (ruling R2-1):
    a URL's path can itself be a secret (ha-mcp authenticates by a secret
    path), so only `name` and the derived `origin` are ever shown."""

    name: str
    url: str
    token: str | None = None
    headers: Mapping[str, str] = field(default_factory=dict)

    def __repr__(self) -> str:
        return f"Endpoint(name={self.name!r}, origin={self.origin!r})"

    @property
    def origin(self) -> str:
        return _normalize_origin(self.url)


@dataclass(frozen=True)
class Probe:
    protocol: str  # "2026-07-28" or "legacy:<version>"
    title: str | None


@dataclass(frozen=True)
class ToolList:
    tools: tuple[dict, ...]  # each {"name", "description", "inputSchema", "annotations"}
    ttl_ms: int
    rejected: tuple[tuple[str, str], ...] = ()  # (name, why): definitions the spec says to drop


@dataclass(frozen=True)
class CallResult:
    text: str
    is_error: bool
    structured: Any = None
    notes: tuple[str, ...] = ()

    @property
    def bytes(self) -> int:
        return len(self.text.encode("utf-8"))


# -- the fixture seam ---------------------------------------------------------


@dataclass(frozen=True)
class _Planted:
    transport: httpx.AsyncBaseTransport
    plant_id: str


TRANSPORTS: ContextVar[Mapping[str, _Planted] | None] = ContextVar("mcp_transports", default=None)


def plant(transports: Mapping[str, httpx.AsyncBaseTransport]) -> Token:
    """Route requests to each origin (`scheme://host:port`) to its transport,
    for this task and what it spawns. Returns the token `unplant` takes."""
    merged = dict(TRANSPORTS.get() or {})
    for origin, transport in transports.items():
        merged[_normalize_origin(origin)] = _Planted(transport, uuid.uuid4().hex)
    return TRANSPORTS.set(merged)


def unplant(token: Token) -> None:
    """Undo one plant, and forget everything cached through it."""
    before = TRANSPORTS.get() or {}
    TRANSPORTS.reset(token)
    after = TRANSPORTS.get() or {}
    gone = {p.plant_id for origin, p in before.items() if after.get(origin) is not p}
    for cache in (_ERAS, _TOOLS):
        for key in [k for k in cache if k[1] in gone]:
            cache.pop(key, None)


def _planted(origin: str) -> _Planted | None:
    return (TRANSPORTS.get() or {}).get(origin)


# -- caches -------------------------------------------------------------------


@dataclass
class _Era:
    modern: bool
    version: str
    title: str | None = None
    session: str | None = None


_ERAS: dict[tuple[str, str], _Era] = {}
_TOOLS: dict[tuple[str, str], tuple[float, ToolList]] = {}


def _key(endpoint: Endpoint) -> tuple[str, str]:
    """(credentials digest, plant id): the same URL with another token, or a
    fake planted at a real address, is a different server to the caches."""
    material = json.dumps([endpoint.url, endpoint.token or "", sorted(endpoint.headers.items())])
    planted = _planted(endpoint.origin)
    return hashlib.sha256(
        material.encode("utf-8")
    ).hexdigest(), planted.plant_id if planted else "network"


def forget(endpoint: Endpoint) -> None:
    """Drop what is cached for this endpoint: its era and its tool list."""
    key = _key(endpoint)
    _ERAS.pop(key, None)
    _TOOLS.pop(key, None)


# -- the public calls ---------------------------------------------------------


async def probe(endpoint: Endpoint) -> Probe:
    """Find the server's era afresh (forgetting any cached one) and say what was found."""
    forget(endpoint)
    era = await _era(endpoint)
    return Probe(protocol=MODERN if era.modern else f"legacy:{era.version}", title=era.title)


async def list_tools(endpoint: Endpoint, *, refresh: bool = False) -> ToolList:
    """Every page of the server's tools, with the definitions the spec says to
    drop left out and named. Cached for the lifetime the server states."""
    key = _key(endpoint)
    cached = _TOOLS.get(key)
    if cached is not None and not refresh and cached[0] > time.monotonic():
        return cached[1]
    tools: list[dict] = []
    rejected: list[tuple[str, str]] = []
    ttls: list[int] = []
    cursor: str | None = None
    for _page in range(MAX_LIST_PAGES):
        params: dict[str, Any] = {} if cursor is None else {"cursor": cursor}
        result = await _send(endpoint, "tools/list", params, timeout_s=PROBE_TIMEOUT_S, resend=True)
        kind = result.get("resultType", "complete")
        if kind != "complete":
            raise ClientError(
                f"{endpoint.name} answered tools/list with resultType {kind!r}, which that "
                "method may not use",
                reachable=True,
            )
        for raw in result.get("tools") or []:
            why = _tool_problem(raw)
            if why is not None:
                name = str(raw.get("name")) if isinstance(raw, dict) else "?"
                rejected.append((name, why))
                logger.warning("mcp: %s: left out tool %r — %s", endpoint.name, name, why)
                continue
            tools.append(
                {
                    "name": raw["name"],
                    "description": str(raw.get("description") or ""),
                    "inputSchema": raw.get("inputSchema") or {"type": "object", "properties": {}},
                    "annotations": raw.get("annotations")
                    if isinstance(raw.get("annotations"), dict)
                    else {},
                }
            )
        ttl = result.get("ttlMs")
        if isinstance(ttl, int) and not isinstance(ttl, bool) and ttl >= 0:
            ttls.append(ttl)
        next_cursor = result.get("nextCursor")
        if next_cursor is None:
            break
        cursor = str(next_cursor)  # "" is a valid cursor; only its absence ends the list
    else:
        raise ClientError(
            f"{endpoint.name} listed more than {MAX_LIST_PAGES} pages of tools; stopped reading",
            reachable=True,
        )
    era = await _era(endpoint)
    ttl_ms = min(ttls) if ttls else (0 if era.modern else LEGACY_TOOLS_TTL_MS)
    listed = ToolList(tools=tuple(tools), ttl_ms=ttl_ms, rejected=tuple(rejected))
    _TOOLS[key] = (time.monotonic() + ttl_ms / 1000, listed)
    return listed


async def call(
    endpoint: Endpoint,
    tool: str,
    arguments: Mapping[str, Any],
    *,
    timeout_s: float = CALL_TIMEOUT_S,
    progress: Callable[[str], None] | None = None,
) -> CallResult:
    """Run one tool — the library call S38's browser tools make directly.

    The server's own failure (`isError`) comes back as a CallResult with
    is_error True: the tool RAN and failed. A JSON-RPC error, a refusal or a
    transport failure raises ClientError. A stream that breaks before the
    answer is NOT re-sent (plan decision P4): the tool may already have run,
    and a second run of something that changes the world is worse than a
    stated uncertainty."""
    params: dict[str, Any] = {"name": tool, "arguments": dict(arguments)}
    for attempt in (1, 2):
        headers = _param_headers(_cached_schema(endpoint, tool), arguments)
        try:
            result = await _send_call(
                endpoint, params, headers, timeout_s=timeout_s, progress=progress
            )
        except RpcError as exc:
            if exc.code == -32020 and attempt == 1:
                # The spec's remedy for a header mismatch: read the tool's
                # schema again, then send the headers it now asks for.
                await list_tools(endpoint, refresh=True)
                continue
            raise
        return _as_result(endpoint, result)
    raise AssertionError("unreachable: the loop returns or raises")


# -- the era ------------------------------------------------------------------


async def _era(endpoint: Endpoint) -> _Era:
    key = _key(endpoint)
    era = _ERAS.get(key)
    if era is None:
        era = await _detect(endpoint)
        _ERAS[key] = era
    return era


async def _detect(endpoint: Endpoint) -> _Era:
    modern = _Era(modern=True, version=MODERN)
    for attempt in (1, 2):
        message, headers = _framed(modern, "server/discover", {}, None)
        status, _headers, answer, excerpt = await _post(
            endpoint, message, headers, timeout_s=PROBE_TIMEOUT_S
        )
        if answer is None and attempt == 1:
            # No answer — a clean close, a failure once the request was
            # sent, or the deadline, with or without a status (ruling
            # R3-A): a discovery changes nothing, so ask again once.
            continue
        break
    if status in (401, 403):
        raise ClientError(_refused(endpoint, status, answer, excerpt), reachable=True)
    if answer is not None and 200 <= status < 300 and isinstance(answer.get("result"), dict):
        result = answer["result"]
        versions = result.get("supportedVersions")
        if not isinstance(versions, list) or MODERN in versions:
            info = (result.get("_meta") or {}).get("io.modelcontextprotocol/serverInfo") or {}
            return _Era(modern=True, version=MODERN, title=_title(info))
        # The probe answered and the server understood it, but 2026-07-28
        # is not among what it lists: speak the newest it does, through the
        # handshake below — the same case as the -32022 branch just after.
        return await _initialize(endpoint, offer=_best_legacy(versions))
    code = _error_code(answer)
    supported = _supported(answer)
    if status == 400 and code == -32022 and supported is not None and MODERN not in supported:
        return await _initialize(endpoint, offer=_best_legacy(supported))
    if (status == 400 and code in _MODERN_400_CODES) or (status == 404 and code == -32601):
        # A modern server that refused the discovery itself is still modern:
        # the calls after it will say what it wants.
        return _Era(modern=True, version=MODERN)
    if status is None:
        raise ClientError(
            f"{endpoint.name} at {endpoint.origin} did not answer MCP {MODERN} discovery",
            reachable=True,
        )
    # An empty or unrecognised body, a JSON-RPC error inside a 200 (Home
    # Assistant), a 400 with -32600 (DeepWiki) or -32000 (the Playwright MCP
    # engine): nothing this probe recognises as modern. The spec's rule for
    # all of it is the same — fall back to the handshake, never a refusal
    # for being old — and the handshake itself says so in words if even
    # THAT goes unanswered.
    return await _initialize(endpoint, offer=LEGACY_OFFER)


async def _initialize(endpoint: Endpoint, *, offer: str) -> _Era:
    """The 2025-era handshake: initialize, then notifications/initialized,
    and the session id the server may hand out, echoed on every later
    request. `_detect`'s fallback for everything server/discover does not
    answer as a 2026-07-28 server."""
    message = {
        "jsonrpc": "2.0",
        "id": next(_ids),
        "method": "initialize",
        "params": {"protocolVersion": offer, "capabilities": {}, "clientInfo": CLIENT_INFO},
    }
    status, headers, answer, excerpt = await _post(endpoint, message, {}, timeout_s=PROBE_TIMEOUT_S)
    if status in (401, 403):
        raise ClientError(_refused(endpoint, status, answer, excerpt), reachable=True)
    result = answer.get("result") if isinstance(answer, dict) else None
    if not isinstance(result, dict):
        raise ClientError(
            f"{endpoint.name} at {endpoint.origin} is not an MCP server this client can speak "
            f"to: it answered neither a {MODERN} discovery nor a {offer} initialize "
            f"(HTTP {status}{': ' + excerpt if excerpt else ''})",
            reachable=True,
        )
    version = (
        result.get("protocolVersion") if isinstance(result.get("protocolVersion"), str) else offer
    )
    session = headers.get("mcp-session-id")
    era = _Era(
        modern=False, version=version, title=_title(result.get("serverInfo")), session=session
    )
    note = {"jsonrpc": "2.0", "method": "notifications/initialized"}
    note_headers = {
        "MCP-Protocol-Version": version,
        **({"Mcp-Session-Id": session} if session else {}),
    }
    status, _headers, _answer, excerpt = await _post(
        endpoint, note, note_headers, timeout_s=PROBE_TIMEOUT_S
    )
    if status is None or status >= 400:
        # No answer at all is as much a refused handshake as a 4xx: either
        # way the session this client just read from `initialize` is not
        # one the server has confirmed, so nothing after this can be trusted.
        raise ClientError(
            f"{endpoint.name} refused the end of the handshake "
            f"(HTTP {status}{': ' + excerpt if excerpt else ''})",
            reachable=True,
        )
    return era


def _best_legacy(versions: Any) -> str:
    """The newest 2025-era version a server lists, or this client's own
    offer when none of what it lists is a version this client knows."""
    listed = [v for v in versions or () if v in KNOWN_LEGACY]
    return max(listed) if listed else LEGACY_OFFER  # ISO-dated strings sort as dates


def _supported(answer: dict | None) -> list | None:
    """The list an error's `error.data.supported` carries (the -32022
    shape), or None when there is no such list to read."""
    error = answer.get("error") if isinstance(answer, dict) else None
    data = error.get("data") if isinstance(error, dict) else None
    supported = data.get("supported") if isinstance(data, dict) else None
    return supported if isinstance(supported, list) else None


# -- one request --------------------------------------------------------------


def _framed(
    era: _Era,
    method: str,
    params: Mapping[str, Any],
    extra: Mapping[str, str] | None,
    *,
    want_progress: bool = False,
):
    body = {"jsonrpc": "2.0", "id": next(_ids), "method": method, "params": dict(params)}
    headers = dict(extra or {})
    if era.modern:
        meta = dict(body["params"].get("_meta") or {})
        meta.update(
            {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
            }
        )
        if want_progress:
            # The spec sends notifications/progress only for a request that
            # carried this (ruling R2-6) — an unprefixed _meta key, unlike
            # Nova's own namespaced ones above.
            meta["progressToken"] = str(body["id"])
        body["params"]["_meta"] = meta
        headers["MCP-Protocol-Version"] = MODERN
        headers["Mcp-Method"] = method
        if method == "tools/call":
            headers["Mcp-Name"] = header_value(str(params["name"]))
    else:
        headers = {k: v for k, v in headers.items() if not k.lower().startswith("mcp-param-")}
        headers["MCP-Protocol-Version"] = era.version
        if era.session:
            headers["Mcp-Session-Id"] = era.session
        if want_progress:
            # The same progressToken the modern branch sends in `_meta`,
            # above — the legacy spec carries it the same way. This used to
            # send no `_meta` at all, so a legacy call's progress callback
            # was never driven; the fake's legacy progress is gated on it.
            meta = dict(body["params"].get("_meta") or {})
            meta["progressToken"] = str(body["id"])
            body["params"]["_meta"] = meta
    return body, headers


async def _send(
    endpoint: Endpoint,
    method: str,
    params: Mapping[str, Any],
    *,
    timeout_s: float,
    resend: bool,
    progress: Callable[[str], None] | None = None,
    extra: Mapping[str, str] | None = None,
) -> dict:
    """One JSON-RPC request in the endpoint's era; its `result` object.

    `resend`: no answer at all — a clean close, a failure once the request
    was sent, or the deadline, WITH OR WITHOUT a status (ruling R3-A) — is
    sent again once, with a new id, only for a request that changes nothing
    (a listing). A legacy session the server forgot (404) is established
    again once, for any request: the server refused it outright, so nothing
    ran."""
    for attempt in (1, 2):
        era = await _era(endpoint)
        message, headers = _framed(era, method, params, extra, want_progress=progress is not None)
        status, _headers, answer, excerpt = await _post(
            endpoint, message, headers, timeout_s=timeout_s, progress=progress
        )
        if status in (401, 403):
            raise ClientError(_refused(endpoint, status, answer, excerpt), reachable=True)
        if not era.modern and era.session and status == 404 and attempt == 1:
            _ERAS.pop(_key(endpoint), None)
            continue
        if answer is None:
            if resend and attempt == 1:
                continue
            if status is None:
                raise ClientError(
                    f"{endpoint.name} did not answer at all; the call may or may not have run",
                    reachable=True,
                )
            if 200 <= status < 300:
                raise ClientError(
                    f"the stream from {endpoint.name} ended before the answer; the call may "
                    "or may not have run",
                    reachable=True,
                )
            raise ClientError(
                f"{endpoint.name} answered HTTP {status} without a JSON-RPC response"
                f"{': ' + excerpt if excerpt else ''}",
                reachable=True,
            )
        if "error" in answer:
            error = answer["error"] if isinstance(answer["error"], dict) else {}
            raise RpcError(
                endpoint.name,
                int(error.get("code") or 0),
                str(error.get("message") or "no message"),
                error.get("data"),
            )
        result = answer.get("result")
        if not isinstance(result, dict):
            raise ClientError(
                f"{endpoint.name} answered {method} with a result that is not an object",
                reachable=True,
            )
        return result
    raise ClientError(
        f"{endpoint.name} did not answer {method} after a second attempt", reachable=True
    )


async def _send_call(endpoint, params, headers, *, timeout_s, progress) -> dict:
    """tools/call, following a stated retry (MRTR) up to MAX_STATE_ROUNDS."""
    current = dict(params)
    for _round in range(MAX_STATE_ROUNDS + 1):
        result = await _send(
            endpoint,
            "tools/call",
            current,
            timeout_s=timeout_s,
            resend=False,
            progress=progress,
            extra=headers,
        )
        kind = result.get("resultType", "complete")
        if kind == "complete":
            return result
        if kind != "input_required":
            raise ClientError(
                f"{endpoint.name} answered with resultType {kind!r}, which this client does "
                "not know",
                reachable=True,
            )
        if result.get("inputRequests"):
            asked = ", ".join(sorted(str(k) for k in result["inputRequests"]))
            raise ClientError(
                f"{endpoint.name} asked for input this client cannot give ({asked}); "
                "Nova declares no elicitation, sampling or roots",
                reachable=True,
            )
        state = result.get("requestState")
        if not isinstance(state, str):
            raise ClientError(
                f"{endpoint.name} asked to retry without a state to echo", reachable=True
            )
        current = {**params, "requestState": state}
    raise ClientError(
        f"{endpoint.name} asked to retry more than {MAX_STATE_ROUNDS} times; stopped",
        reachable=True,
    )


def _safe_credential(value: str) -> bool:
    """Whether `value` can be sent as a header verbatim: visible ASCII, no
    leading/trailing whitespace, no control characters (ruling R2-2) — the
    same shape `header_value()` treats as plain. A credential that fails
    this is refused outright, never silently re-encoded like a mirrored tool
    argument, because Authorization and a caller's own extra headers are not
    base64-sentinel aware on the other end."""
    return value != "" and value == value.strip() and all(0x20 <= ord(ch) <= 0x7E for ch in value)


def _check_credentials(endpoint: Endpoint) -> None:
    """Refuse BEFORE sending anything when a credential cannot be a header
    value, naming the header but never the value (ruling R2-2): httpx/h11
    would otherwise quote a bad value verbatim in their own exception text —
    e.g. a pasted token with a trailing newline — and `from exc` would carry
    that into a traceback."""
    if endpoint.token and not _safe_credential(endpoint.token):
        raise ClientError(
            f"{endpoint.name}'s token has characters a header cannot carry; nothing was sent",
            reachable=False,
        )
    for key in endpoint.headers:
        if not _safe_credential(endpoint.headers[key]):
            raise ClientError(
                f"{endpoint.name}'s header {key!r} has characters a header cannot carry; "
                "nothing was sent",
                reachable=False,
            )


async def _post(
    endpoint: Endpoint,
    message: dict,
    headers: Mapping[str, str],
    *,
    timeout_s: float,
    progress: Callable[[str], None] | None = None,
) -> tuple[int | None, httpx.Headers, dict | None, str]:
    """One POST: (status, response headers, the JSON-RPC response, or None and
    an excerpt of a body that was not one). `status` is None when nothing
    came back at all — including when `timeout_s` elapsed before anything did.

    Classified by EXCEPTION TYPE, never by whether a status happened to
    arrive (ruling R3-A): a status is not proof the request was sent, and
    its absence is not proof it was not — a plain `application/json` server
    that answers only once a tool finishes sends no status at all while it
    runs, so "no status yet" is the COMMON shape of an ordinary slow call,
    not a sign the server was unreachable. Only a refusal before sending
    (`_check_credentials`) or `ConnectError`/`ConnectTimeout`/`PoolTimeout` —
    which can only happen before the request reaches the wire — raise
    ClientError(reachable=False): the server was never reached. Every other
    failure (a read or protocol error, or the deadline), with or without a
    status, means the request was sent or might have been; it is reported
    exactly like a stream that closed cleanly without an answer: (status,
    headers, None, ""). The caller's resend rule then applies — never for a
    call, once for a listing — and says the call may or may not have run."""
    _check_credentials(endpoint)
    planted = _planted(endpoint.origin)
    sent = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        **dict(endpoint.headers),
        **dict(headers),
    }
    if endpoint.token:
        sent["Authorization"] = f"Bearer {endpoint.token}"
    want = message.get("id")
    raw = b""
    status: int | None = None
    response_headers: httpx.Headers = httpx.Headers()
    try:
        async with asyncio.timeout(timeout_s):
            async with httpx.AsyncClient(
                transport=planted.transport if planted else None,
                timeout=httpx.Timeout(timeout_s, connect=CONNECT_TIMEOUT_S),
                follow_redirects=False,
            ) as http:
                async with http.stream(
                    "POST", endpoint.url, json=message, headers=sent
                ) as response:
                    status, response_headers = response.status_code, response.headers
                    kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    if kind == "text/event-stream":
                        answer = await _read_sse(endpoint, response, want, progress)
                        return status, response_headers, answer, ""
                    raw = await _read_capped(endpoint, response)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
        raise ClientError(
            f"could not reach {endpoint.name} at {endpoint.origin} — {type(exc).__name__}",
            reachable=False,
        ) from None
    except (httpx.UnsupportedProtocol, httpx.LocalProtocolError) as exc:
        # Raised building or framing the request — an unsupported URL scheme,
        # a header this transport cannot encode — never once anything of it
        # reached the wire, unlike every other exception caught below.
        raise ClientError(
            f"nothing was sent to {endpoint.name} at {endpoint.origin} — {type(exc).__name__}",
            reachable=False,
        ) from None
    except (TimeoutError, httpx.HTTPError):
        return status, response_headers, None, ""
    text = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text) if text.strip() else None
    except ValueError:
        parsed = None
    if (
        isinstance(parsed, dict)
        and parsed.get("jsonrpc") == "2.0"
        and ("result" in parsed or "error" in parsed)
    ):
        return status, response_headers, parsed, ""
    return status, response_headers, None, " ".join(text.split())[:200]


async def _read_capped(endpoint: Endpoint, response: httpx.Response) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body += chunk
        if len(body) > MAX_RESPONSE_BYTES:
            raise ClientError(
                f"{endpoint.name} sent more than {MAX_RESPONSE_BYTES // (1024 * 1024)} MiB in "
                "one answer; stopped reading",
                reachable=True,
            )
    return bytes(body)


_SSE_LINE_END = re.compile(rb"\r\n|\r|\n")


async def _sse_lines(endpoint: Endpoint, response: httpx.Response) -> AsyncIterator[str]:
    """Decoded lines of an SSE body, split only on CR, LF or CRLF — SSE's own
    line ending, never the wider Unicode set `str.splitlines()`/httpx's
    `aiter_lines()` use (U+2028, U+2029, U+0085), which are legal unescaped
    inside a JSON string and would cut it open (ruling R2-5). Bytes are
    counted as they arrive, including an unterminated buffered remainder, so
    one huge line is refused as it streams rather than fully buffered first.

    Each search resumes where the last one stopped (ruling R3-C) rather than
    rescanning `buf` from 0 on every chunk, which was quadratic in the
    number of chunks making up one unterminated line — measured at 32 s for
    a ~4 MiB line delivered in 1460-byte pieces. `scanned` is the prefix of
    `buf` already proven to hold no line ending; it is kept one byte short
    of the end when nothing matched, since a trailing `\\r` there may still
    turn into `\\r\\n` once more bytes arrive, and reset to 0 whenever `buf`
    itself shrinks (a line was just removed from its front)."""
    buf = bytearray()
    total = 0
    scanned = 0
    async for chunk in response.aiter_bytes():
        buf += chunk
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise ClientError(
                f"{endpoint.name} streamed more than "
                f"{MAX_RESPONSE_BYTES // (1024 * 1024)} MiB for one answer; stopped reading",
                reachable=True,
            )
        while True:
            match = _SSE_LINE_END.search(buf, scanned)
            if match is None:
                scanned = max(0, len(buf) - 1)
                break
            if match.group() == b"\r" and match.end() == len(buf):
                scanned = match.start()  # a lone trailing \r may become \r\n; wait for more
                break
            yield bytes(buf[: match.start()]).decode("utf-8", errors="replace")
            del buf[: match.end()]
            scanned = 0
    if buf:
        yield bytes(buf).decode("utf-8", errors="replace")


async def _read_sse(endpoint, response, want, progress) -> dict | None:
    """The response whose id matches, from a stream scoped to one request.
    Progress notifications go to `progress`; comments and other events are
    skipped. None when the stream ends without the answer."""
    data: list[str] = []
    async for line in _sse_lines(endpoint, response):
        if line == "":
            answer = _sse_event(data, want, progress)
            data = []
            if answer is not None:
                return answer
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    return _sse_event(data, want, progress)


def _sse_event(data: list[str], want: Any, progress) -> dict | None:
    if not data:
        return None
    try:
        message = json.loads("\n".join(data))
    except ValueError:
        return None
    if not isinstance(message, dict):
        return None
    if ("result" in message or "error" in message) and message.get("id") == want:
        return message
    if message.get("method") == "notifications/progress" and progress is not None:
        progress(_progress_line(message.get("params") or {}))
    return None


def _progress_line(params: Mapping[str, Any]) -> str:
    done, total, words = params.get("progress"), params.get("total"), params.get("message")
    parts: list[str] = []
    if isinstance(done, (int, float)) and isinstance(total, (int, float)) and total:
        parts.append(f"{done:g} of {total:g}")
    elif isinstance(done, (int, float)):
        parts.append(f"{done:g}")
    if isinstance(words, str) and words.strip():
        parts.append(words.strip()[:200])
    return " — ".join(parts) or "working"


# -- tools, headers, results ----------------------------------------------------


def header_value(value: str) -> str:
    """A header value by 2026-07-28's "Value Encoding": as-is when it is
    visible ASCII with no leading or trailing whitespace, else base64 in the
    `=?base64?…?=` sentinel — and a plain value that LOOKS like the sentinel is
    encoded too, so it cannot be misread."""
    plain = (
        value != ""
        and value == value.strip()
        and all(0x20 <= ord(ch) <= 0x7E or ch == "\t" for ch in value)
        and not _SENTINEL.match(value)
    )
    if plain:
        return value
    return "=?base64?" + base64.b64encode(value.encode("utf-8")).decode("ascii") + "?="


def _annotations(schema: Any, path: tuple = ()) -> Iterator[tuple[tuple, str, dict]]:
    """(property path, header name, property schema) for every x-mcp-header
    reachable from the root through a chain of `properties` keys only."""
    props = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(props, dict):
        return
    for key, prop in props.items():
        if not isinstance(prop, dict):
            continue
        name = prop.get("x-mcp-header")
        if name is not None:
            yield path + (key,), name, prop
        yield from _annotations(prop, path + (key,))


def _every_annotation(node: Any) -> Iterator[dict]:
    if isinstance(node, dict):
        if "x-mcp-header" in node:
            yield node
        for value in node.values():
            yield from _every_annotation(value)
    elif isinstance(node, list):
        for value in node:
            yield from _every_annotation(value)


def _tool_problem(raw: Any) -> str | None:
    """Why the spec says to leave this tool definition out, or None."""
    if not isinstance(raw, dict) or not isinstance(raw.get("name"), str) or not raw["name"].strip():
        return "it has no name"
    schema = raw.get("inputSchema", {"type": "object"})
    if not isinstance(schema, dict):
        return "its inputSchema is not an object"
    reachable = {id(prop) for _path, _name, prop in _annotations(schema)}
    seen: set[str] = set()
    for node in _every_annotation(schema):
        name = node.get("x-mcp-header")
        if id(node) not in reachable:
            return "an x-mcp-header sits where only a chain of properties may reach it"
        if not isinstance(name, str) or not _TCHAR.match(name):
            return f"x-mcp-header {name!r} is not a header-name token"
        if name.lower() in seen:
            return f"x-mcp-header {name!r} is used twice"
        seen.add(name.lower())
        if node.get("type") not in ("string", "integer", "boolean"):
            return (
                f"x-mcp-header {name!r} is on a {node.get('type')!r} parameter; "
                "only string, integer and boolean may be mirrored"
            )
    return None


def _cached_schema(endpoint: Endpoint, tool: str) -> dict | None:
    cached = _TOOLS.get(_key(endpoint))
    if cached is None:
        return None
    for listed in cached[1].tools:
        if listed["name"] == tool:
            return listed["inputSchema"]
    return None


def _param_headers(schema: dict | None, arguments: Mapping[str, Any]) -> dict[str, str]:
    if not isinstance(schema, dict):
        return {}
    out: dict[str, str] = {}
    for path, name, _prop in _annotations(schema):
        value: Any = arguments
        for key in path:
            value = value.get(key) if isinstance(value, Mapping) else None
        if value is None:
            continue
        if isinstance(value, bool):
            text = "true" if value else "false"
        elif isinstance(value, int):
            text = str(value)
        elif isinstance(value, str):
            text = value
        else:
            continue
        out[f"Mcp-Param-{name}"] = header_value(text)
    return out


def _as_result(endpoint: Endpoint, result: Mapping[str, Any]) -> CallResult:
    parts: list[str] = []
    notes: list[str] = []
    saw_content = False  # a well-formed ContentBlock object, text or not
    content = result.get("content")
    well_formed = isinstance(content, list)
    if well_formed:
        for block in content:
            if not isinstance(block, dict):
                # A note, never counted as content seen (ruling R3-B): a
                # list of {"content": ["the real answer"]} is as unreadable
                # as a result with no content block at all.
                notes.append("the server returned a content block that is not an object; skipped")
                continue
            kind = block.get("type")
            if kind == "text":
                saw_content = True
                parts.append(str(block.get("text", "")))
            elif kind in ("image", "audio"):
                saw_content = True
                size = len(str(block.get("data", ""))) * 3 // 4
                noun = "an image" if kind == "image" else "audio"
                notes.append(
                    f"the server returned {noun} ({block.get('mimeType', '?')}, about "
                    f"{max(1, size // 1024)} KB), which is not read yet"
                )
            elif kind == "resource_link":
                saw_content = True
                parts.append(f"[link] {block.get('name') or ''} {block.get('uri') or ''}".strip())
            elif kind == "resource":
                saw_content = True
                resource = block.get("resource") if isinstance(block.get("resource"), dict) else {}
                if "text" in resource:
                    parts.append(str(resource["text"]))
                else:
                    notes.append(
                        f"the server returned an embedded binary resource "
                        f"({resource.get('uri', '?')}); not read"
                    )
            elif isinstance(kind, str) and kind:
                # An unknown but NAMED kind (breaker ruling B): still content
                # seen, for forward compatibility with a block type this
                # client does not know about yet.
                saw_content = True
                notes.append(f"the server returned a {kind!r} block this client does not read")
            else:
                # No `type` at all, or not a string: never content seen — a
                # {"text": "the real answer"} with no `type` key is as
                # unreadable as a block that is not an object at all.
                notes.append("the server returned a content block with no type; skipped")
    elif content is not None:
        # Present but not a list — a malformed shape, not a block the spec
        # defines. Noted (ruling R3-B: this used to be silently dropped
        # beside isError/structuredContent), but never counted as content
        # seen, so it still falls through to the raise below when nothing
        # else redeems the result.
        notes.append("the server's content was not a list of blocks; nothing could be read")
    structured = result.get("structuredContent")
    if not parts and structured is not None:
        parts.append(json.dumps(structured, ensure_ascii=False, indent=1))
    empty_success = well_formed and not content  # content was exactly []
    if not parts and empty_success and structured is None:
        # The protocol's own sanctioned empty result (ruling R3-D) — the
        # official SDK documents CallToolResult(content=[]) for one — is a
        # SUCCESS, never the stated failure below.
        notes.append("the tool returned no content")
    if (
        not parts
        and not saw_content
        and not empty_success
        and structured is None
        and not result.get("isError")
    ):
        # Nothing to show, nothing recognisable, no sanctioned empty
        # success, and the server did not even say the call failed: the old
        # shape here was an empty "success" (ruling R2-7) — never report one
        # we did not establish. A note about a skipped or malformed block
        # does not count as content (ruling R3-B): it says what could not
        # be read, not that something was.
        raise ClientError(
            f"{endpoint.name}'s result has no readable content and no structuredContent",
            reachable=True,
        )
    return CallResult(
        text="\n".join(parts),
        is_error=bool(result.get("isError")),
        structured=structured,
        notes=tuple(notes),
    )


# -- small helpers --------------------------------------------------------------


def _title(info: Any) -> str | None:
    if not isinstance(info, dict):
        return None
    for key in ("title", "name"):
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:80]
    return None


def _error_code(answer: dict | None) -> int | None:
    if not isinstance(answer, dict) or not isinstance(answer.get("error"), dict):
        return None
    code = answer["error"].get("code")
    return code if isinstance(code, int) else None


def _refused(endpoint: Endpoint, status: int, answer: dict | None, excerpt: str) -> str:
    detail = ""
    if isinstance(answer, dict) and isinstance(answer.get("error"), dict):
        detail = str(answer["error"].get("message") or "")
    detail = detail or excerpt
    return (
        f"{endpoint.name} refused the credentials (HTTP {status}{': ' + detail if detail else ''})"
    )
