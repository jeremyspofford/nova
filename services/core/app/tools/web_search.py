"""web_search — ask the bundled metasearch engine, hand back the top hits.

Nova has fetch_url for a URL she already knows, and had nothing for "what's
the latest on X" — so the model GUESSED a URL (openai.com/blog -> 403) and
then deflected. This is the tool that SEARCHES: it GETs the in-network
SearXNG JSON API and returns the top few results as readable text (title,
url, snippet) for the model to reason over or hand on to fetch_url.

A "latest / news / 2026"-style (recency) query is routed to SearXNG's NEWS
category — measured to return relevant, current articles where the general web
engine returns junk (see _is_recency_query) — with a single general fallback
when a quiet news day comes back empty. Every other query uses the general
engine as before.

SearXNG is a stock battery on the compose network — keyless and loopback-only
(deploy/docker-compose.yml binds 127.0.0.1) — so this is a plain GET, not a
bearer peer link the way the gateway/memory clients are. It is time-bounded
and length-capped, and a search that fails says so as a stated ToolFailure
("web search is unavailable: <reason>") rather than returning a fake-empty
"no results" that would read to the model as a successful, empty search. A
search that genuinely finds nothing is a different, honest outcome — reported
in words, ok=True — and only reachable when SearXNG actually answered.
"""
from __future__ import annotations

import asyncio
import os
import re
from urllib.parse import urlsplit

import httpx

from app.tools.base import Tool, ToolContext, ToolFailure

DEFAULT_SEARXNG_URL = "http://searxng:8080"
TOTAL_TIMEOUT_SECONDS = 10.0
DEFAULT_RESULTS = 5
MAX_RESULTS = 10
MAX_SNIPPET_CHARS = 300
MAX_TOTAL_CHARS = 4000
USER_AGENT = "Nova/0.0.1 (self-hosted assistant)"

# --- recency detection: which queries want fresh, current results -----------
# Measured on the live in-network SearXNG: "latest / news / 2026"-style phrasing
# gets JUNK from the general web engine (q="Google Pixel latest news 2026" →
# Google.com, About Google, Google Maps) but 143 relevant, current articles from
# the NEWS category (q="Google Pixel"&categories=news → "Pixel 11 Pro Review",
# "The best Google Pixel phone in 2026"…). So a RECENCY-oriented query is routed
# to categories=news instead of the general engine.
#
# This is the single, derived trigger — a query is recency-oriented when it
# carries any of these whole-word markers, any of these phrases, or a 4-digit
# 19xx/20xx year. It is mechanical and case-insensitive; edit HERE to tune it,
# and nothing downstream hardcodes "news" as the only category.
_RECENCY_WORDS = frozenset(
    {
        "latest",
        "news",
        "recent",
        "recently",
        "current",
        "currently",
        "today",
        "tonight",
        "yesterday",
        "update",
        "updates",
        "updated",
        "announce",
        "announced",
        "announcement",
        "release",
        "released",
    }
)
_RECENCY_PHRASES = ("this week", "this month", "this year", "just came out")
_RECENCY_YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
NEWS_CATEGORY = "news"


def _is_recency_query(query: str) -> bool:
    """True when the query asks for fresh/current info, so it should hit SearXNG's
    NEWS category rather than the general web engine (the measured fix).

    Mechanical and case-insensitive: a whole-word marker (so 'newsletter' does not
    trip 'news'), one of the multi-word phrases, or a 19xx/20xx year. Derived from
    the one marker list above — never a per-query special case."""
    lowered = query.lower()
    words = set(re.findall(r"[a-z]+", lowered))
    if _RECENCY_WORDS & words:
        return True
    if any(phrase in lowered for phrase in _RECENCY_PHRASES):
        return True
    return bool(_RECENCY_YEAR.search(lowered))


def _base_url() -> str:
    """The SearXNG root, read from core's env each call (never cached), with a
    default that matches the compose service name so a stock deployment needs
    no configuration at all."""
    return (os.environ.get("SEARXNG_URL") or DEFAULT_SEARXNG_URL).rstrip("/")


def _transport_for(app, origin: str):
    """The same by-origin ASGI map fetch_url reads (app.state.peer_transports):
    a test mounts a SearXNG stand-in on the searxng origin so the real request,
    JSON parse and formatting run with no socket. A deployment has no entry, so
    this is None and httpx connects to the container on the compose network."""
    transports = getattr(getattr(app, "state", None), "peer_transports", None) or {}
    return transports.get(origin)


def _clean(value: object) -> str:
    """A result field as a single trimmed line — SearXNG snippets can carry
    newlines, and a title/url that spilled across lines would break the
    numbered layout the model reads."""
    return " ".join(str(value or "").split())


def _format(query: str, payload: dict, limit: int, kind: str = "web") -> str:
    """The JSON results as the numbered title/url/snippet block the model reads.

    `kind` labels which engine answered — "news" (the recency path) or "web"
    (the general engine) — so the model and the Activity view can see which ran.
    An empty result list is an HONEST outcome (SearXNG answered, and found
    nothing), stated in words rather than returned as an empty string — an
    empty tool result reads to the model as "it worked, nothing to say", which
    dispatch() rejects anyway. A snippet is capped per-result and the whole
    block is capped overall, so one verbose engine cannot blow the turn's
    context budget.
    """
    results = payload.get("results") or []
    if not results:
        return f'No {kind} results were found for "{query}".'

    lines = [f'Top {min(len(results), limit)} {kind} results for "{query}":', ""]
    for number, item in enumerate(results[:limit], start=1):
        title = _clean(item.get("title")) or "(untitled)"
        url = _clean(item.get("url"))
        snippet = _clean(item.get("content"))
        if len(snippet) > MAX_SNIPPET_CHARS:
            snippet = snippet[:MAX_SNIPPET_CHARS].rstrip() + "…"
        lines.append(f"{number}. {title}")
        if url:
            lines.append(f"   {url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")

    text = "\n".join(lines).rstrip()
    if len(text) > MAX_TOTAL_CHARS:
        text = text[:MAX_TOTAL_CHARS].rstrip() + "\n[…results truncated]"
    return text


