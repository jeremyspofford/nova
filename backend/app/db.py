"""Database connection and migrations."""

import hashlib
import logging
import re
from pathlib import Path

import asyncpg

from app.config import settings

log = logging.getLogger(__name__)

_PREFIX_RE = re.compile(r"^(\d+)_")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT_RE = re.compile(r"--[^\n]*")


# THE directory the running backend migrates from — one definition, because
# `backup_apply.check_migrations` compares a bundle's ledger against it and a
# second expression for the same path is a second thing that can be pointed
# somewhere else. A pre-flight reading a different directory than the migrator
# would answer a question nobody asked.
MIGRATIONS_DIR = Path(__file__).parent / "migrations"

#: The prefix collisions that predate the one-number-one-migration rule and
#: cannot be undone: both files were APPLIED on 2026-08-04, thirteen minutes
#: apart, and renumbering an applied migration is what caused the incident
#: this whole guard exists for. Mirrored by ACCEPTED_COLLISIONS in
#: tests/test_migration_identity.py — the mechanical gate that refuses NEW
#: ones. Nothing may be added here without the same evidence: applied, on
#: this database, un-renumberable.
ACCEPTED_COLLISIONS: dict[str, set[str]] = {
    "088": {"088_action_runs.sql", "088_eval_runs_gradeable.sql"},
}


def migration_prefix(filename: str) -> str:
    """The leading number of a migration filename, or "" if it has none.

    The number is the only part of the name that carries ordering, which is
    why it — and not the whole name — is what the adopt-by-content rule below
    insists on matching.
    """
    m = _PREFIX_RE.match(filename)
    return m.group(1) if m else ""


def has_statements(body: str) -> bool:
    """Whether a migration body would actually execute anything.

    A body that is only comments is a TOMBSTONE — see
    087_eval_runs_gradeable.sql, which exists to hold a filename open after a
    renumber. Two things follow, and both are why this is asked rather than
    assumed:

    * It must not be sent to the server. Measured 2026-08-05 against this
      stack's asyncpg: `execute("-- x")`, `execute("")` and `execute("  ")`
      all raise `AttributeError: 'NoneType' object has no attribute 'decode'`
      from deep inside the protocol, not a SQL error. A comments-only
      migration would therefore crash-loop a fresh install at startup.
    * Its checksum drifting from the ledger is not schema drift. A body that
      executes nothing cannot have moved the database away from the repo, so
      reporting one would be crying wolf on every boot.

    Deliberately crude: it strips block and line comments and asks whether
    anything is left. A `--` inside a string literal shortens the line but
    leaves the rest of the statement standing, so the only direction it can
    err in is calling a tombstone a statement.
    """
    stripped = _LINE_COMMENT_RE.sub("", _BLOCK_COMMENT_RE.sub("", body))
    return bool(stripped.strip())


def adopt_target(filename: str, digest: str, applied_with_same_body,
                 on_disk: dict[str, str]) -> str | None:
    """The applied name `filename` is a RENAME of, or None if it must run.

    A migration's identity is its body, not the string in front of it, so a
    file whose body is already in the ledger under another name has already
    been applied and must be recorded rather than re-executed. Three things
    have to hold before that conclusion is safe, and each is a live-state
    question rather than an exemption anyone maintains:

    * The number must match. Two legitimately distinct migrations CAN share a
      body, and a hash-only rule would silently skip the second — a real
      schema change quietly not applied is far worse than a benign re-run.
      A RENUMBER therefore re-runs, which is why the 088 collision in this
      tree is left alone rather than tidied up.
    * EVERY row carrying the body is considered, not the first one. This is
      pure rather than a `fetchval` for exactly that reason: the live ledger
      holds 087_eval_runs_gradeable.sql and 088_eval_runs_gradeable.sql at
      the same checksum 5fe4c904b8b8, so a first-row rule reads 087, sees the
      number differ, and re-runs a rename it should have adopted — the fix
      failing on the install it was written for.
    * The name being adopted must no longer carry that body on disk. If it
      does, this file is a COPY of a migration that is still there, not the
      same one moved, and a copy has never been applied. That closes the gap
      the number check alone leaves open (two identical bodies under one
      number) without appealing to the names of either.

    Returns None — meaning "execute it" — for an unnumbered filename, since
    there is no number to agree on.
    """
    prefix = migration_prefix(filename)
    if not prefix:
        return None
    for candidate in sorted(applied_with_same_body):
        if candidate == filename or migration_prefix(candidate) != prefix:
            continue
        if on_disk.get(candidate) == digest:
            continue
        return candidate
    return None


pool: asyncpg.Pool | None = None


async def init_pool():
    global pool
    pool = await asyncpg.create_pool(settings.database_url, min_size=5, max_size=20)
    log.info("Database pool initialized")


async def close_pool():
    global pool
    if pool:
        await pool.close()
        pool = None
        log.info("Database pool closed")


def acquire():
    """Async context manager for a pooled connection: `async with db.acquire() as conn:`"""
    if pool is None:
        raise RuntimeError("Pool not initialized")
    return pool.acquire()


