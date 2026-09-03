"""Earned autonomy (ruling S3-R5): a consent-tier action class that racks up
N consecutive approved-AND-SUCCEEDED runs is promoted to auto, mechanically —
by flipping the SAME `action_classes.disposition` column policy.authorize
already reads. There is no parallel decision path here: this module only
ever mutates that table's row and appends the governance event that records
the mutation, in one transaction; the kernel's next `authorize` call sees the
new disposition by reading the row, exactly as it reads any other.

Who calls this, and when:
  * `record_outcome` — tools.dispatch(), immediately after an executor runs,
    for exactly the calls policy.authorize marked `track_outcome=True`: a
    consent-tier ALLOW that just burned a consent (a candidate for
    promotion), or an already-earned-auto class (a candidate for demotion on
    failure). A plain seeded-auto call (get_time, memory_save, ...) is never
    tracked — see policy.py's `_class_row`/`Decision.track_outcome`.
  * `revoke` — the operator, via autonomy_api.py's POST .../revoke, from
    Settings -> Autonomy. Only ever demotes a class this module itself
    promoted (`earned=true`); revoking a seeded-auto class is refused (the
    caller reports 404), matching Fix 1's "always revocable" scope: what was
    earned can be taken back, what was granted by design is not this
    button's business.
  * `set_disposition` — the operator, via autonomy_api.py's PUT
    .../{action_class}, from Settings -> Autonomy. The owner's own control
    over a class: auto ("runs automatically"), consent ("needs my approval")
    or deny ("never"). Same table, same column, same one-transaction event as
    revoke — the kernel reads the row it edits. Not a second authorizer.
  * `set_all_dispositions` — the operator, via autonomy_api.py's PUT
    /api/v1/autonomy (no class segment), from the master control at the top
    of Settings -> Autonomy. Every class to one disposition in ONE
    transaction, touching — and recording — only the classes that were not
    already there. Same row, same column, same event kind as set_disposition,
    one event per changed class, sharing a `batch` id.
  * `state`/`graduation_runs` — read-only, for the Settings and governance
    surfaces.
"""
from __future__ import annotations

import uuid

import asyncpg

from app import governance, settings_store

GRADUATION_RUNS_SETTING = "autonomy.graduation_runs"

# The dispositions the kernel reads (migration 004's CHECK is the last line;
# this is the first, so a typo is a stated ValueError rather than a postgres
# constraint error the API has to decode).
DISPOSITIONS = ("auto", "consent", "deny")

# The one SELECT behind every "what is every class at right now" answer —
# `state` (over the pool) and `set_all_dispositions` (inside its own
# transaction, so the state it returns is the state it committed).
_STATE_SQL = (
    "SELECT action_class, risk_tier, disposition, earned, consecutive_successes, updated_at "
    "FROM action_classes ORDER BY action_class"
)


def _check_disposition(disposition: str) -> None:
    """The one refusal both operator writes share, so a typo is the same
    stated ValueError whether one class or every class was being set."""
    if disposition not in DISPOSITIONS:
        raise ValueError(
            f"disposition must be one of {', '.join(DISPOSITIONS)} — not {disposition!r}"
        )


async def graduation_runs(pool: asyncpg.Pool) -> int:
    """N — how many consecutive burned-and-succeeded runs promote a class."""
    return await settings_store.read_value(pool, GRADUATION_RUNS_SETTING)


async def record_outcome(pool: asyncpg.Pool, *, action_class: str, succeeded: bool) -> None:
    """Apply one tracked run's outcome to `action_class`'s counter, promoting
    or demoting it if the outcome crosses a threshold. Atomic: the row read
    (FOR UPDATE, so two concurrent outcomes for the same class never race
    each other's counter), the row write, and any governance event it earns
    all commit — or roll back — together.

    A row with no action_class (a tool that vanished from the table between
    authorize() and here — should not happen, but this must never throw into
    a chat turn) is a silent no-op: there is nothing to record an outcome
    against.
    """
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "SELECT disposition, earned, consecutive_successes FROM action_classes "
            "WHERE action_class = $1 FOR UPDATE",
            action_class,
        )
        if row is None:
            return

        if not succeeded:
            if row["earned"]:
                # A promoted class's first failure demotes it back to
                # consent — the same governed transition a revoke makes,
                # just triggered by the run itself rather than the operator.
                await conn.execute(
                    "UPDATE action_classes SET disposition = 'consent', earned = false, "
                    "consecutive_successes = 0, updated_at = now() WHERE action_class = $1",
                    action_class,
                )
                await governance.record_event(
                    conn,
                    kind=governance.AUTONOMY_DEMOTED,
                    action_class=action_class,
                    meta={"reason": "a run of this earned-auto class failed"},
                )
            else:
                # Still consent-tier (or a class this module does not track):
                # nothing to demote, but a broken streak starts over.
                await conn.execute(
                    "UPDATE action_classes SET consecutive_successes = 0, updated_at = now() "
                    "WHERE action_class = $1",
                    action_class,
                )
            return

        if row["disposition"] == "auto":
            # Already promoted and this run succeeded too — nothing crosses.
            return

        threshold = await settings_store.read_value(conn, GRADUATION_RUNS_SETTING)
        new_count = row["consecutive_successes"] + 1
        if new_count >= threshold:
            await conn.execute(
                "UPDATE action_classes SET disposition = 'auto', earned = true, "
                "consecutive_successes = 0, updated_at = now() WHERE action_class = $1",
                action_class,
            )
            await governance.record_event(
                conn,
                kind=governance.AUTONOMY_PROMOTED,
                action_class=action_class,
                meta={"graduation_runs": threshold},
            )
        else:
            await conn.execute(
                "UPDATE action_classes SET consecutive_successes = $2, updated_at = now() "
                "WHERE action_class = $1",
                action_class,
                new_count,
            )


