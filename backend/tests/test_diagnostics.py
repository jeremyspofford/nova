"""Looking at her own configuration instead of guessing about it.

    docker compose exec backend python tests/test_diagnostics.py

Asked on 2026-07-28 why push notifications had stopped, Nova said "tell me
what you're seeing and I can investigate" and then could not. Every step the
real investigation took was read-only — list the notify settings, count the
subscriptions, see which relay the endpoints point at, read the last errors —
and she held none of it.

The cause was one unset value: Apple's push relay rejects a non-routable
VAPID contact with a bare 403, and the default was mailto:nova@localhost. No
amount of reasoning reaches that. It has to be looked at.

The property that must never regress is the scrubbing. This exists to hand
CONFIGURATION to a model, and configuration is exactly where the API keys
live.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    from app import db, diagnostics, settings_store
    await db.init_pool()
    await settings_store.warm()

    print("1. the areas are derived, not listed")
    names = diagnostics.areas()
    from app.settings_store import SETTING_DEFS
    declared = {d.get("section") for d in SETTING_DEFS if d.get("section")}
    check("every settings section is diagnosable, so a new one works the day "
          "it lands with no edit here",
          declared == set(names), f"{sorted(declared ^ set(names))}")

    print("2. it reports what is actually configured")
    r = await diagnostics.report("Notifications")
    check("the area resolves case-insensitively", r["area"] == "Notifications")
    check("and returns that section's real settings",
          any(k.startswith("notify.") for k in r["settings"]),
          str(list(r["settings"])[:3]))
    check("scoped to the section — not every setting in the system",
          not any(k.startswith("voice.") for k in r["settings"]))

    print("3. SECRETS ARE SCRUBBED — the whole point is handing config to a model")
    saved = settings_store._cache.get("notify.webhook.url")
    settings_store._cache["notify.webhook.url"] = \
        "https://hooks.example.com/services/T0/B0/abcdef1234567890secret"
    try:
        r = await diagnostics.report("Notifications")
        leaked = str(r["settings"].get("notify.webhook.url", ""))
        check("a webhook whose secret is in the PATH does not come back whole",
              "abcdef1234567890secret" not in leaked, leaked[:70])
    finally:
        if saved is not None:
            settings_store._cache["notify.webhook.url"] = saved

    # The ntfy topic is the OTHER shapeless secret: a plain word that, on a
    # shared server, is the whole credential (its own description says so).
    # Its def declares `secret: True` and diagnose masks on that declaration,
    # because no shape rule can know a word is a password.
    saved = settings_store._cache.get("notify.ntfy.topic")
    settings_store._cache["notify.ntfy.topic"] = "shhh8f2k1x9qtopic441"
    try:
        r = await diagnostics.report("Notifications")
        topic = str(r["settings"].get("notify.ntfy.topic", ""))
        check("the ntfy topic does not come back whole",
              "8f2k1x9qtopic441" not in topic, topic)
        check("...but answers 'is it set and does it look right'",
              topic.startswith("shhh") and "20 chars" in topic, topic)
    finally:
        if saved is not None:
            settings_store._cache["notify.ntfy.topic"] = saved

    print("4. absence is stated, not implied — and health cannot be IMPLIED")
    from app import failures
    base = {"scanned": ["ingest_jobs"], "sources": {}, "total": 0,
            "recent_total": 0, "days": 7, "unreadable": [], "unclassified": []}
    check("with nothing failing, absence is explained rather than left to "
          "read as 'fine'", "RECORDED" in failures.note(base))

    # The 2026-08-02 bug: diagnose said "8 error(s) in the last 72h" over two
    # failed ingest jobs it structurally could not see. The reassuring wording
    # must be unreachable while any failure row exists.
    failing = {**base, "total": 2, "recent_total": 2,
               "sources": {"ingest_jobs": {"failed": 2, "recent_failed": 2}}}
    note = failures.note(failing)
    check("a failed queue row makes the all-clear unreachable",
          "RECORDED" not in note, note[:80])
    check("...and the count comes from the census, not from prose",
          "ingest_jobs 2" in note)

    blind = {**base, "unclassified": ["some_new_queue"]}
    check("a failure-shaped store nobody classified forces INCOMPLETE",
          failures.note(blind).startswith("INCOMPLETE")
          and "some_new_queue" in failures.note(blind))

    print("4b. every report carries the census, whatever the area")
    for area in (None, "Notifications", "nonsense-area"):
        r = await diagnostics.report(area)
        check(f"diagnose({area!r}) cannot answer without it",
              "background_failures" in r, str(sorted(r))[:60])

    print("5. an unknown area is refused with the options")
    r = await diagnostics.report("nonsense-area")
    check("it says so", "error" in r)
    check("...and lists what it does know", bool(r.get("areas")))

    print("6. it is a READER — no new trust required")
    from app.tools import registry
    check("diagnose does not classify as an ACTOR, so it stays usable on a "
          "turn holding third-party text", not registry.is_actor("diagnose"))

    await db.close_pool()


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
