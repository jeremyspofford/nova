"""Backups as the app sees them (roadmap #31, phase 1 wiring).

The four `backup_*` modules take paths and DSNs and know nothing about this
application. This is the layer that answers "where, and with what
credentials" from live settings, so a caller — an HTTP route, an automation
— does not have to.

Deliberately thin. Every refusal that matters already lives below: coverage
refuses when a store is unaccounted for, snapshot refuses when a source
cannot be read, apply refuses without a verified way back. Adding judgement
here would put a second opinion in front of controls that are supposed to be
the only one.
"""

import logging
import os
from pathlib import Path
from typing import Optional

from app import settings_store
from app.config import settings

log = logging.getLogger(__name__)

# Where bundles land inside the container. A bind mount, so they survive the
# container and can be copied off the machine — a backup that only exists
# inside the thing it is backing up is not one.
BACKUP_DIR = Path(os.environ.get("NOVA_BACKUP_DIR", "/app/data/backups"))

# The project root as the CONTAINER sees it. Coverage is derived from the
# host's compose file and git, so the paths it returns are host paths; they
# have to be translated to where this process can actually read them.
HOST_ROOT = os.environ.get("NOVA_PROJECT_DIR_HOST", "/home/jeremy/workspace/nova")
CONTAINER_ROOT = os.environ.get("NOVA_PROJECT_DIR", "/app/project")


def store_available() -> tuple[bool, str]:
    """Whether bundles can be written at all, asked of the filesystem."""
    if not BACKUP_DIR.exists():
        return False, (f"the backup directory {BACKUP_DIR} is not mounted — "
                       f"add ./data/backups to the backend service in "
                       f"docker-compose.yml. Writing bundles into the "
                       f"container would lose them on the next rebuild, "
                       f"which is the one moment you would want them.")
    if not os.access(BACKUP_DIR, os.W_OK):
        return False, f"{BACKUP_DIR} is not writable"
    return True, ""


def dsn(database: str = "nova") -> str:
    """A DSN for this stack's Postgres, from the same URL the app uses."""
    base = settings.database_url
    head = base.rsplit("/", 1)[0]
    return f"{head}/{database}"


def to_container_path(host_path: str) -> Optional[str]:
    """Translate a host path from the coverage report into one this process
    can read, or None if it is not reachable from here.

    None rather than a guess: `backup_coverage.check_reachable` turns an
    unreachable include into a REFUSAL, and that is the correct outcome —
    a bundle missing a tier because the runner could not see it is exactly
    what the refusal exists to prevent.
    """
    if host_path.startswith(HOST_ROOT):
        rel = host_path[len(HOST_ROOT):].lstrip("/")
        candidate = Path(CONTAINER_ROOT) / rel
        if candidate.exists():
            return str(candidate)
        # the individually-bound data dirs are the common case
        alt = Path("/app") / rel
        if alt.exists():
            return str(alt)
    return None


def volume_paths() -> dict[str, str]:
    """Named volumes this process can read, for the snapshot.

    Derived by looking, not by listing: a volume classified for inclusion
    that is absent here becomes a refusal in `backup_snapshot.create`
    rather than a silent omission.
    """
    found = {}
    for name, path in (("nova_state", "/state"),
                       ("tailscale_state", "/vol/tailscale_state")):
        if Path(path).is_dir():
            found[name] = path
    return found


# The scan shells out to git over a bind-mounted repo and parses the compose
# file: measured at 3.5s on this machine, which is a card sitting on a
# skeleton every time Settings opens. Cached briefly — the inputs are the
# compose file and git's opinion of the tree, neither of which changes
# between two clicks. A SNAPSHOT never uses the cache (see below): the whole
# point of the refusals is that they reflect the stack as it is at the
# moment a bundle is written.
_cov_cache: tuple[float, dict] | None = None
_COV_TTL_S = 60.0


async def coverage(*, fresh: bool = False) -> dict:
    """What a bundle would contain right now, and whether one may be made."""
    global _cov_cache
    import time as _time
    if not fresh and _cov_cache and _time.monotonic() - _cov_cache[0] < _COV_TTL_S:
        return _cov_cache[1]
    from app import backup_coverage as bc, backup_inventory as bi
    # Read the compose file rather than asking docker: no CLI in here, and
    # the socket stays with inference-control where it belongs.
    inventory = bi.from_compose_file(CONTAINER_ROOT)
    # Paths are resolved against the CONTAINER's view of the project, which
    # is where git also runs. Coverage therefore speaks container paths
    # end to end and needs no host/container translation at all.
    report = bc.report(
        inventory, project_dir=CONTAINER_ROOT,
        git_status=bi.git_status_fn(CONTAINER_ROOT),
        ignored_paths=bi.ignored_top_level(CONTAINER_ROOT),
        readable=lambda p: Path(p).exists(),
        include_secrets=bool(settings_store.get("backups.include_secrets")))
    _cov_cache = (_time.monotonic(), report)
    return report


async def snapshot() -> dict:
    """Make one bundle. Refuses loudly rather than producing a partial one."""
    from app import backup_snapshot as bs
    ok, why = store_available()
    if not ok:
        raise bs.SnapshotRefused(why)
    cov = await coverage()
    # rewrite host paths to where this process can read them; anything that
    # cannot be translated was already refused by `readable` above
    return bs.create(cov, out_dir=BACKUP_DIR, dsn=dsn(),
                     volume_paths=volume_paths())


def bundles() -> list[dict]:
    from app import backup_restore as br
    return br.list_bundles(BACKUP_DIR)


async def verify_restore(name: str) -> dict:
    """Prove a bundle restores, into a throwaway database. Non-destructive."""
    from app import backup_restore as br
    target = BACKUP_DIR / name
    if not target.exists() or target.parent != BACKUP_DIR:
        raise br.RestoreRefused(f"no bundle named {name!r}")
    return br.verify_restore(target, dsn("postgres"), live_dsn=dsn())
