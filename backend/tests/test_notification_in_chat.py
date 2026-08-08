"""A notification lands in the conversation, and never claims it was received.

    docker compose exec -T backend python tests/test_notification_in_chat.py

Jeremy, 2026-08-07, verbatim: "I get push notifications from the PWA but when
I click on it, it brings me to chat but doesn't show me what the push
notification was. Notifications should be in chat, not just the notifications
bell."

Four properties are pinned here, each one a line of code that refuses rather
than a sentence anybody has to remember:

1. THE TRANSCRIPT ROW IS A POINTER, NOT A COPY. Migration 125 rejects a
   role='notification' message that carries its own content. If it ever
   stopped rejecting one, the chat text and the pushed text would be two rows
   free to drift, which is the thing "derive one from the other" forbids.

2. ACCEPTED IS NOT RECEIVED. `mark_accepted` is what a transport's 200
   produces, and there is deliberately no argument, flag or provider response
   that makes it — or anything else reachable from a send — write the one
   state that means a person saw it. This is the operator-visible-outcomes
   lesson, which this repo has had to relearn in a startup line, an import
   step and an endpoint that returned {"status": "ok"}.

3. A FAILURE MUST SAY WHY. The DB refuses state='failed' with an empty
   reason, so a caller that swallowed its exception cannot record a blank
   one — a failure that reads as an absence is a fallback that reads as
   success.

4. THE ID SURVIVES THE TAP. The click URL carries the notification id and
   push.py pulls it back out into the payload. Losing it between the push and
   the client is precisely the reported bug.

5. A SUPPRESSED PUSH IS NOT A SEND. The anti-nag dedupe returns ok:True
   without asking the provider anything, so every caller has to read
   `deduped` — and the one that talks to the MODEL is checked here, because
   `notify_operator` answering "accepted … this confirms it was PUBLISHED"
   for a push that never left the box is how Nova ends up telling Jeremy she
   notified him about a thing he was never notified about.

Plus the anti-nag rule (one piece of news, one notification) and the fact
that opening a notification retires its linked inbox card from the bell.
"""

import asyncio
import json
import os
import sys
import uuid

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
DB_NAME = f"nova_notif_{uuid.uuid4().hex[:8]}"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _admin_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/postgres"


def _test_url() -> str:
    return os.environ["DATABASE_URL"].rsplit("/", 1)[0] + "/" + DB_NAME


# ── 1. pure: the fingerprint, the deep link, the id-through-the-URL ────────

def test_pure():
    from app import notifications, push
    print("1. pure functions — the id survives, the news is identified")

    # THE REPORTED BUG, in one assertion. push.py reads the id back out of the
    # click URL notify.py built, because the URL is the one carrier that
    # survives a cold start, a WindowClient.navigate and an iOS PWA that has
    # neither.
    nid = "11111111-2222-3333-4444-555555555555"
    link = notifications.deep_link(nid)
    check("the deep link names the notification", f"notification={nid}" in link, link)
    check("push.py recovers the id from that link",
          push.notification_id_from(link) == nid,
          str(push.notification_id_from(link)))
    check("a caller's own destination simply has no id",
          push.notification_id_from("/observability") is None)
    check("no URL at all is not a crash", push.notification_id_from(None) is None)

    # ONE PIECE OF NEWS, ONE FINGERPRINT. `recommendations.create` pushes
    # `body[:140]` for the card while the raiser pushes the whole text, so the
    # long and short forms of one event must hash alike or the phone buzzes
    # twice with the same sentence.
    text = ("Backups have not run for 3 days and the last attempt was refused "
            "by the passphrase check. Nothing has been restorable since "
            "Tuesday, and the weekly drill did not fire either.")
    check("the truncated and full forms of one event fingerprint alike",
          notifications.fingerprint(text) == notifications.fingerprint(text[:140]),
          f"{notifications.fingerprint(text)} vs {notifications.fingerprint(text[:140])}")
    check("whitespace differences do not make it new news",
          notifications.fingerprint(text)
          == notifications.fingerprint(text.replace(" ", "  ")))
    check("different news is different",
          notifications.fingerprint(text) != notifications.fingerprint("all quiet"))

    # `confirmed` answers the one question that matters, for one state.
    rows = [
        {"state": "pending", "opened_at": None},
        {"state": "accepted", "opened_at": None},
        {"state": "failed", "opened_at": None},
        {"state": "opened", "opened_at": None},          # no evidence
        {"state": "opened", "opened_at": "2026-08-07"},
    ]
    got = [notifications.confirmed(r) for r in rows]
    check("only an opened row WITH a timestamp counts as received",
          got == [False, False, False, False, True], str(got))
    # The label is derived from `confirmed`, not from the state string, so no
    # unconfirmed row can be worded as a delivery — including the impossible
    # one (state='opened' with no timestamp) the database already refuses.
    for i, r in enumerate(rows[:4]):
        label = notifications.delivery_label(
            {**r, "provider": "webpush", "error": "relay refused"})
        check(f"row {i} ({r['state']}, unconfirmed) is never worded as arrival",
              "opened on your device" not in label, label)
    check("the confirmed row IS worded as arrival",
          notifications.delivery_label(
              {**rows[4], "provider": "webpush", "error": None})
          == "opened on your device")


