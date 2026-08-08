"""Every desktop surface, reached the way the operator reaches it: by click.

Born from a manual QA walk on 2026-08-07 that found two defects no suite
could see — a Library tab clipped off the end of an overflowing tab strip,
and a Backups card that shows a skeleton forever when its (7-second) load
fails. Each check here is one step of that walk, kept.

The repo's own navigation rule applies: search-only reachability is
unacceptable. So these click the rail and the tabs rather than jumping
straight to URLs — a surface that exists at a route the UI cannot reach is a
surface the operator does not have.
"""

import re

from playwright.sync_api import Page, expect

#: Rail item → text that proves the surface actually rendered its content,
#: not just its frame. Chosen from stable chrome (headings, fixed copy), not
#: from data that changes with the install. The library's proof is a TAB
#: BUTTON: its DOM text is lowercase ("agents") wearing a CSS `capitalize`,
#: so matching the pretty label would test the stylesheet, not the app.
SURFACES = [
    ("Vault", re.compile(r"her notes, their links", re.I)),
    ("Library", re.compile(r"^agents$", re.I)),
    ("Action log", re.compile(r"Ingestion queue", re.I)),
    ("Observability", re.compile(r"SERVICE HEALTH", re.I)),
    ("Settings", re.compile(r"Assistant name", re.I)),
]

#: The full tab strip, in its DOM order and DOM casing (lowercase — the
#: capitals on screen are CSS). The strip overflows at some widths BY
#: DESIGN (`overflow-x-auto`, "keeps the tabs it hides reachable"), so the
#: click below also proves the scroll actually delivers the hidden tabs.
LIBRARY_TABS = ["goals", "agents", "models", "automations", "rules",
                "tools", "skills", "documents", "coding", "files"]


def test_every_rail_surface_opens_by_click(app: Page):
    """The five utility surfaces, each reached from the rail.

    Asserts content, not URL: a route that mounts an empty panel passes a
    URL check and leaves the operator staring at chrome.
    """
    for label, proof in SURFACES:
        app.get_by_label(label, exact=True).click()
        expect(app.get_by_text(proof).first).to_be_visible(timeout=15_000)
        # clicking the active item again returns to the canvas — the rail's
        # own contract (`go` in Rail.tsx) — so each surface also proves it
        # can be left.
        app.get_by_label(label, exact=True).click()


def test_ingest_queue_still_reachable_from_the_action_log(app: Page):
    """The queue /activity used to BE is one click down, not gone.

    2026-08-08 moved the Action log into the rail slot and the media ingest
    queue behind its "Ingestion queue →" button (retry/dismiss are queue
    controls, not log controls — the rationale is in AppShell.tsx). A moved
    surface is a deleted surface unless a click still reaches it, so this
    walks the whole path: rail → log → queue → back to the log.
    """
    app.get_by_label("Action log", exact=True).click()
    app.get_by_text("Ingestion queue", exact=False).first.click()
    expect(app.get_by_text(
        re.compile(r"background learning queue", re.I)).first
    ).to_be_visible(timeout=15_000)
    app.go_back()
    expect(app.get_by_text(
        re.compile(r"Ingestion queue", re.I)).first
    ).to_be_visible(timeout=15_000)


def test_every_library_tab_is_clickable(app: Page):
    """All ten tabs, clicked in order, at the default desktop viewport.

    THE POINT IS THE LAST ONES. At 1440×900 the strip overflows and the
    tail tabs render clipped ("Fi") — reachable only because the strip is
    `overflow-x-auto`. That reachability is a one-line regression away
    (`hidden` instead of `auto`, a comment in LibraryPage.tsx says so), and
    a click is the only honest probe: Playwright scrolls the strip to
    deliver the tab and refuses to click a control another element covers.
    """
    app.get_by_label("Library", exact=True).click()
    for tab in LIBRARY_TABS:
        app.get_by_role("button",
                        name=re.compile(rf"^{tab}$", re.I)).first.click(
            timeout=10_000)


def test_backups_settings_show_data_not_skeleton(app: Page):
    """The Backups card loads its data and says so.

    Two failure modes hide here, both found on 2026-08-07. The endpoint took
    7.3s, so an impatient assertion sees only the loading skeleton. And on a
    failed load the card sets an error string that nothing renders — the
    skeleton just stays. So: wait generously, then require the card's
    header copy and its action button, which only exist once real data
    arrived. A skeleton cannot pass this; neither can a swallowed error.
    """
    app.goto(app.url.rstrip("/") + "/settings/backups",
             wait_until="domcontentloaded")
    expect(app.get_by_text(re.compile(r"One bundle holds the database", re.I))
           .first).to_be_visible(timeout=30_000)
    expect(app.get_by_role(
        "button", name=re.compile(r"back up now|backing up", re.I)).first
    ).to_be_visible()


def test_recommendations_inbox_opens(app: Page):
    """The bell opens the inbox. It is the only door to recommendation
    cards — if this click dies, proposals pile up invisibly and the
    'she proposes, he approves' loop silently stops."""
    app.get_by_label("Recommendations inbox").first.click()
    expect(app.get_by_text(re.compile(r"RECOMMENDATIONS", re.I)).first
           ).to_be_visible(timeout=10_000)


def test_no_console_errors_walking_every_surface(page: Page, base_url: str):
    """The load test's deeper sibling: errors while USING the app.

    The existing clean-load test proved the front door; this walks every
    room. React error boundaries swallow render crashes into console.error,
    so a surface that dies on open looks fine in every other assertion
    here.
    """
    import os
    token = os.environ.get("NOVA_AUTH_TOKEN", "")
    if token:
        page.add_init_script(
            f"window.localStorage.setItem('nova.token', {token!r});")
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base_url, wait_until="domcontentloaded")
    for label, proof in SURFACES:
        page.get_by_label(label, exact=True).click()
        expect(page.get_by_text(proof).first).to_be_visible(timeout=15_000)
    # GL driver chatter is the headless GPU talking, not the app; favicon
    # and PWA noise likewise.
    real = [e for e in errors
            if not re.search(r"WebGL|GL Driver|favicon|manifest|sw\.js|workbox",
                             e, re.I)]
    assert not real, "console errors while navigating:\n" + "\n".join(real[:5])
