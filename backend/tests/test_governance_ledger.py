"""The governance ledger commits WITH the fact it records, or not at all.

    docker compose exec backend python tests/test_governance_ledger.py
    PYTHONPATH=backend python backend/tests/test_governance_ledger.py   (CI)

Slice 2 (docs/DECISIONS.md D-020, D-030). Three onboarded event types:
consent.decided, consent.burned, capability.changed. What is pinned:

  1. ATOMICITY, the integrity model: a consent decision/burn and its event
     commit in one transaction. A forced ledger failure rolls the mutation
     back — the click stays pending and retryable; the burn reverts and the
     approval survives; no partial state, no orphan event. The rollback is
     real Postgres, not a mock (only the event writer is patched to fail).
  2. PAIR-ATOMICITY for capability events: for each successfully completed
     capability_events._write() transaction, the legacy row and its mirror
     commit together or neither commits. NOT a completeness upgrade — the
     fire-and-forget posture around it is unchanged and untested here.
  3. Readers unchanged: capability_events.recent() output shape and detail
     content are exactly as before; no consumer was touched.
  4. Typed payloads fail safe: bad enums, oversized identifiers, and
     over-cap payloads REJECT (never truncate), and their error messages
     name the event type and key only — never the offending value.
  5. Append-only is an application-level contract: no UPDATE/DELETE against
     governance_events anywhere in app/, and only app/governance.py inserts
     into it. (This test's own cleanup is the documented exception — the
     contract binds app/, not tests/.)
  6. Not an authorization authority: app/ outside governance.py touches the
     module only through its constructors and record().
  7. reconcile() is a TEST/ADMIN-ONLY diagnostic: it finds a synthetic gap,
     and nothing in app/ schedules, boots, or exposes it.
"""

import asyncio
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import capability_events, consents, db, governance   # noqa: E402

FAILURES: list[str] = []
KIND = "test.gov"
APP = Path(__file__).resolve().parents[1] / "app"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def probe_consent(made, *, status="pending", chosen=None,
                        decided_ago_s=0, requested_by="agent-a"):
    subject = str(uuid.uuid4())
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            "INSERT INTO consents (kind, subject, question, requested_by, "
            "status, chosen, decided_at) VALUES ($1, $2, 'probe', $3, $4, $5, "
            "CASE WHEN $4 = 'decided' "
            "THEN now() - make_interval(secs => $6::float) END) "
            "RETURNING id", KIND, subject, requested_by, status, chosen,
            float(decided_ago_s))
    made.append(str(r["id"]))
    return str(r["id"]), subject


async def events_for(subject_id):
    async with db.acquire() as conn:
        return await conn.fetch(
            "SELECT * FROM governance_events WHERE subject_id = $1 "
            "ORDER BY id", subject_id)


async def consent_state(cid):
    async with db.acquire() as conn:
        return await conn.fetchrow(
            "SELECT status, chosen, used_at FROM consents WHERE id = $1",
            uuid.UUID(cid))


class _Boom(Exception):
    pass


