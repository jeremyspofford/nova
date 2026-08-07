"""The weekly restore drill is a fact machine, not a request (roadmap #31c).

    docker compose exec backend python tests/test_backup_drill.py

Three properties, each the kind that fails silently if nothing pins it:

  * A `handler` row is MECHANICAL. run_one executes registered code and the
    agent path is never consulted — an unknown handler is a loud failure,
    never a fall-through to "hand the instruction to a model as a prompt",
    because that fall-through would run the exact theatre this column
    exists to prevent, on the exact night nobody is watching.
  * Every handler the DATABASE names is registered in this build. Derived
    from the live automations table, not from a list in this file, so a
    future migration seeding a handler nobody wired goes red here.
  * The drill tells the truth about bad news: no bundles is a FAILED drill,
    a bundle that restores but fails the migration gate is a FAILED drill.

Plus the seam checks: the passphrase-source setting's options are derived
from backup_passphrase.SOURCES, so they cannot drift apart quietly.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import backup_passphrase, backup_service, settings_store  # noqa: E402
from app import db, scheduler                                       # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Explode:
    """A stand-in that fails the test if the agent path is ever touched."""
    def __getattr__(self, name):
        raise AssertionError(f"agent path consulted ({name}) for a "
                             f"mechanical automation")


async def main() -> int:                                     # noqa: PLR0915
    print("1. a handler row runs code; the agent path is never consulted")
    ran = []

    async def stub_handler(a):
        ran.append(a["name"])
        return True, "stub did the thing"

    real_registry = scheduler.agent_registry
    scheduler.agent_registry = Explode()
    scheduler.MECHANICAL_HANDLERS["_test_stub"] = stub_handler
    try:
        ok, summary = await scheduler.run_one(
            {"name": "t", "handler": "_test_stub", "agent_name": "main",
             "timeout_seconds": 60})
        check("the registered handler ran", ok and ran == ["t"], summary)

        ok, summary = await scheduler.run_one(
            {"name": "t2", "handler": "_no_such_handler",
             "agent_name": "main", "timeout_seconds": 60})
        check("an unknown handler FAILS rather than reaching an agent",
              not ok and "not registered" in summary, summary)

        async def crasher(a):
            raise RuntimeError("boom")
        scheduler.MECHANICAL_HANDLERS["_test_crash"] = crasher
        ok, summary = await scheduler.run_one(
            {"name": "t3", "handler": "_test_crash", "agent_name": "main",
             "timeout_seconds": 60})
        check("a crashed handler is a FAILED run with the reason",
              not ok and "boom" in summary, summary)

        async def sleeper(a):
            await asyncio.sleep(5)
            return True, "never"
        scheduler.MECHANICAL_HANDLERS["_test_sleep"] = sleeper
        ok, summary = await scheduler.run_one(
            {"name": "t4", "handler": "_test_sleep", "agent_name": "main",
             "timeout_seconds": 0.2})
        check("a hung handler times out as a FAILED run",
              not ok and "timed out" in summary, summary)
    finally:
        scheduler.agent_registry = real_registry
        for k in ("_test_stub", "_test_crash", "_test_sleep"):
            scheduler.MECHANICAL_HANDLERS.pop(k, None)

    print("\n2. the drill tells the truth")
    real_bundles = backup_service.bundles
    real_verify = backup_service.verify_restore
    real_enc_state = backup_service.encryption_state
    real_sweep = backup_service.sweep_scratch_databases
    real_offsite2 = backup_service.offsite_state
    try:
        backup_service.sweep_scratch_databases = lambda: 0
        # a healthy offsite baseline, so section 2 tests ITS concerns and
        # the offsite notes are exercised on their own in section 2b
        backup_service.offsite_state = lambda: {
            "configured": True, "dir": "/offsite", "ok": True, "bundles": 3,
            "newest_synced": True, "problem": ""}

        async def enc_confirmed():
            return {"state": "confirmed", "fingerprint": "aaaabbbbcccc"}
        backup_service.encryption_state = enc_confirmed

        backup_service.bundles = lambda: []
        ok, summary = await backup_service.drill({})
        check("no bundles at all is a FAILED drill",
              not ok and "no bundles" in summary, summary)

        newest = {"path": "/b/nova-backup-20260807T030000Z.tar",
                  "created_at": "20260807T030000Z", "encrypted": True,
                  "passphrase_fingerprint": "aaaabbbbcccc"}
        backup_service.bundles = lambda: [newest]

        async def good(name):
            return {"restored_ok": True, "tables": 34, "rows": 15704,
                    "encrypted": True, "migrations_ok": True}
        backup_service.verify_restore = good
        ok, summary = await backup_service.drill({})
        check("a green drill reports counts, encryption and the drop",
              ok and "34 tables" in summary and "15704" in summary
              and "encrypted" in summary, summary)
        check("nothing to caution about when fingerprints match and the "
              "passphrase is confirmed",
              "CAUTION" not in summary and "NOTE" not in summary, summary)

        old = {"path": "/b/nova-backup-20260701T030000Z.tar",
               "created_at": "20260701T030000Z", "encrypted": True,
               "passphrase_fingerprint": "000011112222"}
        backup_service.bundles = lambda: [newest, old]
        ok, summary = await backup_service.drill({})
        check("a rotated passphrase cannot orphan older bundles silently — "
              "the green drill says so",
              ok and "CAUTION" in summary and "DIFFERENT passphrase" in summary,
              summary)

        async def enc_unconfirmed():
            return {"state": "unconfirmed", "fingerprint": "aaaabbbbcccc"}
        backup_service.encryption_state = enc_unconfirmed
        backup_service.bundles = lambda: [newest]
        ok, summary = await backup_service.drill({})
        check("a green drill still says the passphrase is not recorded "
              "off-machine — green is not disaster recovery until it is",
              ok and "not yet confirmed" in summary, summary)
        backup_service.encryption_state = enc_confirmed

        async def gated(name):
            return {"restored_ok": False, "migrations_ok": False,
                    "migration_refusal": "made by a NEWER version"}
        backup_service.verify_restore = gated
        ok, summary = await backup_service.drill({})
        check("restores-but-migration-gate-refuses is a FAILED drill",
              not ok and "NEWER version" in summary, summary)

        from app.backup_restore import RestoreRefused

        async def refused(name):
            raise RestoreRefused("wrong passphrase, or the file is corrupt")
        backup_service.verify_restore = refused
        ok, summary = await backup_service.drill({})
        check("a refusal (e.g. bad passphrase) is a FAILED drill with why",
              not ok and "passphrase" in summary, summary)
    finally:
        backup_service.bundles = real_bundles
        backup_service.verify_restore = real_verify
        backup_service.encryption_state = real_enc_state
        backup_service.sweep_scratch_databases = real_sweep
        backup_service.offsite_state = real_offsite2

    print("\n2b. the drill carries the off-machine gap in the weekly push")
    real_offsite = backup_service.offsite_state
    backup_service.bundles = real_bundles
    backup_service.verify_restore = real_verify
    try:
        backup_service.sweep_scratch_databases = lambda: 0
        backup_service.encryption_state = enc_confirmed
        newest = {"path": "/b/nova-backup-20260807T030000Z.tar",
                  "created_at": "20260807T030000Z", "encrypted": True,
                  "passphrase_fingerprint": "aaaabbbbcccc"}
        backup_service.bundles = lambda: [newest]

        async def good(name):
            return {"restored_ok": True, "tables": 34, "rows": 15704,
                    "encrypted": True, "migrations_ok": True}
        backup_service.verify_restore = good

        backup_service.offsite_state = lambda: {
            "configured": False, "dir": "", "ok": False, "bundles": 0,
            "newest_synced": None, "problem": ""}
        ok, summary = await backup_service.drill({})
        check("unconfigured offsite is SAID in the green summary",
              ok and "no off-machine bundle folder" in summary, summary)

        backup_service.offsite_state = lambda: {
            "configured": True, "dir": "/offsite", "ok": True, "bundles": 3,
            "newest_synced": False, "problem": ""}
        ok, summary = await backup_service.drill({})
        check("a stale offsite is a CAUTION",
              ok and "NOT reached the off-machine folder" in summary, summary)

        backup_service.offsite_state = lambda: {
            "configured": True, "dir": "/offsite", "ok": False, "bundles": 0,
            "newest_synced": False, "problem": "not mounted"}
        ok, summary = await backup_service.drill({})
        check("a broken offsite mount is a CAUTION with the reason",
              ok and "off-machine folder is broken" in summary, summary)

        backup_service.offsite_state = lambda: {
            "configured": True, "dir": "/offsite", "ok": True, "bundles": 3,
            "newest_synced": True, "problem": ""}
        ok, summary = await backup_service.drill({})
        check("a healthy offsite adds no noise",
              ok and "off-machine" not in summary, summary)
    finally:
        backup_service.bundles = real_bundles
        backup_service.verify_restore = real_verify
        backup_service.encryption_state = real_enc_state
        backup_service.sweep_scratch_databases = real_sweep
        backup_service.offsite_state = real_offsite

    print("\n2c. offsite_sync copies, verifies, prunes — and never raises")
    import tempfile
    from pathlib import Path as _P
    from app import settings_store as _ss
    tmp = _P(tempfile.mkdtemp(prefix="nova-offsite-test-"))
    local, offsite = tmp / "local", tmp / "offsite"
    local.mkdir(); offsite.mkdir()
    for i, name in enumerate(["nova-backup-20260801T000000Z.tar",
                              "nova-backup-20260802T000000Z.tar"]):
        (local / name).write_bytes(b"bundle-bytes-%d" % i * 100)
    fake_settings = {"backups.offsite_dir": str(offsite), "backups.keep": 2}
    orig_get = _ss.get
    _ss.get = lambda k: fake_settings.get(k, orig_get(k))
    backup_service.bundles = lambda: [
        {"path": str(local / "nova-backup-20260802T000000Z.tar")},
        {"path": str(local / "nova-backup-20260801T000000Z.tar")}]
    try:
        r = backup_service.offsite_sync()
        check("both missing bundles were copied and re-hashed",
              sorted(r["copied"]) == ["nova-backup-20260801T000000Z.tar",
                                      "nova-backup-20260802T000000Z.tar"]
              and not r["errors"], str(r))
        fake_settings["backups.keep"] = 1
        r = backup_service.offsite_sync()
        check("a tightened keep prunes offsite to 1, newest kept — and "
              "copies nothing doomed",
              r["pruned"] == 1 and r["copied"] == []
              and (offsite / "nova-backup-20260802T000000Z.tar").exists()
              and not (offsite / "nova-backup-20260801T000000Z.tar").exists(),
              str(r))
        check("a further pass copies nothing (idempotent — never re-copy "
              "what retention just removed)",
              backup_service.offsite_sync()["copied"] == [])
        st = backup_service.offsite_state()
        check("offsite_state sees the newest bundle synced",
              st["configured"] and st["ok"] and st["newest_synced"] is True,
              str(st))
        fake_settings["backups.offsite_dir"] = str(tmp / "no-such-dir")
        r = backup_service.offsite_sync()
        check("a missing mount is an ERROR in the result, not an exception",
              r["errors"] and "not a writable directory" in r["errors"][0])
        check("...and offsite_state stands the problem",
              not backup_service.offsite_state()["ok"])
        fake_settings["backups.offsite_dir"] = ""
        check("unconfigured is a clean no-op",
              backup_service.offsite_sync() == {"configured": False,
                                                "copied": [], "pruned": 0,
                                                "errors": []})
    finally:
        _ss.get = orig_get
        backup_service.bundles = real_bundles

    print("\n2d. the standing drill verdict, every state")
    from datetime import datetime, timedelta, timezone as _tz
    v = backup_service._drill_verdict
    check("no row: says no bundle is ever proven restorable",
          "proven restorable" in v(None), v(None))
    check("auto-disabled after 5: named as such",
          "DISABLED (after 5 straight failures)" in
          v({"enabled": False, "consecutive_failures": 5}))
    check("operator-disabled: 'switched off'",
          "switched off" in v({"enabled": False, "consecutive_failures": 0}))
    check("last run failed: said plainly",
          "FAILED" in v({"enabled": True, "last_status": "failed"}))
    check("never ran, overdue: overdue hours named",
          "never run" in v({"enabled": True, "last_status": None,
                            "last_run_at": None,
                            "next_run_at": datetime.now(_tz.utc)
                            - timedelta(hours=30)}))
    check("healthy: silent",
          v({"enabled": True, "last_status": "ok",
             "last_run_at": datetime.now(_tz.utc)}) == "")

    print("\n2e. the offsite mount is excluded from coverage by DERIVATION")
    from app import backup_coverage as bc
    # the entry is named by its HOST source; the setting names the CONTAINER
    # path — the exclusion must connect them through mounted_at, because
    # that is exactly what a real NAS mount looks like in the inventory
    rep = bc.report(
        [{"kind": "bind", "name": "/mnt/nas/nova", "source": "compose-file",
          "service": "backend", "mounted_at": "/offsite"}],
        git_status=lambda p: "unknown", project_dir="/repo",
        offsite_dir="/offsite")
    off_entries = [e for e in rep["entries"] if e["name"] == "/mnt/nas/nova"]
    check("a mount whose container path is backups.offsite_dir is excluded "
          "with the nesting reason",
          off_entries and not off_entries[0]["included"]
          and "OFF-MACHINE" in off_entries[0]["reason"],
          str(off_entries and (off_entries[0]["disposition"],
                               off_entries[0]["reason"][:40])))
    check("...and the out-of-project refusal is ANSWERED by the setting, "
          "so mounting a NAS does not block every backup",
          rep["may_snapshot"], str(rep["refusals"]))
    rep_unset = bc.report(
        [{"kind": "bind", "name": "/mnt/nas/nova", "source": "compose-file",
          "service": "backend", "mounted_at": "/offsite"}],
        git_status=lambda p: "unknown", project_dir="/repo")
    check("without the setting, the same mount still refuses loudly — the "
          "exclusion is DERIVED from live config, not a standing pass",
          not rep_unset["may_snapshot"])

    print("\n3. the passphrase seam cannot drift from its setting")
    d = settings_store._DEFS["backups.passphrase_source"]
    check("the setting's options ARE the registered sources",
          d["options"] == sorted(backup_passphrase.SOURCES),
          f"{d['options']} vs {sorted(backup_passphrase.SOURCES)}")
    check("the default source exists",
          d["default"] in backup_passphrase.SOURCES)
    check("complete bundles are the default now (decision a)",
          settings_store._DEFS["backups.include_secrets"]["default"] is True)

    print("\n4. orphaned scratch databases are swept, surgically")
    await db.init_pool()
    from app.backup_restore import _psql
    admin = backup_service.dsn("postgres")
    orphan, imposter = "nova_verify_deadbeef", "nova_verify_notascratch"
    for name in (orphan, imposter):
        _psql(admin, f'DROP DATABASE IF EXISTS "{name}"')
        _psql(admin, f'CREATE DATABASE "{name}"')
    try:
        swept = backup_service.sweep_scratch_databases()
        left = _psql(admin, "SELECT datname FROM pg_database "
                            "WHERE datname LIKE 'nova_verify_%'")
        check("an orphaned nova_verify_<8hex> is dropped",
              swept >= 1 and orphan not in left, f"swept={swept} left={left!r}")
        check("a name outside SCRATCH_RE survives the sweep, prefix or not "
              "— the shape is the contract",
              imposter in left, left)
    finally:
        for name in (orphan, imposter):
            _psql(admin, f'DROP DATABASE IF EXISTS "{name}"')

    print("\n5. every handler the database names is code this build has")
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name, handler, notify, schedule FROM automations "
            " WHERE handler IS NOT NULL")
    unknown = [r["handler"] for r in rows
               if r["handler"] not in scheduler.MECHANICAL_HANDLERS]
    check("no seeded handler is unregistered (derived from the live table)",
          not unknown, str(unknown))
    drill_rows = [r for r in rows if r["name"] == "weekly-restore-drill"]
    check("the weekly drill row exists (migration 112)", bool(drill_rows))
    if drill_rows:
        r = drill_rows[0]
        check("the drill notifies — a failed drill must reach the operator",
              bool(r["notify"]))
        check("the drill runs the registered restore_drill handler",
              r["handler"] == "restore_drill")
        import json as _json
        spec = r["schedule"]
        spec = _json.loads(spec) if isinstance(spec, str) else spec
        check("the drill is a REAL weekly schedule that names a day",
              spec and spec.get("every") == "week" and spec.get("on"),
              str(spec))

    print("\n6. the passphrase source never rotates over an unreadable row")
    # The near-miss this pins: _local() once caught SecretError wholesale, so
    # "could not decrypt" (a changed master key) fell through to the same
    # generate-and-put as "no such secret" — and put() upserts. Every bundle
    # would have gone quietly unrestorable while backups stayed green.
    from app import capability_events as ce, secret_store
    real_secret_name = backup_passphrase.SECRET_NAME
    real_ce_record = ce.record
    test_secret = "test-backup-passphrase"
    backup_passphrase.SECRET_NAME = test_secret
    ce.record = lambda *a, **k: None    # no audit rows for a test secret
    try:
        await secret_store.delete(test_secret)
        try:
            await secret_store.reveal(test_secret)
            check("an absent row raises SecretMissing, the definitive kind",
                  False, "revealed a deleted secret")
        except secret_store.SecretMissing:
            check("an absent row raises SecretMissing, the definitive kind",
                  True)

        p1 = await backup_passphrase._local()
        check("absent -> generated and stored (first use still works)",
              len(p1) == 39 and await secret_store.reveal(test_secret) == p1)
        check("a second call re-reads, never re-generates",
              await backup_passphrase._local() == p1)

        # simulate the changed master key: the row stays, its bytes no
        # longer authenticate — exactly what _decrypt sees after a key swap
        import secrets as _sec
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE secrets SET value_enc = $2 WHERE name = $1",
                test_secret, _sec.token_bytes(48))
            before = await conn.fetchval(
                "SELECT value_enc FROM secrets WHERE name = $1", test_secret)
        try:
            await backup_passphrase._local()
            check("present-but-undecryptable is a LOUD refusal", False,
                  "returned a passphrase from an unreadable row")
        except backup_passphrase.PassphraseUnavailable as e:
            check("present-but-undecryptable is a LOUD refusal",
                  "cannot be read" in str(e) and "master key" in str(e),
                  str(e)[:120])
        async with db.acquire() as conn:
            after = await conn.fetchval(
                "SELECT value_enc FROM secrets WHERE name = $1", test_secret)
        check("the unreadable row was NOT overwritten — no silent rotation",
              after == before)
    finally:
        backup_passphrase.SECRET_NAME = real_secret_name
        ce.record = real_ce_record
        await secret_store.delete(test_secret)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