# ── 2. the database rails ─────────────────────────────────────────────────

async def _make_db() -> None:
    """Throwaway DB, and DATABASE_URL repointed BEFORE app.config is imported
    — pydantic reads the environment once, at import, so doing this later
    runs the whole test against the OPERATOR'S database."""
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


async def test_db() -> None:
    import asyncpg

    from app import conversations, db, notifications, settings_store
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()

    print("2. the transcript row is a POINTER, not a copy")
    cid = await conversations.operator_conversation_id()
    check("the operator conversation resolves", bool(cid), str(cid))

    rec = await notifications.record(
        "The backup drill failed: the passphrase check refused the bundle.",
        title="Nova heartbeat", kind="heartbeat", source="heartbeat",
        click_url="/chat?inbox=open", tags=["heartbeat"])
    note = rec["notification"]
    check("it landed in the conversation", rec["in_chat"] is True, str(rec))
    check("...and starts out claiming nothing", note["state"] == "pending",
          note["state"])
    check("...and is not confirmed", note["confirmed"] is False)

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT role, content, metadata FROM messages WHERE id = $1",
            uuid.UUID(note["message_id"]))
    check("the transcript row is role='notification'", row["role"] == "notification",
          str(row["role"]))
    check("...carries NO text of its own", row["content"] is None,
          repr(row["content"]))
    meta = row["metadata"]
    meta = json.loads(meta) if isinstance(meta, str) else meta
    check("...and names the notification it renders",
          meta.get("notification_id") == note["id"], str(meta))

    # THE REFUSAL. A copy is only prevented if writing one fails.
    async with db.acquire() as conn:
        try:
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content, metadata) "
                "VALUES ($1, 'notification', 'a second copy of the text', "
                "'{\"notification_id\": \"x\"}'::jsonb)", uuid.UUID(cid))
            refused_copy = False
        except asyncpg.exceptions.CheckViolationError:
            refused_copy = True
        try:
            await conn.execute(
                "INSERT INTO messages (conversation_id, role, content, metadata) "
                "VALUES ($1, 'notification', NULL, '{}'::jsonb)", uuid.UUID(cid))
            refused_orphan = False
        except asyncpg.exceptions.CheckViolationError:
            refused_orphan = True
    check("the DB REFUSES a notification row that carries its own text",
          refused_copy)
    check("the DB REFUSES a notification row that points at nothing",
          refused_orphan)

    print("3. accepted is not received")
    accepted = await notifications.mark_accepted(
        note["id"], provider="webpush", transport_id="2/2 devices")
    check("a transport 200 moves it to 'accepted'",
          accepted["state"] == "accepted", accepted["state"])
    check("...and it is STILL not confirmed", accepted["confirmed"] is False)
    check("...and says so in words the UI must reuse",
          "not confirmed received" in accepted["delivery_label"],
          accepted["delivery_label"])
    # the point of the whole file: nothing a provider can return reaches the
    # one state that means a person saw it
    check("no send path can produce state='opened'",
          accepted["state"] != notifications.OPENED)

    opened = await notifications.mark_opened(note["id"], via="chat")
    check("a client that rendered it CAN", opened["state"] == "opened",
          opened["state"])
    check("...and only then is it confirmed", opened["confirmed"] is True)
    first_open = opened["opened_at"]
    again = await notifications.mark_opened(note["id"], via="chat")
    check("a second tap does not restamp the first confirmation",
          again["opened_at"] == first_open, f"{first_open} -> {again['opened_at']}")

    print("4. a failure must say why")
    rec2 = await notifications.record("something else entirely happened here",
                                      title="Nova", kind="alert")
    n2 = rec2["notification"]["id"]
    failed = await notifications.mark_failed(
        n2, provider="ntfy", error="   ")          # a caller with nothing to say
    check("an empty reason is replaced, never stored blank",
          bool((failed["error"] or "").strip()), repr(failed["error"]))
    check("...and the row reads as a failure, not an absence",
          failed["state"] == "failed" and failed["confirmed"] is False)
    check("...and the label leads with what went wrong",
          failed["delivery_label"].startswith("not delivered"),
          failed["delivery_label"])
    async with db.acquire() as conn:
        try:
            await conn.execute(
                "UPDATE notifications SET state='failed', error='' WHERE id=$1",
                uuid.UUID(n2))
            refused_blank = False
        except asyncpg.exceptions.CheckViolationError:
            refused_blank = True
        try:
            await conn.execute(
                "UPDATE notifications SET state='opened', opened_at=NULL "
                "WHERE id=$1", uuid.UUID(n2))
            refused_evidence = False
        except asyncpg.exceptions.CheckViolationError:
            refused_evidence = True
    check("the DB REFUSES a failure with no reason", refused_blank)
    check("the DB REFUSES 'opened' with no moment it was opened",
          refused_evidence)

    print("5. one piece of news, one notification")
    body = ("Ingestion has failed 14 times since Monday and nothing has been "
            "done about it; the queue is not draining.")
    first = await notifications.record(body, title="Nova heartbeat")
    await notifications.mark_accepted(first["notification"]["id"], provider="ntfy")
    repeat = await notifications.find_repeat(
        notifications.fingerprint(body[:140]))
    check("the same news, differently truncated, finds the live record",
          repeat is not None and repeat["id"] == first["notification"]["id"],
          str(repeat and repeat["id"]))
    # a FAILED original is not something to be quiet about
    third = await notifications.record("a third distinct piece of news here",
                                       title="Nova")
    await notifications.mark_failed(third["notification"]["id"],
                                    provider="ntfy", error="ntfy refused: 403")
    check("a repeat of something that FAILED is not suppressed",
          await notifications.find_repeat(
              notifications.fingerprint("a third distinct piece of news here")) is None)

    print("6. reading it in chat retires the card from the bell")
    async with db.acquire() as conn:
        rid = await conn.fetchval(
            "INSERT INTO recommendations (kind, title, body, source, status) "
            "VALUES ('heartbeat','Heartbeat','something','heartbeat','new') "
            "RETURNING id")
    rec3 = await notifications.record("a fourth and final piece of news today",
                                      title="Nova heartbeat",
                                      recommendation_id=str(rid))
    await notifications.mark_accepted(rec3["notification"]["id"], provider="webpush")
    async with db.acquire() as conn:
        before = await conn.fetchval(
            "SELECT status FROM recommendations WHERE id = $1", rid)
    check("the card is unread while the notification is unopened",
          before == "new", str(before))
    await notifications.mark_opened(rec3["notification"]["id"], via="chat")
    async with db.acquire() as conn:
        after = await conn.fetchval(
            "SELECT status FROM recommendations WHERE id = $1", rid)
    check("opening the notification in chat marks its card seen",
          after == "seen", str(after))
    check("...but does not decide it — 'seen' keeps it in the inbox",
          after in ("seen",), str(after))

    print("7. the notification is IN the transcript, in order")
    history = await conversations.load_history(
        cid, roles=("user", "assistant", "notification"))
    kinds = [m["role"] for m in history]
    check("notification rows come back with the transcript",
          kinds.count("notification") >= 4, str(kinds))
    check("...and every one of them resolves to a record",
          all(conversations.notification_id_of(m)
              for m in history if m["role"] == "notification"))
    # and they must NOT be replayed to the model as turns: they carry no
    # content, so to_llm_history drops them
    llm = conversations.to_llm_history(history)
    check("...and none of them is replayed to the model as a turn",
          all(m["role"] in ("user", "assistant") for m in llm), str(llm[:2]))

    print("8. notify.send: the seam, end to end")
    from app import notify

    class FakeProvider(notify.Provider):
        key, label = "fake", "Fake"
        sent: list[dict] = []
        ok = True

        def configured(self):
            return True

        async def send(self, message, *, title, priority, tags, click):
            FakeProvider.sent.append({"message": message, "click": click})
            if not FakeProvider.ok:
                return {"ok": False, "error": "the relay refused: 403"}
            return {"ok": True, "id": "1/1 devices"}

    notify._PROVIDERS["fake"] = FakeProvider()
    settings_store._cache["notify.enabled"] = True
    settings_store._cache["notify.provider"] = "fake"

    out = await notify.send("the disk is at 96% and writes are about to fail",
                            title="Nova resource alert", kind="alert",
                            source="sysmon", click="/observability")
    check("send reports acceptance", out["ok"] is True, str(out))
    check("...names the notification it recorded", bool(out.get("notification_id")),
          str(out))
    check("...and says it reached the conversation", out.get("in_chat") is True,
          str(out))
    # THE REPORTED BUG, at the seam: what the provider was handed to put behind
    # the tap. It used to be the caller's bare page.
    check("the provider was given the DEEP LINK, not the caller's page",
          FakeProvider.sent[-1]["click"]
          == notifications.deep_link(out["notification_id"]),
          FakeProvider.sent[-1]["click"])
    stored = await notifications.get(out["notification_id"])
    check("the record moved to accepted", stored["state"] == "accepted",
          stored["state"])
    check("...still not confirmed received", stored["confirmed"] is False)
    check("...and the caller's own destination was KEPT for the chat card",
          stored["click_url"] == "/observability", str(stored["click_url"]))

    # SAME NEWS TWICE inside the window — one notification, one buzz.
    before_sends = len(FakeProvider.sent)
    dup = await notify.send("the disk is at 96% and writes are about to fail",
                            title="Nova recommends: disk", kind="recommendation")
    check("the same news does not buzz twice", dup.get("deduped") is True, str(dup))
    check("...and the provider was not asked again",
          len(FakeProvider.sent) == before_sends, str(len(FakeProvider.sent)))
    check("...and it points at the record that already exists",
          dup["notification_id"] == out["notification_id"], str(dup))

    # A BROKEN TRANSPORT STILL REACHES THE CONVERSATION. This is the whole
    # reason recording happens before delivering: the channel that failed used
    # to be the only record that anything had been raised at all.
    FakeProvider.ok = False
    bad = await notify.send("the nightly backup bundle could not be written",
                            title="Nova", kind="alert")
    check("a refused push still reports failure honestly", bad["ok"] is False,
          str(bad))
    check("...and the notification is STILL in the conversation",
          bad.get("in_chat") is True, str(bad))
    broken = await notifications.get(bad["notification_id"])
    check("...recorded as failed", broken["state"] == "failed", broken["state"])
    check("...carrying the relay's reason", "403" in (broken["error"] or ""),
          str(broken["error"]))

    # DISABLED IS NOT SILENT either — the news lands, saying why nothing was
    # pushed. That branch never touched a network and used to vanish.
    settings_store._cache["notify.enabled"] = False
    off = await notify.send("a fifth and quite separate thing has happened",
                            title="Nova", kind="alert")
    check("notifications switched off still land in chat",
          off.get("in_chat") is True, str(off))
    quiet = await notifications.get(off["notification_id"])
    check("...saying exactly why nothing was sent",
          "disabled" in (quiet["error"] or ""), str(quiet["error"]))
    settings_store._cache["notify.enabled"] = True

    # record=False is the ONE opt-out, and it must not write anything.
    async with db.acquire() as conn:
        n_before = await conn.fetchval("SELECT count(*) FROM notifications")
    await notify.send("Nova replied", title="Nova replied", record=False)
    async with db.acquire() as conn:
        n_after = await conn.fetchval("SELECT count(*) FROM notifications")
    check("record=False writes no notification at all", n_before == n_after,
          f"{n_before} -> {n_after}")

    print("9. what the MODEL is told — a suppressed push is not a send")
    # The dedupe landed in notify.send and no caller read `deduped`, so a
    # notification that was never published came back to the model as
    # {"status": "accepted", "note": "...this confirms it was PUBLISHED..."}
    # and Nova would have told Jeremy she notified him. This is the
    # "never report success you did not check" rule at the tool boundary.
    from app.tools.builtin import _notify_operator

    FakeProvider.ok = True
    news = "the garage door has been open for two hours"
    sends_before = len(FakeProvider.sent)
    first = json.loads(await _notify_operator({"message": news}, None))
    check("a real send is reported as accepted", first["status"] == "accepted",
          str(first))
    check("...the provider WAS asked", len(FakeProvider.sent) == sends_before + 1,
          f"{sends_before} -> {len(FakeProvider.sent)}")
    check("...and the model is handed the notification id, not just a transport id",
          bool(first.get("notification_id"))
          and first.get("transport_id") == "1/1 devices", str(first))
    check("...and the row's own delivery line, which does not claim receipt",
          "not confirmed received" in (first.get("delivery") or ""),
          str(first.get("delivery")))
    check("...and whether it reached the conversation",
          first.get("in_chat") is True, str(first))

    sends_before = len(FakeProvider.sent)
    second = json.loads(await _notify_operator({"message": news}, None))
    check("the provider is NOT asked a second time",
          len(FakeProvider.sent) == sends_before,
          f"{sends_before} -> {len(FakeProvider.sent)}")
    check("THE DEFECT: a suppressed notification is never reported as accepted",
          second["status"] != "accepted", str(second))
    check("...it is reported as deduped", second["status"] == "deduped",
          str(second))
    check("...and the note says plainly that nothing was published",
          "NOTHING WAS PUBLISHED" in second["note"], second["note"])
    check("...and it names the notification the news was folded onto",
          second.get("notification_id") == first.get("notification_id"),
          str(second.get("notification_id")))
    check("...and no wording in it can be read as a fresh send",
          "PUBLISHED, " not in second["note"]
          and "Accepted by" not in second["note"], second["note"])

    # and the other two callers of notify.send read `deduped` too, so an
    # automation run and a heartbeat beat cannot record a delivery that did
    # not happen either.
    dupe = await notify.send(news, title="Nova")
    check("send always states whether it published", "deduped" in dupe, str(dupe))
    check("...and a deduped result carries the earlier row's honest state",
          dupe.get("delivery_label") and dupe.get("state") in ("accepted", "opened"),
          str(dupe))
    fresh = await notify.send("a sixth and unrelated thing just happened",
                              title="Nova")
    check("...and a fresh send says deduped is False", fresh.get("deduped") is False,
          str(fresh))
    check("...carrying its own state", fresh.get("state") == "accepted",
          str(fresh.get("state")))

    await db.close_pool()


def main() -> int:
    asyncio.run(_make_db())
    try:
        test_pure()
        asyncio.run(test_db())
    finally:
        asyncio.run(_drop_db())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:6]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
