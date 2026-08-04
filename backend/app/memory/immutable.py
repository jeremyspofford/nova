"""Which memory documents can honestly go stale.

`_list_stale_topics` used to answer that with a date alone: any topic with a
source_url, learned more than N days ago. That put 202 of 220 topics on a
refresh queue and burned 50 unattended automation runs on the same three
YouTube videos from 2026-07-22, because a recorded video is immutable — no
amount of re-fetching makes it newer, and the refresh never succeeded, so it
never bumped the timestamp and stayed the oldest thing in the list forever.

Three classes of document cannot go stale, and each is settled MECHANICALLY,
from state the backend writes, not from anything a model says:

  recording       the ingest ledger (`media_ingests`) holds the item_id and the
                  URL of everything ingest_media ever wrote. Membership is
                  proof, and it survives the frontmatter stamp being wrong —
                  which it demonstrably can be: one live transcript
                  (topics/what-is-an-ai-harness-…-full-transcript.md) reads
                  `source_type: tool` because write_memory stamps that literal
                  for every caller and write_concept merged it caller-wins.

  followed_source a channel page whose feed is in `source_subscriptions`. That
                  is `poll-followed-sources`' job, not the refresh sweep's, and
                  fetch_url cannot read a JS-rendered YouTube channel anyway.
                  DERIVED: unfollow the channel and the exclusion disappears by
                  itself, with no edit here.

  summary         a distillation, regenerated from its source by the
                  summariser — never re-fetched. The refresh workflow would
                  overwrite it with raw page bytes.

Nothing here is a list of URLs or titles someone has to maintain. Every signal
is a query against state some other part of the backend already owns, which is
the only version of this that survives a corpus it has not seen.
"""

from typing import Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app import db

# Written by code, never by a model: tools/builtin.py and summariser.py hold
# the only two literals, and no tool schema exposes source_type as an input.
# It is a corroborating signal, not the primary one — the ledger is primary
# precisely because a stamp can be overwritten and one already was.
_RECORDED_SOURCE_TYPES = frozenset({"media_transcript"})


def _host(netloc: str) -> str:
    """Lowercased, with `www.` folded away.

    Every subscription on this install is stored as `www.youtube.com/...` while
    plenty of source_url stamps omit it. Comparing netloc literally made those
    two spellings different sources, so the match silently depended on which
    form happened to be written.
    """
    host = (netloc or "").lower()
    return host[4:] if host.startswith("www.") else host


def canonical(url: str) -> str:
    """A transcript chunk's source_url is its recording's URL plus an offset.

    media ingest appends `t=<n>s` (youtube) or a `#t=` fragment to point at the
    moment a chunk starts, so a chunk's URL never equals the ledger's URL
    literally. Strip the offset and the fragment so both sides compare equal.
    """
    p = urlsplit((url or "").strip())
    q = [(k, v) for k, v in parse_qsl(p.query) if k not in ("t", "start")]
    return urlunsplit((p.scheme.lower(), _host(p.netloc), p.path,
                       urlencode(q), ""))


def _segments(url: str) -> tuple[str, list[str]]:
    """Host and lowercased path segments.

    Path case is folded because these are compared against subscription URLs
    and a YouTube handle is case-insensitive: the same channel is stamped
    `@AILABS-393` on one document and `@ailabs-393` on another.
    """
    p = urlsplit((url or "").strip())
    return _host(p.netloc), [s.lower() for s in p.path.split("/") if s]


def page_key(url: str) -> str:
    """Host plus full path — the identity of one page, query dropped."""
    host, segs = _segments(url)
    return f"{host}/{'/'.join(segs)}" if segs else host


def parent_key(url: str) -> Optional[str]:
    """The page one path segment up, or None when that would be a bare host.

    The guard is the point. A subscription stored as `example.com/feed.xml`
    has no meaningful parent, and admitting a bare host as a feed key would
    exclude every page on that site from ever going stale.
    """
    host, segs = _segments(url)
    return f"{host}/{'/'.join(segs[:-1])}" if len(segs) > 1 else None


def feed_keys(sub_url: str) -> set[str]:
    """What counts as a subscription's OWN page: itself, and one level up.

    One level, not a subtree. The tolerance exists for exactly one reason —
    a channel is followed as `@X/videos` and stamped on documents as `@X`,
    `@X/videos` or `@X/streams`, and those are the same page — so it is scoped
    to that and no further.

    The rule it replaces took host + FIRST path segment, which is the same
    answer for a YouTube channel and an arbitrary one for anything else: a
    source followed at `example.com/blog/feed` excluded the whole of
    `/blog/**` forever, while one followed at `example.com/feed.xml` excluded
    nothing at all. Same function, opposite behaviour, decided by the shape of
    a URL nobody chose. Every subscription here is `youtubetab` today, so that
    was latent rather than live — it would have landed with the first
    non-YouTube source followed.

    What survives is one bounded, explainable case: a page that is a SIBLING
    of the followed feed is treated as the source's own page. `/blog/post-1`
    beside `/blog/feed` still matches; `/blog/2026/post-1` no longer does.
    """
    keys = {page_key(sub_url)}
    parent = parent_key(sub_url)
    if parent:
        keys.add(parent)
    return keys


def is_followed_page(url: str, feeds: set[str]) -> bool:
    """Is this URL the page of a source something else already polls?"""
    if not url:
        return False
    if page_key(url) in feeds:
        return True
    parent = parent_key(url)
    return bool(parent and parent in feeds)


async def signals() -> dict:
    """One database trip. media_ingests is ~114 rows, subscriptions is 4."""
    async with db.acquire() as conn:
        ingests = await conn.fetch(
            "SELECT full_transcript_item_id, url FROM media_ingests")
        subs = await conn.fetch(
            "SELECT url FROM source_subscriptions WHERE enabled")
    return {
        "ids": {r["full_transcript_item_id"] for r in ingests
                if r["full_transcript_item_id"]},
        "urls": {canonical(r["url"]) for r in ingests if r["url"]},
        "feeds": {k for r in subs if r["url"] for k in feed_keys(r["url"])},
    }


def empty_signals() -> dict:
    """No exclusions — for replays and tests that must not read live tables."""
    return {"ids": set(), "urls": set(), "feeds": set()}


def why_skip(doc_id: str, fm: dict, sig: dict) -> str | None:
    """None means this document can honestly go stale. Otherwise, the reason."""
    from app import summariser

    url = str(fm.get("source_url") or "")
    if (doc_id in sig["ids"]
            or str(fm.get("source_type") or "").strip().lower()
            in _RECORDED_SOURCE_TYPES
            or canonical(url) in sig["urls"]):
        return "recording"
    if is_followed_page(url, sig["feeds"]):
        return "followed_source"
    if str(fm.get("title") or "").endswith(summariser.SUMMARY_SUFFIX):
        return "summary"
    return None
