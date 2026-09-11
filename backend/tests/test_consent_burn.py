"""The consent burn is single-use, fresh, bound, and race-safe (Slice 1.1).

    docker compose exec backend python tests/test_consent_burn.py
    PYTHONPATH=backend python backend/tests/test_consent_burn.py   (CI)

`consents.validate_and_use` is the mechanical half of every guarded
destructive action (docs/DECISIONS.md D-018; gates.py `consent-burn`): one
UPDATE whose WHERE clause is the whole contract. Until this suite, the burn
had no direct pinning test — `test_consent_visibility.py` covers who can SEE
a card, not who can SPEND one. What is pinned here, against the real
function and the real Postgres, with no mocks:

  1. A fresh decided+approved consent burns exactly once; a replay — by
     kind+subject or by id — gets None and cannot disturb the original
     `used_at` stamp.
  2. Freshness: a decision older than USE_TTL_MIN is dead, and the failed
     attempt leaves the row unconsumed and unusable — a refusal never
     half-spends.
  3. Binding: wrong kind, wrong subject, wrong requesting agent, or a
     non-matching consent id each refuse. Two behaviors are pinned AS-BUILT
     inventory truth, not endorsements: a garbled (unparseable) id falls
     back to kind+subject lookup, and `agent_name=None` bypasses the agent
     binding (both production call sites pass a real agent name —
     tools/builtin.py:2704, :2735).
  4. Pending and denied cards are never burnable; newest-first selection
     when two approvals coexist, each still single-use.
  5. THE RACE: N simultaneous attempts on one approval yield exactly one
     winner. The suite must PROVE concurrency rather than assume it: an
     observation-only wrapper around the real `db.acquire` records the
     `pg_backend_pid()` of the connection each attempt actually uses and
     holds attempts at a start gate until the peers have connections
     checked out, so the UPDATEs genuinely contend for the row lock. At
     least two distinct backend PIDs are required for the SKIP LOCKED claim;
     a single-connection environment downgrades that assertion to an
     explicit SKIP — a queued single-session run proves single-use, not
     concurrent SKIP LOCKED behavior, and is not reported as if it did.

Probe rows use kind 'test.burn*' with uuid subjects (can never collide with
production 'rule.*' consents), are tracked by id, and are deleted in the
`finally:` — a survivor fails the suite.
"""

import asyncio
import contextlib
import logging
import sys
import uuid
from contextlib import asynccontextmanager

sys.path.insert(0, "/app/backend")

from app import consents, db                              # noqa: E402

FAILURES: list[str] = []
KIND = "test.burn"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def probe(made, *, kind=KIND, subject=None, status="decided",
                chosen="approve", decided_ago_s=0, requested_by="agent-a"):
    """Insert one probe consent row directly; returns (id, subject)."""
    subject = subject or str(uuid.uuid4())
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "INSERT INTO consents (kind, subject, question, requested_by, "
            "status, chosen, decided_at) VALUES ($1, $2, 'probe', $3, $4, $5, "
            "CASE WHEN $4 = 'decided' "
            "THEN now() - make_interval(secs => $6::float) END) "
            "RETURNING id", kind, subject, requested_by, status, chosen,
            float(decided_ago_s))
    made.append(str(r["id"]))
    return str(r["id"]), subject


async def row_state(cid):
    async with db.acquire() as conn:
        return await conn.fetchrow(
            "SELECT status, chosen, used_at FROM consents WHERE id = $1",
            uuid.UUID(cid))


