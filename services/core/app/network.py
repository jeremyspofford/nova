"""Nova's address for another device (S47; D17, pulled forward from S43a).

The tailnet name is known only to tailscaled, inside the sidecar. Every 15 s
deploy/tailscale/start.sh writes what tailscaled says to
/run/nova-status/tailscale.json on the v4_status volume, which core mounts
read-only. This module is core's ONE reader of that file: every QR code, her
nova_address tool and the address guard read through address(), so what a
page encodes and what she says cannot come from two readings.

An origin is stated only when every fact holds on a file written in the last
45 seconds. Anything else is None with the FIRST fact that failed, in the
owner's words — a stale file is "no address", never the address it used to
say. It never states loopback, an IP address or plain http: the web UI is
never on the LAN (hub decision 10), and a QR code of 127.0.0.1 opens nothing
on any other device.

No cache: the file is a few hundred bytes and every caller wants now. S43a
widens this to every access origin (Headscale, the LAN door); it extends this
reader, it does not add a second one.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

STATUS_FILE_ENV = "NOVA_STATUS_FILE"
DEFAULT_STATUS_FILE = "/run/nova-status/tailscale.json"
MAX_AGE_S = 45
STATUS_VERSION = 1

# A MagicDNS name: dot-separated DNS labels ending in .ts.net. An IP address or
# "localhost" can never match, which is the loopback/IP refusal by construction.
_TAILNET_NAME = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$")

NO_FILE = (
    "the tailnet sidecar has not written its status — this Nova runs without its "
    "tailnet (`NOVA_TAILNET=1 ./install` turns it on)"
)


@dataclass(frozen=True)
class Address:
    origin: str | None
    reason: str | None
    read_at: datetime

    def as_json(self) -> dict:
        return {"address": self.origin, "reason": self.reason, "read_at": self.read_at.isoformat()}


def status_path() -> Path:
    return Path(os.environ.get(STATUS_FILE_ENV) or DEFAULT_STATUS_FILE)


def _parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _age(seconds: float) -> str:
    if seconds < 120:
        return f"{int(seconds)} seconds"
    minutes = int(seconds // 60)
    if minutes < 120:
        return f"{minutes} minutes"
    return f"{int(minutes // 60)} hours"


def address(now: datetime | None = None) -> Address:
    now = now or datetime.now(UTC)

    def none(reason: str) -> Address:
        return Address(None, reason, now)

    try:
        raw = status_path().read_text(encoding="utf-8")
    except FileNotFoundError:
        return none(NO_FILE)
    # A byte the sidecar never wrote (a torn write caught mid-flush, a
    # corrupted volume) must be a stated reason like every other malformed
    # file — never an uncaught UnicodeDecodeError out of core's one reader
    # (review fix round 1, I6).
    except UnicodeDecodeError:
        return none("the tailnet status file is not UTF-8 text")
    except OSError as exc:
        return none(f"the tailnet status could not be read ({exc.strerror or exc})")
    try:
        data = json.loads(raw)
    # RecursionError (pathologically deep nesting) is not a ValueError and
    # json.JSONDecodeError IS one, so the two are caught in this order:
    # RecursionError first, then any ValueError (json.JSONDecodeError and any
    # other parse failure) (review fix round 1, I6).
    except RecursionError:
        return none("the tailnet status file is nested too deeply to parse")
    except ValueError:
        return none("the tailnet status file is not valid JSON")
    if not isinstance(data, dict):
        return none("the tailnet status file is not a JSON object")
    if data.get("version") != STATUS_VERSION:
        return none(
            f"the tailnet status file is version {data.get('version')!r}; this core "
            f"reads version {STATUS_VERSION}"
        )
    written = _parse_time(data.get("written_at"))
    if written is None:
        return none("the tailnet status file has no readable written_at")
    age = (now - written).total_seconds()
    if age > MAX_AGE_S:
        return none(f"the tailnet status is {_age(age)} old — the sidecar has stopped writing it")
    if age < -MAX_AGE_S:
        return none(
            f"the tailnet status is dated {_age(-age)} in the future — this host's clocks disagree"
        )
    state = data.get("backend_state")
    if state != "Running":
        said = state if isinstance(state, str) and state else "in no stated state"
        return none(f"the tailnet sidecar is {said}, not Running")
    name = data.get("dns_name")
    if not isinstance(name, str) or not name.strip():
        return none("the tailnet status names no DNS name")
    name = name.strip().rstrip(".").lower()
    if not _TAILNET_NAME.match(name):
        return none(f"the tailnet name {name!r} is not a MagicDNS name (*.ts.net)")
    if data.get("serve_ok") is not True:
        return none("the tailnet does not serve Nova over HTTPS: the serve mapping is missing")
    if data.get("https_cert") is not True:
        return none(
            "the tailnet does not serve Nova over HTTPS: HTTPS certificates are not "
            "enabled for this tailnet (admin console: DNS -> HTTPS Certificates)"
        )
    return Address(f"https://{name}", None, now)


# -- S42b: which door a device socket came through (P15) ---------------------

# The stack's own addresses (deploy/docker-compose.yml; decide_subnet writes
# them to .env when 172.18 is taken). Core reads them to tell which door a
# device socket came through; the defaults are compose's.
WEB_ADDR_ENV = "NOVA_WEB_ADDR"
TAILSCALE_ADDR_ENV = "NOVA_TAILSCALE_ADDR"
GATEWAY_ENV = "NOVA_SUBNET_GATEWAY"
_ADDR_DEFAULTS = {
    WEB_ADDR_ENV: "172.18.128.10",
    TAILSCALE_ADDR_ENV: "172.18.128.20",
    GATEWAY_ENV: "172.18.0.1",
}


def _addr(name: str) -> str:
    return os.environ.get(name) or _ADDR_DEFAULTS[name]


def door_of(peer: str | None, forwarded: str | None) -> str | None:
    """Which door a device socket came through: "host" — the hub machine's own
    published loopback port, whose traffic docker hands to the stack from the
    subnet gateway (measured, Task 2 — docs/plans/rebuild/hub-p0-measurements.md,
    "The loopback door": a loopback request arrives at `web` carrying
    NOVA_SUBNET_GATEWAY as its client address); "tailnet" — through the
    sidecar; None when it cannot be told. nginx's X-Real-IP is believed ONLY
    from web's fixed address: on a bridge a connection cannot be completed
    from a spoofed source, so any other sender's header counts for nothing
    (P15).

    The door is not identity (S42b Task 22): anything that reaches the hub
    machine's own loopback port comes in through "host" — a relay on the hub
    too, such as the owner's tunnel or an ssh -L. So "host" says how a
    socket came in, never that its agent runs on the hub machine: the agent
    lines of machine_status and device_list, and machine_update's refusal of
    "hub", say it as "came in through the hub machine's own door"."""
    if peer == _addr(WEB_ADDR_ENV):
        if forwarded == _addr(GATEWAY_ENV):
            return "host"
        if forwarded == _addr(TAILSCALE_ADDR_ENV):
            return "tailnet"
        return None
    if peer == _addr(GATEWAY_ENV):
        return "host"
    return None


def client_of(peer: str | None, real_ip: str | None) -> str:
    """Who sent a request, as far as core can tell (S42b; the door half of
    bucket_of, which core's per-client limits count by): nginx's X-Real-IP
    when the request came from web's fixed address — nginx writes its own
    $remote_addr over whatever the caller sent — and the peer itself
    otherwise. door_of's rule: a header any other sender wrote counts for
    nothing, so it can neither buy a new identity nor borrow another's.
    Behind nginx this is the door: the hub's loopback port arrives from the
    subnet gateway, the tailnet from the sidecar."""
    if peer is not None and peer == _addr(WEB_ADDR_ENV):
        said = (real_ip or "").strip()
        if said:
            return said
    return peer or "unknown"


def bucket_of(peer: str | None, headers: Mapping[str, str]) -> str:
    """The bucket a request is counted in by core's per-client limits (S42b
    Task 26): the agent downloads' 30 a minute (agent_dist_api) and enroll's
    5 code failures in 15 minutes (devices_api) both key on this and
    nothing else. It is client_of's door, with a visitor who came through a public
    RELAY counted apart, as "relayed via <door>". `headers` are the
    request's: any mapping, its names matched case-insensitively HERE —
    lower-cased on the way in (fix round 1, I5) — so a plain dict, which
    unlike Starlette's Headers matches only the exact spelling, can never
    lose the door or the relay mark.

    A relay on the hub machine shares a door: the owner's cloudflared tunnel
    reaches web from the subnet gateway, as ./install and a browser on the
    hub do. Counted by the door alone, a stranger on the tunnel asking 30
    times a minute would hold ./install's download off for as long as it
    kept asking, and five wrong codes would lock pairing through the hub's
    own loopback.

    "Relayed" is decided by a header's PRESENCE, from facts a relayed
    visitor cannot remove, and believed ONLY from web's fixed address —
    client_of's rule, door_of's: from any other peer every header counts
    for nothing.
      * The tunnel: Cf-Connecting-IP is there. Cloudflare's edge sets it on
        every request it proxies, and a visitor cannot strip it. Only its
        presence counts: its value is the caller's to write, so it never
        names a bucket.
      * Funnel: the request came from the sidecar WITHOUT serve's
        Tailscale-User-Login. serve strips a client's copy and never sets
        one on funnel traffic, and nginx forwards the header only from the
        sidecar, so from web the login is serve's or nothing: the gate's
        own $tailnet_peer rule, negated. A tagged tailnet node, which
        carries no identity header, lands here too.
    Both marks fail toward "relayed": an empty Cf-Connecting-IP is there, a
    blank login is no login. Nothing nginx does not already forward is read.

    One relayed bucket per door: the tunnel's strangers (the loopback door)
    and funnel's (the sidecar) never spend each other's budget, and neither
    spends its door's own.

    What follows:
      * a relayed visitor can never leave the relayed bucket — the door is
        nginx's $remote_addr, which it cannot choose, and the mark is a fact
        it cannot remove;
      * the hub's own loopback is never starved by one — ./install straight
        to core arrives with the gateway as its peer, so none of its headers
        is read, and through web it is the door with no mark;
      * a forged mark can only move its sender INTO the relayed bucket of
        its own door, never out of it, and never into another client's.
    If Cloudflare's header is ever absent, a tunnel visitor falls back to
    the loopback door's own bucket, where every visitor was counted before
    this split: no worse than then.

    What being counted in a relayed bucket costs (fix round 1, I6): for the
    downloads, a shared minute; for enroll, more — a bucket at five failures
    is a refusal to pair from that door for up to 15 minutes, which anyone
    in the same bucket can renew. The owner pairing through his own tunnel
    shares the tunnel's relayed bucket with its strangers; his way round is
    the tailnet or the hub machine, whose buckets no stranger reaches. A
    tagged node shares the sidecar's relayed bucket with funnel's visitors —
    but deploy/tailscale/start.sh turns funnel OFF on every restart, so
    unless the owner turns it on again, only his own tagged nodes share it
    and no stranger can renew a lock there."""
    headers = {name.lower(): value for name, value in headers.items()}
    client = client_of(peer, headers.get("x-real-ip"))
    if peer is None or peer != _addr(WEB_ADDR_ENV):
        return client
    tunnel = "cf-connecting-ip" in headers
    login = (headers.get("tailscale-user-login") or "").strip()
    funnel = client == _addr(TAILSCALE_ADDR_ENV) and not login
    return f"relayed via {client}" if tunnel or funnel else client
