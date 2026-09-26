"""S47 — whether a native Nova app exists is ONE fact stated in two places:
core (what she says) and the /app page (where a phone is sent). This pins
them equal, so the day an app ships both change together."""

from __future__ import annotations

import re
from pathlib import Path

from app import native_app

WEB = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "lib" / "nativeApp.ts"


def _web_links() -> dict[str, str | None]:
    source = WEB.read_text(encoding="utf-8")
    out: dict[str, str | None] = {}
    for platform in ("ios", "android"):
        found = re.search(rf"\b{platform}:\s*(null|'([^']*)')", source)
        assert found, f"{platform} is not stated in {WEB}"
        out[platform] = None if found.group(1) == "null" else found.group(2)
    return out


def test_core_and_the_app_page_agree_on_the_store_links():
    assert native_app.STORE_LINKS == _web_links()


def test_with_no_links_she_says_there_is_no_app():
    assert native_app.STORE_LINKS == {"ios": None, "android": None}
    assert native_app.stated() == "There is no native Nova app yet."
    assert native_app.is_store_link("https://apps.apple.com/app/id1") is False
