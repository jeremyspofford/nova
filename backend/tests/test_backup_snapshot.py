"""A bundle is only a backup if it can be read back (roadmap #31, phase 1).

    docker compose exec backend python tests/test_backup_snapshot.py

Offline: pg_dump is stubbed with a script that writes bytes, because what is
under test is the bundle's integrity story, not Postgres.

Every check here defends the same idea from a different angle — a backup
system fails by producing something that LOOKS restorable. So: a refused
coverage report writes nothing, an incomplete archive never gets a real
name, and verification re-hashes the artifact instead of trusting the
numbers the writer recorded about it.
"""

import io
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import backup_snapshot as bs                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def fake_pg_dump(tmp: Path) -> str:
    """A stand-in that writes a plausible dump, so the test needs no server."""
    p = tmp / "pg_dump"
    p.write_text("#!/bin/sh\nfor a in \"$@\"; do\n"
                 "  case $prev in -f) out=$a;; esac\n  prev=$a\ndone\n"
                 "printf 'PGDMP-fake-dump-contents' > \"$out\"\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


def coverage_for(root: Path) -> dict:
    return {"may_snapshot": True, "refusals": [],
            "entries": [
                {"kind": "bind", "name": str(root / "memory"), "included": True,
                 "disposition": "include", "reason": "state"},
                {"kind": "bind", "name": str(root / "secret.txt"), "included": True,
                 "disposition": "include", "reason": "state"},
                {"kind": "volume", "name": "postgres_data", "included": True,
                 "disposition": "include_via_pg_dump", "reason": "db"},
                {"kind": "volume", "name": "nova_state", "included": True,
                 "disposition": "include", "reason": "keys"},
                {"kind": "volume", "name": "ollama_models", "included": False,
                 "disposition": "exclude_redownloadable", "reason": "big"},
            ]}


work = Path(tempfile.mkdtemp(prefix="nova-bs-test-"))
try:
    src, vol, out = work / "src", work / "vol", work / "out"
    (src / "memory").mkdir(parents=True)
    (src / "memory" / "a.md").write_text("first note")
    (src / "memory" / "b.md").write_text("second note")
    (src / "secret.txt").write_text("POSTGRES_PASSWORD=hunter2")
    vol.mkdir()
    (vol / "secret.key").write_text("a-key")
    pg = fake_pg_dump(work)

    print("1. a bundle is produced and self-verifies")
    man = bs.create(coverage_for(src), out_dir=out, dsn="postgresql://x@h/db",
                    volume_paths={"nova_state": str(vol)}, pg_dump=pg)
    bundle = Path(man["path"])
    check("the bundle exists", bundle.exists(), bundle.name)
    check("no .part file is left behind",
          not list(out.glob("*.part")), str(list(out.glob("*"))))
    check("it verifies clean", bs.verify(bundle) == [], str(bs.verify(bundle)))
    kinds = {m["path"] for m in man["members"]}
    check("the database is in it", bs.DB_MEMBER in kinds)
    check("a volume classified include_via_pg_dump is NOT also copied as files",
          not any("postgres_data" in k for k in kinds), str(kinds))
    check("the excluded tiers are RECORDED in the bundle, so a restore can "
          "say what it does not have", len(man["excluded"]) == 1,
          str(man["excluded"]))

    print("\n1b. a second bundle in the same second NEVER overwrites the first")
    # Found by the restore drill: the pre-restore safety snapshot landed on
    # the very bundle being restored (same second, same directory, os.replace
    # clobbers). The restore then "succeeded" and rolled nothing back,
    # because it replayed the state it was meant to discard. A backup system
    # that can destroy a backup is worse than none.
    before = bundle.read_bytes()
    man2 = bs.create(coverage_for(src), out_dir=out, dsn="postgresql://x@h/db",
                     volume_paths={"nova_state": str(vol)}, pg_dump=pg,
                     now=lambda: 0)
    man3 = bs.create(coverage_for(src), out_dir=out, dsn="postgresql://x@h/db",
                     volume_paths={"nova_state": str(vol)}, pg_dump=pg,
                     now=lambda: 0)
    check("two snapshots at the same timestamp get different names",
          man2["path"] != man3["path"], Path(man3["path"]).name)
    check("both exist", Path(man2["path"]).exists() and Path(man3["path"]).exists())
    check("the earlier bundle is byte-for-byte untouched",
          bundle.read_bytes() == before)

    print("\n2. verification re-hashes the ARTIFACT, not the manifest")
    bad = work / "altered.tar.gz"
    with tarfile.open(bundle, "r:gz") as t, tarfile.open(bad, "w:gz") as o:
        for m in t.getmembers():
            f = t.extractfile(m)
            if m.name.endswith("a.md"):
                data = b"quietly different"
                m.size = len(data)
                o.addfile(m, io.BytesIO(data))
            elif f is not None:
                o.addfile(m, f)
            else:
                o.addfile(m)
    probs = bs.verify(bad)
    check("one altered file inside the archive is caught", bool(probs))
    check("...and the member is named", any("memory" in p for p in probs),
          probs[0][:70] if probs else "")

    print("\n3. a truncated bundle is REJECTED, not raised")
    trunc = work / "trunc.tar.gz"
    shutil.copy(bundle, trunc)
    with open(trunc, "r+b") as f:
        f.truncate(200)
    # found by testing: gzip raises EOFError, which is neither TarError nor
    # OSError — a narrower catch turned "this backup is corrupt" into a crash
    probs = bs.verify(trunc)
    check("it returns a verdict rather than throwing", bool(probs), str(probs)[:80])

    print("\n4. refused coverage produces NOTHING")
    never = work / "never"
    raised = None
    try:
        bs.create({"may_snapshot": False, "entries": [],
                   "refusals": [{"code": "R1_UNCLASSIFIED",
                                 "subject": "volume:mystery"}]},
                  out_dir=never, dsn="x", pg_dump=pg)
    except bs.SnapshotRefused as e:
        raised = str(e)
    check("it refuses", raised is not None)
    check("...naming what was unaccounted for", "mystery" in (raised or ""))
    check("...and writes no file at all", not never.exists())

    print("\n5. a volume with nowhere to read it from refuses")
    raised = None
    try:
        bs.create(coverage_for(src), out_dir=work / "no2",
                  dsn="postgresql://x@h/db", volume_paths={}, pg_dump=pg)
    except bs.SnapshotRefused as e:
        raised = str(e)
    check("a classified volume that was never mounted is not silently skipped",
          raised is not None and "nova_state" in (raised or ""),
          (raised or "")[:70])

    print("\n6. a failed dump aborts the whole bundle")
    broken = work / "broken_pg"
    broken.write_text("#!/bin/sh\necho 'connection refused' >&2\nexit 1\n")
    broken.chmod(broken.stat().st_mode | stat.S_IEXEC)
    raised = None
    try:
        bs.create(coverage_for(src), out_dir=work / "no3",
                  dsn="postgresql://x@h/db",
                  volume_paths={"nova_state": str(vol)}, pg_dump=str(broken))
    except bs.SnapshotRefused as e:
        raised = str(e)
    check("no database means no bundle — not a bundle without a database",
          raised is not None and "pg_dump failed" in (raised or ""),
          (raised or "")[:70])
    check("...and nothing was left in the output directory",
          not (work / "no3").exists() or not list((work / "no3").glob("*")))
finally:
    shutil.rmtree(work, ignore_errors=True)

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
