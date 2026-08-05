"""The DESTRUCTIVE restore, end to end, against a THROWAWAY database.

    docker run --rm --network nova_default -v $PWD/backend:/app/backend:ro \
      -v /tmp/drill:/work postgres:16-alpine sh -c \
      "apk add --no-cache python3 >/dev/null; python3 /app/backend/tests/drill_backup_apply.py $PGPASSWORD"

Not part of run_all.py: it needs a Postgres and it creates and drops
databases. It targets `nova_apply_drill`, never `nova`, and cleans up after
itself. This is the drill that caught the safety snapshot overwriting the
bundle it was protecting.
"""
import hashlib
import shutil
import sys
from pathlib import Path

from app import backup_snapshot as bs, backup_apply as ba
from app.backup_restore import RestoreRefused, _psql, _dsn_for

pw = sys.argv[1]
admin = f"postgresql://nova:{pw}@postgres:5432/postgres"
FAIL = []


def chk(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not ok:
        FAIL.append(label)

# A throwaway stand-in for "live". nova is NEVER the target here.
LIVE = "nova_apply_drill"
_psql(admin, f'DROP DATABASE IF EXISTS "{LIVE}"')
_psql(admin, f'CREATE DATABASE "{LIVE}"')
dsn = _dsn_for(admin, LIVE)

# THE REAL MIGRATIONS DIRECTORY, not a two-file stand-in. The synthetic pair
# this drill used to build is why it never saw 2026-08-04: a bundle whose
# ledger and whose migrations directory were both invented agreed with each
# other trivially, while the real install's ledger named a migration that had
# been renumbered on disk and every retained bundle was refused. The drill now
# seeds its ledger from the files that actually ship.
mig = Path("/app/backend/app/migrations")
real = {p.name: hashlib.sha256(p.read_text().encode()).hexdigest()
        for p in sorted(mig.glob("*.sql"))}
assert len(real) > 50, f"the real migrations directory looks wrong: {len(real)}"

# One row with NO file on disk — the shape that broke restore. Its body IS on
# disk, under the next number, exactly as 087_eval_runs_gradeable.sql's is.
RENUMBERED_AWAY = "000_renumbered_away.sql"
newest = sorted(real)[-1]
ledger = dict(real)
ledger[RENUMBERED_AWAY] = real[newest]
# And one row applied before the checksum column existed: NULL is "trusted,
# unverified" and must fall back to the filename rather than read as unknown.
PRE_CHECKSUM = sorted(real)[0]
ledger[PRE_CHECKSUM] = None

_psql(dsn, "CREATE TABLE schema_migrations (filename text primary key, "
           "checksum text)")
_psql(dsn, "INSERT INTO schema_migrations VALUES " + ",".join(
    f"('{n}', {'NULL' if c is None else repr(c)})" for n, c in sorted(ledger.items())))
_psql(dsn, "CREATE TABLE notes (body text)")
_psql(dsn, "INSERT INTO notes VALUES ('ORIGINAL-STATE')")

files = Path("/work/ap/files")
shutil.rmtree(files, ignore_errors=True)
(files / "memory").mkdir(parents=True)
(files / "memory" / "a.md").write_text("ORIGINAL NOTE")

cov = {"may_snapshot": True, "refusals": [], "entries": [
    {"kind": "bind", "name": str(files / "memory"), "included": True,
     "disposition": "include", "reason": "state"},
    {"kind": "volume", "name": "postgres_data", "included": True,
     "disposition": "include_via_pg_dump", "reason": "db"}]}

out = Path("/work/ap/bundles")
shutil.rmtree(out, ignore_errors=True)
man = bs.create(cov, out_dir=out, dsn=dsn)
bundle = Path(man["path"])
print("bundle of ORIGINAL state:", bundle.name)

# now change the world, so a successful restore is visibly a rollback
_psql(dsn, "UPDATE notes SET body='CHANGED-AFTER-BACKUP'")
(files / "memory" / "a.md").write_text("CHANGED NOTE")
(files / "memory" / "new.md").write_text("added after the backup")

TARGETS = {"files" + str(files / "memory"): str(files / "memory")}
KW = dict(admin_dsn=admin, target_db=LIVE, file_targets=TARGETS,
          coverage=cov, snapshot_dir=out, migrations_dir=mig)

print("\n1. gates that must refuse")
for label, kw in [("no confirmation", dict(KW, confirm="yes")),
                  ("wrong phrase", dict(KW, confirm="restore and overwrite my data"))]:
    try:
        ba.apply_bundle(bundle, **kw)
        chk(label, False, "it proceeded")
    except RestoreRefused as e:
        chk(label + " is refused", True, str(e)[:50])
chk("the world is still CHANGED after the refusals",
    _psql(dsn, "SELECT body FROM notes") == "CHANGED-AFTER-BACKUP")

print("\n2. a bundle from a NEWER Nova is refused (derived migration gate)")
known = ba._known_migrations(mig)
chk("the gate reads the real directory", known == real, f"{len(known)} files")
r = ba.check_migrations({"999_from_the_future.sql": "cafe" * 16}, known)
chk("refused", r is not None)
chk("...naming the unknown migration", "999_from_the_future.sql" in (r or ""))
chk("an older bundle is fine",
    ba.check_migrations({newest: real[newest]}, known) is None)
chk("a ledger row with NO file on disk, whose BODY is on disk, is allowed",
    ba.check_migrations({RENUMBERED_AWAY: real[newest]}, known) is None)
chk("...but the same row with a body nobody has is still refused",
    ba.check_migrations({RENUMBERED_AWAY: "cafe" * 16}, known) is not None)
chk("a NULL-checksum row falls back to its filename",
    ba.check_migrations({PRE_CHECKSUM: None}, known) is None)

print("\n2b. the ledger is read from the staged database, checksums and all")
read_back = ba._applied_migrations(dsn)
chk("every row came back", read_back == ledger, f"{len(read_back)} rows")
chk("the pre-checksum row is None, not empty string",
    read_back.get(PRE_CHECKSUM, "") is None)
chk("the whole live ledger passes the gate",
    ba.check_migrations(read_back, known) is None,
    str(ba.check_migrations(read_back, known))[:60])
# A bundle old enough to predate the checksum column must still be readable.
_psql(dsn, "ALTER TABLE schema_migrations DROP COLUMN checksum")
old_shape = ba._applied_migrations(dsn)
chk("a pre-checksum ledger reads by filename instead of failing",
    set(old_shape) == set(ledger) and set(old_shape.values()) == {None})
_psql(dsn, "ALTER TABLE schema_migrations ADD COLUMN checksum text")
# The column comes back empty and is not refilled on purpose: the bundle was
# written before this surgery and step 3 replaces this database wholesale, so
# what matters is that the BUNDLE's ledger still carries its checksums.

print("\n3. the real thing")
res = ba.apply_bundle(bundle, confirm=ba.CONFIRM_PHRASE, **KW)
chk("it reports success", res["restored"])
chk("a bundle carrying a renumbered-away ledger row is NOT refused",
    res["migrations_in_bundle"] == len(ledger), str(res["migrations_in_bundle"]))
chk("a safety snapshot was taken FIRST and verified",
    Path(res["safety_snapshot"]).exists(), Path(res["safety_snapshot"]).name)
chk("the database rolled back", _psql(dsn, "SELECT body FROM notes") == "ORIGINAL-STATE",
    _psql(dsn, "SELECT body FROM notes"))
chk("the file rolled back", (files / "memory" / "a.md").read_text() == "ORIGINAL NOTE")
chk("a file added after the backup is GONE", not (files / "memory" / "new.md").exists())
kept = Path(res["previous_files_kept_at"][str(files / "memory")])
chk("...but kept aside, not deleted", (kept / "new.md").exists(), str(kept.name))
dbs = _psql(admin, "SELECT datname FROM pg_database WHERE datname LIKE 'nova_%'")
chk("the pre-restore database is kept too", "pre_restore" in dbs, dbs.replace("\n"," ")[:70])
chk("no nova_verify_* staging database is left behind", "nova_verify" not in dbs)

# tidy: drop everything this drill made
for d in dbs.splitlines():
    d = d.strip()
    if d.startswith("nova_apply_drill") or "pre_restore" in d or d.startswith("nova_verify"):
        _psql(admin, f'DROP DATABASE IF EXISTS "{d}"')
print("\ncleaned up:", _psql(admin, "SELECT datname FROM pg_database WHERE datname LIKE 'nova%'").replace("\n", " "))
sys.exit(1 if FAIL else 0)
