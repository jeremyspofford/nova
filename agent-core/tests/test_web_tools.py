"""Web tools: provider chain, readability extraction, fallbacks.

Mocked-provider tests are deterministic; two tests do real network fetches
(this suite's sandbox has outbound web) and skip on connection failure so
air-gapped runs stay green.
"""
import uuid

import httpx
import pytest
from app.config import settings
from app.tools.context import ToolContext
from app.tools.tools_builtin import web


def make_ctx() -> ToolContext:
    return ToolContext(
        idempotency_key="t", task_id=uuid.uuid4(), call_id=uuid.uuid4(),
        caller_role="test", caller_caps=["*"], pool=None,
        snapshot=None, request_approval=None,
    )


class FakeResponse:
    def __init__(self, *, json_data=None, text="", content_type="application/json", status=200):
        self._json = json_data
        self.text = text
        self.headers = {"content-type": content_type}
        self.status_code = status

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


def fake_http(responses: dict[str, FakeResponse]):
    """Route by substring of the URL; record calls."""
    calls = []

    async def _get(url, *, params=None, headers=None, timeout=25.0):
        calls.append(url)
        for frag, resp in responses.items():
            if frag in url:
                return resp
        raise httpx.ConnectError(f"no route for {url}")
    return _get, calls


# ── search provider chain ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_searxng_wins_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080")
    get, calls = fake_http({
        "searxng": FakeResponse(json_data={"results": [
            {"title": "T1", "url": "https://a", "content": "S1"},
            {"title": "T2", "url": "https://b", "content": "S2"},
        ]}),
    })
    monkeypatch.setattr(web, "_http_get", get)

    out = await web.web_search("nova ai", ctx=make_ctx())
    assert out["provider"] == "searxng"
    assert [r["url"] for r in out["results"]] == ["https://a", "https://b"]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_chain_falls_through_searxng_to_brave(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080")
    get, calls = fake_http({
        "searxng": FakeResponse(status=500, json_data={}),
        "brave.com": FakeResponse(json_data={"web": {"results": [
            {"title": "B", "url": "https://brave-hit", "description": "D"},
        ]}}),
    })
    monkeypatch.setattr(web, "_http_get", get)

    async def fake_key(ctx):
        return "brave-key"
    monkeypatch.setattr(web, "_brave_key", fake_key)

    out = await web.web_search("q", ctx=make_ctx())
    assert out["provider"] == "brave"
    assert out["results"][0]["url"] == "https://brave-hit"


@pytest.mark.asyncio
async def test_ddg_is_last_resort_with_note(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "")
    get, _ = fake_http({
        "duckduckgo": FakeResponse(json_data={"AbstractText": "", "RelatedTopics": []}),
    })
    monkeypatch.setattr(web, "_http_get", get)

    async def no_key(ctx):
        return None
    monkeypatch.setattr(web, "_brave_key", no_key)

    out = await web.web_search("q", ctx=make_ctx())
    assert out["provider"] == "ddg-instant"
    assert out["results"] == []
    assert "SEARXNG_URL" in out["note"]


@pytest.mark.asyncio
async def test_all_providers_failing_reports_errors(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080")
    get, _ = fake_http({})  # every URL raises ConnectError
    monkeypatch.setattr(web, "_http_get", get)

    async def no_key(ctx):
        return None
    monkeypatch.setattr(web, "_brave_key", no_key)

    out = await web.web_search("q", ctx=make_ctx())
    assert out["provider"] == "none"
    assert "searxng" in out["error"] and "ddg" in out["error"]


# ── fetch / readability ───────────────────────────────────────────────────────

ARTICLE_HTML = """<html><head><title>The Test Article</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article><h1>The Test Article</h1>
<p>Readable extraction turns markup into clean prose so the model's context
window carries content, not angle brackets. This paragraph is the body that
must survive extraction while navigation chrome disappears.</p>
<p>A second paragraph keeps the article long enough for the extractor to
treat it as real content rather than boilerplate.</p></article>
<footer>© corp · privacy · terms</footer></body></html>"""


@pytest.mark.asyncio
async def test_fetch_extracts_readable_text(monkeypatch):
    get, _ = fake_http({"article": FakeResponse(text=ARTICLE_HTML, content_type="text/html")})
    monkeypatch.setattr(web, "_http_get", get)

    out = await web.web_fetch("https://x/article", ctx=make_ctx())
    assert out["extracted"] is True
    assert "clean prose" in out["content"]
    assert "<" not in out["content"]
    assert "privacy" not in out["content"], "footer chrome should be stripped"


@pytest.mark.asyncio
async def test_fetch_json_passthrough(monkeypatch):
    get, _ = fake_http({"api": FakeResponse(text='{"k": 1}', content_type="application/json")})
    monkeypatch.setattr(web, "_http_get", get)

    out = await web.web_fetch("https://x/api", ctx=make_ctx())
    assert out["extracted"] is False
    assert out["content"] == '{"k": 1}'


@pytest.mark.asyncio
async def test_fetch_html_without_article_strips_tags(monkeypatch):
    html = "<html><body><a href='/1'>one</a><a href='/2'>two</a></body></html>"
    get, _ = fake_http({"links": FakeResponse(text=html, content_type="text/html")})
    monkeypatch.setattr(web, "_http_get", get)

    out = await web.web_fetch("https://x/links", ctx=make_ctx())
    assert "<" not in out["content"]
    assert "one" in out["content"]


@pytest.mark.asyncio
async def test_fetch_binary_guard(monkeypatch):
    get, _ = fake_http({"img": FakeResponse(text="", content_type="image/png")})
    monkeypatch.setattr(web, "_http_get", get)

    out = await web.web_fetch("https://x/img", ctx=make_ctx())
    assert out["content"].startswith("[binary:")


# ── live network (skip cleanly when offline) ─────────────────────────────────


@pytest.mark.asyncio
async def test_live_fetch_example_dot_com():
    try:
        out = await web.web_fetch("https://example.com", ctx=make_ctx())
    except Exception:
        pytest.skip("no outbound network")
    assert out["status"] == 200
    # trafilatura returns the body prose (the <h1> heading is chrome to it).
    assert "domain" in out["content"].lower()
    assert "<html" not in out["content"]


@pytest.mark.asyncio
async def test_live_fetch_wikipedia_extracts_article():
    try:
        out = await web.web_fetch(
            "https://en.wikipedia.org/wiki/Wake-on-LAN", ctx=make_ctx()
        )
    except Exception:
        pytest.skip("no outbound network")
    assert out["extracted"] is True
    assert "magic packet" in out["content"].lower()
    assert "<div" not in out["content"]
