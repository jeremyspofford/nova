"""Operator-local time in one place: nova.timezone + nova.time_format.

The server clock is UTC. Anywhere a human reads a time — journal headers,
the system-prompt clock, spoken replies — must go through here so the
timezone and 12h/24h settings win everywhere at once.
"""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app import settings_store

_FALLBACK_TZ = "America/New_York"


def local_tz() -> ZoneInfo:
    name = settings_store.get("nova.timezone") or _FALLBACK_TZ
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(_FALLBACK_TZ)


def now_local() -> datetime:
    return datetime.now(local_tz())


def fmt_clock(dt: datetime, ampm: bool = True) -> str:
    """'2:44 PM' / '2:44' (12h) or '14:44' (24h) per nova.time_format."""
    if settings_store.get("nova.time_format") == "24h":
        return f"{dt:%H:%M}"
    return f"{dt:%-I:%M %p}" if ampm else f"{dt:%-I:%M}"
