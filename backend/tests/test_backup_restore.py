"""Listing bundles, and the guards that keep a restore off the live database.

    docker compose exec backend python tests/test_backup_restore.py

Offline. The restore drill itself needs a Postgres and is exercised
separately; what is pinned here is the part that must never regress — the
refusals that stand between a verify-restore and the live `nova` database.

Why three asserts rather than one validation at the top: `pg_restore`
continues past errors by default, so a restore aimed at the wrong database
does not stop at the first conflict, it interleaves. And the obvious
DSN-building pattern degrades — an empty database name in
`postgresql://…/{name}` resolves to the connecting user's default database,
which on this stack is `nova`. So an empty name must be unable to reach the
wire at all.
"""

import json
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import backup_restore as br                        # noqa: E402
from app import backup_snapshot as bs                       # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("1. only a throwaway name may be created, restored into or dropped")
for bad, why in [("", "empty — silently resolves to the live database"),
                 ("nova", "the live database itself"),
                 ("nova_verify_", "the prefix with no suffix"),
                 ("nova_verify_XYZ12345", "not hex"),
                 ("nova_verify_50a587df; DROP DATABASE nova", "injection"),
                 ("postgres", "the maintenance database")]:
    raised = None
    try:
        br._assert_scratch(bad, "drop")
    except br.RestoreRefused as e:
        raised = str(e)
    check(f"refuses {bad!r} — {why}", raised is not None)
check("...and accepts a well-formed scratch name",
      br._assert_scratch("nova_verify_50a587df", "create") is None)

print("\n2. the regex is anchored, so a valid name cannot be a prefix")
check("a trailing payload is refused",
      not br.SCRATCH_RE.fullmatch("nova_verify_50a587df_live"))
check("a leading payload is refused",
      not br.SCRATCH_RE.fullmatch("xnova_verify_50a587df"))
check("a newline payload is refused (fullmatch, not match)",
      not br.SCRATCH_RE.fullmatch("nova_verify_50a587df\nDROP DATABASE nova"))

work = Path(tempfile.mkdtemp(prefix="nova-br-test-"))
try:
    print("\n3. listing reports what a bundle holds")
    out = work / "bundles"
    out.mkdir()
    man = {"bundle_version": bs.BUNDLE_VERSION, "created_at": "20260802T000000Z",
           "members": [{"path": "db.sql", "origin": "db", "kind": "db",
                        "bytes": 10, "sha256": "x"}],
           "excluded": [{"name": "ollama_models", "disposition": "x",
                         "reason": "big"}]}
    good = out / "nova-backup-20260802T000000Z.tar.gz"
    with tarfile.open(good, "w:gz") as t:
        p = work / bs.MANIFEST
        p.write_text(json.dumps(man))
        t.add(p, arcname=bs.MANIFEST)
    listing = br.list_bundles(out)
    check("the bundle is listed", len(listing) == 1, str(len(listing)))
    check("...with what it EXCLUDES, so nobody assumes it is complete",
          listing[0]["excluded"] == ["ollama_models"])

    print("\n4. an unreadable bundle is LISTED, marked broken — never hidden")
    bad = out / "nova-backup-20260801T000000Z.tar.gz"
    bad.write_bytes(b"this is not an archive")
    listing = br.list_bundles(out)
    check("both are listed", len(listing) == 2, str(len(listing)))
    broken = [b for b in listing if not b["readable"]]
    check("the broken one is flagged rather than dropped from the list — "
          "hiding it would leave the operator believing they have one fewer "
          "backup than the disk shows", len(broken) == 1)
    check("...and says why", bool(broken and broken[0]["problem"]),
          broken[0]["problem"][:60] if broken else "")

    print("\n5. a .part file is NEVER listed as restorable")
    shutil.copy(good, out / "nova-backup-20260803T000000Z.tar.gz.part")
    check("an unfinished bundle does not appear",
          len(br.list_bundles(out)) == 2, str(len(br.list_bundles(out))))

    print("\n6. a bundle that does not verify is not restored at all")
    raised = None
    try:
        br.verify_restore(bad, "postgresql://u@h/postgres")
    except br.RestoreRefused as e:
        raised = str(e)
    check("restoring an unverifiable bundle refuses BEFORE touching any "
          "database", raised is not None and "proves nothing" in (raised or ""),
          (raised or "")[:70])

    print("\n7. a bundle with no database member refuses")
    nodb = out / "nova-backup-20260804T000000Z.tar.gz"
    with tarfile.open(nodb, "w:gz") as t:
        p = work / bs.MANIFEST
        p.write_text(json.dumps({"bundle_version": bs.BUNDLE_VERSION,
                                 "members": [], "excluded": []}))
        t.add(p, arcname=bs.MANIFEST)
    raised = None
    try:
        br._extract_dump(nodb, work / "x.dump")
    except br.RestoreRefused as e:
        raised = str(e)
    check("it says the bundle carries no database", raised is not None,
          (raised or "")[:60])
finally:
    shutil.rmtree(work, ignore_errors=True)

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
