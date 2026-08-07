"""Outbound-target guard: may the backend open a connection to this URL?

Lifted out of `tools/web_fetch.py`, where it grew up guarding the fetch_url
tool alone. It is its own module now because it has five callers and only
one of them is fetch_url:

    tools/web_fetch.py      the original — every hop of every fetch
    media_client.py         was already reaching in for `_validate_target`
                            by private cross-module import
    actions/__init__.py     preflighting a URL a model put on a card
    mcp_client.py           dialling any server a model proposed, i.e.
                            mcp_servers.created_by <> 'operator'
    tools/http_executor.py  every DB-defined http_call tool — under the
                            SECOND policy below, not the first one

Three of those needed the same allow-list; two of them would have
copied it. Migration 037 exists in this repo because a copied rule drifted
from its original, so: one copy, one audit, one place to fix.

ALLOW-LIST, NOT DENY-LIST. Only globally routable addresses pass. The
deny-list this replaced (private/loopback/link-local/reserved/multicast/
unspecified) silently missed CGNAT — 100.64.0.0/10, which is exactly
Tailscale's range — because CPython's `ipaddress` classifies it as none of
those, only as `not is_global`. With the tailscale profile up that left
every peer on the tailnet fetchable by the model.

TWO POLICIES, because two features need the line drawn in different places.
`validate_target` is the strict one above: only globally routable addresses,
for anything reached on the model's say-so. `validate_offstack_target` is for
the operator-approved `tool_host_allowlist`, where reaching the LAN is the
entire point — it refuses this machine and this install's own services and
permits the rest. The comment block over it argues why that is a boundary and
not a weakening.

RESIDUAL RISK, documented deliberately: we resolve, then connect, and httpx
resolves again. A hostile resolver flipping records between the two calls
(DNS rebinding) defeats this. Accepted at this trust level; a pinned-IP
transport is the only thing that closes it. It applies to both policies.
"""

import asyncio
import ipaddress
import logging
import socket
import time
from urllib.parse import urlparse

log = logging.getLogger(__name__)

# What a failed resolution looks like. `gaierror` is the obvious one and was
# the only one caught until 2026-08-05, when both policies were measured
# against a hostname carrying a 70-character label: `getaddrinfo` answers
# that with UnicodeError from the idna codec ("label empty or too long"), not
# with gaierror, and UnicodeError is not an OSError — so the guard raised
# instead of refusing, out of a function whose docstring promises it never
# does. Both policies take hostnames a model chose (validate_target with no
# allow-list in front of it at all), so the string that reaches here is not
# constrained to be a plausible name.
_RESOLVE_ERRORS = (OSError, UnicodeError)


async def _resolve(host: str) -> list:
    """getaddrinfo off the event loop. Raises `_RESOLVE_ERRORS` on failure."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP))


async def validate_target(url: str) -> str | None:
    """Return an error string if the URL must not be dialled, else None.

    Never raises: an unresolvable host is a refusal with a reason, not an
    exception for five call sites to each handle their own way.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"scheme '{parsed.scheme}' is not allowed (http/https only)"
    host = parsed.hostname
    if not host:
        return "URL has no hostname"

    try:
        infos = await _resolve(host)
    except _RESOLVE_ERRORS as e:
        return f"cannot resolve host '{host}': {e}"

    for info in infos:
        if not is_public_address(info[4][0]):
            # host_of, not the url: mcp_client and http_executor hand this
            # the RESOLVED url — `{{secret:name}}` already substituted,
            # possibly into the PATH where no shape rule finds it — so the
            # raw form put credentials in the log on every refusal. The
            # refusal is about where the host resolves; the host is the fact.
            from app import redact
            log.warning("SSRF guard refused %s (resolves to %s)",
                        redact.host_of(url), info[4][0])
            return (f"host '{host}' resolves to a non-public address "
                    f"({info[4][0]}) — connecting to internal/private targets "
                    f"is not allowed")
    return None


def _unwrap(raw_ip: str):
    """The address a connection would actually reach, as an ip_address.

    Two wrinkles: an IPv4-mapped/NAT64 v6 address reports on the v6 wrapper
    rather than the v4 target it really reaches, and getaddrinfo hands back
    scoped link-local forms like 'fe80::1%eth0' that `ip_address` refuses
    outright — a ValueError out of a guard is a crash, not a refusal, so the
    zone is dropped and the address is classified normally.
    """
    ip = ipaddress.ip_address(raw_ip.split("%", 1)[0])
    if getattr(ip, "ipv4_mapped", None):
        return ip.ipv4_mapped
    if ip.version == 6 and ip in ipaddress.ip_network("64:ff9b::/96"):
        # NAT64: the low 32 bits are the real IPv4 destination
        return ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    return ip


