"""Where the Nova app lives in each store (S47). Both None: there is no Nova
app yet. The day one ships, its listing goes here AND in
apps/web/src/lib/nativeApp.ts — tests/test_native_app.py pins the two equal,
so her words and the /app page cannot disagree about whether an app exists."""

from __future__ import annotations

STORE_LINKS: dict[str, str | None] = {"ios": None, "android": None}

_NAMES = {"ios": "iPhone", "android": "Android"}


def stated() -> str:
    listed = [f"{_NAMES[os_name]}: {link}" for os_name, link in STORE_LINKS.items() if link]
    if not listed:
        return "There is no native Nova app yet."
    return "The Nova app — " + "; ".join(listed) + "."


def is_store_link(url: str) -> bool:
    return url in {link for link in STORE_LINKS.values() if link}
