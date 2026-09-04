"""fetch_url: the SSRF guard, the caps, and the text extraction.

No test here touches the real network. The address guard is exercised directly,
and the content behaviour runs the executor against a local ASGI fake mounted
by origin — so the code under test is the real one (guard, redirect walk, byte
cap, tag strip), not a rehearsal of it. These exercise the EXECUTOR at its own
layer; its journey through dispatch() (name lookup, argument parse, schema
check, run) is covered by the chat suites, not here.
"""
from __future__ import annotations

import pytest

from app.main import app
from app.tools import web
from app.tools.base import ERROR_PREFIX, ToolContext, ToolFailure
from tests import fakes

PUBLIC_ADDRESS = "93.184.216.34"


@pytest.fixture
def web_ctx(monkeypatch, tmp_path):
    """A context whose fetches reach the fake, with hosts resolved by a stub.

    `public.test` answers with a globally routable address so the guard
    runs in full and lets it through; `private.test` answers with an
    RFC1918 one so a redirect into it is refused by the same code.
    """
    fake = fakes.FakeWeb()

    async def resolve(host: str) -> list[str]:
        if host == "public.test":
            return [PUBLIC_ADDRESS]
        if host == "private.test":
            return ["10.0.0.5"]
        raise web.ToolFailure(f"could not resolve {host!r} — stubbed resolver")

    monkeypatch.setattr(web, "resolve_addresses", resolve)
    app.state.peer_transports = {fakes.WEB_ORIGIN: fakes.StreamingASGITransport(fake.app)}
    ctx = ToolContext(app=app, person=None, workspace_root=tmp_path)
    yield ctx, fake
    app.state.peer_transports = {}


async def _run(ctx, url: str) -> tuple[str, bool]:
    """Run the executor and adapt it to dispatch's (result, ok) shape — the
    same shape dispatch produces, minus the parse/validate step this layer
    isn't testing (a ToolFailure is a stated refusal; anything else propagates)."""
    try:
        return await web.fetch_url({"url": url}, ctx), True
    except ToolFailure as exc:
        return f"{ERROR_PREFIX}{exc}", False


async def _fetch(ctx, path: str) -> tuple[str, bool]:
    return await _run(ctx, f"{fakes.WEB_ORIGIN}{path}")


# -- the address guard, on its own -----------------------------------------

REFUSED = [
    ("ipv4 loopback", "127.0.0.1", "loopback"),
    ("ipv4 loopback range", "127.9.9.9", "loopback"),
    ("rfc1918 ten", "10.0.0.5", "private"),
    ("rfc1918 172", "172.16.4.4", "private"),
    ("rfc1918 192", "192.168.1.1", "private"),
    ("link local", "169.254.169.254", "link-local"),
    ("cgnat", "100.64.0.1", "carrier-grade NAT"),
    ("unspecified", "0.0.0.0", "unspecified"),
    ("multicast", "224.0.0.1", "multicast"),
    ("ipv6 loopback", "::1", "loopback"),
    ("ipv6 unique local", "fd00::1", "private"),
    ("ipv6 link local", "fe80::1", "link-local"),
    ("ipv4 mapped loopback", "::ffff:127.0.0.1", "loopback"),
    ("ipv4 mapped rfc1918", "::ffff:10.0.0.5", "private"),
]


@pytest.mark.parametrize(("label", "address", "why"), REFUSED, ids=[r[0] for r in REFUSED])
def test_non_global_addresses_are_refused_by_name(label, address, why):
    reason = web.refusal_for_address(address)
    assert reason is not None
    assert why in reason


@pytest.mark.parametrize("address", ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])
def test_public_addresses_are_allowed(address):
    assert web.refusal_for_address(address) is None


def test_something_that_is_not_an_address_at_all_is_refused():
    assert web.refusal_for_address("not-an-ip") is not None


# -- refusals through dispatch ---------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/x",
        "gopher://example.com/",
        "/relative/path",
    ],
)
async def test_only_http_and_https_are_fetched(web_ctx, url):
    ctx, fake = web_ctx
    result, ok = await _run(ctx, url)
    assert ok is False
    assert "http" in result
    assert fake.requested == []


async def test_a_host_that_resolves_privately_is_refused_before_connecting(web_ctx):
    ctx, fake = web_ctx
    result, ok = await _run(ctx, "http://private.test/secret")
    assert ok is False
    assert "10.0.0.5" in result
    assert "private" in result
    assert fake.requested == []


async def test_a_redirect_into_private_space_is_refused_at_the_hop(web_ctx):
    ctx, fake = web_ctx
    result, ok = await _fetch(ctx, "/redirect-to-private")
    assert ok is False
    assert "private" in result
    # The first hop was allowed and made; the second never was.
    assert fake.requested == ["/redirect-to-private"]


async def test_a_host_that_does_not_resolve_is_a_stated_error(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _run(ctx, "http://nowhere.test/x")
    assert ok is False
    assert "resolve" in result


async def test_more_than_three_redirects_is_refused(web_ctx):
    ctx, fake = web_ctx
    result, ok = await _fetch(ctx, "/hop/1")
    assert ok is False
    assert "redirect" in result
    assert fake.requested == ["/hop/1", "/hop/2", "/hop/3", "/hop/4"]


async def test_a_redirect_with_no_location_is_a_stated_error(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/redirect-without-location")
    assert ok is False
    assert "Location" in result


async def test_an_error_status_is_reported_not_returned_as_content(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/gone")
    assert ok is False
    assert "404" in result
    assert "nothing here" not in result


async def test_a_binary_content_type_is_refused_by_name(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/image.png")
    assert ok is False
    assert "image/png" in result


# -- content ---------------------------------------------------------------


async def test_plain_text_comes_back_whole(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/plain.txt")
    assert ok is True
    assert "just some text" in result
    assert "text/plain" in result  # the header states what was read


async def test_json_comes_back_as_json(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/data.json")
    assert ok is True
    assert '"temperature_c":21' in result.replace(" ", "")


async def test_html_is_reduced_to_its_text(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/page.html")
    assert ok is True
    assert "Tea & biscuits" in result  # entity unescaped
    assert "Steep for three minutes." in result
    assert "<p>" not in result and "<h1>" not in result
    assert "do not read me" not in result  # script bodies are not prose
    assert "color: red" not in result  # nor are stylesheets
    assert "a comment" not in result


async def test_a_redirect_is_followed_and_the_final_url_is_stated(web_ctx):
    ctx, fake = web_ctx
    result, ok = await _fetch(ctx, "/redirect")
    assert ok is True
    assert "Steep for three minutes." in result
    assert "/page.html" in result
    assert fake.requested == ["/redirect", "/page.html"]


async def test_a_large_page_is_capped_and_says_so(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/big.txt")
    assert ok is True
    assert result.count("z") == web.MAX_BYTES
    assert "truncated" in result
    assert str(web.MAX_BYTES) in result


async def test_the_request_is_a_GET(web_ctx):
    ctx, _fake = web_ctx
    result, ok = await _fetch(ctx, "/post-only")
    assert ok is True
    assert result.rstrip().endswith("GET")