async def _do_search(query: str, categories: str | None, ctx: ToolContext) -> dict:
    """One SearXNG JSON GET + parse. Returns the parsed payload (whose results
    may legitimately be empty — an honest "found nothing"); raises a stated
    ToolFailure when the SERVICE itself is unavailable (down/unreachable,
    non-200, or a 200 that is not JSON), so a failure is never mistaken for an
    empty result. `categories` adds &categories=<group> to route the query to a
    specific engine group (e.g. "news"); None is the general default.

    Keyless, in-network, time-bound (each call gets its own budget), on the same
    by-origin transport map fetch_url uses — unchanged from the single-search
    original; only the category parameter and the split into a reusable helper
    are new."""
    base = _base_url()
    parts = urlsplit(base)
    origin = f"{parts.scheme}://{parts.netloc}"
    url = f"{base}/search"
    params = {"q": query, "format": "json"}
    if categories:
        params["categories"] = categories

    try:
        async with asyncio.timeout(TOTAL_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(TOTAL_TIMEOUT_SECONDS),
                transport=_transport_for(ctx.app, origin),
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            ) as client:
                response = await client.get(url, params=params)
    except TimeoutError as exc:
        raise ToolFailure(
            f"web search is unavailable: the search service did not answer within "
            f"{TOTAL_TIMEOUT_SECONDS:g} seconds"
        ) from exc
    except httpx.HTTPError as exc:
        # SearXNG down, unreachable, or DNS gone — a real failure, not an empty
        # result. Named as unavailable so the model relays "I could not search"
        # rather than "I searched and found nothing".
        raise ToolFailure(
            f"web search is unavailable: could not reach the search service — "
            f"{type(exc).__name__}: {exc}"
        ) from exc

    if response.status_code != 200:
        raise ToolFailure(
            f"web search is unavailable: the search service answered "
            f"{response.status_code} {response.reason_phrase}".strip()
        )
    try:
        return response.json()
    except ValueError as exc:
        # A 200 that is not JSON is the botdetection/limiter serving an HTML
        # block page — the exact failure settings.yml's `limiter: false` exists
        # to prevent. Stated, never parsed as "no results".
        raise ToolFailure(
            "web search is unavailable: the search service returned a non-JSON "
            "response (its bot filter may be blocking this request) — "
            f"{exc}"
        ) from exc


async def web_search(args: dict, ctx: ToolContext) -> str:
    query = _clean(args.get("query"))
    if not query:
        raise ToolFailure("web search needs a non-empty query")
    limit = int(args.get("count") or DEFAULT_RESULTS)
    limit = max(1, min(limit, MAX_RESULTS))

    if _is_recency_query(query):
        # Recency phrasing gets junk from the general engine and relevant, current
        # hits from the NEWS category (measured) — so try news first. A news-engine
        # outage is NOT an empty day: swallow it here so the general fallback below
        # still gets its turn, and a stated failure only surfaces if BOTH engines
        # are unavailable.
        try:
            news = await _do_search(query, NEWS_CATEGORY, ctx)
            news_results = news.get("results") or []
        except ToolFailure:
            news, news_results = None, []
        if news_results:
            return _format(query, news, limit, kind="news")

        # No news results (a quiet news day, or the news engine was down): ONE
        # general fallback, so a real answer still surfaces. If general is also
        # unavailable, _do_search raises here — the "both unavailable" case.
        general = await _do_search(query, None, ctx)
        if general.get("results"):
            return _format(query, general, limit, kind="web")

        # News empty AND general empty: two engines, nothing found. State it rather
        # than hand back a fake-empty "no results" for a live-info query — this
        # pairs with the prompt nudge telling the model to refine and search again.
        raise ToolFailure(
            f'web search found no news or general web results for "{query}" — '
            "try a broader or reworded query"
        )

    # Non-recency (how-to, definitions, facts): the general engine as before. An
    # empty result here is the honest "found nothing", said in words by _format.
    payload = await _do_search(query, None, ctx)
    return _format(query, payload, limit, kind="web")


TOOLS: tuple[Tool, ...] = (
    Tool(
        name="web_search",
        description=(
            "Search the public web and get back the top results, each with its "
            "title, URL, and a short snippet. Use this whenever you need current "
            "or recent information, or when you do not already know the exact "
            "page: 'what's the latest on X', 'news about Y', 'find Z online', "
            "questions about recent events. Do NOT guess a URL and pass it to "
            "fetch_url — search first to find the real page, then use fetch_url "
            "on a result's URL only if you need that page's full text."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search the web for, in plain words.",
                },
                "count": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_RESULTS,
                    "description": f"How many results to return (default {DEFAULT_RESULTS}).",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        executor=web_search,
        reads_only=True,
        # Search results are a live, time-sensitive read, exactly like fetch_url:
        # the turn is NOT ingested into long-term memory, so a later "what's the
        # latest?" re-searches instead of recalling a stale snapshot and serving
        # it as current (round 5 — same reasoning as web.py).
        ephemeral=True,
    ),
)
