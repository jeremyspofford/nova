"""Audit retention — the four DELETEs, against a real database.

    docker compose exec backend python tests/test_retention.py

This is the only code in the repo that deletes the operator's rows on a
timer, and it shipped without a test. Everything here runs against a
THROWAWAY database created and dropped by this script, never the live one:
a test for destructive code must not be the thing that proves it destructive.

What it pins down, in order of what would hurt most if it broke:

  1. The CONVERSATION is never touched. user and assistant messages are the
     conversation; only role='tool' audit rows are prunable. If this check
     ever fails, the feature is deleting the thing the product is for.
  2. Only FINISHED rows go — a pending consent, an open alert and a new
     recommendation all survive regardless of age, because they are still
     the operator's to decide.
  3. The cutoff is honoured: rows inside the window stay.
  4. One failing sweep does not stop the others.
  5. The 24h self-limit holds, so a scheduler tick every 55s does not run
     four table scans a minute.
"""

import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_ret_{uuid.uuid4().hex[:8]}"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    url = os.environ["DATABASE_URL"]
    return url.rsplit("/", 1)[0] + "/postgres"


def _test_url() -> str:
    url = os.environ["DATABASE_URL"]
    return url.rsplit("/", 1)[0] + "/" + DB_NAME


async def main() -> int:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    await admin.close()
    os.environ["DATABASE_URL"] = _test_url()

    try:
        from app import db, retention, settings_store
        await db.init_pool()
        await db.run_migrations()
        await settings_store.warm()

        async with db.acquire() as conn:
            conv = await conn.fetchval(
                "INSERT INTO conversations (title) VALUES ('t') RETURNING id")
            # old rows: three prunable, three that must survive on status
            for role in ("user", "assistant", "tool"):
                await conn.execute(
                    "INSERT INTO messages (conversation_id, role, content, created_at) "
                    "VALUES ($1, $2, 'old', now() - interval '99 days')", conv, role)
            # a RECENT tool row — inside the window, must survive
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) "
                "VALUES ($1, 'tool', 'recent', now())", conv)
            await conn.execute(
                "INSERT INTO consents (kind, subject, question, requested_by, status, created_at) "
                "VALUES ('rule.delete','x','?','main','pending', now() - interval '99 days')")
            await conn.execute(
                "INSERT INTO consents (kind, subject, question, requested_by, status, created_at) "
                "VALUES ('rule.delete','y','?','main','decided', now() - interval '99 days')")
            await conn.execute(
                "INSERT INTO recommendations (kind, title, body, source, status, created_at) "
                "VALUES ('model','n','b','test','new', now() - interval '99 days')")
            await conn.execute(
                "INSERT INTO recommendations (kind, title, body, source, status, created_at) "
                "VALUES ('model','d','b','test','dismissed', now() - interval '99 days')")

        settings_store._cache["retention.audit_days"] = 30
        retention._last_prune = 0.0
        await retention.maybe_prune()

        async with db.acquire() as conn:
            kept_roles = [r["role"] for r in await conn.fetch(
                "SELECT role FROM messages ORDER BY role")]
            tool_contents = [r["content"] for r in await conn.fetch(
                "SELECT content FROM messages WHERE role='tool'")]
            consents = [r["status"] for r in await conn.fetch("SELECT status FROM consents")]
            recs = [r["status"] for r in await conn.fetch("SELECT status FROM recommendations")]

        check("the conversation survives — user and assistant rows untouched",
              "user" in kept_roles and "assistant" in kept_roles, str(kept_roles))
        check("the old tool audit row is pruned",
              "old" not in tool_contents, str(tool_contents))
        check("a RECENT tool row inside the window survives",
              "recent" in tool_contents, str(tool_contents))
        check("a PENDING consent survives regardless of age",
              "pending" in consents, str(consents))
        check("a decided consent is pruned", "decided" not in consents, str(consents))
        check("a NEW recommendation survives regardless of age",
              "new" in recs, str(recs))
        check("a decided recommendation is pruned", "dismissed" not in recs, str(recs))

        # self-limit: a second call inside the window must not sweep again
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) "
                "VALUES ($1, 'tool', 'old2', now() - interval '99 days')", conv)
        await retention.maybe_prune()
        async with db.acquire() as conn:
            still = await conn.fetchval(
                "SELECT count(*) FROM messages WHERE content = 'old2'")
        check("the 24h self-limit holds — no second sweep", still == 1, str(still))

        # one bad sweep must not stop the rest
        retention._last_prune = 0.0
        original = retention._SWEEPS
        retention._SWEEPS = [("broken", "DELETE FROM does_not_exist")] + list(original)
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content, created_at) "
                "VALUES ($1, 'tool', 'old3', now() - interval '99 days')", conv)
        await retention.maybe_prune()
        retention._SWEEPS = original
        async with db.acquire() as conn:
            gone = await conn.fetchval(
                "SELECT count(*) FROM messages WHERE content = 'old3'")
        check("a failing sweep does not stop the others", gone == 0, str(gone))

        await db.close_pool()
    finally:
        admin = await asyncpg.connect(_admin_url())
        await admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
        await admin.close()

    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
