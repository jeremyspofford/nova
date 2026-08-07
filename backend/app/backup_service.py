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

import asyncio
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
        include_secrets=bool(settings_store.get("backups.include_secrets")),
        offsite_dir=str(settings_store.get("backups.offsite_dir") or ""))
    _cov_cache = (_time.monotonic(), report)
    return report


# The standalone restore script, committed to the repo and copied into every
# bundle. Read from the bind-mounted checkout so the copy in a bundle is the
# copy in git — never a second implementation.
RESTORE_SCRIPT = Path(CONTAINER_ROOT) / "scripts" / "nova_restore.py"


async def snapshot() -> dict:
    """Make one ENCRYPTED bundle. Refuses loudly rather than producing a
    partial one — and refuses with NO passphrase rather than writing a
    complete, cleartext copy of every credential on the stack. That refusal
    lands in `backup_attempts` and notifies like any other, so a broken
    passphrase source is a told failure, not a quiet gap in the history."""
    from app import backup_passphrase, backup_snapshot as bs
    ok, why = store_available()
    if not ok:
        raise bs.SnapshotRefused(why)
    try:
        passphrase = await backup_passphrase.resolve()
    except backup_passphrase.PassphraseUnavailable as e:
        raise bs.SnapshotRefused(
            f"no passphrase, no bundle: {e}. A complete bundle carries .env "
            f"and the secrets master key, and writing one unencrypted is "
            f"worse than writing none.") from e
    # fresh=True is the cache's own stated contract ("a SNAPSHOT never uses
    # the cache") — the refusals must reflect the stack at the moment a
    # bundle is written, not up to a minute before. The call sat on the
    # cache anyway; found while wiring encryption, fixed as one word.
    cov = await coverage(fresh=True)
    # rewrite host paths to where this process can read them; anything that
    # cannot be translated was already refused by `readable` above.
    # The snapshot walks and hashes a couple hundred MB twice — off the
    # event loop, so a 3 A.M. backup never freezes a 3 A.M. conversation.
    return await asyncio.to_thread(
        bs.create, cov, out_dir=BACKUP_DIR, dsn=dsn(),
        volume_paths=volume_paths(), passphrase=passphrase,
        restore_script=RESTORE_SCRIPT, root_prefix=CONTAINER_ROOT)


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
    """Prove a bundle restores, into a throwaway database. Non-destructive.

    For an encrypted bundle this now proves the WHOLE chain — the
    passphrase source answers, the payload decrypts and authenticates, the
    inner archive verifies, and the dump restores — which is exactly the
    chain a disaster would need, and exactly why the weekly drill calls
    this rather than some gentler check.
    """
    from app import backup_passphrase, backup_restore as br
    from app import backup_snapshot as bs
    target = BACKUP_DIR / name
    if not target.exists() or target.parent != BACKUP_DIR:
        raise br.RestoreRefused(f"no bundle named {name!r}")
    passphrase = None
    if bs.is_outer_bundle(target):
        try:
            passphrase = await backup_passphrase.resolve()
        except backup_passphrase.PassphraseUnavailable as e:
            raise br.RestoreRefused(
                f"{name} is encrypted and the passphrase source failed: "
                f"{e}") from e
    # The migrations THIS CHECKOUT has, so the proof asks the same question
    # apply_bundle will ask. Derived from the package rather than configured:
    # the directory the running backend migrates from is the only honest
    # comparison, and a settable path could be pointed somewhere that made a
    # doomed bundle look fine.
    from app.db import MIGRATIONS_DIR

    def _run() -> dict:
        from app.backup_crypto import CryptoError
        try:
            with bs.open_inner(target, passphrase) as inner:
                out = br.verify_restore(inner, dsn("postgres"),
                                        live_dsn=dsn(),
                                        migrations_dir=MIGRATIONS_DIR)
        except CryptoError as e:
            # A bundle the current passphrase cannot open is a VERDICT about
            # that bundle, not a crash: 409 on the route, a plain FAILED
            # line in the drill. Left unmapped it was a 500 reading "Verify
            # failed" and a push reading "crashed" — both of which send the
            # operator debugging the app instead of reading the answer.
            raise br.RestoreRefused(
                f"{name} did not decrypt with the CURRENT passphrase: {e}. "
                f"If the passphrase was rotated since this bundle was "
                f"written, its listing shows which fingerprint seals it."
            ) from e
        out["bundle"] = str(target)      # the operator asked about the OUTER
        out["encrypted"] = passphrase is not None
        return out

    # decrypt + hash + pg_restore is minutes of CPU and subprocess wait;
    # off the event loop so verification never freezes the app.
    return await asyncio.to_thread(_run)


