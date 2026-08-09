"""Every settings write leaves a row — who, which key, old and new.

    docker compose exec backend python tests/test_settings_audit.py

THE INCIDENT (2026-08-08/09): the `backups.every_hours` row VANISHED from the
settings table, nightly backups went silently off, and nothing recorded who
or what removed it — it was found only because the heartbeat complained about
stale backups. capability_events already records config changes for agents,
models and automations; raw settings writes were the one config channel with
no trail. What is pinned here:

1. The operator PATCH route attributes its writes to "operator" and the row
   carries the old and new values — the exact record the incident lacked.
2. A clear (the incident's own operation: the override row deleted, the
   default silently back in force) is recorded, not just sets.
3. SECRETS STAY SECRET. A key whose def says `secret: True`, a key whose name
   is credential-shaped (redact.SECRET_KEY, dots normalised), and a VALUE that
   is credential-shaped (an sk- token in an innocent field) are all masked —
   derived from redact.py's machinery, never a fresh keyword list.
4. ACTOR IS A FACT, NOT A DEFAULT. An internal write that names nobody is
   recorded as "backend (unattributed)" — visible gap, never mislabeled as
   the operator. capability_events.record's own `or "operator"` fallback must
   not be reachable from here.
5. A test process against the live DB writes NO audit rows (the
   notifications.test_context guard) — a suite's settings churn is not the
   operator's config history.
6. The /activity surface renders the new kind with a readable title.

Everything here runs against a THROWAWAY database, repointed BEFORE the first
app import (pydantic reads the environment once) — which is also what frees
the positive-path writes from the very guard section 5 pins: this process's
settings disagree with PID 1's, so test_context() is None until we make the
DB look live on purpose.
"""

import asyncio
import json
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_setaudit_{uuid.uuid4().hex[:8]}"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/postgres"


