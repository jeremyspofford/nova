"""The one way core calls the engine (S38): the pinned engine's era, its
refusals passed on as answers, a call it could not make stated, and one
tool's calls never split by another's."""

from __future__ import annotations

import asyncio

import pytest

from app.browser import engine
from app.mcp import client, fake
from tests.browser_engine import ORIGIN, engine_tool, fake_engine


async def test_the_engine_is_spoken_to_in_its_own_era_and_its_answer_is_read():
    with fake_engine(engine_tool("browser_navigate", "navigate-index")) as server:
        async with engine.session():
            answer = await engine.call("browser_navigate", {"url": "http://site:8000/index.html"})
    assert (answer.url, answer.title, answer.error) == (
        "http://site:8000/index.html",
        "Capture index",
        None,
    )
    methods = [call["method"] for call in server.calls]
    assert "initialize" in methods and methods[-1] == "tools/call"


async def test_the_engines_own_refusal_is_the_answers_error():
    with fake_engine(engine_tool("browser_click", "click-stale-ref")):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e9999"})
    assert answer.error == (
        "Ref e9999 not found in the current page snapshot. Try capturing new snapshot."
    )


async def test_an_error_with_no_error_section_still_says_what_it_was():
    tool = fake.FakeTool("browser_click", results=({"text": "boom: it broke", "is_error": True},))
    with fake_engine(tool):
        async with engine.session():
            answer = await engine.call("browser_click", {"target": "e1"})
    assert answer.error == "boom: it broke"


async def test_an_unreachable_engine_is_a_stated_failure():
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        with pytest.raises(engine.EngineError) as caught:
            async with engine.session():
                await engine.call("browser_navigate", {"url": "https://example.com"})
    finally:
        client.unplant(handle)
    assert caught.value.reason.startswith(
        "the browser engine is not answering at http://browser:8931"
    )


async def test_the_address_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv(engine.ENDPOINT_ENV, "http://elsewhere:9999/mcp")
    assert engine.endpoint().origin == "http://elsewhere:9999"
    monkeypatch.delenv(engine.ENDPOINT_ENV)
    assert engine.endpoint().url == engine.DEFAULT_URL


async def test_two_opens_at_once_never_interleave_their_calls():
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")

    async def open_and_read(url: str) -> None:
        async with engine.session():
            await engine.call("browser_navigate", {"url": url})
            await asyncio.sleep(0)  # give the other task every chance to cut in
            await engine.call("browser_snapshot", {})

    with fake_engine(navigate, snapshot) as server:
        await asyncio.gather(open_and_read("http://a.example/"), open_and_read("http://b.example/"))
    names = [call["params"]["name"] for call in server.calls if call["method"] == "tools/call"]
    assert names == ["browser_navigate", "browser_snapshot"] * 2