async def encryption_state() -> dict:
    """What the Settings card needs to say about the passphrase, without
    ever carrying the passphrase: which source, whether one exists, and
    where the operator stands on recording it off-machine."""
    from app import backup_passphrase, settings_store
    state = dict(await backup_passphrase.confirmation())
    state["source"] = str(settings_store.get("backups.passphrase_source")
                          or "local")
    state["secret_name"] = backup_passphrase.SECRET_NAME
    return state


# ── the off-machine copy (roadmap #31 phase 2a) ─────────────────────────────
#
# "If a computer crashes" is the goal, and a bundle on the crashed machine's
# own disk answers it not at all. This is the PATH half of phase 2: the
# operator mounts something that survives this machine (NAS, USB) into the
# backend and names it in backups.offsite_dir; every verified bundle is
# copied there, re-hashed after the copy, and pruned to the same keep count.
# The CLOUD half (rclone) is deliberately later — it needs a remote and
# credentials only the operator can supply, and he has said not yet.


def _sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def offsite_state() -> dict:
    """Where the off-machine story stands, asked of the filesystem.

    `newest_synced` is the fact the drill and the failure nudge care about:
    the newest LOCAL bundle exists at the target with the same size. Size,
    not hash, because this runs on every Settings load — the full re-hash
    happens once, at copy time, where it proves the write.
    """
    from app import settings_store
    target = str(settings_store.get("backups.offsite_dir") or "").strip()
    if not target:
        return {"configured": False, "dir": "", "ok": False,
                "bundles": 0, "newest_synced": None, "problem": ""}
    out = {"configured": True, "dir": target, "ok": True, "problem": ""}
    tdir = Path(target)
    if not tdir.is_dir() or not os.access(tdir, os.W_OK):
        out.update(ok=False, bundles=0, newest_synced=False,
                   problem=(f"{target} is not a writable directory from the "
                            f"backend — is the mount present in "
                            f"docker-compose.yml and the drive attached?"))
        return out
    have = {p.name: p.stat().st_size
            for p in tdir.glob("nova-backup-*.tar*")
            if not p.name.endswith(".part")}
    out["bundles"] = len(have)
    local = bundles()
    if not local:
        out["newest_synced"] = None
    else:
        newest = Path(local[0]["path"])
        out["newest_synced"] = have.get(newest.name) == newest.stat().st_size
    return out


