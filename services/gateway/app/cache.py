"""A small, bounded, process-local cache that remembers WHEN each answer
was fetched.

The catalogue's rail: every fact a route returns carries its source and
fetch time. A cached answer is the answer that was fetched at its ORIGINAL
time, so `get` hands the value back with the `fetched_at` it was stored
under and the caller marks the row `cached: true` — restamping "now" on
every read would claim a freshness nobody checked.

`ttl_s=None` (never expires) is for content-addressed keys such as an
ollama digest: the content cannot go stale under its own digest, and a
re-pull simply produces a new key. Bounded because a cache keyed by free
text (a search string) would otherwise grow for the life of the process.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from datetime import UTC, datetime
from typing import Any


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class TTLCache:
    """`clock` (monotonic seconds) decides expiry; `now_iso` stamps
    `fetched_at`. Both are injectable so a test can move time without
    sleeping."""

    def __init__(
        self,
        ttl_s: float | None,
        *,
        max_entries: int = 512,
        clock: Callable[[], float] = time.monotonic,
        now_iso: Callable[[], str] = _utc_now_iso,
    ) -> None:
        if ttl_s is not None and ttl_s <= 0:
            raise ValueError("ttl_s must be a positive number of seconds, or None for never")
        if max_entries < 1:
            raise ValueError("max_entries must be at least 1")
        self.ttl_s = ttl_s
        self.max_entries = max_entries
        self._clock = clock
        self._now_iso = now_iso
        # key -> (value, fetched_at, expires_at | None); insertion order is
        # eviction order, and a re-put moves the key to the newest end.
        self._entries: OrderedDict[Hashable, tuple[Any, str, float | None]] = OrderedDict()

    def get(self, key: Hashable) -> tuple[Any, str] | None:
        """The value and the fetch time it was stored with, or None when
        the key is unknown or has expired (an expired entry is dropped on
        the spot, so it can never be served stale)."""
        entry = self._entries.get(key)
        if entry is None:
            return None
        value, fetched_at, expires_at = entry
        if expires_at is not None and self._clock() >= expires_at:
            del self._entries[key]
            return None
        return value, fetched_at

    def put(self, key: Hashable, value: Any) -> str:
        """Store `value` under `key` and return the `fetched_at` it was
        stamped with — the caller labels its row with that same string."""
        fetched_at = self._now_iso()
        expires_at = None if self.ttl_s is None else self._clock() + self.ttl_s
        if key in self._entries:
            del self._entries[key]
        self._entries[key] = (value, fetched_at, expires_at)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)
        return fetched_at

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)
