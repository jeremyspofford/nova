"""The backup interval must survive a restart, and a repeat refusal must be quiet.

    docker compose exec backend python tests/test_backup_attempts.py

`scheduler._last_backup` was a module global, so "every 24 hours" measured
UPTIME. Every backend restart reset it to 0, the next tick attempted a
backup, and a standing refusal notified again. Measured over 24h on
2026-08-04: 76 backend starts, 29 refusal notifications, every one naming the
same unclassified file.

Two properties fix that, and both are here: the interval is read from the
attempt history (migration 089), and a refusal that says what the last one
said is recorded but not announced.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import backup_service, db                              # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def main() -> int:
    await db.init_pool()
    # work on a private copy of the table, so a real backup history is never
    # disturbed by a test that is about bookkeeping
    async with db.acquire() as conn:
        await conn.execute("CREATE TEMP TABLE _saved AS SELECT * FROM backup_attempts")
        await conn.execute("DELETE FROM backup_attempts")
    try:
        print("1. nothing recorded means a backup is due")
        check("no history reads as due, rather than as recently done",
              await backup_service.last_attempt() is None)

        print("\n2. a refusal is news ONCE")
        check("the first refusal is news", await backup_service.record_attempt(
            "refused", reason="[R5] frontend/vite.config.d.ts"))
        check("...the same refusal again is NOT — this is the storm",
              not await backup_service.record_attempt(
                  "refused", reason="[R5] frontend/vite.config.d.ts"))
        check("...but a DIFFERENT reason is news again, or the next real "
              "problem would be swallowed by the last one",
              await backup_service.record_attempt(
                  "refused", reason="[R5] some/other/path"))
        check("...and recovering is news too",
              await backup_service.record_attempt("ok", bundle="/x/b.tar.gz"))

        print("\n3. the interval is read from the history, not from uptime")
        last = await backup_service.last_attempt()
        check("the newest attempt is what comes back", last["outcome"] == "ok",
              str(last["outcome"]))
        check("...with its bundle, so a success is traceable to a file",
              last["bundle"] == "/x/b.tar.gz", str(last["bundle"]))
        check("every attempt is kept, not just the last — a refusal that "
              "repeated for a day is legible afterwards",
              await _count() == 4, str(await _count()))

        print("\n4. bookkeeping failure cannot CAUSE a storm")
        # record_attempt returns False when it cannot write, so the caller
        # stays quiet rather than notifying on every tick about a DB problem
        real = db.acquire

        class Boom:
            async def __aenter__(self): raise RuntimeError("db down")
            async def __aexit__(self, *a): return False

        db.acquire = lambda: Boom()
        try:
            check("a write that fails reports NOT-news, so nothing notifies",
                  not await backup_service.record_attempt("refused", reason="z"))
        finally:
            db.acquire = real

        print("\n5. a manual 'Back up now' is a recorded attempt")
        # POST /api/v1/backups used to call snapshot() and write NOTHING, so
        # after a manual backup freshness() — and the FACTS line built from
        # it — kept reporting whatever the last scheduled attempt said.
        from app import backup_snapshot, bg, router_chat
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM backup_attempts")
        real_snapshot = backup_service.snapshot
        real_spawn = bg.spawn

        async def fake_snapshot():
            return {"path": "/x/manual.tar.gz", "bytes": 1}

        backup_service.snapshot = fake_snapshot
        # swallow the offsite-sync coroutine: this test is about bookkeeping,
        # not about copying a bundle off-machine
        bg.spawn = lambda coro, *, name=None: coro.close()
        try:
            await router_chat.create_backup()
            last = await backup_service.last_attempt()
            check("a manual success lands as the scheduler's own ok shape",
                  bool(last) and last["outcome"] == "ok"
                  and last["bundle"] == "/x/manual.tar.gz", str(last))

            async def refusing_snapshot():
                raise backup_snapshot.SnapshotRefused("[R5] some/path")

            backup_service.snapshot = refusing_snapshot
            raised = None
            try:
                await router_chat.create_backup()
            except Exception as e:  # noqa: BLE001
                raised = e
            check("a refusal still reaches the operator as a 409",
                  getattr(raised, "status_code", None) == 409, repr(raised))
            last = await backup_service.last_attempt()
            check("...and is on the record with its reason, so the next "
                  "identical scheduled refusal dedupes against it",
                  bool(last) and last["outcome"] == "refused"
                  and last["reason"] == "[R5] some/path", str(last))

            async def crashing_snapshot():
                raise RuntimeError("disk on fire")

            backup_service.snapshot = crashing_snapshot
            raised = None
            try:
                await router_chat.create_backup()
            except RuntimeError as e:
                raised = e
            check("a crash still raises — the 500 stands",
                  raised is not None, repr(raised))
            last = await backup_service.last_attempt()
            check("...and is on the record as an error",
                  bool(last) and last["outcome"] == "error"
                  and last["reason"] == "disk on fire", str(last))
        finally:
            backup_service.snapshot = real_snapshot
            bg.spawn = real_spawn
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM backup_attempts")
            await conn.execute("INSERT INTO backup_attempts SELECT * FROM _saved")

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


async def _count() -> int:
    async with db.acquire() as conn:
        return await conn.fetchval("SELECT count(*) FROM backup_attempts")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