async def reset_streak_on_deny(conn: asyncpg.Connection, action_class: str) -> None:
    """An operator DENY breaks a consent-tier class's graduation streak. It is
    the strongest distrust signal there is — stronger than a failure (a failure
    is Nova's fault; a deny is the operator saying "no, not this action") — so
    the class's `consecutive_successes` goes back to 0.

    Runs on the CONNECTION the caller passes (consents.decide's own
    transaction, never a pool), so the counter reset and the deny + its
    governance event commit or roll back as one — never a denied card with a
    stale counter. It ONLY zeroes the counter: it must NEVER touch disposition
    or earned. A deny breaks the streak of a still-consent class; it does not
    demote (that is the failure/revoke path). Zeroing a class already at 0, or —
    defensively — one somehow already `auto` (an auto class raises no card, so
    this should not happen), is harmless: disposition and earned stay put.
    """
    await conn.execute(
        "UPDATE action_classes SET consecutive_successes = 0, updated_at = now() "
        "WHERE action_class = $1",
        action_class,
    )


async def revoke(pool: asyncpg.Pool, *, action_class: str, actor: str | None) -> bool:
    """The operator takes back an earned promotion. True only when a row was
    actually flipped — revoking a class that is not currently earned-auto
    (never graduated, already consent, unknown) is a no-op the caller turns
    into a stated 404, never a silent success."""
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "UPDATE action_classes SET disposition = 'consent', earned = false, "
            "consecutive_successes = 0, updated_at = now() "
            "WHERE action_class = $1 AND disposition = 'auto' AND earned = true "
            "RETURNING action_class",
            action_class,
        )
        if row is None:
            return False
        await governance.record_event(
            conn,
            kind=governance.AUTONOMY_REVOKED,
            action_class=action_class,
            actor=actor,
            meta={},
        )
        return True


async def set_disposition(
    pool: asyncpg.Pool, *, action_class: str, disposition: str, actor: str
) -> dict:
    """The owner sets `action_class`'s disposition by hand.

    This is NOT a second authorizer. It edits the DATA the kernel reads — the
    same `action_classes.disposition` row `revoke` and `record_outcome` edit —
    and policy.authorize sees the new value on its very next call by reading
    the row, exactly as it reads any other. No decision is made here; one is
    recorded: the row write and the AUTONOMY_DISPOSITION_SET governance event
    (meta before/after, actor = the person) commit together or not at all.

    Every disposition is written as earned=false with the streak reset:
      * auto     an operator-set auto is exactly a seeded auto — the kernel
                 allows it untracked, so a failure never self-demotes it, and
                 `revoke` (earned-only) has nothing to take back. Pinning auto
                 onto a class that EARNED auto therefore makes it the owner's
                 decision rather than a streak a failure can undo.
      * consent  the card returns; graduation starts over from 0.
      * deny     the kernel refuses the class by name.

    Refuses (writes nothing): a disposition outside DISPOSITIONS is a stated
    ValueError; a class with no row is a stated LookupError — a row is never
    created here, because a class with no row is denied by absence and an
    owner setting a class that does not exist is a typo to name, not a grant
    to invent. The API maps these to 400 and 404.
    """
    _check_disposition(disposition)
    async with pool.acquire() as conn, conn.transaction():
        before = await conn.fetchrow(
            "SELECT disposition FROM action_classes WHERE action_class = $1 FOR UPDATE",
            action_class,
        )
        if before is None:
            raise LookupError(f"{action_class} is not an action class")
        row = await conn.fetchrow(
            "UPDATE action_classes SET disposition = $2, earned = false, "
            "consecutive_successes = 0, updated_at = now() WHERE action_class = $1 "
            "RETURNING action_class, risk_tier, disposition, earned, consecutive_successes, "
            "updated_at",
            action_class,
            disposition,
        )
        await governance.record_event(
            conn,
            kind=governance.AUTONOMY_DISPOSITION_SET,
            action_class=action_class,
            actor=actor,
            meta={
                "before": before["disposition"],
                "after": disposition,
                "action_class": action_class,
            },
        )
        threshold = await settings_store.read_value(conn, GRADUATION_RUNS_SETTING)
    return _entry(row, threshold)


