"""Listing bundles, and proving one restores (roadmap #31, increments 3-4).

A backup that has never been restored is a hope. This is the half that turns
it into a fact — WITHOUT touching the live database, which is the only way
it can be run routinely and unattended.

THE SAFETY ARGUMENT, because it is the entire design
----------------------------------------------------
`verify_restore` creates a throwaway database, restores a bundle's dump into
it, compares it against live, and drops it. Every one of those verbs is one
typo away from operating on `nova` instead, so the scratch name is asserted
immediately before CREATE, before RESTORE and before DROP — three times, not
once at the top — and the connection is asked what database it is actually
attached to before anything is written.

That is deliberately more paranoid than it looks:

  * `pg_restore` CONTINUES ON ERROR by default. A restore aimed at the wrong
    database would not stop at the first conflict; it would keep going and
    interleave a bundle's rows with live ones. `--exit-on-error` is not an
    option here, it is a requirement.
  * The obvious DSN-building pattern degrades. Interpolating an empty name
    into `postgresql://…/{name}` yields a URL whose database defaults to the
    connecting user — which for this stack is `nova`, the live database. So
    an empty or malformed name must be impossible to reach the wire, which
    is what the regex assert guarantees.

Nothing here writes to the live database. It reads row counts from it, and
that is all.
"""

import json
import logging
import re
import subprocess
import tarfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.backup_snapshot import (DB_MEMBER, MANIFEST, is_outer_bundle,
                                 read_outer_meta, verify)

log = logging.getLogger(__name__)

# The ONLY database name shape this module may create, write to or drop.
# Asserted before every destructive verb rather than once, because the
# distance between "validated at the top" and "used at the bottom" is where
# this class of accident lives.
SCRATCH_RE = re.compile(r"^nova_verify_[0-9a-f]{8}$")


class RestoreRefused(Exception):
    """Something about the bundle or the target is not safe. Nothing ran."""


def _assert_scratch(name: str, verb: str) -> None:
    if not SCRATCH_RE.fullmatch(name or ""):
        raise RestoreRefused(
            f"refusing to {verb} database {name!r}: this module may only "
            f"touch a throwaway database named nova_verify_<8 hex>. Anything "
            f"else — including an empty name, which silently resolves to the "
            f"live database — is a bug, not a request.")


@dataclass
class BundleInfo:
    path: str
    bytes: int
    created_at: str
    bundle_version: int
    members: int
    included: list
    excluded: list
    readable: bool
    problem: Optional[str] = None
    encrypted: bool = False
    passphrase_fingerprint: Optional[str] = None

    def as_dict(self) -> dict:
        return self.__dict__


def list_bundles(directory: Path) -> list[dict]:
    """Every bundle in a directory, newest first, with what it holds.

    Reads only the manifest — a full re-verify of a 167 MB archive is not
    something a listing should do. A bundle whose manifest cannot be read is
    LISTED ANYWAY, marked unreadable: hiding it would leave the operator
    believing they have one fewer backup than the disk shows, and the broken
    one is exactly what they need to know about.
    """
    out: list[dict] = []
    if not directory.exists():
        return out
    for p in sorted(directory.glob("nova-backup-*.tar*"), reverse=True):
        if p.name.endswith(".part"):
            # never listed: an unfinished bundle must not look restorable
            continue
        try:
            if is_outer_bundle(p):
                # An encrypted bundle lists WITHOUT the passphrase, from its
                # cleartext advisory meta — a listing that needed the key
                # would put a KDF on a screen that shows several bundles.
                # Advisory only: anything that decides a restore is re-read
                # from the authenticated manifest inside.
                meta = read_outer_meta(p)
                out.append(BundleInfo(
                    path=str(p), bytes=p.stat().st_size,
                    created_at=meta.get("created_at", "?"),
                    bundle_version=meta.get("bundle_version", 0),
                    members=int(meta.get("members", 0)),
                    included=list(meta.get("included", [])),
                    excluded=list(meta.get("excluded", [])),
                    readable=True, encrypted=True,
                    passphrase_fingerprint=meta.get(
                        "passphrase_fingerprint")).as_dict())
                continue
            with tarfile.open(p, "r:*") as tar:
                fh = tar.extractfile(MANIFEST)
                man = json.loads(fh.read().decode())
            out.append(BundleInfo(
                path=str(p), bytes=p.stat().st_size,
                created_at=man.get("created_at", "?"),
                bundle_version=man.get("bundle_version", 0),
                members=len(man.get("members", [])),
                included=[m["origin"] for m in man.get("members", [])],
                excluded=[e["name"] for e in man.get("excluded", [])],
                readable=True).as_dict())
        except Exception as e:  # noqa: BLE001 — an unreadable bundle is news
            out.append(BundleInfo(
                path=str(p), bytes=p.stat().st_size, created_at="?",
                bundle_version=0, members=0, included=[], excluded=[],
                readable=False,
                problem=f"{type(e).__name__}: {e}").as_dict())
    return out


