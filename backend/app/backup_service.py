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

import datetime as dt
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


def sweep_partials(older_than_s: float = 3600.0) -> int:
    """Remove `.part` archives an interrupted run left behind.

    A snapshot writes to `<name>.tar.gz.part` and renames only after it
    verifies, so a half-written archive is never listable as a bundle. That
    is the right design and it has no janitor: kill the process mid-write and
    the partial stays forever. Found on 2026-08-04 — a 167 MB orphan from a
    backend restart during a snapshot, invisible to `bundles()` and to
    `_prune_bundles`, which only ever deletes things it can list.

    Age-gated because a `.part` may belong to a snapshot running right now.
    An hour is far longer than any snapshot here has taken and far shorter
    than "never".
    """
    import time as _time
    freed = 0
    try:
        for part in BACKUP_DIR.glob("*.part"):
            try:
                if _time.time() - part.stat().st_mtime < older_than_s:
                    continue
                size = part.stat().st_size
                part.unlink()
                freed += 1
                log.warning("removed an interrupted backup archive: %s (%.0f MB)",
                            part.name, size / 1e6)
            except OSError:
                log.exception("could not remove partial backup %s", part)
    except OSError:
        log.exception("could not scan the backup store for partials")
    return freed


async def last_attempt() -> Optional[dict]:
    """The most recent scheduled attempt, or None if there has never been one.

    Read from the database rather than a module global, because the global
    measured UPTIME: every restart reset it and re-armed the interval. Under
    `--reload` that meant a standing refusal notified on every source edit.
    """
    from app import db
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT at, outcome, reason, bundle FROM backup_attempts "
                " ORDER BY at DESC LIMIT 1")
    except Exception:  # noqa: BLE001 — a missing history is not a failed backup
        log.exception("could not read the backup attempt history")
        return None
    return dict(row) if row else None


async def record_attempt(outcome: str, *, reason: Optional[str] = None,
                         bundle: Optional[str] = None) -> bool:
    """Write the attempt down. Returns whether this outcome is NEWS.

    News means: the outcome or the reason differs from the previous attempt.
    A refusal that says exactly what the last one said is the same fact
    arriving again, and the caller uses this to decide whether the operator
    needs telling. The first one is news; the twenty-ninth identical one is
    how someone learns to swipe the alert away without reading it.

    Recording is best-effort — a backup that ran is not undone by failing to
    write a row about it — but a failure to record returns False so a
    notification storm can never be CAUSED by the bookkeeping breaking.
    """
    from app import db
    prev = await last_attempt()
    news = not prev or prev.get("outcome") != outcome or \
        (prev.get("reason") or "") != (reason or "")
    try:
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO backup_attempts (outcome, reason, bundle) "
                "VALUES ($1,$2,$3)", outcome, reason, bundle)
    except Exception:  # noqa: BLE001
        log.exception("could not record the backup attempt")
        return False
    return news


# ── is this still HAPPENING? ────────────────────────────────────────────────
#
# Every other backup control asks whether a bundle is good. None of them asks
# whether one was made, and that is the failure nothing on this stack could
# see: `failures.census` counts rows, and the three ways backups stop —
# backups.every_hours at 0, an unmounted bundle store (the store_available
# early return), a scheduler that is not ticking — all write ZERO rows. An
# empty `backup_attempts` and a healthy one are the same answer to count(*).
# So this asks max(at) against the interval instead.

# How late a backup may be before "late" means "stopped". The scheduler ticks
# every 60s and decides due-ness from the attempt history, so a backup becomes
# due and is attempted inside a minute; an hour of slack is sixty ticks. Past
# that it is not a backup running late, it is a loop that is not running.
_STALE_GRACE_H = 1.0


