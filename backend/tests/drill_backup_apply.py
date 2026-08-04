"""The DESTRUCTIVE restore, end to end, against a THROWAWAY database.

    docker run --rm --network nova_default -v $PWD/backend:/app/backend:ro \
      -v /tmp/drill:/work postgres:16-alpine sh -c \
      "apk add --no-cache python3 >/dev/null; python3 /app/backend/tests/drill_backup_apply.py $PGPASSWORD"

Not part of run_all.py: it needs a Postgres and it creates and drops
databases. It targets `nova_apply_drill`, never `nova`, and cleans up after
itself. This is the drill that caught the safety snapshot overwriting the
bundle it was protecting.
"""
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
_psql(dsn, "CREATE TABLE schema_migrations (filename text primary key)")
_psql(dsn, "INSERT INTO schema_migrations VALUES ('001_init.sql'),('002_more.sql')")
_psql(dsn, "CREATE TABLE notes (body text)")
_psql(dsn, "INSERT INTO notes VALUES ('ORIGINAL-STATE')")

files = Path("/work/ap/files")
shutil.rmtree(files, ignore_errors=True)
(files / "memory").mkdir(parents=True)
(files / "memory" / "a.md").write_text("ORIGINAL NOTE")
mig = Path("/work/ap/migrations")
mig.mkdir(parents=True, exist_ok=True)
for n in ("001_init.sql", "002_more.sql"):
    (mig / n).write_text("--")

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
r = ba.check_migrations({"001_init.sql", "999_from_the_future.sql"},
                        {"001_init.sql"})
chk("refused", r is not None)
chk("...naming the unknown migration", "999_from_the_future.sql" in (r or ""))
chk("an older bundle is fine", ba.check_migrations({"001_init.sql"},
                                {"001_init.sql", "002_more.sql"}) is None)

print("\n3. the real thing")
res = ba.apply_bundle(bundle, confirm=ba.CONFIRM_PHRASE, **KW)
chk("it reports success", res["restored"])
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
