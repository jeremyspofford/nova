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

    print("4. absence is stated, not implied")
    r = await diagnostics.report("Notifications")
    check("an empty error list is explained rather than left to read as 'fine'",
          "LOGGED" in r["errors_note"], r["errors_note"][:80])

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
