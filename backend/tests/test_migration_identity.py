"""A migration is identified by its BODY, not by the string in front of it.

    docker compose exec backend python tests/test_migration_identity.py

This is the mechanical half of the fix for 2026-08-04, when
`087_eval_runs_gradeable.sql` was renumbered to 088 to dodge a prefix
collision. `run_migrations` tracked migrations by bare filename, so the
rename read as a brand new migration: it re-executed the body and left the
old name in `schema_migrations` with nothing on disk to match. The re-run was
benign. The orphan row was not — `backup_apply.check_migrations` read it as a
migration this checkout has never seen, and refused ALL 7 retained bundles
with "made by a NEWER version of Nova". Disaster recovery was off for a day,
silently, on an install whose backups were green.

The refusal lives HERE and not in `db.py` on purpose. `run_migrations` is the
first thing lifespan does, so a raise there crash-loops the backend with no
UI left to fix it from — and it would fire today, on a collision that has
already applied cleanly. db.py logs; this refuses.
"""

import hashlib
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import backup_apply as ba                             # noqa: E402
from app.db import adopt_target, has_statements, migration_prefix   # noqa: E402

MIGRATIONS = Path("/app/backend/app/migrations")

# The one collision that predates this test. Both files were APPLIED on
# 2026-08-04 before anything checked, and neither can be renumbered out of the
# way now: adopt-by-content requires the numeric prefix to match as well as
# the hash — precisely so that two distinct migrations with identical bodies
# cannot silently skip each other — so a renumber changes the prefix, defeats
# adoption, re-executes the body and mints a second orphan row. The cure would
# be the disease. They stay; new collisions do not.
ACCEPTED_COLLISIONS = {"088": {"088_action_runs.sql", "088_eval_runs_gradeable.sql"}}

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


files = sorted(MIGRATIONS.glob("*.sql"))
bodies = {p.name: p.read_text() for p in files}
digests = {name: hashlib.sha256(b.encode()).hexdigest() for name, b in bodies.items()}

print(f"1. every migration filename is numbered ({len(files)} files)")
unnumbered = sorted(n for n in bodies if not migration_prefix(n))
check("every file carries a numeric prefix", not unnumbered, ", ".join(unnumbered))
malformed = sorted(n for n in bodies if not re.fullmatch(r"\d{3}_[a-z0-9_]+\.sql", n))
check("...in the house shape NNN_lower_snake.sql", not malformed, ", ".join(malformed))

print("\n2. a number identifies ONE migration")
by_prefix = defaultdict(set)
for name in bodies:
    by_prefix[migration_prefix(name)].add(name)
# A tombstone shares a number without contending for it: it executes nothing,
# so it cannot make "what did 087 do" ambiguous and it cannot be ordered
# wrongly against its neighbour. Derived from the body rather than excused by
# name, so deleting the tombstone or giving it a statement re-arms this check
# by itself.
executing = {p: sorted(n for n in names if has_statements(bodies[n]))
             for p, names in by_prefix.items()}
new_collisions = {p: names for p, names in executing.items()
                  if len(names) > 1 and ACCEPTED_COLLISIONS.get(p) != set(names)}
check("no NEW prefix collision", not new_collisions, str(new_collisions))
check("a tombstone may share a number, because it runs nothing",
      executing.get("087") == ["087_action_preflight.sql"],
      ", ".join(executing.get("087", ())))
for prefix, names in ACCEPTED_COLLISIONS.items():
    check(f"the known-accepted {prefix} pair is still exactly what was accepted",
          by_prefix.get(prefix) == names, ", ".join(sorted(by_prefix.get(prefix, ()))))

print("\n3. no two migrations share a body")
# The adopt-by-content rule in db.py skips a file whose body is already in the
# ledger under another name at the same number. Two DISTINCT migrations with
# identical bodies at the same number would therefore silently not apply. The
# prefix guard makes that impossible while numbers stay unique, and this keeps
# the second half of the argument true.
by_digest = defaultdict(list)
for name, d in digests.items():
    by_digest[d].append(name)
dupes = {d[:12]: sorted(n) for d, n in by_digest.items() if len(n) > 1}
check("no duplicate-content group", not dupes, str(dupes))

print("\n4. the 087 tombstone is a real no-op, and safe to apply")
tomb = "087_eval_runs_gradeable.sql"
check("the renumbered-away filename still exists on disk", tomb in bodies)
check("...with a body that executes nothing",
      tomb in bodies and not has_statements(bodies[tomb]))
check("...explaining why an empty migration is here",
      tomb in bodies and "TOMBSTONE" in bodies[tomb])