def offsite_sync() -> dict:
    """Copy every local bundle the target is missing; verify; prune.

    Returns {configured, copied, verified, pruned, errors}. Never raises:
    a failed off-machine copy must not fail the backup that produced the
    bundle — the local copy exists — but every error is in the result for
    the caller to journal, and `offsite_state` keeps saying newest_synced=
    False until a later pass succeeds, so the failure cannot silently
    become the steady state.

    Copies via .part + rename, same as the snapshot: a half-copied bundle
    on the recovery medium is the exact artifact someone reaches for after
    a disk dies. Verified by RE-HASHING BOTH SIDES — a copy that matched
    sizes and rotted in transit is invisible to everything cheaper.
    """
    from app import settings_store
    target = str(settings_store.get("backups.offsite_dir") or "").strip()
    result: dict = {"configured": bool(target), "copied": [], "pruned": 0,
                    "errors": []}
    if not target:
        return result
    tdir = Path(target)
    if not tdir.is_dir() or not os.access(tdir, os.W_OK):
        result["errors"].append(
            f"{target} is not a writable directory from the backend")
        return result
    import time as _time
    for part in tdir.glob("*.part"):        # an interrupted earlier copy
        try:
            if _time.time() - part.stat().st_mtime > 3600:
                part.unlink()
        except OSError:
            pass
    have = {p.name for p in tdir.glob("nova-backup-*.tar*")
            if not p.name.endswith(".part")}
    keep = int(settings_store.get("backups.keep") or 7)
    # Only the newest `keep` are candidates: copying a bundle the prune
    # below would immediately delete is churn — and worse, it made every
    # pass non-idempotent whenever local held more bundles than offsite
    # retention keeps, re-copying and re-pruning the same old bundle
    # forever. Found by this module's own test.
    for b in reversed(bundles()[:keep]):    # oldest first: newest lands last,
        src = Path(b["path"])               # so a partial pass biases recent
        if src.name in have:
            continue
        dst = tdir / src.name
        part = tdir / (src.name + ".part")
        try:
            import shutil
            shutil.copyfile(src, part)
            src_sha, dst_sha = _sha256_of(src), _sha256_of(part)
            if src_sha != dst_sha:
                part.unlink(missing_ok=True)
                result["errors"].append(
                    f"{src.name}: the copy does not hash like the original "
                    f"— the target medium may be failing")
                continue
            os.replace(part, dst)
            result["copied"].append(src.name)
            log.info("bundle copied off-machine: %s -> %s", src.name, tdir)
        except OSError as e:
            part.unlink(missing_ok=True)
            result["errors"].append(f"{src.name}: {e}")
    try:
        offsite = sorted((p for p in tdir.glob("nova-backup-*.tar*")
                          if not p.name.endswith(".part")),
                         key=lambda p: p.name, reverse=True)
        for old in offsite[keep:]:
            old.unlink()
            result["pruned"] += 1
    except OSError as e:
        result["errors"].append(f"prune: {e}")
    return result


def sweep_scratch_databases() -> int:
    """Drop orphaned nova_verify_* databases. Returns how many.

    verify_restore drops its scratch in a `finally`, but a `finally` does
    not survive the process: the backend runs under --reload, and an edit
    (or a restart) mid-verify leaves the scratch behind forever — nothing
    else on the stack will ever look at it. Swept here, at the start of the
    weekly drill, because that is the moment a leftover would otherwise
    accumulate unattended. Only names matching SCRATCH_RE are ever touched,
    and a database with live connections is skipped — it belongs to a
    verify that is running right now.
    """
    from app.backup_restore import SCRATCH_RE, RestoreRefused, _psql
    admin = dsn("postgres")
    try:
        names = _psql(admin, "SELECT datname FROM pg_database "
                             "WHERE datname LIKE 'nova_verify_%'")
    except RestoreRefused:
        log.exception("could not scan for orphaned scratch databases")
        return 0
    dropped = 0
    for scratch in [ln.strip() for ln in names.splitlines() if ln.strip()]:
        if not SCRATCH_RE.fullmatch(scratch):
            continue
        try:
            busy = _psql(admin, f"SELECT count(*) FROM pg_stat_activity "
                                f"WHERE datname = '{scratch}'")
            if busy.strip() != "0":
                continue
            _psql(admin, f'DROP DATABASE IF EXISTS "{scratch}"')
            dropped += 1
            log.warning("dropped an orphaned scratch database: %s", scratch)
        except RestoreRefused:
            log.exception("could not drop orphaned scratch %s", scratch)
    return dropped


def _drill_verdict(row: Optional[dict]) -> str:
    """The standing drill sentence for the failure nudge, or "" when quiet.

    Pure, so every state is testable without staging automations rows. The
    states it names are exactly the ones nothing else says out loud: the
    auto-disable path notifies ONCE and then the weekly proof is simply
    absent — five quiet Sundays later, "backups are verified weekly" is a
    memory, and this is the only reader that would know.
    """
    if row is None:
        return ("no weekly restore drill is scheduled, so no bundle is ever "
                "proven restorable")
    if not row.get("enabled"):
        n = row.get("consecutive_failures") or 0
        why = (f"after {n} straight failures" if n >= 5
               else "switched off")
        return f"the weekly restore drill is DISABLED ({why})"
    if (row.get("last_status") or "") == "failed":
        return "the last weekly restore drill FAILED"
    if not row.get("last_run_at") and row.get("next_run_at"):
        overdue_h = (dt.datetime.now(dt.timezone.utc)
                     - row["next_run_at"]).total_seconds() / 3600
        if overdue_h > 6:
            return (f"the weekly restore drill has never run and its "
                    f"scheduled time passed {overdue_h:.0f}h ago")
    return ""