async def main():
    await db.init_pool()
    import _gov_cleanup as gc
    made: list[str] = []
    async with db.acquire() as conn:
        gov_wm = await gc.start_watermark(conn)
    try:
        print("1. single use")
        cid, subj = await probe(made)
        burned = await consents.validate_and_use(KIND, subj, agent_name="agent-a")
        check("a fresh approval burns", bool(burned))
        st = await row_state(cid)
        check("...and used_at is stamped in the database", st["used_at"] is not None)
        first_used_at = st["used_at"]
        replay = await consents.validate_and_use(KIND, subj, agent_name="agent-a")
        check("replay by kind+subject gets None", replay is None)
        replay = await consents.validate_and_use(KIND, subj, cid, agent_name="agent-a")
        check("replay by exact id gets None", replay is None)
        st = await row_state(cid)
        check("the original stamp is undisturbed", st["used_at"] == first_used_at)

        print("2. freshness")
        cid, subj = await probe(made, decided_ago_s=4 * 60)   # past USE_TTL_MIN=3
        check("a 4-minute-old decision is dead",
              await consents.validate_and_use(KIND, subj) is None)
        st = await row_state(cid)
        check("...and the failed attempt consumed nothing",
              st["used_at"] is None and st["status"] == "decided")

        print("3. binding")
        cid, subj = await probe(made)
        check("wrong kind refuses",
              await consents.validate_and_use(KIND + ".other", subj) is None)
        check("wrong subject refuses",
              await consents.validate_and_use(KIND, str(uuid.uuid4())) is None)
        check("the wrong agent cannot spend it",
              await consents.validate_and_use(KIND, subj, agent_name="agent-b") is None)
        st = await row_state(cid)
        check("...all three refusals left it unconsumed", st["used_at"] is None)
        check("a non-matching (valid) consent id refuses",
              await consents.validate_and_use(KIND, subj, str(uuid.uuid4()),
                                              agent_name="agent-a") is None)
        # AS-BUILT inventory truth, pinned deliberately (see module docstring):
        check("a garbled id falls back to kind+subject and burns",
              await consents.validate_and_use(KIND, subj, "not-a-uuid",
                                              agent_name="agent-a") is not None)
        cid, subj = await probe(made)
        check("agent_name=None bypasses the agent binding (as-built)",
              await consents.validate_and_use(KIND, subj) is not None)

        print("4. undecided / denied / newest-first")
        _, subj = await probe(made, status="pending", chosen=None)
        check("a pending card is not burnable",
              await consents.validate_and_use(KIND, subj) is None)
        _, subj = await probe(made, chosen="deny")
        check("a denial is not burnable",
              await consents.validate_and_use(KIND, subj) is None)
        subj = str(uuid.uuid4())
        older, _ = await probe(made, subject=subj, decided_ago_s=60)
        newer, _ = await probe(made, subject=subj, decided_ago_s=5)
        b1 = await consents.validate_and_use(KIND, subj)
        check("with two approvals, the newest burns first",
              b1 is not None and b1["id"] == newer)
        b2 = await consents.validate_and_use(KIND, subj)
        check("...then the older (each single-use)",
              b2 is not None and b2["id"] == older)
        check("...then nothing", await consents.validate_and_use(KIND, subj) is None)

        print("5. the race (real sessions, real row lock)")
        # How many pool connections can this environment actually hold at
        # once? Hold up to 3 simultaneously and count distinct backends.
        held, held_pids = [], set()
        try:
            for _ in range(3):
                try:
                    conn = await asyncio.wait_for(db.pool.acquire(), timeout=2)
                except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                    break
                held.append(conn)
                held_pids.add(await conn.fetchval("SELECT pg_backend_pid()"))
        finally:
            for conn in held:
                await db.pool.release(conn)
        usable = len(held_pids)
        print(f"     concurrently usable sessions: {usable} "
              f"(pids {sorted(held_pids)})")

        n = 6
        parties = min(n, max(usable, 1))
        arrivals, gate = [0], asyncio.Event()
        race_pids: list[int] = []
        real_acquire = db.acquire

        def spying_acquire():
            @asynccontextmanager
            async def cm():
                async with real_acquire() as conn:
                    race_pids.append(
                        await conn.fetchval("SELECT pg_backend_pid()"))
                    arrivals[0] += 1
                    if arrivals[0] >= parties:
                        gate.set()
                    # Hold until the peers also hold connections, so the
                    # UPDATEs contend for the row lock at the same moment.
                    # Timeout fallback: the gate synchronizes, it must never
                    # deadlock the suite.
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(gate.wait(), timeout=5)
                    yield conn
            return cm()

        cid, subj = await probe(made)
        db.acquire = spying_acquire
        try:
            results = await asyncio.gather(
                *[consents.validate_and_use(KIND, subj, agent_name="agent-a")
                  for _ in range(n)])
        finally:
            db.acquire = real_acquire
        wins = [r for r in results if r]
        distinct = sorted(set(race_pids))
        print(f"     race attempt backend pids: {race_pids}")
        if usable >= 2:
            check("the attempts ran on at least two PostgreSQL sessions",
                  len(distinct) >= 2, f"distinct pids: {distinct}")
            check("exactly one attempt burned the consent",
                  len(wins) == 1, f"{len(wins)} winner(s) of {n}")
        else:
            print("  SKIP  concurrent SKIP LOCKED assertion — this "
                  "environment provided only one usable pool connection; a "
                  "queued single-session run does not prove concurrent "
                  "behavior")
            check("even serialized, at most one attempt burned it",
                  len(wins) == 1, f"{len(wins)} winner(s)")
        st = await row_state(cid)
        check("the database shows exactly one consumption",
              st["used_at"] is not None)
        again = await asyncio.gather(
            *[consents.validate_and_use(KIND, subj, agent_name="agent-a")
              for _ in range(n)])
        check("a second wave all get None", not any(again))

        print("6. audit")
        records: list[logging.LogRecord] = []
        handler = logging.Handler()
        handler.emit = records.append
        lg = logging.getLogger("app.consents")
        old_level = lg.level
        # The bare test process has no logging config, so the module's
        # log.info would be filtered at the WARNING root default before any
        # handler saw it — the runtime process runs at INFO.
        lg.setLevel(logging.INFO)
        lg.addHandler(handler)
        try:
            cid, subj = await probe(made)
            await consents.validate_and_use(KIND, subj, agent_name="agent-a")
        finally:
            lg.removeHandler(handler)
            lg.setLevel(old_level)
        check("a burn logs 'Consent burned'",
              any("Consent burned" in r.getMessage() for r in records))
        # The durable audit fact is the used_at stamp (checked throughout).
        # No trace span or governance event exists in the current contract —
        # that gap belongs to the event-ledger slice (D-020), not here.
    finally:
        async with db.acquire() as conn:
            await conn.execute(
                "DELETE FROM consents WHERE id = ANY($1::uuid[])",
                [uuid.UUID(i) for i in made])
            # The burns above wrote real governance events (D-030); this
            # suite removes ONLY its own — exact consent ids, bounded to
            # this run by the start watermark (D-031). Historical rows are
            # structurally out of reach.
            await gc.purge(conn, after_id=gov_wm, subject_ids=made,
                           kinds=("test.burn",))
            left = await conn.fetchval(
                "SELECT count(*) FROM consents WHERE id = ANY($1::uuid[])",
                [uuid.UUID(i) for i in made])
            left += await gc.remaining(conn, after_id=gov_wm,
                                       subject_ids=made, kinds=("test.burn",))
        print(f"\n  cleanup: {left} probe row(s) left behind "
              f"(consents + governance events)")
        if left:
            FAILURES.append("probe rows survived cleanup")

    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)}")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("all checks passed")


asyncio.run(main())
