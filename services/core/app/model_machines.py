"""Model machines: which gateway providers run on a machine, not a cloud.

machine_status reports every model provider the gateway routes to that runs on
a machine Nova can reach (a home LAN host, a tailnet node, a container), and
which paired device it runs on. Everything here is derived from live state."""

from __future__ import annotations

import ipaddress
import math
import re
from datetime import datetime
from urllib.parse import urlsplit

# Names that only resolve on a home network, a tailnet or a container network.
# Each is matched as whole trailing labels, never as a text suffix.
MACHINE_SUFFIXES = ("ts.net", "local", "lan", "internal", "home.arpa")


def _host(base_url: str | None) -> str | None:
    """The URL's host, lowercased, one trailing dot dropped; None when absent."""
    if not isinstance(base_url, str) or not base_url:
        return None
    try:
        host = urlsplit(base_url.strip()).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.lower()
    if host.endswith("."):
        host = host[:-1]
    return host or None


def on_a_machine(base_url: str | None) -> bool:
    """True when the provider URL's host is a machine, not a cloud service.

    Decided from the host alone — no DNS lookup, no network call: an IP
    literal that is not globally routable (private, CGNAT/tailnet, loopback,
    link-local, ULA), a single-label name (localhost, a container name), or a
    name under a home/tailnet suffix."""
    host = _host(base_url)
    if host is None:
        return False
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        pass
    labels = host.split(".")
    if len(labels) == 1:
        return True
    return any(
        labels[-len(suffix.split(".")) :] == suffix.split(".") for suffix in MACHINE_SUFFIXES
    )


# A tailnet peer's OS (as tailscale reports it) -> a paired device's platform.
PEER_OS_PLATFORM = {"windows": "windows", "linux": "linux", "macos": "darwin"}

VIA_AGENT = "its agent's addresses"


def _ip(text: object) -> str | None:
    """The normalised text of an IP address; None when it is not one."""
    if not isinstance(text, str):
        return None
    try:
        return str(ipaddress.ip_address(text.strip()))
    except ValueError:
        return None


def _dns(text: object) -> str | None:
    if not isinstance(text, str):
        return None
    name = text.strip().lower()
    if name.endswith("."):
        name = name[:-1]
    return name or None


def _peer_matches(peer: dict, host: str, host_ip: str | None) -> bool:
    if host_ip is not None:
        ips = peer.get("ips")
        if isinstance(ips, (tuple, list)) and host_ip in {_ip(ip) for ip in ips}:
            return True
    return _dns(peer.get("dns_name")) == host


def _agents_of_peer(peer: dict, agents: list[dict]) -> list[dict]:
    """The agents whose hostname is the peer's host name, narrowed by OS when
    more than one: a machine that runs two agents (Windows + WSL) is two peers."""
    host_name = peer.get("host_name")
    if not isinstance(host_name, str) or not host_name:
        return []
    want = host_name.casefold()
    found = [
        a for a in agents if isinstance(a.get("hostname"), str) and a["hostname"].casefold() == want
    ]
    if len(found) > 1:
        os_name = peer.get("os")
        platform = PEER_OS_PLATFORM.get(os_name.lower()) if isinstance(os_name, str) else None
        narrowed = [a for a in found if a.get("platform") == platform]
        if platform is not None and narrowed:
            found = narrowed
    return found


