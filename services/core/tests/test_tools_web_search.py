"""web_search: the request shape, the JSON parse, and every failure stated.

No test here touches the real network. web_search is exercised against a local
ASGI SearXNG stand-in (fakes.FakeSearx) mounted by origin on the same by-URL
transport map fetch_url's tests use — so the code under test is the real one
(env read, request, JSON parse, formatting, caps), not a rehearsal of it. These
run the EXECUTOR at its own layer; web_search is auto-tiered, so its journey
through the policy gate in dispatch() is covered by the chat suites, not here.

The load-bearing property proved throughout: a search that FAILED (searxng
down, non-200, or a 200 that is not JSON) comes back as a stated ToolFailure —
never a fake-empty success. A search that genuinely found nothing is a
different, honest outcome (ok=True, said in words), and only reachable when
searxng actually answered.
"""
from __future__ import annotations

import httpx
import pytest

from app.main import app
from app.tools import web_search
from app.tools.base import ERROR_PREFIX, ToolContext, ToolFailure
from tests import fakes


@pytest.fixture
def search_ctx(monkeypatch, tmp_path):
    """A context whose web_search reaches a FakeSearx mounted on the searxng
    origin. The test sets `searx` up (results/status/body) before calling."""
    monkeypatch.setenv("SEARXNG_URL", fakes.SEARXNG_URL)
    searx = fakes.FakeSearx()
    app.state.peer_transports = {
        fakes.SEARXNG_URL: fakes.StreamingASGITransport(searx.app)
    }
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    yield ctx, searx
    app.state.peer_transports = {}


async def _run(ctx, **args) -> tuple[str, bool]:
    """Run the executor and adapt it to dispatch's (result, ok) shape — a
    ToolFailure is a stated refusal; anything else propagates as a real bug."""
    try:
        return await web_search.web_search(args, ctx), True
    except ToolFailure as exc:
        return f"{ERROR_PREFIX}{exc}", False


# -- the happy path --------------------------------------------------------


async def test_results_come_back_as_title_url_snippet(search_ctx):
    ctx, searx = search_ctx
    searx.results = (
        {"title": "OpenAI news", "url": "https://example.com/a", "content": "the latest"},
        {"title": "More news", "url": "https://example.com/b", "content": "also relevant"},
    )
    result, ok = await _run(ctx, query="latest on openai")
    assert ok is True
    # Each field of each result is present and readable.
    assert "OpenAI news" in result
    assert "https://example.com/a" in result
    assert "the latest" in result
    assert "More news" in result
    assert "https://example.com/b" in result


async def test_the_request_is_json_format_and_carries_the_query(search_ctx):
    ctx, searx = search_ctx
    searx.results = ({"title": "t", "url": "u", "content": "c"},)
    await _run(ctx, query="quantum computing")
    assert searx.queries == ["quantum computing"]
    assert searx.formats == ["json"]  # the JSON API, not the HTML page


async def test_a_blank_query_is_refused_before_any_request(search_ctx):
    ctx, searx = search_ctx
    result, ok = await _run(ctx, query="   ")
    assert ok is False
    assert "non-empty" in result
    assert searx.queries == []  # nothing was asked


async def test_no_results_is_an_honest_non_empty_answer_not_a_failure(search_ctx):
    ctx, searx = search_ctx
    searx.results = ()
    result, ok = await _run(ctx, query="asdfqwerzxcv no such thing")
    # SearXNG answered, and found nothing: ok=True, said in words. This is NOT a
    # failure, and it is NOT an empty string (which dispatch would reject).
    assert ok is True
    assert result.strip()
    assert "No web results" in result


# -- recency: news category, with a general fallback -----------------------
# Measured on live searxng: "latest / news / 2026" phrasing gets junk from the
# general engine and 143 relevant, current articles from categories=news. These
# pin that the recency path routes to news, falls back to general on an empty
# news day, and states a failure only when BOTH engines come back empty.


@pytest.mark.parametrize(
    "query",
    [
        "what's the latest on the pixel",
        "openai news",
        "quantum breakthroughs in 2026",
    ],
)
async def test_a_recency_query_hits_the_news_category(search_ctx, query):
    ctx, searx = search_ctx
    searx.results = ({"title": "t", "url": "https://example.com/n", "content": "c"},)
    result, ok = await _run(ctx, query=query)
    assert ok is True
    # One request, routed to the NEWS engine (the measured fix). News answered
    # with results, so there is no general fallback.
    assert searx.categories == ["news"]
    assert result.startswith("Top 1 news results")


async def test_a_non_recency_query_stays_on_the_general_engine(search_ctx):
    ctx, searx = search_ctx
    searx.results = ({"title": "t", "url": "https://example.com/g", "content": "c"},)
    result, ok = await _run(ctx, query="how to set up a raspberry pi")
    assert ok is True
    # No news category: a how-to must still get the general web engine.
    assert searx.categories == [""]
    assert "news" not in searx.categories
    assert result.startswith("Top 1 web results")


