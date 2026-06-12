"""Wake-on-LAN for a sleeping inference host (split deployments).

The magic packet must reach the target's LAN as an L2 broadcast. Containers on
Docker's bridge network usually can't emit that — the reliable path is the
optional `wol-helper` sidecar (compose profile `wol`, host networking), which
this module delegates to when WOL_HELPER_URL is set. Direct UDP broadcast from
the gateway container is attempted otherwise as a best effort (works with host
networking or macvlan setups).

The target MAC lives in the secrets vault as `wol_mac` — set it in
Settings → Secrets. No secret ⇒ the feature is simply off.
"""
from __future__ import annotations

import logging
import re
import socket
import time

import httpx

from . import secrets_client
from .config import settings

logger = logging.getLogger(__name__)

MAC_SECRET_NAME = "wol_mac"

_mac_cache: dict[str, tuple[float, str | None]] = {}   # secret name -> (time, mac)
_MAC_CACHE_TTL = 60.0
# Per-endpoint last-wake times. Absent key = never woke. (Not 0.0: monotonic
# starts near zero on a fresh boot, which would silently rate-limit auto-wake
# for the first wol_min_interval_s of uptime.)
_last_auto_wake: dict[str, float] = {}


def build_magic_packet(mac: str) -> bytes:
    """6×0xFF + 16×MAC = 102 bytes. Accepts aa:bb:…, aa-bb-…, or bare hex."""
    cleaned = re.sub(r"[:\-.]", "", mac.strip()).lower()
    if not re.fullmatch(r"[0-9a-f]{12}", cleaned):
        raise ValueError(f"Invalid MAC address: {mac!r}")
    mac_bytes = bytes.fromhex(cleaned)
    return b"\xff" * 6 + mac_bytes * 16


async def get_mac(force: bool = False, secret_name: str = MAC_SECRET_NAME) -> str | None:
    """A WoL MAC secret, cached briefly. None ⇒ WoL not configured.

    force propagates all the way through secrets_client so setup/remove in the
    dashboard reflects immediately. Pool endpoints may name their own secret
    (wol_mac_secret); the default endpoint uses 'wol_mac'.
    """
    now = time.monotonic()
    cached = _mac_cache.get(secret_name)
    if not force and cached is not None and (now - cached[0]) < _MAC_CACHE_TTL:
        return cached[1]
    mac = await secrets_client.resolve(secret_name, force=force)
    _mac_cache[secret_name] = (now, mac)
    return mac


async def send_wake(mac: str) -> dict:
    """Send the magic packet — via the helper when configured, else direct UDP."""
    packet = build_magic_packet(mac)

    if settings.wol_helper_url:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{settings.wol_helper_url}/wake",
                json={"mac": mac, "broadcast": settings.wol_broadcast_addr, "port": settings.wol_port},
                headers={"X-Admin-Secret": settings.admin_secret},
            )
            r.raise_for_status()
        return {"via": "helper", "broadcast": settings.wol_broadcast_addr}

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for _ in range(3):
            sock.sendto(packet, (settings.wol_broadcast_addr, settings.wol_port))
    finally:
        sock.close()
    return {"via": "direct-udp", "broadcast": settings.wol_broadcast_addr}


async def wake_if_due(reason: str, ep: dict | None = None) -> bool:
    """Rate-limited (per endpoint) auto-wake for routing failures.

    True if a wake was sent. Never raises — a failed wake must not mask the
    original completion error.
    """
    eid = ep["id"] if ep else "default"
    secret_name = (ep or {}).get("wol_mac_secret") or MAC_SECRET_NAME
    now = time.monotonic()
    last = _last_auto_wake.get(eid)
    if last is not None and (now - last) < settings.wol_min_interval_s:
        return False
    try:
        mac = await get_mac(secret_name=secret_name)
        if not mac:
            return False
        _last_auto_wake[eid] = now
        result = await send_wake(mac)
        logger.info("WoL fired for endpoint %s (%s) — %s", eid, result["via"], reason)
        return True
    except Exception as exc:
        logger.warning("WoL attempt failed for endpoint %s (%s): %s", eid, reason, exc)
        return False
