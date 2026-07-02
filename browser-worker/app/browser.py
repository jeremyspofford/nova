"""
Browser session manager — Playwright contexts keyed by session id.

One persistent browser context per domain (profiles on disk, so logins
survive restarts). A snapshot is a numbered list of interactive elements
from the accessibility tree; agents act on elements by their ref number,
which keeps payloads small and stable versus raw DOM/screenshots.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import Browser, BrowserContext, Page, async_playwright

from app.config import settings

log = logging.getLogger(__name__)


def _domain(url: str) -> str:
    return urlparse(url).netloc or "default"


@dataclass
class Session:
    id: str
    domain: str
    context: BrowserContext
    page: Page
    created_at: float = field(default_factory=time.monotonic)
    last_used: float = field(default_factory=time.monotonic)
    # Maps snapshot ref number → Playwright selector for the last snapshot.
    element_refs: dict[int, str] = field(default_factory=dict)

    def touch(self) -> None:
        self.last_used = time.monotonic()


class BrowserManager:
    def __init__(self):
        self._pw = None
        self._browser: Browser | None = None
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.launch(headless=settings.headless)
        Path(settings.profiles_dir).mkdir(parents=True, exist_ok=True)
        log.info("Browser manager started (headless=%s)", settings.headless)

    async def stop(self) -> None:
        for sid in list(self._sessions):
            await self.close_session(sid)
        if self._browser:
            await self._browser.close()
        if self._pw:
            await self._pw.stop()

    async def open_session(self, url: str, session_id: str) -> Session:
        async with self._lock:
            if len(self._sessions) >= settings.max_concurrent_sessions:
                await self._reap(force_oldest=True)
            domain = _domain(url) if url else "default"
            profile = Path(settings.profiles_dir) / domain
            profile.mkdir(parents=True, exist_ok=True)
            # Persistent context = cookies/localStorage survive across sessions.
            context = await self._pw.chromium.launch_persistent_context(
                user_data_dir=str(profile),
                headless=settings.headless,
            )
            page = context.pages[0] if context.pages else await context.new_page()
            page.set_default_timeout(settings.nav_timeout_ms)
            sess = Session(id=session_id, domain=domain, context=context, page=page)
            self._sessions[session_id] = sess
        if url:
            await self.navigate(session_id, url)
        return sess

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    async def navigate(self, session_id: str, url: str) -> dict:
        sess = self._require(session_id)
        await sess.page.goto(url, wait_until="domcontentloaded")
        sess.touch()
        return {"url": sess.page.url, "title": await sess.page.title()}

    async def snapshot(self, session_id: str, include_screenshot: bool = False) -> dict:
        """Numbered accessibility-tree snapshot the agent acts on."""
        sess = self._require(session_id)
        page = sess.page
        # Collect interactive elements with a stable ref → selector map.
        handles = await page.query_selector_all(
            "a, button, input, textarea, select, [role=button], [role=link], [role=checkbox]"
        )
        elements = []
        refs: dict[int, str] = {}
        ref = 0
        for h in handles:
            try:
                if not await h.is_visible():
                    continue
            except Exception:
                continue
            tag = await h.evaluate("el => el.tagName.toLowerCase()")
            etype = await h.get_attribute("type") or ""
            name = (
                await h.get_attribute("aria-label")
                or await h.get_attribute("name")
                or await h.get_attribute("placeholder")
                or (await h.inner_text() if tag != "input" else "")
                or ""
            ).strip()[:80]
            ref += 1
            # Stable per-snapshot selector using nth-match on the element list.
            refs[ref] = h
            desc = f"[{ref}] <{tag}"
            if etype:
                desc += f" type={etype}"
            desc += f"> {name}" if name else ">"
            elements.append(desc)

        sess.element_refs = refs  # handles are valid until next navigation
        sess.touch()
        out = {
            "url": page.url,
            "title": await page.title(),
            "elements": elements,
        }
        if include_screenshot:
            import base64

            png = await page.screenshot()
            out["screenshot_b64"] = base64.b64encode(png).decode()
        return out

    async def act(self, session_id: str, ref: int, action: str, value: str = "") -> dict:
        """Perform an action on a snapshot element by its ref number."""
        sess = self._require(session_id)
        handle = sess.element_refs.get(ref)
        if handle is None:
            raise ValueError(f"unknown element ref {ref} — take a fresh snapshot")
        if action == "click":
            await handle.click()
        elif action == "type":
            await handle.fill(value)
        elif action == "select":
            await handle.select_option(value)
        elif action == "press":
            await handle.press(value or "Enter")
        else:
            raise ValueError(f"unknown action {action!r}")
        sess.touch()
        # Give the page a beat to settle after an action.
        try:
            await sess.page.wait_for_load_state("domcontentloaded", timeout=5000)
        except Exception:
            pass
        return {"url": sess.page.url, "title": await sess.page.title()}

    async def close_session(self, session_id: str) -> bool:
        sess = self._sessions.pop(session_id, None)
        if sess is None:
            return False
        try:
            await sess.context.close()
        except Exception:
            log.warning("error closing session %s", session_id, exc_info=True)
        return True

    async def _reap(self, force_oldest: bool = False) -> None:
        now = time.monotonic()
        stale = [
            sid for sid, s in self._sessions.items()
            if now - s.last_used > settings.session_idle_timeout_seconds
            or now - s.created_at > settings.session_max_seconds
        ]
        if not stale and force_oldest and self._sessions:
            stale = [min(self._sessions, key=lambda k: self._sessions[k].last_used)]
        for sid in stale:
            await self.close_session(sid)

    async def reaper_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            try:
                async with self._lock:
                    await self._reap()
            except Exception:
                log.warning("session reaper error", exc_info=True)

    def _require(self, session_id: str) -> Session:
        sess = self._sessions.get(session_id)
        if sess is None:
            raise KeyError(session_id)
        return sess

    def session_count(self) -> int:
        return len(self._sessions)


manager = BrowserManager()