# asyncpg raises AttributeError, not a SQL error, on a statement-free query:
# db.py must therefore RECORD a tombstone without sending it. Measured
# 2026-08-05 against this stack's asyncpg.
check("a comments-only body is recognised as statement-free",
      not has_statements("-- only a comment\n\n-- and another\n"))
check("a body with one statement is not",
      has_statements("-- a comment\nSELECT 1;\n"))
check("a block comment does not hide a statement",
      has_statements("/* why\n   this exists */\nALTER TABLE t ADD COLUMN c INT;"))
check("a block comment alone is a tombstone",
      not has_statements("/* nothing to do */\n"))

print("\n5. a renamed migration is not a migration from the future")
# This is the exact live shape: the ledger inside every retained bundle still
# carries 087_eval_runs_gradeable.sql at checksum 5fe4c904…, which is the body
# that now sits on disk under 088.
live_shape = ba.check_migrations(
    {"087_eval_runs_gradeable.sql": digests["088_eval_runs_gradeable.sql"]},
    {"088_eval_runs_gradeable.sql": digests["088_eval_runs_gradeable.sql"]})
check("a ledger row whose body is on disk under another name is allowed",
      live_shape is None, str(live_shape)[:70])
future = ba.check_migrations({"999_from_the_future.sql": "cafe" * 16},
                             {"001_init.sql": "beef" * 16})
check("a body this checkout has never seen is still refused", future is not None)
check("...naming it", "999_from_the_future.sql" in (future or ""))
check("a NULL checksum falls back to the filename, not to a refusal",
      ba.check_migrations({"001_init.sql": None}, {"001_init.sql": "beef" * 16}) is None)
check("...and a NULL checksum with no file of that name is still refused",
      ba.check_migrations({"404_gone.sql": None},
                          {"001_init.sql": "beef" * 16}) is not None)
check("bare sets still work — no checksums known reads as filenames only",
      ba.check_migrations({"001_init.sql"}, {"001_init.sql"}) is None)
check("a prefix match alone does NOT wave a migration through",
      ba.check_migrations({"088_from_the_future.sql": "cafe" * 16},
                          {"088_action_runs.sql": "beef" * 16}) is not None)

print("\n6. the real ledger, as it is on disk right now")
known = ba._known_migrations(MIGRATIONS)
check("_known_migrations hashes exactly as db.py does",
      known == digests, f"{len(known)} files")
# Every bundle on this install holds this row; before the fix it was the whole
# reason apply_bundle refused them.
check("the live orphan row no longer refuses a bundle",
      ba.check_migrations({"087_eval_runs_gradeable.sql":
                           "5fe4c904b8b85f262a8896aca42602ed"
                           "0523d253b3893ee2b7937a7a2b4ff3ee"}, known) is None)

print("\n7. what db.py adopts as a rename, and what it makes run")
# The ledger this box actually has: ONE body applied twice, under two numbers,
# because it was renumbered on 2026-08-04. Every case below is fed that shape,
# because a rule that only works against a tidy ledger is no use here.
LIVE_DUPLICATE = ["087_eval_runs_gradeable.sql", "088_eval_runs_gradeable.sql"]
D88 = digests["088_eval_runs_gradeable.sql"]
renamed = {n: d for n, d in digests.items() if n != "088_eval_runs_gradeable.sql"}
renamed["088_eval_gradeable.sql"] = D88
check("a same-number rename is adopted, even though an OLDER number in the "
      "ledger carries the identical body",
      adopt_target("088_eval_gradeable.sql", D88, LIVE_DUPLICATE, renamed)
      == "088_eval_runs_gradeable.sql")
check("a RENUMBER is not adopted — it changes the number, so it runs",
      adopt_target("089_eval_runs_gradeable.sql", D88, LIVE_DUPLICATE,
                   digests) is None)
check("a COPY of a file still on disk is not adopted — a copy never ran",
      adopt_target("088_eval_runs_copy.sql", D88, LIVE_DUPLICATE,
                   {**digests, "088_eval_runs_copy.sql": D88}) is None)
check("a body nobody has applied is not adopted",
      adopt_target("094_new.sql", "cafe" * 16, [], digests) is None)
check("an unnumbered filename is never adopted: no number to agree on",
      adopt_target("cleanup.sql", D88, LIVE_DUPLICATE, digests) is None)
check("a file is never adopted as itself",
      adopt_target("088_eval_runs_gradeable.sql", D88, LIVE_DUPLICATE,
                   digests) is None)
check("the tombstone is not adopted onto the body it replaced",
      adopt_target(tomb, digests[tomb], LIVE_DUPLICATE, digests) is None)

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