def device_of(base_url: str | None, agents: list[dict], peers: object) -> dict:
    """{device, via, said}: the paired device a provider URL's host names.

    Two live sources, both tried and unioned: (a) an agent's own reported
    addresses (works on a LAN, no Tailscale needed); (b) the stack's tailnet
    peer list — the URL host is a peer's IP or MagicDNS name, and the peer's
    host name is a paired agent's hostname. Identity only, never liveness.
    No I/O: agents and peers are what the caller already read."""
    host = _host(base_url)
    if host is None:
        return {
            "device": None,
            "via": (),
            "said": "the provider URL names no host, so no paired device can be named",
        }
    host_ip = _ip(host)
    agent_list = [a for a in (agents or []) if isinstance(a, dict)]
    peer_list = getattr(peers, "peers", ()) or ()
    peer_reason = getattr(peers, "reason", None)

    vias: dict[str, list[str]] = {}

    def found(name: object, via: str) -> None:
        if isinstance(name, str) and name and via not in vias.setdefault(name, []):
            vias[name].append(via)

    if host_ip is not None:
        for agent in agent_list:
            addresses = agent.get("addresses")
            if not isinstance(addresses, (tuple, list)):
                continue
            if host_ip in {_ip(a) for a in addresses}:
                found(agent.get("name"), VIA_AGENT)

    for peer in peer_list if isinstance(peer_list, (tuple, list)) else ():
        if not isinstance(peer, dict) or not _peer_matches(peer, host, host_ip):
            continue
        dns_name = _dns(peer.get("dns_name")) or str(peer.get("host_name") or host)
        for agent in _agents_of_peer(peer, agent_list):
            found(agent.get("name"), f"the tailnet peer {dns_name}")

    if not vias:
        said = f"no paired device is known by {host}"
        if peer_reason:
            said += f" ({peer_reason})"
        return {"device": None, "via": (), "said": said}

    if len(vias) > 1:
        names = sorted(vias)
        all_vias = tuple(dict.fromkeys(v for n in names for v in vias[n]))
        return {
            "device": None,
            "via": all_vias,
            "said": f"ambiguous: {host} is known by {len(names)} paired devices — "
            + ", ".join(f"{n} ({' and '.join(vias[n])})" for n in names),
        }

    ((name, name_vias),) = vias.items()
    ordered = tuple(sorted(name_vias, key=lambda v: v != VIA_AGENT))
    return {
        "device": name,
        "via": ordered,
        "said": f"runs on paired device {name} ({' and '.join(ordered)})",
    }


NO_VERDICT = "the gateway has no verdict yet on whether it answers"
WALL_NO_REASON = "walled by the gateway"


def _instant(value: object) -> datetime | None:
    """A tz-aware instant from a datetime or an ISO-8601 string; None when it
    is not one or carries no timezone (never guessed as UTC)."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.strip())
        except ValueError:
            return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    if value.utcoffset() is None:
        return None
    return value


def _latest_live_wall(name: object, walls: object, now: datetime) -> tuple[datetime, dict] | None:
    """The provider's live wall (walled_until > now, any model) ending last."""
    if not isinstance(name, str) or not name or not isinstance(walls, list):
        return None
    latest: tuple[datetime, dict] | None = None
    for wall in walls:
        if not isinstance(wall, dict) or wall.get("provider") != name:
            continue
        until = _instant(wall.get("walled_until"))
        if until is None or until <= now:
            continue
        if latest is None or until > latest[0]:
            latest = (until, wall)
    return latest


def state_of(provider: object, walls: object, now: object) -> dict:
    """{state, reason, walled_for_s, answering}: the provider's live state.

    From its public gateway row (`listing`, `listing_note`) and the live walls
    (/admin/routes `walls`). A live wall beats the listing; a listing with no
    verdict, or a row that cannot be read, is "unknown" and never answering.
    No I/O; never raises."""
    unknown = {"state": "unknown", "reason": NO_VERDICT, "walled_for_s": None, "answering": None}
    if not isinstance(provider, dict):
        return unknown
    now_at = _instant(now)
    live = _latest_live_wall(provider.get("name"), walls, now_at) if now_at else None
    if live is not None:
        until, wall = live
        reason = wall.get("reason")
        return {
            "state": "walled",
            "reason": reason if isinstance(reason, str) and reason else WALL_NO_REASON,
            "walled_for_s": math.floor((until - now_at).total_seconds()),
            "answering": False,
        }
    listing = provider.get("listing")
    note = provider.get("listing_note")
    note = note.strip() if isinstance(note, str) and note.strip() else None
    if listing == "available":
        return {
            "state": "answering",
            "reason": note or "the gateway lists its models",
            "walled_for_s": None,
            "answering": True,
        }
    if listing == "unavailable" or (listing == "unknown" and note):
        return {
            "state": "failing",
            "reason": provider.get("listing_note")
            if note
            else "the gateway could not list its models",
            "walled_for_s": None,
            "answering": False,
        }
    return unknown


