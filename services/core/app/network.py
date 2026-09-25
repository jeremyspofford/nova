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
    except OSError as exc:
        return none(f"the tailnet status could not be read ({exc.strerror or exc})")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
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
