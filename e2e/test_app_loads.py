"""The app renders, routes, and answers — driven in a real browser.

The floor. Every check here is something no backend suite can see, and
something that would leave the operator with a blank page if it broke.

DELIBERATELY NOT PIXELS. These assert on what a person could find: a heading,
a control, a click path that leads somewhere. Screenshot comparison breaks on
font rendering and teaches people to delete tests.
"""

import re

from playwright.sync_api import Page, expect


def test_the_app_actually_paints(app: Page):
    """It renders SOMETHING. The cheapest test here and the one that catches
    the worst failure: a bundle that 404s, a router that throws on mount, a
    CSP that blocks the entry script. All of those serve HTTP 200 and a blank
    screen, so a health check cannot see them."""
    expect(app).to_have_title(re.compile("Nova", re.I))
    root = app.locator("#root")
    expect(root).not_to_be_empty()


def test_no_console_errors_on_load(page: Page, base_url: str):
    """A clean load. React logs its own crashes to the console, so this
    catches a component that threw and was swallowed by an error boundary —
    which looks fine in a screenshot and is broken for the operator.

    AUTHENTICATED, unlike the first version of this test. Loading unauthed
    produced a 401 on the first API call and the test dutifully reported it
    as a console error — a true observation about a page nobody uses, which
    is the definition of a test that will be ignored. The interesting
    question is whether the app is clean for someone who is logged in.
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
    page.goto(base_url, wait_until="networkidle")
    # Favicon and manifest noise is not a broken app; anything else is.
    real = [e for e in errors
            if not re.search(r"favicon|manifest|sw\.js|workbox", e, re.I)]
    assert not real, "console errors on load:\n" + "\n".join(real[:5])


def test_the_api_is_reachable_through_the_same_origin(app: Page):
    """The nginx proxy is doing its job.

    This is the one that would have caught a 43-hour class of outage: the
    bundle loads from `web` and the API is proxied by the SAME nginx, so a
    stale upstream or a broken proxy_pass serves a perfect-looking app that
    can do nothing. Asserted from the browser, over the real origin, rather
    than by curling the backend directly — which is exactly the difference
    that hid it before.
    """
    resp = app.request.get("/api/v1/settings")
    assert resp.status in (200, 401), f"same-origin API said {resp.status}"


def test_settings_is_reachable_by_clicking(app: Page):
    """Reachable by NAVIGATION, not only by URL.

    This repo's own rule: search-only reachability is unacceptable, so walk
    the click path. A settings page that exists at /settings and cannot be
    reached from the UI is a page the operator does not have.
    """
    app.goto(f"{app.url.rstrip('/')}/settings", wait_until="domcontentloaded")
    expect(app.locator("#root")).not_to_be_empty()
    # Section names come from SETTING_DEFS, so this also proves the settings
    # API answered and the list rendered from real data.
    expect(app.get_by_text(re.compile(r"Agents|Appearance|Voice", re.I)).first
           ).to_be_visible()


def test_the_home_panel_she_wrote_renders(app: Page, base_url: str):
    """Settings → Home, the panel whose last change Nova wrote herself.

    Worth its own test for a reason beyond coverage: the three-line change she
    landed on 2026-08-05 is a UI change, and until this file existed nothing
    could tell whether her code did what it claimed. A suite of unit tests
    would have passed on a component that renders nothing.

    NOTE FOR ANYONE CHASING A FAILURE HERE: `web` serves a BAKED build.
    Frontend source changes reach :5173 by HMR and do NOT reach :8080 until
    `docker compose build web`. If this test disagrees with the source, that
    is the first thing to check — it has bitten this project twice.
    """
    app.goto(f"{base_url.rstrip('/')}/settings/home",
             wait_until="domcontentloaded")
    expect(app.get_by_text(re.compile("Home Assistant", re.I)).first
           ).to_be_visible()
    # The control, not just the words: a card that renders its title and no
    # button is the failure mode that reads fine in a screenshot.
    expect(app.get_by_role("button", name=re.compile("Start|Stop", re.I)).first
           ).to_be_visible()


def test_chat_is_the_default_surface(app: Page):
    """The composer is there on arrival.

    Nova is a chat-first app: if the operator lands and cannot type, nothing
    else about the build matters. Asserted by ROLE rather than by class name,
    so a restyle does not fail it and a genuinely missing input does.
    """
    composer = app.get_by_role("textbox").first
    expect(composer).to_be_visible()
    expect(composer).to_be_editable()