async def run_migrations():
    if pool is None:
        raise RuntimeError("Pool not initialized")

    migrations_dir = MIGRATIONS_DIR
    if not migrations_dir.exists():
        log.info("No migrations directory found, skipping")
        return

    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ DEFAULT now()
            );
        """)
        # Rows applied before this column existed stay NULL on purpose:
        # hashing them against their CURRENT text would bless whatever drift
        # is already there. NULL reads as "trusted, unverified".
        await conn.execute(
            "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT")

        files = sorted(migrations_dir.glob("*.sql"))
        # Read once: the collision scan, the adoption rule and the apply loop
        # all ask about the same bytes, and re-reading them per question makes
        # it possible for the three answers to disagree mid-run.
        bodies = {f.name: f.read_text() for f in files}
        digests = {name: hashlib.sha256(b.encode()).hexdigest()
                   for name, b in bodies.items()}

        # Two files under one number apply in filename order, which is an
        # accident of the suffix rather than anyone's intent, and it makes
        # "migration 088" ambiguous in every log line and incident note.
        # It is live right now: 088_action_runs.sql and
        # 088_eval_runs_gradeable.sql landed thirteen minutes apart on
        # 2026-08-04. Loud log, NEVER raise, for the reason given below —
        # raising here would brick this box today over a collision that has
        # already applied cleanly, and renumbering an APPLIED migration is
        # itself unsafe (see the adopt-by-content guard). The mechanical gate
        # against NEW collisions is tests/test_migration_identity.py, which
        # globs this directory; it is a test because a test can refuse
        # without taking the backend down with it.
        #
        # Tombstones do not count as contenders: a body that executes nothing
        # cannot make a number ambiguous, and 087_eval_runs_gradeable.sql is
        # a tombstone sharing 087 by design. Counting it would put an ERROR
        # in the log on every one of this box's ~76 daily backend starts, and
        # a warning that is always there is one nobody reads.
        #
        # And the ONE collision that predates the rule is accepted by name,
        # for exactly the reason the paragraph above gives about tombstones:
        # it is unfixable (both files applied on 2026-08-04; renumbering an
        # applied migration is the disease, not the cure), so logging it
        # fires an ERROR on every start forever and teaches everyone that
        # migration errors are background noise — which is how the NEXT
        # collision gets scrolled past. Same set as ACCEPTED_COLLISIONS in
        # tests/test_migration_identity.py, which is the mechanical gate; a
        # collision not in this set is still loud here.
        by_prefix: dict[str, list[str]] = {}
        for name, body in bodies.items():
            if not has_statements(body):
                continue
            by_prefix.setdefault(migration_prefix(name), []).append(name)
        for prefix, names in sorted(by_prefix.items()):
            if prefix and len(names) > 1 and set(names) != ACCEPTED_COLLISIONS.get(prefix):
                log.error(
                    "Migration prefix %s is used by %d files (%s) — the "
                    "number no longer identifies one migration. Give the "
                    "NEXT new migration a free number; do not renumber an "
                    "applied one.", prefix, len(names), ", ".join(names))

        for filename, body in bodies.items():
            digest = digests[filename]
            already = await conn.fetchrow(
                "SELECT checksum FROM schema_migrations WHERE filename = $1", filename)
            if already:
                # An applied migration is never re-run, so editing one that
                # has already been applied is a silent no-op:
                # the repo says one thing, the live DB another, with nothing
                # in between to notice. That has already shipped a dead
                # feature — 037 exists only to repair an edited-after-apply
                # 032, which left raise_recommendation ungranted for days.
                # Loud log, never raise: run_migrations is the first thing
                # lifespan does, so raising crash-loops the backend with no UI
                # left to fix it from, and editing a just-written migration
                # mid-lane is the normal way of working here.
                #
                # A tombstone is exempt, not excused: it runs nothing, so it
                # cannot be the reason the database differs from the repo.
                if (already["checksum"] and already["checksum"] != digest
                        and has_statements(body)):
                    log.error(
                        "Migration %s CHANGED since it was applied — the live "
                        "database does not match the repo. Nothing will re-run "
                        "it; write a follow-up migration with the difference.",
                        filename)
                continue

            # Not applied under THIS name — but a migration's identity is its
            # body, not the string someone typed in front of it. Renaming or
            # renumbering an applied file used to re-execute it and leave the
            # old name in the ledger forever with nothing on disk to match:
            # 087_eval_runs_gradeable.sql and 088_eval_runs_gradeable.sql are
            # both in the live ledger, four minutes apart, byte-identical at
            # checksum 5fe4c904b8b8, because the file was renumbered to dodge
            # a prefix collision. That re-run was benign — ADD COLUMN IF NOT
            # EXISTS — and the orphan row was not: it made every retained
            # backup bundle unrestorable, because backup_apply read the ledger
            # and saw a migration this checkout does not have (see
            # backup_apply.check_migrations).
            #
            # What makes that safe is adopt_target(), which is pure so that
            # tests/test_migration_identity.py can hold it to its contract
            # without a database. ALL rows carrying the body are handed to it:
            # this ledger has two, and picking one in SQL picked the wrong one.
            rows = await conn.fetch(
                "SELECT filename FROM schema_migrations WHERE checksum = $1",
                digest)
            adopted = adopt_target(filename, digest,
                                   [r["filename"] for r in rows], digests)
            if adopted:
                log.info(
                    "Migration %s is %s under a new name (same number, same "
                    "body) — recording it as applied without re-running it",
                    filename, adopted)
                await conn.execute(
                    "INSERT INTO schema_migrations (filename, checksum) "
                    "VALUES ($1, $2)", filename, digest)
                continue

            log.info("Running migration: %s", filename)
            try:
                # One transaction for the body AND its ledger row: they were
                # separate execute() calls, so a crash in between re-ran the
                # whole migration on the next boot.
                async with conn.transaction():
                    # A tombstone is recorded but never sent: asyncpg raises
                    # AttributeError rather than a SQL error on a body with
                    # no statement in it, which would crash-loop a fresh
                    # install at startup. See has_statements().
                    if has_statements(body):
                        await conn.execute(body)
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename, checksum) "
                        "VALUES ($1, $2)", filename, digest)
            except Exception:
                log.exception("Migration %s failed", filename)
                raise
