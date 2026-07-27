"""/clear and the retrieval it must not break.

    docker compose exec backend python tests/test_context_clear.py

Two mechanisms that fail SILENTLY if they regress, which is why they are
pinned here rather than trusted.

1. THE WATERMARK. /clear resets the working context without deleting
   anything: messages stay for the turn ledger, the journal keeps every
   exchange. Three things have to move together — load_history must stop at
   the mark, the rolling summary must be dropped (it is merged from aged-out
   turns, so leaving it hands the cleared conversation back as a 300-word
   paraphrase), and compaction must not reach back across the mark and
   rebuild it.

2. THE SNIPPET WINDOW. Retrieval used to return the first N chars of a
   document. That is right for a short distilled note and wrong for
   everything else here: a journal is APPEND-ONLY, so its head is the
   morning's news digest and "what did we decide earlier" could never find
   the decision. Measured 2026-07-27: the index ranked the journal TOP for
   three different queries and the answer was still "no record of you
   telling me a favourite colour", because the match was 19 KB below the
   snippet. The same shape breaks the 51 KB video transcripts.
"""

import asyncio
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_clear_{uuid.uuid4().hex[:8]}"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/postgres"


def _test_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/" + DB_NAME


# ── 1. the snippet window (pure, no DB) ──────────────────────────────────

def test_window():
    from app.memory.memory import OkfMemory
    print("1. snippets centre on the match, not the head")

    head = "MORNING DIGEST. " + ("filler " * 400)
    body = head + "\nUser: my favourite colour is chartreuse\nNova: ok"

    got = OkfMemory._best_window(body, {"chartreuse", "colour"}, 300)
    check("an append-only journal surfaces the MATCH", "chartreuse" in got, got[-60:])
    check("...and marks itself an excerpt", got.startswith("… "), got[:20])

    got = OkfMemory._best_window(body, {"nonexistent", "absent"}, 300)
    check("no match anywhere falls back to the head",
          got.startswith("MORNING DIGEST"), got[:30])

    short = "a short note about lighthouses"
    check("a document shorter than the window is returned whole",
          OkfMemory._best_window(short, {"lighthouses"}, 300) == short)
    check("no query terms is not a crash",
          OkfMemory._best_window(body, set(), 300).startswith("MORNING"))


# ── 2. the watermark (throwaway DB) ──────────────────────────────────────

async def _make_db() -> None:
    """Create the throwaway and point DATABASE_URL at it BEFORE anything
    imports app.config. pydantic reads the environment once, at import — so
    setting it later silently leaves every query on the OPERATOR'S database.
    This test did exactly that on its first run and inserted five rows into
    the live conversation."""
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    await admin.close()
    os.environ["DATABASE_URL"] = _test_url()


async def _drop_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
    await admin.close()


async def test_watermark() -> None:
    if True:
        from app import conversations, db, settings_store
        await db.init_pool()
        await db.run_migrations()
        await settings_store.warm()

        conv = await conversations.get_or_create_active_conversation()
        cid = conv["id"]
        async with db.acquire() as conn:
            for i in range(4):
                await conn.execute(
                    "INSERT INTO messages (conversation_id, role, content) "
                    "VALUES ($1, $2, $3)", uuid.UUID(cid),
                    "user" if i % 2 == 0 else "assistant", f"before-{i}")
            await conn.execute(
                "UPDATE conversations SET summary = 'stale summary', "
                "summary_upto = now() WHERE id = $1", uuid.UUID(cid))

        print("2. the watermark")
        before = await conversations.load_history(cid, roles=("user", "assistant"))
        check("history is visible before the clear", len(before) == 4, str(len(before)))

        result = await conversations.clear_context(cid)
        check("clear reports success", result["cleared"] is True, str(result))
        check("...and says nothing was deleted",
              result["messages_kept"] == 4, str(result))

        after = await conversations.load_history(cid, roles=("user", "assistant"))
        check("history is empty after the clear", after == [], str(len(after)))

        async with db.acquire() as conn:
            still = await conn.fetchval(
                "SELECT count(*) FROM messages WHERE conversation_id = $1",
                uuid.UUID(cid))
            row = await conn.fetchrow(
                "SELECT summary, summary_upto, cleared_at FROM conversations "
                "WHERE id = $1", uuid.UUID(cid))
        check("the rows are STILL THERE — nothing was destroyed", still == 4, str(still))
        check("the stale summary is dropped", row["summary"] is None, str(row["summary"]))
        check("summary_upto is pinned, not nulled — a null would let "
              "compaction re-summarise from epoch and undo the clear",
              row["summary_upto"] is not None)
        check("the watermark is set", row["cleared_at"] is not None)

        # a turn AFTER the clear must be visible again
        async with db.acquire() as conn:
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content) "
                "VALUES ($1, 'user', 'after-the-clear')", uuid.UUID(cid))
        fresh = await conversations.load_history(cid, roles=("user", "assistant"))
        check("new turns after the clear are visible",
              [m["content"] for m in fresh] == ["after-the-clear"], str(fresh))

        # and the active-conversation read must carry the mark, or callers
        # downstream would act as though nothing had been cleared
        active = await conversations.get_or_create_active_conversation()
        check("the active conversation reports its watermark",
              active.get("cleared_at") is not None, str(active.get("cleared_at")))
        check("...and its summary is gone", active.get("summary") is None)

        await db.close_pool()


# ── 3. the command registry ──────────────────────────────────────────────

def test_registry():
    from app import commands
    print("3. the command parser")
    cmd, arg = commands.parse("/clear")
    check("/clear resolves", cmd is not None and cmd.name == "clear")
    cmd, arg = commands.parse("  /help  ")
    check("surrounding whitespace is tolerated", cmd is not None and cmd.name == "help")
    cmd, arg = commands.parse("/clear everything")
    check("an argument is split off", cmd is not None and arg == "everything")
    # the guard that keeps this from being infuriating
    cmd, _ = commands.parse("/home/jeremy/workspace/nova is the path")
    check("a PATH is not a command", cmd is None)
    cmd, _ = commands.parse("/notacommand")
    check("an unknown slash falls through to the model", cmd is None)
    cmd, _ = commands.parse("what is /clear for?")
    check("a slash mid-sentence is not a command", cmd is None)
    check("the catalog is populated for the palette",
          len(commands.catalog()) >= 2, str(commands.catalog()))


def main() -> int:
    # DB first, and the throwaway created before any app import — see _make_db
    asyncio.run(_make_db())
    try:
        test_window()
        test_registry()
        asyncio.run(test_watermark())
    finally:
        asyncio.run(_drop_db())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
