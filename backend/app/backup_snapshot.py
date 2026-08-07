"""Producing a bundle, and proving it is one (roadmap #31, phase 1, inc. 2).

`backup_coverage` decides WHAT goes in. This puts it in a file, and then
reads that file back to check it is really there.

Three properties, each a reaction to how backup systems fail rather than to
how they work:

1. **A refused coverage report produces NO bundle.** Not a partial one, not
   one with a warning attached. The refusals exist because something on this
   stack is unaccounted for, and a bundle written anyway is a bundle that
   will be trusted.

2. **Nothing is visible until it is complete.** The bundle is built under a
   `.part` name and renamed only after it verifies. A half-written archive
   that appears in a listing is worse than a missing one — it is the thing
   the operator reaches for after a disk dies.

3. **Verification reads the artifact, not the intention.** Checksums
   computed while writing prove nothing about the file on disk; they prove
   the bytes we thought we wrote. So `verify()` opens the finished archive,
   walks its members, and re-hashes them. A backup that has never been read
   back is a hope.

The database is dumped with `pg_dump -Fc` and never copied as files: PGDATA
under a running server is torn, and a torn PGDATA restores as a corrupt
cluster rather than as an error.
"""

import contextlib
import hashlib
import json
import logging
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)

MANIFEST = "manifest.json"
DB_MEMBER = "db.sql"

# Bundle format. Bumped when the LAYOUT changes in a way a reader must know
# about; restore refuses a bundle whose version it does not understand,
# rather than half-reading it.
BUNDLE_VERSION = 1

# The ENCRYPTED bundle is an outer, uncompressed tar around the exact
# archive this module has always written. Uncompressed and partly cleartext
# on purpose — this is the bootstrap answer, not an oversight:
#
#   nova_restore.py   the standalone restore script, CLEAR, because a script
#                     sealed inside what it decrypts can never run
#   README.txt        one paragraph for whoever finds this file in a drawer
#   meta.json         advisory listing facts (when, how many members), so
#                     the Settings card can list bundles WITHOUT the key
#   payload.enc       the real bundle (tar.gz, manifest first), AES-GCM
#
# meta.json is unauthenticated by construction; anything that matters is
# re-read from the authenticated manifest inside the payload.
OUTER_META = "meta.json"
OUTER_PAYLOAD = "payload.enc"
OUTER_SCRIPT = "nova_restore.py"
OUTER_README = "README.txt"

_README = """\
This is an encrypted Nova backup bundle.

To restore it — on any machine with python3, even one with no Nova, no
Docker and no network — extract this tar and run:

    python3 nova_restore.py <this bundle file>

It will ask for the backup passphrase, decrypt and VERIFY everything, and
print the exact commands that finish the job. The passphrase is not in this
file, on purpose: it is whatever the operator recorded off-machine when
this backup system was set up.

One caution: this README and nova_restore.py are the bundle's CLEARTEXT
parts — the passphrase authenticates the payload, but nothing can
authenticate the script that checks it. If this file reached you through
storage you do not fully trust, take nova_restore.py from the Nova
repository (github.com/jeremyspofford/nova, scripts/) instead of running
the copy in the bundle.
"""


class SnapshotRefused(Exception):
    """Coverage is incomplete, or a source could not be read. No bundle."""


@dataclass
class Member:
    """One archived thing, and the hash of what actually went in."""
    path: str          # path INSIDE the bundle
    origin: str        # where it came from on this machine
    kind: str          # "tree" | "file" | "db"
    bytes: int
    sha256: str
    restore_to: str = ""   # where it belongs, relative to the repo root —
                           # "data/memory", ".env", "volume:nova_state" —
                           # written HERE because only the writer knows the
                           # container/host mapping; the standalone script
                           # obeys it instead of hardcoding paths

    def as_dict(self) -> dict:
        return {"path": self.path, "origin": self.origin, "kind": self.kind,
                "bytes": self.bytes, "sha256": self.sha256,
                "restore_to": self.restore_to}


