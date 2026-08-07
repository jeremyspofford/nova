"""End-to-end tests that drive the real app in a real browser.

Step 10 of Jeremy's self-improvement flow, and the gap it fills is stark: 77
backend suites, and NONE of them opened the app or drove a turn through it.
"The suite passed" meant the unit tests passed. A change could rename a
route, break the settings page, or leave a panel blank, and every one of
those suites would still be green.

WHY A SEPARATE SERVICE. Playwright needs real browser binaries — hundreds of
megabytes of them — and the backend image has no business carrying that. It
also needs the app to be SERVED, not imported, which is the whole point:
these tests are the only ones that exercise nginx, the built bundle, the API
proxy and the router together.

WHAT THEY DRIVE. `web` (:8080), the one-origin build — the same path the
phone uses over the tailnet. Not the vite dev server, because a dev-server
pass says nothing about the artefact that actually ships, and this codebase
has been bitten twice by exactly that difference (a frontend change live on
:5173 and absent from :8080 until `web` was rebuilt).

WHAT THEY DO NOT DO. Assert on pixels. Screenshot comparison breaks on font
rendering and teaches people to delete tests; these assert on what a person
could FIND — a heading, a control, a click path that leads somewhere. That is
also the rule this repo already states for navigation: reachable by clicking,
not only by searching.
"""

import os

import pytest
from playwright.sync_api import Page, expect

BASE_URL = os.environ.get("NOVA_E2E_URL", "http://web:80")
TOKEN = os.environ.get("NOVA_AUTH_TOKEN", "")

# Generous: a first paint behind nginx on a cold container is not the thing
# under test, and a flaky timeout teaches people to re-run rather than read.
expect.set_options(timeout=15_000)


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture
def app(page: Page) -> Page:
    """The app, loaded and authenticated, at its default route.

    The token goes into localStorage before the first navigation, because the
    app reads it on mount — setting it afterwards would leave the first render
    unauthenticated and make every test start by racing a redirect.
    """
    if TOKEN:
        page.add_init_script(
            f"window.localStorage.setItem('nova.token', {TOKEN!r});")
    page.goto(BASE_URL, wait_until="domcontentloaded")
    return page


@pytest.fixture
def mobile_app(browser) -> Page:
    """The app as the phone sees it: a 390×844 touch viewport.

    A separate context rather than a resized desktop page, because the app
    decides mobile-vs-desktop at mount (`window.innerWidth < 768` in
    AppShell) and phones land on /chat via a replace-navigation that only
    happens on first load. Resizing an already-mounted desktop page tests a
    state no real phone is ever in.
    """
    ctx = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                    "Mobile/15E148 Safari/604.1"))
    if TOKEN:
        ctx.add_init_script(
            f"window.localStorage.setItem('nova.token', {TOKEN!r});")
    page = ctx.new_page()
    page.goto(BASE_URL, wait_until="domcontentloaded")
    yield page
    ctx.close()
