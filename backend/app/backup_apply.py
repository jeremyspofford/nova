"""Restoring a bundle over the live system (roadmap #31, increment 5).

This is the destructive one. Everything else in this lane reads; this
replaces the database and overwrites files, and it is the only operation
here that can lose data if it is wrong.

Four gates stand in front of it, in this order, and each refuses rather than
warns:

1. **A typed confirmation.** Not a boolean an integration can default to
   true, and not a click. The caller must pass back the literal phrase this
   module publishes, which means an automated caller has to be written
   deliberately rather than by passing `force=True` in a hurry.

2. **A pre-restore snapshot that VERIFIES.** Taken first, of the system as
   it is right now, and read back before anything is touched. If it cannot
   be produced or does not verify, the restore does not happen — a restore
   with no way back is a coin flip. This is the gate most likely to fire in
   practice and the one most likely to be resented; it stays.

3. **A bundle-version gate.** A bundle whose layout this code does not
   understand is refused, not half-read.

4. **A migration gate, DERIVED.** After the dump lands in a staging
   database, the migrations recorded IN THE BUNDLE are compared against the
   migration files this checkout has. A bundle from a NEWER app carries
   migrations this code has never seen, and letting it through means
   running against a schema from the future — refused. A bundle from an
   older app is fine: migrations run forward at startup, which is already
   how this system works.

THE MOUNT TRAP
--------------
`data/memory` and friends are bind MOUNTS. The obvious atomic file restore —
write a new tree beside the old one and rename it into place — fails with
EBUSY on a mount point, and worse, it fails AFTER the database has already
been replaced. So directories are restored by replacing their CONTENTS, and
the previous contents are moved aside into a timestamped directory rather
than deleted, so a half-finished restore is recoverable by hand.
"""

import json
import logging
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

from app import backup_snapshot as bs
from app.backup_restore import RestoreRefused, _psql, _dsn_for, _assert_scratch

log = logging.getLogger(__name__)

# The caller must pass this back verbatim. A phrase rather than a flag: a
# boolean is one careless default away from being true, and this operation
# has no undo beyond the snapshot taken in front of it.
CONFIRM_PHRASE = "RESTORE AND OVERWRITE MY DATA"

_MIGRATION_RE = re.compile(r"^(\d+)_")


def _applied_migrations(dsn: str, *, psql: str = "psql") -> set[str]:
    out = _psql(dsn, "SELECT filename FROM schema_migrations", psql=psql)
    return {line.strip() for line in out.splitlines() if line.strip()}


def _known_migrations(migrations_dir: Path) -> set[str]:
    return {p.name for p in migrations_dir.glob("*.sql")}


def check_migrations(bundle_migrations: set[str],
                     known: set[str]) -> Optional[str]:
    """None if this checkout can safely carry the bundle's schema forward.

    Derived from the two live sets rather than from a version number written
    into the manifest, so it stays true when someone adds a migration and
    forgets to bump anything.
    """
    from_future = sorted(bundle_migrations - known)
    if from_future:
        return (f"this bundle was made by a NEWER version of Nova: it "
                f"contains {len(from_future)} migration(s) this checkout has "
                f"never seen ({', '.join(from_future[:3])}"
                f"{'…' if len(from_future) > 3 else ''}). Restoring it would "
                f"put a schema from the future under older code. Update Nova "
                f"first, then restore.")
    return None


