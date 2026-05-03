"""Privacy denylist: drop sessions matching any of three sub-lists."""

import re
from dataclasses import dataclass


@dataclass
class Denylist:
    apps: list[str]
    url_patterns: list[str]
    window_titles: list[str]

    def __post_init__(self) -> None:
        self._compiled_url_patterns = [re.compile(p) for p in self.url_patterns]
        self._lower_window_titles = [w.lower() for w in self.window_titles]

    def matches(self, session: dict) -> bool:
        return self._matches_with_reason(session) is not None

    def matches_with_reason(self, session: dict) -> str | None:
        return self._matches_with_reason(session)

    def _matches_with_reason(self, session: dict) -> str | None:
        app = session.get("app") or ""
        window = (session.get("window") or "").lower()
        url = session.get("url")
        if app in self.apps:
            return "denylist_app"
        if url and any(p.search(url) for p in self._compiled_url_patterns):
            return "denylist_url"
        if window and any(t in window for t in self._lower_window_titles):
            return "denylist_window"
        return None