def _sha256_file(path: Path, chunk: int = 1 << 20) -> tuple[str, int]:
    h, n = hashlib.sha256(), 0
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
            n += len(b)
    return h.hexdigest(), n


def _sha256_tree(root: Path) -> tuple[str, int]:
    """A stable hash of a directory: every file's relative path and content,
    in sorted order. Sorted because filesystem order is not stable across
    machines, and an unstable hash makes verification meaningless."""
    h, total = hashlib.sha256(), 0
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rel = str(p.relative_to(root))
        h.update(rel.encode())
        digest, n = _sha256_file(p)
        h.update(digest.encode())
        total += n
    return h.hexdigest(), total


def dump_database(dsn: str, out: Path, pg_dump: str = "pg_dump") -> None:
    """`pg_dump -Fc`. Custom format, because it restores selectively and
    compresses; plain SQL would restore all-or-nothing through psql."""
    proc = subprocess.run([pg_dump, "-Fc", "--no-owner", "--no-acl",
                           "-f", str(out), dsn],
                          capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        raise SnapshotRefused(
            f"pg_dump failed, so there is no database in this bundle and it "
            f"must not be written: {proc.stderr.strip()[:400]}")
    if not out.exists() or out.stat().st_size == 0:
        raise SnapshotRefused("pg_dump reported success and produced no file")


def create(coverage: dict, *, out_dir: Path, dsn: str,
           volume_paths: Optional[dict[str, str]] = None,
           now: Optional[Callable[[], float]] = None,
           pg_dump: str = "pg_dump",
           passphrase: Optional[str] = None,
           restore_script: Optional[Path] = None,
           root_prefix: str = "") -> dict:
    """Build one bundle. Returns the manifest.

    `volume_paths` maps a named volume to a path where the runner can read
    its contents. A volume classified for inclusion with no path here is a
    REFUSAL, not a silent omission — that is the whole reason the mapping is
    passed in rather than guessed.

    With a `passphrase`, the output is an ENCRYPTED bundle (an outer tar
    carrying the standalone restore script beside an AES-GCM payload), and
    `restore_script` becomes mandatory: a bundle that does not carry its own
    way back is refused, because the machine it will be opened on is by
    definition one where this repo may not exist yet. `root_prefix` is what
    the writer strips from origins to stamp each member's `restore_to`.
    Without a passphrase the classic plaintext .tar.gz is written — that
    path stays for tests and for reading history, not for new snapshots.
    """
    if not coverage.get("may_snapshot"):
        raise SnapshotRefused(
            "coverage is incomplete, so no bundle is produced: "
            + "; ".join(f"[{r['code']}] {r['subject']}"
                        for r in coverage.get("refusals", [])))
    if passphrase is not None:
        if not passphrase:
            raise SnapshotRefused("an empty passphrase is not a passphrase")
        if not restore_script or not Path(restore_script).is_file():
            raise SnapshotRefused(
                f"the standalone restore script is missing "
                f"({restore_script}) — an encrypted bundle must carry its "
                f"own way back, and one that cannot is not written")

    volume_paths = volume_paths or {}
    stamp = time.strftime("%Y%m%dT%H%M%SZ",
                          time.gmtime((now or time.time)()))
    out_dir.mkdir(parents=True, exist_ok=True)
    # NEVER overwrite an existing bundle. The name is second-resolution, and
    # two snapshots in the same second is not hypothetical: the pre-restore
    # safety snapshot is taken moments before a restore reads a bundle from
    # the same directory. Measured — os.replace clobbered the bundle being
    # restored WITH THE STATE IT WAS ABOUT TO REPLACE, the restore then
    # "succeeded", and the rollback silently did nothing. A backup system
    # that can destroy a backup is worse than none.
    suffix = ".tar" if passphrase else ".tar.gz"
    final = out_dir / f"nova-backup-{stamp}{suffix}"
    n = 1
    while final.exists():
        final = out_dir / f"nova-backup-{stamp}-{n}{suffix}"
        n += 1
    partial = final.with_suffix(final.suffix + ".part")

    def _restore_to(kind: str, name: str) -> str:
        if kind == "volume":
            return f"volume:{name}"
        if root_prefix and name.startswith(root_prefix.rstrip("/") + "/"):
            return name[len(root_prefix.rstrip("/")):].lstrip("/")
        return name

    members: list[Member] = []
    with tempfile.TemporaryDirectory(prefix="nova-snapshot-") as tmp:
        # staging is a SUBDIR so the inner archive and the encrypted payload
        # can live beside it without archiving themselves — the output
        # directory backing itself up is a bug this module has already had.
        staging = Path(tmp) / "staging"
        staging.mkdir()

        # 1. the database FIRST. pg_dump is a consistent snapshot, and doing
        #    it first means the files copied after are never older than it —
        #    an attachment blob written between the two shows up as a file
        #    with no row, which is recoverable. The reverse (a row with no
        #    blob) is not.
        db_path = staging / DB_MEMBER
        dump_database(dsn, db_path, pg_dump=pg_dump)
        digest, size = _sha256_file(db_path)
        members.append(Member(DB_MEMBER, dsn.split("@")[-1], "db", size,
                              digest, restore_to="database"))

        # 2. everything coverage says to include
        for entry in coverage["entries"]:
            if not entry["included"] or entry["disposition"] == "include_via_pg_dump":
                continue
            name, kind = entry["name"], entry["kind"]
            if kind == "volume":
                src = volume_paths.get(name)
                if not src:
                    raise SnapshotRefused(
                        f"volume '{name}' is classified for inclusion but the "
                        f"runner was given no path to read it from. Mount it "
                        f"read-only and pass it in volume_paths — a bundle "
                        f"that quietly skips it is the failure this whole "
                        f"lane exists to prevent.")
                origin, member_dir = src, f"volumes/{name}"
            else:
                origin, member_dir = name, "files/" + name.lstrip("/")
            dest_hint = _restore_to(kind, name)

            srcp = Path(origin)
            if not srcp.exists():
                raise SnapshotRefused(
                    f"'{origin}' is classified for inclusion and does not "
                    f"exist or is not readable from here")
            dest = staging / member_dir
            if srcp.is_dir():
                shutil.copytree(srcp, dest, symlinks=True,
                                ignore_dangling_symlinks=True)
                digest, size = _sha256_tree(dest)
                members.append(Member(member_dir, origin, "tree", size,
                                      digest, restore_to=dest_hint))
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(srcp, dest)
                digest, size = _sha256_file(dest)
                members.append(Member(member_dir, origin, "file", size,
                                      digest, restore_to=dest_hint))

        manifest = {
            "bundle_version": BUNDLE_VERSION,
            "created_at": stamp,
            "members": [m.as_dict() for m in members],
            # What the bundle DOES NOT hold, carried in the bundle itself.
            # A restore that cannot say what it is missing invites the
            # operator to assume it is missing nothing.
            "excluded": [{"name": e["name"], "disposition": e["disposition"],
                          "reason": e["reason"]}
                         for e in coverage["entries"] if not e["included"]],
        }
        (staging / MANIFEST).write_text(json.dumps(manifest, indent=2))

        # 3. archive, so nothing incomplete is ever listable: the plaintext
        #    path writes straight to the .part name; the encrypted path
        #    builds the inner archive in the tempdir, because the only thing
        #    allowed to appear in out_dir is the finished OUTER bundle.
        inner = (Path(tmp) / "inner.tar.gz") if passphrase else partial
        with tarfile.open(inner, "w:gz") as tar:
            # THE MANIFEST GOES FIRST, and the order is load-bearing rather
            # than tidy. A gzip stream cannot be seeked: reading a member
            # means decompressing everything before it. Sorted alphabetically
            # `manifest.json` lands after `db.sql` and `files/`, so simply
            # LISTING a 167 MB bundle decompressed almost all of it —
            # measured at 3.4s per bundle, on a screen that lists several.
            tar.add(staging / MANIFEST, arcname=MANIFEST)
            for item in sorted(staging.iterdir()):
                if item.name != MANIFEST:
                    tar.add(item, arcname=item.name)
        # the copied trees have served their purpose; give the ~200 MB back
        # before verification doubles the footprint again
        shutil.rmtree(staging)

        # 4. verify the ARTIFACT before it goes any further
        try:
            problems = verify(inner)
        except Exception as e:  # noqa: BLE001 — see verify(); belt and braces
            problems = [f"verification itself failed: {type(e).__name__}: {e}"]
        if problems:
            # the .part goes FIRST. If verification failed, this file is the
            # thing we must not leave lying around — an unverified archive
            # with a plausible name is what someone reaches for after a disk
            # dies.
            partial.unlink(missing_ok=True)
            raise SnapshotRefused(
                "the bundle failed its own verification and was discarded: "
                + "; ".join(problems))

        if passphrase:
            # 5. seal it, wrap it, and prove the WRAPPED artifact — the
            #    round trip below re-decrypts and re-verifies, so "it
            #    encrypts" is never taken on faith from the writer.
            from app import backup_crypto
            payload = Path(tmp) / OUTER_PAYLOAD
            backup_crypto.encrypt_file(inner, payload, passphrase)
            from app.backup_passphrase import fingerprint as _fingerprint
            meta = {
                "outer_version": 1,
                "encrypted": True,
                "created_at": stamp,
                "bundle_version": BUNDLE_VERSION,
                "members": len(members),
                "included": [m.origin for m in members],
                "excluded": [e["name"] for e in manifest["excluded"]],
                "bytes_inner": inner.stat().st_size,
                # WHICH passphrase seals this file — a truncated hash, not a
                # hint at the value. Without it, a rotated passphrase makes
                # every older bundle fail with the deliberately ambiguous
                # "wrong passphrase or corrupt", and nothing can tell the
                # operator that the paper in the drawer from March is the
                # right key for this one.
                "passphrase_fingerprint": _fingerprint(passphrase),
            }
            meta_path = Path(tmp) / OUTER_META
            meta_path.write_text(json.dumps(meta, indent=2))
            readme = Path(tmp) / OUTER_README
            readme.write_text(_README)
            with tarfile.open(partial, "w") as tar:
                tar.add(readme, arcname=OUTER_README)
                tar.add(meta_path, arcname=OUTER_META)
                tar.add(Path(restore_script), arcname=OUTER_SCRIPT)
                tar.add(payload, arcname=OUTER_PAYLOAD)
            try:
                problems = verify_bundle(partial, passphrase)
            except Exception as e:  # noqa: BLE001 — same rule as verify()
                problems = [f"round-trip verification itself failed: "
                            f"{type(e).__name__}: {e}"]
            if problems:
                partial.unlink(missing_ok=True)
                raise SnapshotRefused(
                    "the encrypted bundle failed its round-trip verification "
                    "and was discarded: " + "; ".join(problems))
            manifest["encrypted"] = True

    os.replace(partial, final)      # atomic: it appears complete or not at all
    manifest["path"] = str(final)
    manifest["bytes"] = final.stat().st_size
    log.info("backup written: %s (%.1f MB, %d members%s)",
             final, manifest["bytes"] / 1e6, len(members),
             ", encrypted" if passphrase else "")
    return manifest


def verify(bundle: Path) -> list[str]:
    """Read the finished archive back and re-hash every member.

    Returns the problems found, empty if sound. Deliberately re-derives the
    hashes from the extracted bytes rather than trusting the manifest's own
    numbers: the manifest records what the writer believed, and the question
    here is what the file actually contains.
    """
    problems: list[str] = []
    try:
        with tarfile.open(bundle, "r:*") as tar:
            names = tar.getnames()
            if MANIFEST not in names:
                return [f"no {MANIFEST} in the bundle — it cannot be read"]
            fh = tar.extractfile(MANIFEST)
            manifest = json.loads(fh.read().decode())
            if manifest.get("bundle_version") != BUNDLE_VERSION:
                problems.append(
                    f"bundle_version {manifest.get('bundle_version')} is not "
                    f"{BUNDLE_VERSION}; this reader would misread it")
            with tempfile.TemporaryDirectory(prefix="nova-verify-") as tmp:
                root = Path(tmp)
                tar.extractall(root, filter="data")
                for m in manifest.get("members", []):
                    p = root / m["path"]
                    if not p.exists():
                        problems.append(f"{m['path']}: named in the manifest "
                                        f"and absent from the archive")
                        continue
                    if m["kind"] == "tree":
                        digest, size = _sha256_tree(p)
                    else:
                        digest, size = _sha256_file(p)
                    if digest != m["sha256"]:
                        problems.append(
                            f"{m['path']}: content does not match its "
                            f"recorded hash ({size} bytes vs {m['bytes']})")
    except Exception as e:  # noqa: BLE001
        # DELIBERATELY broad. This reads an artifact that may be truncated,
        # bit-rotted or half-uploaded, and every one of those is a REASON TO
        # REJECT rather than an exception to propagate. Found by testing: a
        # bundle truncated mid-stream raises EOFError from gzip, which is
        # neither TarError nor OSError, so a narrower catch turned "this
        # backup is corrupt" into a crash — and a crash is not a verdict.
        problems.append(f"the bundle could not be read: {type(e).__name__}: {e}")
    return problems


# ── the encrypted (outer) format ─────────────────────────────────────────────

def is_outer_bundle(path: Path) -> bool:
    """An encrypted bundle, told apart by CONTENT, not filename: gzip's two
    magic bytes say legacy, anything else is opened as an outer tar."""
    try:
        with open(path, "rb") as f:
            if f.read(2) == b"\x1f\x8b":
                return False
        with tarfile.open(path, "r:") as tar:
            return OUTER_PAYLOAD in tar.getnames()
    except Exception:  # noqa: BLE001 — unreadable is "not an outer bundle"
        return False


def read_outer_meta(path: Path) -> dict:
    """The cleartext advisory listing facts. UNAUTHENTICATED — good enough
    to render a list row, never good enough to decide a restore."""
    with tarfile.open(path, "r:") as tar:
        fh = tar.extractfile(OUTER_META)
        return json.loads(fh.read().decode())


@contextlib.contextmanager
def open_inner(bundle: Path, passphrase: Optional[str] = None):
    """Yield a path to the plaintext inner archive, whichever format the
    bundle is. For an encrypted bundle the decrypted copy lives in a
    tempdir that is REMOVED on exit, so plaintext credentials never outlive
    the operation that needed them."""
    if not is_outer_bundle(bundle):
        yield bundle
        return
    from app import backup_crypto
    if not passphrase:
        raise backup_crypto.CryptoError(
            f"{bundle.name} is encrypted and no passphrase was available")
    with tempfile.TemporaryDirectory(prefix="nova-bundle-inner-") as tmp:
        enc = Path(tmp) / OUTER_PAYLOAD
        with tarfile.open(bundle, "r:") as tar:
            fh = tar.extractfile(OUTER_PAYLOAD)
            with open(enc, "wb") as out:
                shutil.copyfileobj(fh, out)
        inner = Path(tmp) / "inner.tar.gz"
        backup_crypto.decrypt_file(enc, inner, passphrase)
        enc.unlink()
        yield inner


def verify_bundle(bundle: Path, passphrase: Optional[str] = None) -> list[str]:
    """`verify`, for either format. For an encrypted bundle this is the full
    round trip — decrypt with the passphrase, then re-hash every member —
    because an encrypted archive that decrypts to garbage and a plaintext
    archive that was never checked are the same lie at different layers."""
    if not is_outer_bundle(bundle):
        return verify(bundle)
    problems: list[str] = []
    try:
        with tarfile.open(bundle, "r:") as tar:
            names = tar.getnames()
        for required in (OUTER_PAYLOAD, OUTER_SCRIPT, OUTER_META):
            if required not in names:
                problems.append(f"no {required} in the outer bundle")
        if problems:
            return problems
        with open_inner(bundle, passphrase) as inner:
            problems = verify(inner)
    except Exception as e:  # noqa: BLE001 — same rule as verify()
        problems.append(f"the bundle could not be read: "
                        f"{type(e).__name__}: {e}")
    return problems