def _verdict(*, every_hours: float, age_hours: Optional[float],
             outcome: Optional[str]) -> dict:
    """Whether backups are still happening, from three numbers.

    Pure, so the rule is testable without a backup history and without waiting
    a day for one to go stale. Returns {stale, alarm, headline, note}:
    `headline` is timings and outcome words only, because it is what
    `failures._backup_clause` puts in a system prompt and a refusal quotes
    paths; `note` is the fuller sentence for diagnose.

    It answers ONE question and not the neighbouring ones. It does not say
    whether the newest bundle restores — that is verify_restore's job and this
    cannot know it — and it does not treat an interval of 0 as a failure: the
    operator turning backups off is a decision, the same reason the census
    does not count rows in a disabled MCP server. It is stated, not alarmed.
    """
    if every_hours <= 0:
        return {"stale": False, "alarm": False, "headline": "",
                "note": ("Automatic backups are OFF (backups.every_hours is "
                         "0). Nothing is scheduled, so nothing will ever "
                         "report a backup failure — an empty attempt history "
                         "here means none was tried, never that all is "
                         "well.")}
    every = f"{every_hours:g}"
    if age_hours is None:
        return {"stale": True, "alarm": True,
                "headline": (f"no backup has ever been attempted, though one "
                             f"is scheduled every {every}h"),
                "note": (f"No backup attempt has ever been recorded, and one "
                         f"is scheduled every {every}h. Every path that ends "
                         f"without a bundle still writes an attempt row — a "
                         f"refusal, a crash, an unmounted store — so no rows "
                         f"at all means the scheduler is not reaching the "
                         f"backup step, or its history cannot be read. It "
                         f"does not mean backups are fine.")}
    ago = f"{age_hours:.0f}" if age_hours >= 1 else f"{age_hours:.1f}"
    ended = outcome or "unknown"
    if age_hours > every_hours + _STALE_GRACE_H:
        return {"stale": True, "alarm": True,
                "headline": (f"the last attempt was {ago}h ago and one is due "
                             f"every {every}h"),
                "note": (f"The last backup attempt was {ago}h ago and one is "
                         f"due every {every}h, so attempts have stopped "
                         f"rather than run late — the scheduler retries every "
                         f"60s once a backup is due. That last attempt ended "
                         f"'{ended}'.")}
    if ended != "ok":
        return {"stale": False, "alarm": True,
                "headline": (f"the last attempt, {ago}h ago, ended '{ended}' "
                             f"— no bundle was written"),
                "note": (f"Backups are running on schedule but the last one, "
                         f"{ago}h ago, ended '{ended}' and wrote no bundle. "
                         f"The reason is in this report; retention never "
                         f"deletes an old bundle for a run that did not "
                         f"produce a new one, so nothing has been lost yet.")}
    return {"stale": False, "alarm": False, "headline": "",
            "note": (f"The last backup succeeded {ago}h ago and one is taken "
                     f"every {every}h. That the bundle exists is not proof it "
                     f"restores — verify_restore is what proves that.")}


async def freshness() -> dict:
    """The freshness verdict plus the facts it was computed from.

    Reads the interval from live settings and the newest attempt from the
    history, so it is right about a schedule that changed a minute ago.

    Errs toward the alarm: `last_attempt` returns None both when nothing has
    ever been attempted and when the history could not be read, and both
    answers come back here as stale. A backup story that cannot be read is not
    a backup story that is fine, which is the same rule failures.py applies to
    a store it cannot scan.
    """
    from app import redact
    hours = float(settings_store.get("backups.every_hours") or 0)
    last = await last_attempt() or {}
    age = None
    if last.get("at"):
        age = (dt.datetime.now(dt.timezone.utc)
               - last["at"]).total_seconds() / 3600.0
    out = _verdict(every_hours=hours, age_hours=age,
                   outcome=last.get("outcome"))
    reason = last.get("reason")
    out.update({
        "every_hours": hours,
        "at": str(last["at"])[:19] if last.get("at") else None,
        "age_hours": round(age, 1) if age is not None else None,
        "outcome": last.get("outcome"),
        "bundle": last.get("bundle"),
        # A refusal quotes paths off this machine and a crash quotes a
        # traceback line; both go to a model from here, so both go through
        # redact first.
        "reason": redact.scrub_text(reason)[:300] if reason else None,
    })
    return out


async def verify_restore(name: str) -> dict:
    """Prove a bundle restores, into a throwaway database. Non-destructive."""
    from app import backup_restore as br
    target = BACKUP_DIR / name
    if not target.exists() or target.parent != BACKUP_DIR:
        raise br.RestoreRefused(f"no bundle named {name!r}")
    # The migrations THIS CHECKOUT has, so the proof asks the same question
    # apply_bundle will ask. Derived from the package rather than configured:
    # the directory the running backend migrates from is the only honest
    # comparison, and a settable path could be pointed somewhere that made a
    # doomed bundle look fine.
    from app.db import MIGRATIONS_DIR
    return br.verify_restore(target, dsn("postgres"), live_dsn=dsn(),
                             migrations_dir=MIGRATIONS_DIR)