_LISTED = re.compile(r"(\d+) models listed(?:;|$)")


def listed_models(provider: object) -> int | None:
    """N when the gateway's last listing answered with "N models listed"; else None.

    Reads the leading count of the gateway's Listing.summary() sentence
    ("N models listed", optionally "; <note>"). Only an "available" listing
    carries a count; any other shape is None — never 0, never a guess."""
    if not isinstance(provider, dict) or provider.get("listing") != "available":
        return None
    note = provider.get("listing_note")
    if not isinstance(note, str):
        return None
    match = _LISTED.match(note.strip())
    return int(match.group(1)) if match else None


def remotes_of(providers: object, walls: object, now: object) -> list[dict]:
    """[{name, base_url, host, state, models}] per non-builtin provider on a machine.

    The one selection machine_status and About share: dict rows whose
    `builtin` is not True and whose URL is on a machine, in input order.
    No I/O; the caller supplies `now`."""
    remotes: list[dict] = []
    for provider in providers if isinstance(providers, (list, tuple)) else ():
        if not isinstance(provider, dict) or provider.get("builtin") is True:
            continue
        base_url = provider.get("base_url")
        if not on_a_machine(base_url):
            continue
        remotes.append(
            {
                "name": provider.get("name"),
                "base_url": base_url,
                "host": _host(base_url),
                "state": state_of(provider, walls, now),
                "models": listed_models(provider),
            }
        )
    return remotes


AGENTS_UNREAD_DEVICE = (
    "Nova's agents could not be read, so the paired device it runs on cannot be named"
)


def place(
    base_url: str | None, agents: list[dict], agents_error: str | None, peers: object
) -> dict:
    """{device, said}: the paired device a remote runs on, or why none is named.

    When the agents could not be read, a no-match proves nothing, so no match
    is attempted: device None with AGENTS_UNREAD_DEVICE. Otherwise device_of's
    device and words. No I/O."""
    if agents_error is not None:
        return {"device": None, "said": AGENTS_UNREAD_DEVICE}
    found = device_of(base_url, agents, peers)
    return {"device": found["device"], "said": found["said"]}


def fact_of(remote: dict, device: str | None, at: str) -> dict:
    """The machine_status remote fact for one remote model machine.

    answering is state_of's own value (never assumed); checked_now is False
    (the gateway's last verdict, not a call made now); never a "connected"
    key, which is a device connectivity fact's shape."""
    state = remote["state"]
    return {
        "machine": remote["name"],
        "answering": state["answering"],
        "checked_now": False,
        "state": state["state"],
        "device": device,
        "at": at,
    }


def remote_words(entry: dict, device_said: str) -> str:
    """One remote model machine as words: everything after "<name> (<host>): ".

    The one wording machine_status and About share. Order is state, device,
    reason: the state (a wall's time left in whole minutes, floored), then
    "; <device_said>", then ". Reason: <the gateway's reason>" last, since that
    reason is foreign text that may carry its own punctuation. Answering's
    reason is its listing note, joined by ", " (the model count is said once,
    from the note). A wall with no reason of its own (WALL_NO_REASON) says
    "walled" once and no reason. Takes any dict carrying state/walled_for_s/
    reason — state_of's own, or About's flattened entry. Never "answering"
    unless the state is "answering"."""
    kind = entry["state"]
    reason = entry["reason"]
    if kind == "answering":
        return f"answering, {reason}; {device_said}"
    if kind == "walled":
        left = entry["walled_for_s"]
        minutes = left // 60 if isinstance(left, int) else None
        if minutes is None:
            head = WALL_NO_REASON
        elif minutes < 1:
            head = "walled for less than a minute more"
        else:
            head = f"walled for another {minutes} min"
        if reason == WALL_NO_REASON:
            return f"{head}; {device_said}"
    elif kind == "failing":
        head = "failing"
    else:
        head = "state unknown"
    return f"{head}; {device_said}. Reason: {reason}"