async def set_all_dispositions(
    pool: asyncpg.Pool, *, disposition: str, actor: str
) -> tuple[list[dict], list[str]]:
    """The owner sets EVERY class to `disposition` at once — the master
    control at the top of Settings -> Autonomy.

    Not a second authorizer, and not a loop over set_disposition either:
      * ONE transaction. Every differing row is locked up front (SELECT ...
        FOR UPDATE, which serialises against record_outcome's per-row lock
        and against a concurrent per-class PUT), then written and recorded
        one by one; a failure anywhere — a refused event write included —
        rolls back every row, so the table never ends up half-set.
      * Only what differs is touched. A class already at `disposition` gets
        no write, no event and no streak reset: the ledger names exactly what
        changed, and an EARNED auto stays earned under a bulk auto (decided
        2026-09-03 — the owner's "everything auto" is not a reason to turn a
        streak the class earned into a pin; set_disposition on that one class
        still does, deliberately). A class that does change is written exactly
        as set_disposition writes it: earned=false, streak 0.
      * One AUTONOMY_DISPOSITION_SET event PER CHANGED CLASS, each carrying
        the class in its own `action_class` column so the audit's per-class
        filter (Governance, the row's "recent decisions" pane) still finds it,
        plus `meta.batch` — one uuid4 shared by every event this call writes —
        so the ledger can tell "the owner set 14 classes at once" from 14
        separate decisions.

    Returns (every class's state row, rendered inside the same transaction so
    it is the state that committed; the names that changed, in action_class
    order). Nothing differing is an honest (state, []) — not an error. A
    disposition outside DISPOSITIONS is the same stated ValueError as
    set_disposition's, raised before anything is opened.
    """
    _check_disposition(disposition)
    batch = str(uuid.uuid4())
    changed: list[str] = []
    async with pool.acquire() as conn, conn.transaction():
        differing = await conn.fetch(
            "SELECT action_class, disposition FROM action_classes "
            "WHERE disposition <> $1 ORDER BY action_class FOR UPDATE",
            disposition,
        )
        for row in differing:
            action_class = row["action_class"]
            await conn.execute(
                "UPDATE action_classes SET disposition = $2, earned = false, "
                "consecutive_successes = 0, updated_at = now() WHERE action_class = $1",
                action_class,
                disposition,
            )
            await governance.record_event(
                conn,
                kind=governance.AUTONOMY_DISPOSITION_SET,
                action_class=action_class,
                actor=actor,
                meta={
                    "before": row["disposition"],
                    "after": disposition,
                    "action_class": action_class,
                    "batch": batch,
                },
            )
            changed.append(action_class)
        threshold = await settings_store.read_value(conn, GRADUATION_RUNS_SETTING)
        rows = await conn.fetch(_STATE_SQL)
    return [_entry(row, threshold) for row in rows], changed


def _entry(row: asyncpg.Record, threshold: int) -> dict:
    """One class as Settings -> Autonomy renders it — the same shape from
    `state` and from `set_disposition`, so the UI can echo a returned row into
    the list it already holds."""
    return {
        "action_class": row["action_class"],
        "risk_tier": row["risk_tier"],
        "disposition": row["disposition"],
        "earned": row["earned"],
        "consecutive_successes": row["consecutive_successes"],
        "graduation_runs": threshold,
        "updated_at": row["updated_at"].isoformat(),
    }


async def state(pool: asyncpg.Pool) -> list[dict]:
    """Every action class's current disposition and graduation progress —
    the real stored counters, for Settings -> Autonomy and the governance
    audit's per-class view. `graduation_runs` rides every row rather than
    being a separate field, so the UI never has to fetch it twice or guess
    which N a given `consecutive_successes` is counting toward."""
    threshold = await graduation_runs(pool)
    rows = await pool.fetch(_STATE_SQL)
    return [_entry(row, threshold) for row in rows]
