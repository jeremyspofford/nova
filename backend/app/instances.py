"""Instance identity + leadership — the seam co-owned with
`docs/plans/remote-shared-state.md`.

Nova may run as several backends against one shared DB ("one brain, many
machines"). Every metric, trace, and alert is attributed to the *instance*
that produced it. Today there is exactly one instance and it is always the
leader; when remote-shared-state phase 1 lands `leader.py` (a pg advisory
lock), `is_leader()` here delegates to it and nothing else in the
observability code changes — which is the whole point of routing leadership
through this one function from the start.

Identity is stored in the per-host `/state` volume, NOT the settings store:
`settings_store` is DB-backed and therefore SHARED across instances, so an id
kept there would be identical on every machine — exactly wrong. `/state` is a
per-host docker volume (the same one the model-store path lives in), so each
instance gets its own stable id.
"""

import logging
import os
import socket
import uuid

log = logging.getLogger(__name__)

_STATE_ID_FILE = os.environ.get("INSTANCE_ID_FILE", "/state/instance_id")
_id: str | None = None


def _read_id_file() -> str | None:
    try:
        with open(_STATE_ID_FILE) as f:
            return f.read().strip() or None
    except OSError:
        return None


async def ensure_id() -> str:
    """Stable per-host id, generated once and persisted in /state so history
    rows survive container recreation with the same id. Cached in-process."""
    global _id
    if _id:
        return _id
    val = _read_id_file()
    if not val:
        val = uuid.uuid4().hex[:12]
        try:
            with open(_STATE_ID_FILE, "w") as f:
                f.write(val)
        except OSError as e:
            log.warning("could not persist instance id (%s); using ephemeral id", e)
    _id = val
    return _id


def label() -> str:
    """Human name for this instance. NOVA_INSTANCE_LABEL lets an operator name
    a machine ('work laptop'); otherwise the container/host name — enough to
    tell two instances apart."""
    return (os.environ.get("NOVA_INSTANCE_LABEL")
            or os.environ.get("HOSTNAME") or socket.gethostname())


def is_leader() -> bool:
    """Whether this instance runs the fleet-wide singletons (automations,
    retention prunes, alert evaluation). Delegates to the advisory-lock
    election (remote-shared-state phase 1) — exactly the swap this seam was
    built for; callers are unchanged."""
    from app import leader
    return leader.is_leader()
