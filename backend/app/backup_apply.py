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
   how this system works. A migration is matched by NAME OR BODY, because a
   file that was renamed is not a file from the future — see
   `check_migrations`, which had this install's entire backup set refused.

THE MOUNT TRAP
--------------
`data/memory` and friends are bind MOUNTS. The obvious atomic file restore —
write a new tree beside the old one and rename it into place — fails with
EBUSY on a mount point, and worse, it fails AFTER the database has already
been replaced. So directories are restored by replacing their CONTENTS, and
the previous contents are moved aside into a timestamped directory rather
than deleted, so a half-finished restore is recoverable by hand.
"""

import hashlib
import json
import logging
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

def _applied_migrations(dsn: str, *, psql: str = "psql"
                        ) -> dict[str, Optional[str]]:
    """The bundle's migration ledger: filename -> body checksum, or None.

    None is not "missing", it is "unverified on purpose": db.py leaves the
    checksum NULL on rows applied before the column existed, because hashing
    them against their current text would bless whatever drift is already
    there. Those rows can only ever be compared by name, which is why the
    gate below keeps a filename path and does not require a hash.

    Falls back to a name-only read for a bundle old enough to predate the
    checksum column entirely — refusing to restore a bundle because its
    ledger has fewer columns than today's would be the same class of bug this
    whole function exists to close.
    """
    has_checksum = _psql(
        dsn, "SELECT 1 FROM information_schema.columns "
             " WHERE table_name = 'schema_migrations' "
             "   AND column_name = 'checksum'", psql=psql).strip()
    if not has_checksum:
        out = _psql(dsn, "SELECT filename FROM schema_migrations", psql=psql)
        return {line.strip(): None for line in out.splitlines() if line.strip()}
    out = _psql(dsn, "SELECT filename, coalesce(checksum, '') "
                     "  FROM schema_migrations", psql=psql)
    rows: dict[str, Optional[str]] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        name, _, csum = line.partition("|")
        rows[name.strip()] = csum.strip() or None
    return rows


def _known_migrations(migrations_dir: Path) -> dict[str, str]:
    """Every migration file this checkout has: filename -> body checksum.

    Hashed exactly as db.py hashes them when it writes the ledger, so the two
    sides of the gate are comparing the same number.
    """
    return {p.name: hashlib.sha256(p.read_text().encode()).hexdigest()
            for p in migrations_dir.glob("*.sql")}


def check_migrations(bundle_migrations, known) -> Optional[str]:
    """None if this checkout can safely carry the bundle's schema forward.

    Derived from the two live sets rather than from a version number written
    into the manifest, so it stays true when someone adds a migration and
    forgets to bump anything.

    A bundle row is from the future only when NEITHER its filename NOR its
    body checksum matches a file on disk. Filename alone was the whole test,
    and it took disaster recovery out on this install: a migration renumbered
    on 2026-08-04 left 087_eval_runs_gradeable.sql in the ledger with no file
    of that name, so all 7 retained bundles were refused as "made by a NEWER
    version of Nova" while the body they were worried about sat on disk under
    the next number, byte for byte. Renaming a migration is not a version
    bump, and the gate now says so.

    Deliberately NOT compared on the numeric prefix: prefixes already collide
    in this tree (two files are 088), so a prefix match would wave through a
    genuinely newer migration that happened to reuse a number.

    Both arguments accept either a mapping of filename -> checksum or a bare
    set of filenames; a set reads as "no checksums known", which degrades to
    the filename comparison rather than refusing.
    """
    bundle: dict[str, Optional[str]] = (
        dict(bundle_migrations) if isinstance(bundle_migrations, dict)
        else {name: None for name in bundle_migrations})
    known_names = set(known)
    known_hashes = (set(v for v in known.values() if v)
                    if isinstance(known, dict) else set())
    from_future = sorted(
        name for name, checksum in bundle.items()
        if name not in known_names
        and not (checksum and checksum in known_hashes))
    if from_future:
        return (f"this bundle was made by a NEWER version of Nova: it "
                f"contains {len(from_future)} migration(s) this checkout has "
                f"never seen ({', '.join(from_future[:3])}"
                f"{'…' if len(from_future) > 3 else ''}). Restoring it would "
                f"put a schema from the future under older code. Update Nova "
                f"first, then restore.")
    return None


def migration_gate(staged_dsn: str, migrations_dir: Path, *,
                   psql: str = "psql") -> tuple[Optional[str], int]:
    """Run the migration gate against a bundle already staged in a database.

    Returns the refusal (or None) and how many migrations the bundle's ledger
    holds. Published as one call so the destructive restore and the
    non-destructive proof-of-restore ask the same question of the same
    ledger: `verify_restore` skipped this gate entirely, so an operator's
    pre-flight passed on all 7 bundles that `apply_bundle` then refused. A
    pre-flight that can disagree with the thing it precedes is worse than
    none — it is where the confidence comes from.
    """
    bundle_migrations = _applied_migrations(staged_dsn, psql=psql)
    return (check_migrations(bundle_migrations,
                             _known_migrations(migrations_dir)),
            len(bundle_migrations))


def apply_bundle(bundle: Path, *, admin_dsn: str, target_db: str,
                 file_targets: dict[str, str], confirm: str,
                 coverage: dict, snapshot_dir: Path,
                 migrations_dir: Path,
                 volume_paths: Optional[dict[str, str]] = None,
                 psql: str = "psql", pg_restore: str = "pg_restore",
                 pg_dump: str = "pg_dump",
                 now: Optional[Callable[[], float]] = None,
                 passphrase: Optional[str] = None,
                 restore_script: Optional[Path] = None,
                 root_prefix: str = "") -> dict:
    """Replace the live database and files with a bundle's contents.

    `file_targets` maps a bundle member path to where it should land, so the
    caller — not this module — decides what "live" means. That is what lets
    the whole path be exercised against throwaway directories.

    `bundle` is the INNER (plaintext) archive — a caller holding an
    encrypted bundle unwraps it first via backup_snapshot.open_inner. The
    `passphrase`/`restore_script`/`root_prefix` trio is forwarded to the
    SAFETY snapshot, so the way back is protected the same way the way
    forward was.
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
                           now=now, passphrase=passphrase,
                           restore_script=restore_script,
                           root_prefix=root_prefix)
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
            refusal, migration_count = migration_gate(
                _dsn_for(admin_dsn, staging), migrations_dir, psql=psql)
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
                    "migrations_in_bundle": migration_count}
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
