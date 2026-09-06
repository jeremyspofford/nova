"""app/cache.py — a cached answer is the answer fetched THEN, not now.

The catalogue labels every fact with its fetch time. A cache that restamped
"now" on each read would claim a freshness nobody checked, so the one
property these tests defend is that `get` hands back the ORIGINAL
`fetched_at` and that an expired entry is gone rather than stale.
"""
from __future__ import annotations

from datetime import datetime

import pytest

from app.cache import TTLCache


class Clock:
    def __init__(self, start: float = 100.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t


def _stamps(*values: str):
    it = iter(values)
    return lambda: next(it)


def test_put_returns_the_fetch_time_and_get_hands_it_back_unchanged():
    clock = Clock()
    cache = TTLCache(ttl_s=60, clock=clock, now_iso=_stamps("T0", "T1"))
    assert cache.put("k", {"a": 1}) == "T0"
    clock.t += 30
    # Thirty seconds later the answer is still the one fetched at T0.
    assert cache.get("k") == ({"a": 1}, "T0")
    assert cache.get("k") == ({"a": 1}, "T0")


def test_a_missing_key_is_none_never_a_default():
    cache = TTLCache(ttl_s=60)
    assert cache.get("nope") is None


def test_an_expired_entry_is_gone_not_stale():
    clock = Clock()
    cache = TTLCache(ttl_s=60, clock=clock)
    cache.put("k", "v")
    clock.t += 59.9
    assert cache.get("k") is not None
    clock.t += 0.1
    assert cache.get("k") is None
    assert len(cache) == 0


def test_ttl_none_never_expires():
    clock = Clock()
    cache = TTLCache(ttl_s=None, clock=clock, now_iso=_stamps("T0"))
    cache.put("digest", "facts")
    clock.t += 10_000_000
    assert cache.get("digest") == ("facts", "T0")


def test_a_re_put_replaces_the_value_and_the_fetch_time():
    cache = TTLCache(ttl_s=None, now_iso=_stamps("T0", "T1"))
    cache.put("k", 1)
    assert cache.put("k", 2) == "T1"
    assert cache.get("k") == (2, "T1")
    assert len(cache) == 1


def test_bounded_the_oldest_entry_is_evicted_first():
    cache = TTLCache(ttl_s=None, max_entries=2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)
    assert cache.get("a") is None
    assert cache.get("b")[0] == 2
    assert cache.get("c")[0] == 3
    assert len(cache) == 2


def test_a_re_put_counts_as_the_newest_for_eviction():
    cache = TTLCache(ttl_s=None, max_entries=2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("a", 3)  # refreshed: now the newest, so "b" is the oldest
    cache.put("c", 4)
    assert cache.get("b") is None
    assert cache.get("a")[0] == 3


def test_clear_forgets_everything():
    cache = TTLCache(ttl_s=None)
    cache.put("a", 1)
    cache.clear()
    assert cache.get("a") is None
    assert len(cache) == 0


def test_default_fetched_at_is_a_utc_iso_timestamp():
    cache = TTLCache(ttl_s=None)
    fetched_at = cache.put("k", "v")
    parsed = datetime.fromisoformat(fetched_at)
    assert parsed.tzinfo is not None and parsed.utcoffset().total_seconds() == 0


@pytest.mark.parametrize("bad", [0, -1])
def test_a_non_positive_ttl_is_refused_not_read_as_never(bad):
    with pytest.raises(ValueError):
        TTLCache(ttl_s=bad)


def test_a_cache_with_no_room_is_refused():
    with pytest.raises(ValueError):
        TTLCache(ttl_s=None, max_entries=0)


def test_put_keeps_a_stamp_the_caller_already_took():
    """A source answered at T; the cache must not re-stamp the value at the
    later instant it was stored — the fetch time travels with the value."""
    cache = TTLCache(ttl_s=None)
    assert cache.put("k", 1, "2026-09-06T12:00:00+00:00") == "2026-09-06T12:00:00+00:00"
    assert cache.get("k") == (1, "2026-09-06T12:00:00+00:00")