def is_public_address(raw_ip: str) -> bool:
    """Only globally routable addresses pass.

    One wrinkle `is_global` does not cover on its own: some multicast is
    is_global.
    """
    ip = _unwrap(raw_ip)
    return ip.is_global and not ip.is_multicast


# ─── second policy: off-stack targets, for the http_call tools ──────────────
#
# `validate_target` is the WRONG guard for `tool_host_allowlist`, and calling
# it there would delete the feature it was meant to protect: it passes only
# globally routable addresses, and reaching the LAN is the entire reason that
# allow-list exists. `builtin._manage_tool_hosts` names `router.lan` as its
# example, migration 067 records "manage my router" as the use case that
# motivated the table, and `tools/scopes.py:139` sells the verb to the
# operator as "a new host on your network or the internet".
#
# `tools/scopes.py:135` already draws the line this needs: the card for
# allow_internet_egress reads "your LAN and the Nova stack stay blocked", so
# the LAN and the stack are two separately modelled targets rather than one
# "private" blob. Only one of them is refused here.
#
# What must be refused is not academic. Until 2026-08-05 `execute_http_tool`
# checked the allow-listed HOSTNAME and nothing else — it never resolved and
# never called this module — so an approved name pointing at 127.0.0.1
# dialled the backend's own :8000, where `main._is_local` grants the
# tokenless path and /api/v1/auth/token answers with the admin token
# (verified live: 200, a 48-character token, no Authorization header). Tool
# results are never redacted, so that body lands in model context, the SSE
# stream, and the 30-day `messages` rows. 169.254.169.254 (cloud instance
# metadata) and http://postgres:5432 were reachable the same way.
#
# THE CHECK RUNS AT DIAL TIME, not when the host was approved. A name that
# pointed at the router the day an operator allow-listed it can point at
# 127.0.0.1 by the time the tool runs; only the resolution taken now is a
# fact about where this request is going.

_STACK_TTL_S = 60.0
_stack_cache: tuple[float, frozenset[str], tuple] | None = None


def _own_addresses() -> set[str]:
    """Every address this process's own container answers on."""
    try:
        return {i[4][0] for i in socket.getaddrinfo(
            socket.gethostname(), None, proto=socket.IPPROTO_TCP)}
    except _RESOLVE_ERRORS:
        return set()


def _configured_hosts() -> set[str]:
    """Every host named by a URL in the live env configuration.

    DERIVED FROM `settings`, not from a list of container names. The whole
    stack is in there already — postgres via database_url, the sidecar,
    ollama, searxng, mcp-runner, coder, media, whisper, kokoro, ntfy — so a
    service added to config.py tomorrow is covered by the line that added it,
    and a service pointed at a non-compose address (a host-run ollama) is
    covered at the address it is actually configured to use.
    """
    from app.config import settings
    hosts: set[str] = set()
    for value in settings.model_dump().values():
        if isinstance(value, str) and "://" in value:
            host = urlparse(value).hostname
            if host:
                hosts.add(host)
    return hosts


def _compose_network_prefixes() -> tuple:
    """The subnets this container shares with its compose peers.

    Catches every peer, including ones with no URL in the configuration at
    all, without naming a single container: a directly attached route (no
    gateway) is a segment this container is ON, and inside compose that
    segment is the docker bridge every other service sits on.

    GATED on docker's embedded resolver — 127.0.0.11 in /etc/resolv.conf is
    the signature of a user-defined docker network, and the same fact that
    makes `postgres` resolve by name at all. Without it (a bare-metal run, or
    network_mode: host) the attached segment IS the operator's LAN, and
    calling the LAN "the stack" would refuse exactly what this guard exists
    to permit. IPv4 only: compose networks are v4 here, and a v6 peer is
    still caught by name through `_configured_hosts`.
    """
    try:
        with open("/etc/resolv.conf") as f:
            if "127.0.0.11" not in f.read():
                return ()
    except OSError:
        return ()

    nets = []
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                fields = line.split()
                # fields[2] is the gateway: a nonzero one means the route
                # leaves this segment, so it is not our own network.
                if len(fields) < 8 or fields[2] != "00000000":
                    continue
                dest, mask = _le_addr(fields[1]), _le_addr(fields[7])
                if not dest or not mask or mask == "0.0.0.0":
                    continue
                nets.append(ipaddress.ip_network(f"{dest}/{mask}", strict=False))
    except (OSError, ValueError) as e:
        log.warning("net_guard: cannot read attached routes: %s", e)
    return tuple(nets)


def _le_addr(field: str) -> str | None:
    """One little-endian hex column of /proc/net/route as dotted quad."""
    try:
        return ".".join(str(b) for b in reversed(bytes.fromhex(field)))
    except ValueError:
        return None


