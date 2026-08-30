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
    tracked — see policy.py's `_disposition`/`Decision.track_outcome`.
  * `revoke` — the operator, via autonomy_api.py's POST .../revoke, from
    Settings -> Autonomy. Only ever demotes a class this module itself
    promoted (`earned=true`); revoking a seeded-auto class is refused (the
    caller reports 404), matching Fix 1's "always revocable" scope: what was
    earned can be taken back, what was granted by design is not this
    button's business.
  * `state`/`graduation_runs` — read-only, for the Settings and governance
    surfaces.
"""
from __future__ import annotations

import asyncpg

from app import governance, settings_store

GRADUATION_RUNS_SETTING = "autonomy.graduation_runs"


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


async def state(pool: asyncpg.Pool) -> list[dict]:
    """Every action class's current disposition and graduation progress —
    the real stored counters, for Settings -> Autonomy and the governance
    audit's per-class view. `graduation_runs` rides every row rather than
    being a separate field, so the UI never has to fetch it twice or guess
    which N a given `consecutive_successes` is counting toward."""
    threshold = await graduation_runs(pool)
    rows = await pool.fetch(
        "SELECT action_class, risk_tier, disposition, earned, consecutive_successes, updated_at "
        "FROM action_classes ORDER BY action_class"
    )
    return [
        {
            "action_class": row["action_class"],
            "risk_tier": row["risk_tier"],
            "disposition": row["disposition"],
            "earned": row["earned"],
            "consecutive_successes": row["consecutive_successes"],
            "graduation_runs": threshold,
            "updated_at": row["updated_at"].isoformat(),
        }
        for row in rows
    ]