async def main():
    await db.init_pool()
    made: list[str] = []
    cap_subjects: list[str] = []
    api_decided: list[str] = []   # consents decided through decide()
    api_burned: list[str] = []    # consents burned through validate_and_use()
    try:
        print("1. commit together")
        cid, _ = await probe_consent(made)
        row = await consents.decide(cid, "approve")
        api_decided.append(cid)
        check("decide() still returns the row", bool(row))
        st = await consent_state(cid)
        evs = await events_for(cid)
        check("the decision and its event committed together",
              st["status"] == "decided" and len(evs) == 1)
        e = evs[0] if evs else {}
        check("...typed: consent.decided, operator, kind+chosen only",
              e and e["event_type"] == "consent.decided"
              and e["actor_kind"] == "operator"
              and set(__import__("json").loads(e["payload"])) == {"kind", "chosen"}
              and e["actor_assurance"] == "unknown")

        cid, subj = await probe_consent(made, status="decided", chosen="approve")
        burned = await consents.validate_and_use(KIND, subj, agent_name="agent-a")
        api_burned.append(cid)
        evs = await events_for(cid)
        check("the burn and its event committed together",
              burned is not None and len(evs) == 1
              and evs[0]["event_type"] == "consent.burned")
        check("...burn actor is the requesting agent",
              evs and evs[0]["actor_kind"] == "agent"
              and evs[0]["actor_id"] == "agent-a")

        print("2. forced ledger failure rolls the mutation back")
        real_record = governance.record

        async def boom(conn, event):
            raise _Boom("ledger down (test)")

        cid, _ = await probe_consent(made)
        governance.record = boom
        try:
            try:
                await consents.decide(cid, "approve")
                check("decide() fails when the ledger write fails", False)
            except _Boom:
                check("decide() fails when the ledger write fails", True)
        finally:
            governance.record = real_record
        st = await consent_state(cid)
        check("...the click rolled back: row still pending",
              st["status"] == "pending")
        check("...and no orphan event exists", not await events_for(cid))
        retried = await consents.decide(cid, "approve")
        api_decided.append(cid)
        check("...and the card is retryable: a later click succeeds",
              retried is not None)

        cid, subj = await probe_consent(made, status="decided", chosen="approve")
        governance.record = boom
        try:
            try:
                await consents.validate_and_use(KIND, subj, agent_name="agent-a")
                check("the burn fails when the ledger write fails", False)
            except _Boom:
                check("the burn fails when the ledger write fails", True)
        finally:
            governance.record = real_record
        st = await consent_state(cid)
        check("...the burn rolled back: used_at is NULL and approval survives",
              st["used_at"] is None)
        check("...no orphan burn event",
              not [e for e in await events_for(cid)
                   if e["event_type"] == "consent.burned"])
        reburned = await consents.validate_and_use(KIND, subj,
                                                   agent_name="agent-a")
        api_burned.append(cid)
        check("...the preserved approval burns once the ledger is back",
              reburned is not None)

        print("3. capability pair-atomicity")
        subj = f"test-gov-{uuid.uuid4()}"
        cap_subjects.append(subj)
        await capability_events._write(
            KIND, subj, "created", "operator",
            {"granted": ["tool_a"], "note": {"free": "text stays legacy-only"}})
        async with db.acquire() as conn:
            legacy = await conn.fetchval(
                "SELECT count(*) FROM capability_events WHERE subject = $1", subj)
        evs = await events_for(subj)
        check("a completed _write() commits legacy row AND mirror",
              legacy == 1 and len(evs) == 1)
        check("...the mirror is a typed projection (no legacy detail copied)",
              evs and set(__import__("json").loads(evs[0]["payload"]))
              == {"kind", "action", "granted"})

        subj = f"test-gov-{uuid.uuid4()}"
        cap_subjects.append(subj)
        governance.record = boom
        try:
            try:
                await capability_events._write(KIND, subj, "created",
                                               "operator", {})
                check("_write() propagates a mirror failure", False)
            except _Boom:
                check("_write() propagates a mirror failure", True)
        finally:
            governance.record = real_record
        async with db.acquire() as conn:
            legacy = await conn.fetchval(
                "SELECT count(*) FROM capability_events WHERE subject = $1", subj)
        check("...and NEITHER row exists (pair rolled back)",
              legacy == 0 and not await events_for(subj))

        subj = f"test-gov-{uuid.uuid4()}"
        cap_subjects.append(subj)
        governance.record = boom
        try:
            capability_events.record(KIND, subj, "created")   # fire-and-forget
            await asyncio.sleep(0.5)
        finally:
            governance.record = real_record
        async with db.acquire() as conn:
            legacy = await conn.fetchval(
                "SELECT count(*) FROM capability_events WHERE subject = $1", subj)
        check("public record() never raises; the pair is lost together, "
              "loudly logged (existing posture, not strengthened)",
              legacy == 0 and not await events_for(subj))

        subj = f"test-gov-{uuid.uuid4()}"
        cap_subjects.append(subj)
        capability_events.record(KIND, subj, "created", actor="operator",
                                 detail={"granted": ["tool_b"]})
        for _ in range(50):
            if await events_for(subj):
                break
            await asyncio.sleep(0.1)
        check("end-to-end record() lands both rows in the background",
              bool(await events_for(subj)))

        print("4. readers unchanged")
        rows = await capability_events.recent(limit=200)
        mine = [r for r in rows if r["kind"] == KIND
                and r["subject"] in cap_subjects]
        check("recent() serves the probe with its full legacy shape",
              mine and set(mine[0].keys())
              == {"at", "kind", "subject", "action", "actor", "detail"})
        check("...including detail content the mirror did not copy",
              any("note" in (r["detail"] or "") for r in mine))

        print("5. typed payloads fail safe, without leaking values")
        secret = "SECRET-VALUE-NEVER-LOGGED"
        for label, fn in [
            ("a bad enum rejects", lambda: governance.consent_decided(
                consent_id=str(uuid.uuid4()), consent_kind="k", chosen=secret)),
            ("an oversized identifier rejects", lambda: governance.consent_burned(
                consent_id=secret * 20, consent_kind="k")),
        ]:
            try:
                fn()
                check(label, False)
            except ValueError as exc:
                check(label, True)
                check(f"...{label.split()[1]} error names type+key only",
                      secret not in str(exc), str(exc)[:80])
        big = governance.capability_changed(
            kind="k", subject="s", action="a", actor="operator",
            granted=[f"tool-{i:03d}" + "x" * 60 for i in range(180)])
        try:
            async with db.acquire() as conn:
                async with conn.transaction():
                    await governance.record(conn, big)
            check("an over-cap payload rejects rather than truncating", False)
        except ValueError as exc:
            check("an over-cap payload rejects rather than truncating",
                  "exceeds" in str(exc))

        print("6. append-only + not-an-authority (application-level contract)")
        offenders, inserters, misusers = [], [], []
        for p in APP.rglob("*.py"):
            src = p.read_text()
            if re.search(r"(UPDATE|DELETE\s+FROM)\s+governance_events", src, re.I):
                offenders.append(p.name)
            if "INSERT INTO governance_events" in src and p.name != "governance.py":
                inserters.append(p.name)
            if p.name != "governance.py":
                for m in re.finditer(r"governance\.(\w+)", src):
                    if m.group(1) not in ("record", "consent_decided",
                                          "consent_burned", "capability_changed"):
                        misusers.append(f"{p.name}:{m.group(1)}")
        check("no UPDATE/DELETE against governance_events in app/", not offenders,
              ",".join(offenders))
        check("only governance.py INSERTs into the ledger", not inserters,
              ",".join(inserters))
        check("app/ uses only constructors + record() — no reads, no authority",
              not misusers, ",".join(misusers))
        sched = [p.name for p in APP.rglob("*.py")
                 if p.name != "governance.py" and "reconcile" in p.read_text()
                 and "governance" in p.read_text()
                 and re.search(r"governance\.reconcile", p.read_text())]
        check("nothing in app/ schedules or exposes reconcile()", not sched,
              ",".join(sched))
        # The test-only cleanup helper (Slice 2.1, D-031) must be unreachable
        # from production: no app/ file may import or reference it.
        helper_refs = [p.name for p in APP.rglob("*.py")
                       if "_gov_cleanup" in p.read_text()]
        check("nothing in app/ references the test-only cleanup helper",
              not helper_refs, ",".join(helper_refs))

        print("7. reconcile() as defense in depth (test/admin-only)")
        # Probes inserted already-decided by raw SQL never went through
        # decide(), so reconcile() CORRECTLY reports them as gaps — they are
        # synthetic by construction. The atomicity claim is about facts that
        # went through the real API (tracked in api_decided/api_burned):
        # those must have no gaps.
        gaps = await governance.reconcile()
        api_gaps = [g for g in gaps
                    if ("consent.decided" in g
                        and any(i in g for i in api_decided))
                    or ("consent.burned" in g
                        and any(i in g for i in api_burned))]
        raw_gaps = [g for g in gaps if any(i in g for i in made)]
        check("no gaps for facts that went through the real API", not api_gaps,
              "; ".join(api_gaps[:3]))
        check("...while raw-SQL synthetic decisions ARE reported",
              bool(raw_gaps))
        gap_id, _ = await probe_consent(made, status="decided",
                                        chosen="approve", decided_ago_s=0)
        gaps = await governance.reconcile()
        check("a synthetic raw-SQL decision without an event is detected",
              any(gap_id in g for g in gaps))
    finally:
        async with db.acquire() as conn:
            await conn.execute(
                "DELETE FROM governance_events WHERE subject_id = ANY($1)",
                made + cap_subjects)
            await conn.execute(
                "DELETE FROM capability_events WHERE kind = $1", KIND)
            await conn.execute(
                "DELETE FROM consents WHERE id = ANY($1::uuid[])",
                [uuid.UUID(i) for i in made])
            left = await conn.fetchval(
                "SELECT (SELECT count(*) FROM consents WHERE id = ANY($1::uuid[]))"
                " + (SELECT count(*) FROM governance_events WHERE subject_id = ANY($2))"
                " + (SELECT count(*) FROM capability_events WHERE kind = $3)",
                [uuid.UUID(i) for i in made], made + cap_subjects, KIND)
        print(f"\n  cleanup: {left} probe row(s) left behind")
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