def _resolve_stack() -> tuple[frozenset[str], tuple]:
    """Blocking half of `stack_targets` — DNS, /proc and /etc reads."""
    addrs = _own_addresses()

    # The addresses the auth middleware treats as "this machine" and as
    # proxies allowed to speak for someone else. Refusing exactly what auth
    # TRUSTS is the invariant that matters, and reading main's own tuple is
    # what keeps the two from drifting: an address added there is refused
    # here the same minute, with nothing to remember.
    try:
        from app.main import _LOCAL_IPS, _proxy_ips
        addrs.update(_LOCAL_IPS)
        addrs.update(_proxy_ips())
    except Exception as e:  # noqa: BLE001 — one source failing is not all four
        log.warning("net_guard: local-trust addresses unavailable: %s", e)

    for host in _configured_hosts():
        try:
            resolved = {i[4][0] for i in socket.getaddrinfo(
                host, None, proto=socket.IPPROTO_TCP)}
        # A profile that is not up is simply not a target, and a typo'd URL
        # in .env is one host missing from the deny set — never an exception
        # thrown out of a guard that promises it refuses instead.
        except _RESOLVE_ERRORS:
            continue
        # Only what we would refuse anyway on routability. openrouter.ai is
        # in this configuration too, and a public API endpoint is not the
        # Nova stack — this filter is what stops the deny-set growing into
        # the internet as providers are added.
        addrs.update(a for a in resolved if not is_public_address(a))

    return frozenset(addrs), _compose_network_prefixes()


async def stack_targets() -> tuple[frozenset[str], tuple]:
    """This install's own addresses, and the networks it sits on.

    Cached for a minute because it costs a DNS lookup per configured service
    and it sits in the turn path. Container addresses change on recreate, so
    it is resolved rather than configured — the same reason `main._proxy_ips`
    caches instead of reading a setting.
    """
    global _stack_cache
    now = time.monotonic()
    if _stack_cache and now - _stack_cache[0] < _STACK_TTL_S:
        return _stack_cache[1], _stack_cache[2]
    loop = asyncio.get_running_loop()
    addrs, nets = await loop.run_in_executor(None, _resolve_stack)
    _stack_cache = (now, addrs, nets)
    return addrs, nets


def _offstack_reason(raw_ip: str, stack: frozenset[str], nets) -> str | None:
    """Why this address is Nova rather than somewhere else, or None.

    The three fixed classes are asked of `ipaddress`, never listed here:
    169.254.169.254 is refused because it is link-local, not because cloud
    metadata is on a list someone maintains.
    """
    ip = _unwrap(raw_ip)
    if ip.is_unspecified:
        return "the unspecified address, which resolves to this host"
    if ip.is_loopback:
        return "this machine's loopback interface"
    if ip.is_link_local:
        return "a link-local address (where cloud instance metadata lives)"
    if raw_ip in stack or str(ip) in stack:
        return "an address belonging to the Nova stack itself"
    if any(ip.version == n.version and ip in n for n in nets):
        return "inside the Nova stack's own container network"
    return None


async def validate_offstack_target(url: str) -> str | None:
    """Return an error string if this URL points back at Nova, else None.

    GUARANTEES the target is not loopback, not link-local, not the
    unspecified address, and not an address this install's own services
    answer on — resolved at the moment of the call, so a name that has since
    been repointed is caught.

    DELIBERATELY PERMITS RFC1918 and CGNAT: `router.lan` is the canonical
    allow-listed host, and refusing the LAN would make `manage_tool_hosts`
    dead on arrival. This is a narrower guard than `validate_target` on
    purpose, and it is only ever reached behind an operator-approved goal.

    DELIBERATELY DOES NOT close DNS rebinding (see the module docstring), and
    does not discriminate by port — the allow-list has no port column, so
    approving a host approves every port on it. Both are recorded rather than
    silently assumed.

    Never raises: an unresolvable host is a refusal with a reason.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"scheme '{parsed.scheme}' is not allowed (http/https only)"
    host = parsed.hostname
    if not host:
        return "URL has no hostname"

    try:
        infos = await _resolve(host)
    except _RESOLVE_ERRORS as e:
        return f"cannot resolve host '{host}': {e}"

    stack, nets = await stack_targets()
    for info in infos:
        raw = info[4][0]
        reason = _offstack_reason(raw, stack, nets)
        if reason:
            log.warning("off-stack guard refused %s (resolves to %s: %s)",
                        url, raw, reason)
            return (f"host '{host}' resolves to {raw}, which is {reason} — "
                    f"an approved outbound host may not point back at Nova "
                    f"or at the machine she runs on")
    return None
