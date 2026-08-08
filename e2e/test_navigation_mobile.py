"""The phone path, walked as a phone: 390×844, touch, mobile UA.

The one-origin build at `web` IS the phone app, and until this file nothing
drove it at phone size — every e2e test ran a desktop viewport, so the
entire mobile shell (chat-first landing, the drawer menu, sheet-history
back behaviour, the 100dvh composer fix) was shipped on faith.

Uses `mobile_app` from conftest: a real mobile context, not a resized
desktop page, because AppShell decides mobile at mount and phones land on
/chat via a replace-navigation that only happens on first load.
"""

import re

from playwright.sync_api import Page, expect

#: Menu item → copy that proves the page rendered CONTENT, where the page
#: has any fixed copy at all. The Action log's is None: on the phone its
#: body is pure install data (rows of what she did), so the heading
#: (asserted for every page below) is all that is stable.
MENU_PAGES = [
    ("Vault", re.compile(r"New note", re.I)),
    ("Library", re.compile(r"What she is working towards", re.I)),
    ("Action log", None),
    ("Observability", re.compile(r"SERVICE HEALTH", re.I)),
    ("Settings", re.compile(r"Operator", re.I)),
]


def _open_menu(page: Page) -> None:
    page.get_by_label("Menu").first.click()
    # The drawer is open when its distinctive cards are findable. `.` for
    # the apostrophe: the copy uses U+2019 (’), and an ASCII quote in this
    # pattern cost twenty minutes of "but the card is right there".
    expect(page.get_by_text(re.compile(r"Nova.s universe", re.I)).first
           ).to_be_visible(timeout=10_000)


def test_a_phone_lands_in_chat_with_a_usable_composer(mobile_app: Page):
    """Chat IS the app on a phone (2026-07-23). Landing anywhere else, or
    landing in chat without a composer the thumb can reach, is the whole
    surface broken."""
    expect(mobile_app).to_have_url(re.compile(r"/chat$"), timeout=15_000)
    composer = mobile_app.get_by_role("textbox").first
    expect(composer).to_be_visible()
    expect(composer).to_be_editable()

    # INSIDE the viewport — the 100dvh regression. With 100vh the composer
    # sat under the browser toolbar: visible to the DOM, unreachable by a
    # thumb. A bounding-box check is the only assertion that can tell the
    # difference.
    box = composer.bounding_box()
    vh = mobile_app.viewport_size["height"]
    assert box is not None and box["y"] + box["height"] <= vh + 1, (
        f"composer bottom at {box and box['y'] + box['height']}px "
        f"overflows the {vh}px viewport")


def test_the_menu_reaches_every_surface_and_back_returns_to_chat(
        mobile_app: Page):
    """The drawer is the phone's entire navigation, and BACK is its exit.

    Mobile surfaces are pages, not modals (the repo's own rule), which
    makes the browser's back button the way out. If back strands the
    operator on a page, the phone app has no navigation at all — so back
    is asserted after every single page, not once.
    """
    for label, proof in MENU_PAGES:
        _open_menu(mobile_app)
        mobile_app.get_by_text(label, exact=True).first.click()
        expect(mobile_app.get_by_role(
            "heading", name=re.compile(rf"^{label}$"))).to_be_visible(
            timeout=15_000)
        if proof is not None:
            expect(mobile_app.get_by_text(proof).first).to_be_visible(
                timeout=15_000)
        mobile_app.go_back()
        expect(mobile_app).to_have_url(re.compile(r"/chat$"), timeout=10_000)
        expect(mobile_app.get_by_role("textbox").first).to_be_visible()


def test_the_menu_offers_the_universe_and_hands_free(mobile_app: Page):
    """The two cards above the list are the phone's only doors to the
    canvas and to voice. They are easy to lose in a menu restyle precisely
    because they are not list items — so they get their own check."""
    _open_menu(mobile_app)
    expect(mobile_app.get_by_text(re.compile(r"Nova.s universe", re.I)).first
           ).to_be_visible()
    expect(mobile_app.get_by_text(re.compile(r"Hands-free", re.I)).first
           ).to_be_visible()