async def test_empty_news_falls_back_to_a_general_search(search_ctx):
    ctx, searx = search_ctx
    searx.news_results = ()  # a quiet news day
    searx.results = (
        {"title": "General hit", "url": "https://example.com/g", "content": "still relevant"},
    )
    result, ok = await _run(ctx, query="latest on the pixel")
    assert ok is True
    # News first (empty), THEN a general fallback that answered — two requests.
    assert searx.categories == ["news", ""]
    assert "General hit" in result
    assert result.startswith("Top 1 web results")  # labeled as web, not news


async def test_both_engines_empty_is_a_stated_failure_not_a_fake_empty(search_ctx):
    ctx, searx = search_ctx
    searx.results = ()
    searx.news_results = ()
    result, ok = await _run(ctx, query="latest on asdfqwerzxcv nonexistent")
    # Two searches (news, then general) both came back empty: a stated failure,
    # never a fake-empty "no results" for a live-info query.
    assert ok is False
    assert result.startswith(ERROR_PREFIX)
    assert searx.categories == ["news", ""]
    assert "no news or general web results" in result


# -- the recency marker detection itself -----------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "what's the latest on the pixel",
        "openai news",
        "recent AI papers",
        "current weather",
        "what happened today",
        "pixel 11 released",
        "google announcement",
        "updates to the tax code",
        "events this week",
        "best phone in 2026",
        "news",
    ],
)
def test_recency_phrasings_are_detected(query):
    assert web_search._is_recency_query(query) is True


@pytest.mark.parametrize(
    "query",
    [
        "how to set up a raspberry pi",
        "python list comprehension syntax",
        "capital of france",
        "newsletter design tips",  # whole-word: 'news' inside 'newsletter' must not trip
        "recentavsky biography",  # nor 'recent' inside a name
    ],
)
def test_non_recency_phrasings_are_not_detected(query):
    assert web_search._is_recency_query(query) is False


# -- caps ------------------------------------------------------------------


async def test_count_limits_how_many_results_are_returned(search_ctx):
    ctx, searx = search_ctx
    searx.results = tuple(
        {"title": f"t{i}", "url": f"https://example.com/{i}", "content": f"c{i}"}
        for i in range(8)
    )
    result, ok = await _run(ctx, query="many", count=3)
    assert ok is True
    assert "t0" in result and "t1" in result and "t2" in result
    assert "t3" not in result  # capped at the requested count
    assert result.startswith("Top 3 web results")


async def test_count_is_clamped_to_the_maximum(search_ctx):
    ctx, searx = search_ctx
    searx.results = tuple(
        {"title": f"t{i}", "url": f"https://example.com/{i}", "content": f"c{i}"}
        for i in range(20)
    )
    result, ok = await _run(ctx, query="lots", count=99)
    assert ok is True
    # Never more than MAX_RESULTS, no matter what count was asked.
    assert f"{web_search.MAX_RESULTS}." in result
    assert f"{web_search.MAX_RESULTS + 1}." not in result


async def test_a_long_snippet_is_capped_per_result(search_ctx):
    ctx, searx = search_ctx
    searx.results = (
        {"title": "t", "url": "https://example.com/x", "content": "z" * 5000},
    )
    result, ok = await _run(ctx, query="verbose")
    assert ok is True
    assert "z" * web_search.MAX_SNIPPET_CHARS in result
    assert "z" * (web_search.MAX_SNIPPET_CHARS + 1) not in result
    assert "…" in result  # the truncation is visible, not silent


# -- failure is stated, never faked as empty -------------------------------


async def test_a_non_200_is_a_stated_unavailable_not_an_empty_result(search_ctx):
    ctx, searx = search_ctx
    searx.status = 502
    result, ok = await _run(ctx, query="anything")
    assert ok is False
    assert result.startswith(ERROR_PREFIX)
    assert "web search is unavailable" in result
    assert "502" in result


async def test_a_200_that_is_not_json_is_stated_as_a_bot_filter(search_ctx):
    ctx, searx = search_ctx
    # The botdetection HTML block page: a 200, but HTML, not JSON — exactly what
    # settings.yml's `limiter: false` exists to prevent. It must be a stated
    # failure, never parsed as "no results".
    searx.body = "<!doctype html><html><body>Access denied</body></html>"
    searx.content_type = "text/html"
    result, ok = await _run(ctx, query="anything")
    assert ok is False
    assert "web search is unavailable" in result
    assert "non-JSON" in result


async def test_an_unreachable_search_service_is_stated_unavailable(monkeypatch, tmp_path):
    """searxng down / unreachable: httpx raises, and the tool states it could
    not reach the service rather than returning an empty (fake-success) list."""

    class _Down(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setenv("SEARXNG_URL", fakes.SEARXNG_URL)
    app.state.peer_transports = {fakes.SEARXNG_URL: _Down()}
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    try:
        result, ok = await _run(ctx, query="anything")
    finally:
        app.state.peer_transports = {}
    assert ok is False
    assert "web search is unavailable" in result
    assert "could not reach" in result


def test_the_web_search_tool_is_ephemeral():
    """Pin the flag the ingest skip derives from: a search is a live read. If a
    refactor drops it, the stale-results regurgitation bug returns silently."""
    assert any(t.name == "web_search" and t.ephemeral for t in web_search.TOOLS)