async def _make_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'CREATE DATABASE "{DB_NAME}"')
    await admin.close()
    os.environ["DATABASE_URL"] = (
        os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/" + DB_NAME)


async def _drop_db() -> None:
    import asyncpg
    admin = await asyncpg.connect(_admin_url())
    await admin.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
    await admin.close()


async def _settle():
    """record() is fire-and-forget; let the spawned writes land."""
    for _ in range(40):
        await asyncio.sleep(0.05)


async def run() -> None:
    from app import capability_events as ce
    from app import db, notifications, settings_store
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()

    print("0. this throwaway DB frees the writes from the live-DB guard")
    check("test_context is None against a scratch database",
          notifications.test_context() is None,
          str(notifications.test_context()))

    print("1. the operator PATCH route leaves an operator-attributed row")
    from app import router_chat
    await router_chat.patch_settings({"backups.every_hours": 30})
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("kind is the settings vocabulary",
          ev["kind"] == ce.SETTING, ev["kind"])
    check("subject is the key",
          ev["subject"] == "backups.every_hours", ev["subject"])
    check("action is 'set'", ev["action"] == "set", ev["action"])
    check("the route's writes are the operator's",
          ev["actor"] == "operator", ev["actor"])
    check("old value recorded", ev["detail"].get("old") == 24,
          str(ev["detail"]))
    check("new value recorded", ev["detail"].get("new") == 30,
          str(ev["detail"]))

    print("2. a clear — the incident's own operation — is recorded")
    await settings_store.clear_value("backups.every_hours", actor="operator")
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("action is 'cleared'",
          (ev["subject"], ev["action"]) == ("backups.every_hours", "cleared"),
          str((ev["subject"], ev["action"])))
    check("the value it held is in the row", ev["detail"].get("old") == 30,
          str(ev["detail"]))
    check("...and the default it reverted to", ev["detail"].get("new") == 24,
          str(ev["detail"]))
    async with db.acquire() as conn:
        n = await conn.fetchval(
            "SELECT count(*) FROM settings WHERE key = 'backups.every_hours'")
    check("the override row is actually gone", n == 0, str(n))
    check("the default is live again",
          settings_store.get("backups.every_hours") == 24)
    try:
        await settings_store.clear_value("no.such.key")
        check("clearing an unknown key is refused", False, "it was accepted")
    except KeyError:
        check("clearing an unknown key is refused", True)

    print("3. secrets stay secret — masked by redact's machinery")
    # (a) the def's own machine-readable flag: notify.ntfy.topic, secret: True
    await settings_store.set_value("notify.ntfy.topic",
                                   "hunter2-long-topic-name", actor="operator")
    # (b) a credential-shaped KEY name: notify.webhook.url — a Slack webhook's
    # PATH is the password, and redact.SECRET_KEY says webhook[_-]?url; the
    # settings namespace spells it with a dot, which must not defeat the rule.
    await settings_store.set_value(
        "notify.webhook.url",
        "https://hooks.slack.com/services/T000/B000/hookpassword",
        actor="operator")
    # (c) a credential-shaped VALUE in an innocently-named field
    await settings_store.set_value("nova.user_name",
                                   "sk-abcdefghijklmnopqrstuvwx",
                                   actor="operator")
    await _settle()
    events = {e["subject"]: e for e in await ce.recent(limit=6)}
    from app import redact
    for key, leak in (("notify.ntfy.topic", "hunter2"),
                      ("notify.webhook.url", "hookpassword"),
                      ("nova.user_name", "sk-abcdef")):
        ev = events.get(key)
        blob = json.dumps(ev["detail"] if ev else {})
        check(f"{key}: the row exists", ev is not None)
        check(f"{key}: new value is masked",
              ev is not None and ev["detail"].get("new") == redact.MASK,
              blob)
        check(f"{key}: the secret appears nowhere in the detail",
              leak not in blob, blob)
    check("the empty old value stays empty — 'was unset' is structure, "
          "not a secret",
          events["notify.ntfy.topic"]["detail"].get("old") == "",
          str(events["notify.ntfy.topic"]["detail"]))
    # an ordinary value is NOT masked — a scrubber that cries wolf gets
    # turned off (redact.py's own words)
    ordinary = events.get("backups.every_hours")  # from section 1/2 above
    check("an ordinary numeric value is recorded in the clear",
          ordinary is None or redact.MASK not in json.dumps(ordinary["detail"]))
    # put the probes back
    for key in ("notify.ntfy.topic", "notify.webhook.url", "nova.user_name"):
        await settings_store.clear_value(key, actor="operator")
    await _settle()

    print("4. actor is a fact, not a default")
    await settings_store.set_value("backups.keep", 8)   # nobody named
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("an unattributed internal write SAYS SO",
          ev["actor"] == "backend (unattributed)", ev["actor"])
    check("...and is never mislabeled as the operator",
          ev["actor"] != "operator", ev["actor"])
    await settings_store.set_value("backups.keep", 7,
                                   actor="actions.home_assistant")
    await _settle()
    ev = (await ce.recent(limit=1))[0]
    check("a named internal caller keeps its name",
          ev["actor"] == "actions.home_assistant", ev["actor"])

    print("5. a test process against the LIVE database writes no audit rows")
    # This process already IS a tests-dir __main__; the one signal that stands
    # between it and the guard is the DB comparison. Point that at "live" and
    # the REAL test_context must refuse — only the comparison is stubbed,
    # never the guard.
    before = len(await ce.recent(limit=100))
    real_live = notifications._live_database
    notifications._live_database = lambda: True
    try:
        why = notifications.test_context()
        check("the guard sees this process for what it is",
              why is not None and "test suite" in (why or ""), str(why))
        await settings_store.set_value("backups.keep", 9)
        await _settle()
    finally:
        notifications._live_database = real_live
    after = len(await ce.recent(limit=100))
    check("no audit row was minted", after == before, f"{before} -> {after}")
    check("...but the write itself still happened — the guard suppresses "
          "the echo, never the setting",
          settings_store.get("backups.keep") == 9)
    await settings_store.set_value("backups.keep", 7, actor="operator")

    print("6. the /activity surface renders the new kind readably")
    from app import activity_log
    page = await activity_log.fetch(window="1h", kinds=["config"], limit=100)
    titles = [r["title"] for r in page["rows"]]
    check("a set reads as a sentence",
          any("set the setting “backups.every_hours”" in t
              for t in titles), str(titles[:4]))
    check("a clear reads as a sentence",
          any("cleared the setting “backups.every_hours”" in t
              for t in titles), str(titles[:4]))
    row = next(r for r in page["rows"]
               if "set the setting “backups.every_hours”" == r["title"])
    check("the detail line carries old and new",
          "old" in row["detail"] and "new" in row["detail"], row["detail"])
    check("settings changes are ok-outcome facts, not problems",
          row["outcome"] == activity_log.OK, row["outcome"])

    await db.close_pool()


async def main() -> int:
    await _make_db()
    try:
        await run()
    finally:
        await _drop_db()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("\nall green")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