def _extract_dump(bundle: Path, dest: Path) -> Path:
    with tarfile.open(bundle, "r:*") as tar:
        try:
            member = tar.extractfile(DB_MEMBER)
        except KeyError:
            # extractfile RAISES for a missing member rather than returning
            # None — found by testing. Left uncaught, a bundle with no
            # database crashed here instead of refusing, so the operator got
            # a traceback where they needed a sentence.
            member = None
        if member is None:
            raise RestoreRefused(
                f"{bundle.name} contains no {DB_MEMBER} — there is no "
                f"database in this bundle to restore")
        dest.write_bytes(member.read())
    return dest


def _psql(dsn: str, sql: str, *, psql: str = "psql") -> str:
    proc = subprocess.run([psql, "-tAX", "-v", "ON_ERROR_STOP=1", "-c", sql, dsn],
                          capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RestoreRefused(f"psql failed: {proc.stderr.strip()[:300]}")
    return proc.stdout.strip()


def _dsn_for(base: str, database: str) -> str:
    """Swap the database on a DSN. The name is asserted by the CALLER before
    this is reached — see the module docstring on why an empty one is
    dangerous rather than merely wrong."""
    head = base.rsplit("/", 1)[0]
    return f"{head}/{database}"


def table_counts(dsn: str, *, psql: str = "psql") -> dict[str, int]:
    """Row counts per public table. The comparison currency for a restore.

    Read-only, and safe to point at the live database — which is the point:
    the question a drill answers is "does this bundle reproduce what I have",
    and that needs both sides.
    """
    rows = _psql(dsn, "SELECT relname, n_live_tup FROM pg_stat_user_tables "
                      "ORDER BY relname", psql=psql)
    out: dict[str, int] = {}
    for line in rows.splitlines():
        if "|" in line:
            name, _, count = line.partition("|")
            out[name.strip()] = int(count.strip() or 0)
    return out


def verify_restore(bundle: Path, admin_dsn: str, *, live_dsn: str = "",
                   psql: str = "psql", pg_restore: str = "pg_restore",
                   keep: bool = False,
                   migrations_dir: Optional[Path] = None) -> dict:
    """Restore a bundle into a THROWAWAY database and report what came back.

    `admin_dsn` connects to a maintenance database (postgres) so the scratch
    one can be created and dropped. The live database is never written to;
    `live_dsn`, if given, is only read for a row-count comparison.

    `migrations_dir` runs `apply_bundle`'s migration gate against the same
    staged ledger. It is optional only so a caller with no checkout to compare
    against can still count rows; every real caller passes it, because a
    pre-flight that can disagree with the thing it precedes is worse than
    none. It disagreed: this function's docstring says it "proves the bundle
    is restorable", it never asked the migration question at all, and on
    2026-08-05 all 7 retained bundles passed here while `apply_bundle` refused
    every one of them with "made by a NEWER version of Nova".
    """
    problems = verify(bundle)
    if problems:
        raise RestoreRefused(
            "the bundle does not verify, so restoring it proves nothing: "
            + "; ".join(problems))

    scratch = f"nova_verify_{uuid.uuid4().hex[:8]}"
    _assert_scratch(scratch, "create")           # 1 of 3
    _psql(admin_dsn, f'CREATE DATABASE "{scratch}"', psql=psql)
    scratch_dsn = _dsn_for(admin_dsn, scratch)
    result: dict = {"scratch": scratch, "bundle": str(bundle)}
    try:
        # The connection itself must agree about where it is. A DSN that
        # looks right and resolves elsewhere is the failure this catches.
        actual = _psql(scratch_dsn, "SELECT current_database()", psql=psql)
        if actual != scratch:
            raise RestoreRefused(
                f"connected to {actual!r} while expecting {scratch!r} — "
                f"refusing to restore into a database that is not the "
                f"throwaway one")

        import tempfile
        with tempfile.TemporaryDirectory(prefix="nova-verify-restore-") as tmp:
            dump = _extract_dump(bundle, Path(tmp) / "db.dump")
            _assert_scratch(scratch, "restore into")     # 2 of 3
            proc = subprocess.run(
                # --exit-on-error is REQUIRED, not tidiness: pg_restore's
                # default is to continue past errors, which turns a
                # misdirected restore into an interleaving instead of a stop.
                [pg_restore, "--exit-on-error", "--no-owner", "--no-acl",
                 "-d", scratch_dsn, str(dump)],
                capture_output=True, text=True, timeout=3600)
            if proc.returncode != 0:
                raise RestoreRefused(
                    f"pg_restore failed, so this bundle does NOT restore: "
                    f"{proc.stderr.strip()[:400]}")

        # THE SAME QUESTION apply_bundle asks, of the same staged ledger.
        # Reported rather than raised: this call is non-destructive and the
        # row counts below are still worth having, so the operator gets both
        # facts — "it restores" and "the real restore would refuse it" are
        # different answers and he needs to see the second one here rather
        # than discovering it with his database already gone.
        if migrations_dir is not None:
            from app import backup_apply
            refusal, count = backup_apply.migration_gate(
                scratch_dsn, migrations_dir, psql=psql)
            result["migrations"] = count
            result["migrations_ok"] = refusal is None
            if refusal:
                result["migration_refusal"] = refusal
                log.warning("verify_restore: %s restores, but the migration "
                            "gate would refuse it: %s", bundle.name, refusal)

        restored = table_counts(scratch_dsn, psql=psql)
        result["tables"] = len(restored)
        result["rows"] = sum(restored.values())
        if live_dsn:
            live = table_counts(live_dsn, psql=psql)
            missing = sorted(set(live) - set(restored))
            # n_live_tup is an ESTIMATE maintained by the stats collector and
            # is not exact on a freshly restored database, so a count
            # difference is reported and never treated as failure. A MISSING
            # TABLE is different: that is structural, and it means the bundle
            # does not carry the schema it claims.
            result["missing_tables"] = missing
            result["restored_ok"] = not missing
        else:
            result["restored_ok"] = result["tables"] > 0
        # AND the real restore has to be willing to run. `restored_ok` is the
        # single boolean the Settings card renders as a green tick, and the
        # operator reads that tick as "this bundle would get my data back". A
        # bundle the migration gate refuses would not, so the tick has to go
        # out with it — otherwise the pre-flight goes on reassuring him about
        # exactly the bundles apply_bundle will not touch.
        if result.get("migrations_ok") is False:
            result["restored_ok"] = False
        return result
    finally:
        if not keep:
            _assert_scratch(scratch, "drop")             # 3 of 3
            try:
                _psql(admin_dsn, f'DROP DATABASE IF EXISTS "{scratch}"', psql=psql)
            except Exception:
                log.exception("scratch database %s was left behind", scratch)