async def drill_state() -> dict:
    """The drill row's standing facts, found by HANDLER, not by name — a
    renamed row keeps its meaning, and a deleted one is honestly absent."""
    from app import db
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT enabled, last_status, consecutive_failures, "
            "       last_run_at, next_run_at "
            "  FROM automations WHERE handler = 'restore_drill' "
            " ORDER BY created_at LIMIT 1")
    row = dict(row) if row else None
    return {"exists": row is not None, "headline": _drill_verdict(row),
            **(row or {})}


async def drill(automation: dict) -> tuple[bool, str]:
    """The weekly restore drill (roadmap #31, decision c): restore the
    NEWEST bundle into a scratch database, verify, drop, and say plainly
    how it went. The scheduler runs this as a mechanical handler — no agent
    in the loop, so nothing can decline, narrate, or summarise it into
    fiction — and `notify:true` on the automation row is what carries a
    failure to the operator's phone.

    A missing bundle is a FAILED drill, not an empty success: the question
    the drill answers is "could I recover from disaster today", and with no
    bundle the answer is no.
    """
    from app.backup_restore import RestoreRefused
    await asyncio.to_thread(sweep_scratch_databases)
    all_bundles = bundles()             # newest first
    if not all_bundles:
        return False, ("restore drill FAILED: there are no bundles at all — "
                       "nothing on this machine could recover it today")
    newest = all_bundles[0]
    name = Path(newest["path"]).name
    age_h = None
    try:
        made = dt.datetime.strptime(newest["created_at"], "%Y%m%dT%H%M%SZ") \
            .replace(tzinfo=dt.timezone.utc)
        age_h = (dt.datetime.now(dt.timezone.utc) - made).total_seconds() / 3600
    except ValueError:
        pass
    try:
        result = await verify_restore(name)
    except RestoreRefused as e:
        return False, (f"restore drill FAILED on {name}: {e}")
    if not result.get("restored_ok"):
        detail = result.get("migration_refusal") \
            or f"missing tables: {result.get('missing_tables')}"
        return False, (f"restore drill FAILED on {name}: it restored but "
                       f"would not carry this install forward — {detail}")
    age = f"{age_h:.0f}h old" if age_h is not None else "age unknown"
    summary = (f"restore drill passed: {name} ({age}"
               f"{', encrypted' if result.get('encrypted') else ''}) "
               f"restored into a scratch database — "
               f"{result.get('tables')} tables, {result.get('rows')} "
               f"rows, migration gate ok — and the scratch was dropped")
    # The drill only proves the NEWEST bundle, so a rotated passphrase can
    # orphan every older one while the weekly line stays green. Say so.
    enc = await encryption_state()
    stale = [b for b in all_bundles
             if b.get("encrypted") and b.get("passphrase_fingerprint")
             and b["passphrase_fingerprint"] != enc.get("fingerprint")]
    if stale:
        summary += (f". CAUTION: {len(stale)} older bundle(s) are sealed "
                    f"with a DIFFERENT passphrase than the current one — "
                    f"they only open with the passphrase recorded when they "
                    f"were made")
    # And a green drill is not disaster recovery while the only copy of the
    # passphrase lives inside the bundles it opens.
    if enc.get("state") not in ("confirmed", "unset"):
        summary += (". NOTE: the backup passphrase is not yet confirmed "
                    "recorded off-machine — if this machine dies, Nova's "
                    "copy dies inside the bundles it opens")
    # Nor is it disaster recovery while every bundle sits on the disk it
    # protects. The weekly push is the one message that reliably reaches
    # the operator, so the off-machine gap rides in it rather than waiting
    # to be noticed on a Settings card.
    off = offsite_state()
    if not off["configured"]:
        summary += (". NOTE: no off-machine bundle folder is configured "
                    "(Settings → Backups) — every bundle lives on the disk "
                    "it protects")
    elif not off["ok"]:
        summary += f". CAUTION: the off-machine folder is broken — {off['problem']}"
    elif off.get("newest_synced") is False:
        summary += (". CAUTION: the newest bundle has NOT reached the "
                    "off-machine folder yet")
    return True, summary
