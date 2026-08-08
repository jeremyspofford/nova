"""A pending consent card the operator cannot see is not a control.

    docker compose exec backend python tests/test_consent_visibility.py

This hole has now been found TWICE, from opposite ends, and that is why it
gets its own suite rather than a line in an existing one.

**July 2026, the writer.** `ctx["conversation_id"]` was never set, so every
consent card an agent raised was written with `conversation_id = NULL` while
`list_pending` filtered `AND conversation_id = $1` using the id the chat UI
always supplies. Real rows, pending forever, visible to nobody. Fixed by
threading the id down through the runner.

**2026-08-07, the reader.** Migration 116 raised "Turn on the
self-improvement loop?" — the card that authorises the entire autonomous
lane. A migration has no conversation, so the row was written with NULL
again, and the same filter hid it again. Jeremy: "I didn't see the improve
yourself continuously one." It had been sitting pending and undecidable while
the capability it gated stayed switched off.

**The writer cannot fix this one.** A migration, the scheduler and the
heartbeat genuinely have no conversation to name. So the fix is at the
reader: NULL does not mean "some other conversation", it means "addressed to
the operator rather than to a chat", and such a card belongs in whichever
conversation he is reading.

The property below is the one that matters: for any conversation id, a
system-raised card is visible. Not "is usually visible", not "is visible if
someone passed the right argument".
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import consents, db                              # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main():
    await db.init_pool()

    convo_a = str(uuid.uuid4())
    convo_b = str(uuid.uuid4())
    made: list[str] = []

    async with db.acquire() as conn:
        # A card belonging to conversation A.
        row_a = await conn.fetchrow(
            "INSERT INTO consents (kind, subject, question, requested_by, "
            "conversation_id, status) VALUES ('goal.activate', $1, "
            "'scoped to A', 'test', $2, 'pending') RETURNING id",
            f"probe-a-{convo_a}", uuid.UUID(convo_a))
        # A card raised by the system, belonging to no conversation — the
        # migration/scheduler/heartbeat shape.
        row_sys = await conn.fetchrow(
            "INSERT INTO consents (kind, subject, question, requested_by, "
            "conversation_id, status) VALUES ('goal.activate', $1, "
            "'raised by a migration', 'system', NULL, 'pending') RETURNING id",
            f"probe-sys-{convo_a}")
    made = [str(row_a["id"]), str(row_sys["id"])]

    try:
        ids_a = {c["id"] for c in await consents.list_pending(convo_a)}
        ids_b = {c["id"] for c in await consents.list_pending(convo_b)}
        ids_all = {c["id"] for c in await consents.list_pending()}

        print("\nthe card that was invisible")
        check("a system-raised card (no conversation) IS shown in a chat",
              made[1] in ids_a)
        check("...and in a DIFFERENT chat too — it is addressed to him, "
              "not to a conversation", made[1] in ids_b)
        check("...and still appears in the unfiltered listing",
              made[1] in ids_all)

        print("\nwithout leaking cards that really are scoped")
        check("a card scoped to conversation A shows in A", made[0] in ids_a)
        check("...and NOT in conversation B", made[0] not in ids_b)

        print("\nthe live row this was found on")
        async with db.acquire() as conn:
            live = await conn.fetchrow(
                "SELECT c.id, c.question FROM consents c "
                "WHERE c.status = 'pending' AND c.conversation_id IS NULL "
                "AND c.question LIKE '%self-improvement loop%'")
        if live:
            visible = {c["id"] for c in await consents.list_pending(convo_a)}
            check("migration 116's card is now reachable from a chat",
                  str(live["id"]) in visible,
                  str(live["question"])[:60])
        else:
            check("migration 116's card is already decided or absent — "
                  "nothing to check here", True)
    finally:
        async with db.acquire() as conn:
            # Address OUR OWN rows by id. A test that reaches into shared
            # state by kind/status once approved and deleted a real pending
            # proposal of Jeremy's while reporting PASS.
            await conn.execute(
                "DELETE FROM consents WHERE id = ANY($1::uuid[])",
                [uuid.UUID(i) for i in made])
            left = await conn.fetchval(
                "SELECT count(*) FROM consents WHERE id = ANY($1::uuid[])",
                [uuid.UUID(i) for i in made])
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
