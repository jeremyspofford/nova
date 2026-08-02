"""The gates in front of a destructive restore (roadmap #31, increment 5).

    docker compose exec backend python tests/test_backup_apply.py

The restore itself needs a Postgres and is exercised by a drill against a
throwaway database; what is pinned here is what must refuse BEFORE anything
is touched. Every check is one answer to the same question — can this
overwrite the operator's data by accident?
"""

import sys

sys.path.insert(0, "/app/backend")

from app import backup_apply as ba                           # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


print("1. confirmation is a PHRASE, not a flag")
check("a boolean cannot express consent here",
      ba.CONFIRM_PHRASE not in (True, "true", "yes", "1"))
check("the phrase is explicit about what happens",
      "OVERWRITE" in ba.CONFIRM_PHRASE, ba.CONFIRM_PHRASE)

print("\n2. the migration gate is DERIVED from the two live sets")
r = ba.check_migrations({"001.sql", "084_from_the_future.sql"}, {"001.sql"})
check("a bundle from a NEWER Nova is refused", r is not None)
check("...naming the migration this code has never seen",
      "084_from_the_future.sql" in (r or ""))
check("...and saying what to do about it", "Update Nova first" in (r or ""))
check("a bundle from an OLDER Nova is allowed — migrations run forward",
      ba.check_migrations({"001.sql"}, {"001.sql", "002.sql"}) is None)
check("an identical set is allowed",
      ba.check_migrations({"001.sql"}, {"001.sql"}) is None)
check("an empty bundle set is allowed rather than mistaken for the future",
      ba.check_migrations(set(), {"001.sql"}) is None)

print("\n3. the refusal happens before the database is reachable")
# apply_bundle checks the phrase FIRST, so a wrong confirmation cannot even
# get as far as opening a connection — there is no DSN in this test at all
raised = None
try:
    ba.apply_bundle(__import__("pathlib").Path("/nonexistent.tar.gz"),
                    admin_dsn="postgresql://would-fail", target_db="nova",
                    file_targets={}, confirm="yes", coverage={},
                    snapshot_dir=__import__("pathlib").Path("/tmp/x"),
                    migrations_dir=__import__("pathlib").Path("/tmp/x"))
except Exception as e:
    raised = e
check("an unconfirmed restore refuses without touching anything",
      isinstance(raised, Exception) and "not confirmed" in str(raised),
      str(raised)[:60])

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