def apply_bundle(bundle: Path, *, admin_dsn: str, target_db: str,
                 file_targets: dict[str, str], confirm: str,
                 coverage: dict, snapshot_dir: Path,
                 migrations_dir: Path,
                 volume_paths: Optional[dict[str, str]] = None,
                 psql: str = "psql", pg_restore: str = "pg_restore",
                 pg_dump: str = "pg_dump",
                 now: Optional[Callable[[], float]] = None) -> dict:
    """Replace the live database and files with a bundle's contents.

    `file_targets` maps a bundle member path to where it should land, so the
    caller — not this module — decides what "live" means. That is what lets
    the whole path be exercised against throwaway directories.
    """
    if confirm != CONFIRM_PHRASE:
        raise RestoreRefused(
            f"restore not confirmed. This replaces the database and "
            f"overwrites files, and the only way back is the snapshot taken "
            f"in front of it. Pass confirm={CONFIRM_PHRASE!r} to proceed.")

    problems = bs.verify(bundle)
    if problems:
        raise RestoreRefused(
            "the bundle does not verify, so it will not be restored: "
            + "; ".join(problems))
    with tarfile.open(bundle, "r:*") as tar:
        manifest = json.loads(tar.extractfile(bs.MANIFEST).read().decode())
    if manifest.get("bundle_version") != bs.BUNDLE_VERSION:
        raise RestoreRefused(
            f"bundle_version {manifest.get('bundle_version')} is not "
            f"{bs.BUNDLE_VERSION}; this code would misread it")

    # GATE 2 — a way back, proven, before anything is touched.
    log.warning("pre-restore snapshot before applying %s", bundle.name)
    try:
        safety = bs.create(coverage, out_dir=snapshot_dir,
                           dsn=_dsn_for(admin_dsn, target_db),
                           volume_paths=volume_paths, pg_dump=pg_dump,
                           now=now)
    except bs.SnapshotRefused as e:
        raise RestoreRefused(
            f"refusing to restore because the safety snapshot failed, which "
            f"means there would be no way back: {e}") from e
    # Belt and braces over the collision guard in bs.create. If these two
    # were ever the same file the safety snapshot would have replaced the
    # bundle with the state we are about to discard, and the restore would
    # "succeed" while changing nothing.
    if Path(safety["path"]).resolve() == bundle.resolve():
        raise RestoreRefused(
            f"the safety snapshot landed on the bundle being restored "
            f"({bundle.name}). Nothing was applied.")

    # GATE 4 — stage the dump into a scratch database and read its schema
    # BEFORE the live one is dropped. Doing this after would mean discovering
    # the bundle is unusable with nothing left to discover it against.
    import uuid as _uuid
    staging = f"nova_verify_{_uuid.uuid4().hex[:8]}"
    _assert_scratch(staging, "create")
    _psql(admin_dsn, f'CREATE DATABASE "{staging}"', psql=psql)
    try:
        with tempfile.TemporaryDirectory(prefix="nova-apply-") as tmp:
            dump = Path(tmp) / "db.dump"
            with tarfile.open(bundle, "r:*") as tar:
                dump.write_bytes(tar.extractfile(bs.DB_MEMBER).read())
            _assert_scratch(staging, "restore into")
            proc = subprocess.run(
                [pg_restore, "--exit-on-error", "--no-owner", "--no-acl",
                 "-d", _dsn_for(admin_dsn, staging), str(dump)],
                capture_output=True, text=True, timeout=3600)
            if proc.returncode != 0:
                raise RestoreRefused(
                    f"the bundle failed to restore into a staging database, "
                    f"so nothing was touched: {proc.stderr.strip()[:300]}")
            bundle_migrations = _applied_migrations(
                _dsn_for(admin_dsn, staging), psql=psql)
            refusal = check_migrations(bundle_migrations,
                                       _known_migrations(migrations_dir))
            if refusal:
                raise RestoreRefused(refusal)

            # ── the point of no return ──────────────────────────────────
            # Everything above this line can fail with the system untouched.
            log.warning("APPLYING %s over %s — safety snapshot at %s",
                        bundle.name, target_db, safety["path"])
            moved = _restore_files(bundle, file_targets, now=now)
            _swap_database(admin_dsn, target_db, staging, psql=psql)
            return {"restored": True, "bundle": str(bundle),
                    "safety_snapshot": safety["path"],
                    "files_replaced": sorted(file_targets),
                    "previous_files_kept_at": moved,
                    "migrations_in_bundle": len(bundle_migrations)}
    except Exception:
        # staging is only dropped on the FAILURE path; on success it has been
        # renamed into place and no longer exists under this name
        try:
            _assert_scratch(staging, "drop")
            _psql(admin_dsn, f'DROP DATABASE IF EXISTS "{staging}"', psql=psql)
        except Exception:
            log.exception("staging database %s was left behind", staging)
        raise


def _swap_database(admin_dsn: str, target_db: str, staging: str, *,
                   psql: str) -> None:
    """Make the staged database the live one by RENAME, not by restoring
    into live.

    Restoring directly into the live database would leave it half-replaced
    if anything failed midway. A rename is close to instantaneous and the
    old database survives under a dated name, so the previous state is still
    on the server until someone chooses to drop it.
    """
    _assert_scratch(staging, "promote")
    old = f"{target_db}_pre_restore_{time.strftime('%Y%m%d%H%M%S')}"
    # sessions hold the live database open; a rename needs it free
    _psql(admin_dsn, f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                     f"WHERE datname = '{target_db}' AND pid <> pg_backend_pid()",
          psql=psql)
    _psql(admin_dsn, f'ALTER DATABASE "{target_db}" RENAME TO "{old}"', psql=psql)
    _psql(admin_dsn, f'ALTER DATABASE "{staging}" RENAME TO "{target_db}"', psql=psql)
    log.warning("database swapped; the previous one is kept as %s", old)


def _restore_files(bundle: Path, file_targets: dict[str, str], *,
                   now: Optional[Callable[[], float]] = None) -> dict:
    """Replace the CONTENTS of each target directory, keeping the old aside.

    Contents rather than the directory itself, because these are bind mount
    points: renaming one fails with EBUSY, and it would fail after the
    database was already swapped.
    """
    stamp = time.strftime("%Y%m%d%H%M%S", time.localtime((now or time.time)()))
    kept: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="nova-apply-files-") as tmp:
        root = Path(tmp)
        with tarfile.open(bundle, "r:*") as tar:
            tar.extractall(root, filter="data")
        for member, target in file_targets.items():
            src, dst = root / member, Path(target)
            if not src.exists():
                raise RestoreRefused(
                    f"the bundle has no member {member!r} to restore to "
                    f"{target}")
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
                aside = dst.parent / f".{dst.name}.pre-restore-{stamp}"
                aside.mkdir(parents=True, exist_ok=True)
                for item in list(dst.iterdir()):
                    if item.name.startswith(f".{dst.name}.pre-restore-"):
                        continue
                    shutil.move(str(item), str(aside / item.name))
                for item in src.iterdir():
                    shutil.move(str(item), str(dst / item.name))
                kept[target] = str(aside)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists():
                    aside = dst.parent / f".{dst.name}.pre-restore-{stamp}"
                    shutil.copy2(dst, aside)
                    kept[target] = str(aside)
                shutil.copy2(src, dst)
    return kept
