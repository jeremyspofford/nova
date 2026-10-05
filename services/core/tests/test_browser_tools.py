"""Her five browser tools (S38), over a strict fake of the pinned engine
answering with its own captured words (tests/browser_engine.py)."""

from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app import addresses, chat, tools, traces
from app.browser import engine, files, reader
from app.browser import page as page_module
from app.mcp import client, fake
from app.tools import browser
from app.tools.base import ToolContext, ToolFailure
from tests.browser_engine import ORIGIN, answer_text, engine_tool, fake_engine

INDEX = "http://site:8000/index.html"
REPORT = b"report body line one\nreport body line two\n"


@pytest.fixture
def world(tmp_path: Path, monkeypatch):
    output = tmp_path / "engine-output"
    workspace = tmp_path / "workspace"
    output.mkdir()
    workspace.mkdir()
    monkeypatch.setenv(files.OUTPUT_DIR_ENV, str(output))
    facts: list = []
    ctx = ToolContext(app=None, person=object(), workspace_root=workspace, facts_sink=facts)
    return ctx, output, workspace, facts


def _called(server) -> list[tuple[str, dict]]:
    return [
        (call["params"]["name"], call["params"].get("arguments") or {})
        for call in server.calls
        if call["method"] == "tools/call"
    ]


# ── browser_open ────────────────────────────────────────────────────────────


async def test_open_outlines_the_page_and_files_one_page_fact(world):
    ctx, _, _, facts = world
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")
    with fake_engine(navigate, snapshot) as server:
        result = await browser.browser_open({"url": INDEX}, ctx)
    assert result.splitlines() == [
        'Opened http://site:8000/index.html — "Capture index".',
        "Headings: Capture index.",
        "It has 2 links, 2 buttons and 2 fields; 379 characters of text in 1 part of 24,000.",
        'Read it with browser_read(part=1), or search it with browser_read(query="…").',
    ]
    assert facts == [{"browser": "page", "url": INDEX, "title": "Capture index", "status": None}]
    assert _called(server) == [("browser_navigate", {"url": INDEX}), ("browser_snapshot", {})]


async def test_open_takes_http_and_https_only(world):
    ctx = world[0]
    with pytest.raises(ToolFailure, match="http and https addresses only"):
        await browser.browser_open({"url": "file:///etc/passwd"}, ctx)


async def test_an_error_page_is_a_stated_failure_that_names_its_status(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_navigate", "navigate-404")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": "http://site:8000/missing.html"}, ctx)
    assert "answered 404 File not found" in str(caught.value)
    assert "error page" in str(caught.value)
    assert facts[0]["status"] == 404


async def test_a_page_that_does_not_load_says_why(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_navigate", "navigate-dns-failure")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": "http://no-such-host.invalid/"}, ctx)
    assert str(caught.value) == (
        "http://no-such-host.invalid/ did not open: "
        "net::ERR_NAME_NOT_RESOLVED at http://no-such-host.invalid/"
    )


# ── browser_read ────────────────────────────────────────────────────────────


async def test_read_gives_a_part_of_the_page_it_names(world):
    ctx, _, _, facts = world
    # m5: the rendered-text expectations come from the reader over the same
    # capture, never hand-written.
    expected = reader.read(page_module.parse(answer_text("snapshot-long")).snapshot or "")
    with fake_engine(engine_tool("browser_snapshot", "snapshot-long")):
        first = await browser.browser_read({}, ctx)
        second = await browser.browser_read({"part": 2}, ctx)
        with pytest.raises(ToolFailure, match="has 2 parts; there is no part 3"):
            await browser.browser_read({"part": 3}, ctx)
    # m12: her own lines (the header) come before the page's; a marker line
    # names where the page's own text begins.
    assert first.splitlines()[0] == 'http://site:8000/long.html — "A long page"'
    assert first.splitlines()[1] == "Page text (part 1 of 2):"
    assert first.splitlines()[2] == ""
    assert first.splitlines()[3] == expected.parts[0].splitlines()[0]
    assert second.splitlines()[1] == "Page text (part 2 of 2):"
    assert second.splitlines()[3] == expected.parts[1].splitlines()[0]
    assert facts[0] == {
        "browser": "page",
        "url": "http://site:8000/long.html",
        "title": "A long page",
        "status": None,
    }


async def test_read_searches_by_every_word(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_snapshot", "snapshot-long")):
        found = await browser.browser_read({"query": "zebra-quartz"}, ctx)
        many = await browser.browser_read({"query": "many details"}, ctx)
        missing = await browser.browser_read({"query": "zebra-quartz unicorn"}, ctx)
    assert found.splitlines() == [
        "http://site:8000/long.html — \"A long page\" · 1 line holds every word of 'zebra-quartz':",
        "- part 2 under '# A long page': The needle sentence is here: zebra-quartz lives in"
        " paragraph three hundred.",
    ]
    many_lines = many.splitlines()
    assert many_lines[0].endswith("· 399 lines hold every word of 'many details':")
    assert len(many_lines) == 1 + 40 + 1  # the header, MAX_MATCHES lines, the rest counted
    assert many_lines[-1] == "…and 359 more; use more words, or read a part."
    assert (
        missing.splitlines()[1] == "No line holds every word of 'zebra-quartz unicorn' (2 parts)."
    )


async def test_reading_under_a_dialog_says_to_answer_it_first(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_snapshot", "snapshot-during-dialog")):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_read({}, ctx)
    assert str(caught.value) == (
        'an alert dialog is open on the page ("Hello from the page") — answer it with '
        'browser_act(action="accept") or browser_act(action="dismiss") first'
    )


# ── browser_act ─────────────────────────────────────────────────────────────


async def test_a_click_names_what_the_engine_clicked_and_the_new_page(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_click", "click-link")) as server:
        result = await browser.browser_act({"action": "click", "ref": "f3e4"}, ctx)
    assert result.splitlines() == [
        'Clicked link "Page two".',
        'The page is now http://site:8000/page2.html — "Page two".',
    ]
    assert _called(server) == [("browser_click", {"target": "f3e4"})]
    assert facts[-1]["url"] == "http://site:8000/page2.html"


async def test_typing_never_echoes_what_was_typed(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_type", "type")) as server:
        result = await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "hello world"}, ctx
        )
    assert result.splitlines() == [
        'Typed 11 characters into textbox "Search words".',
        "The engine reported no new page, dialog or download.",
    ]
    assert "hello world" not in result and "hello world" not in repr(facts)
    assert _called(server) == [("browser_type", {"target": "f3e17", "text": "hello world"})]


async def test_select_and_press_and_submit_reach_the_engine_as_its_own_calls(world):
    ctx = world[0]
    select = engine_tool("browser_select_option", "select")
    press = engine_tool("browser_press_key", "press-key")
    typed = engine_tool("browser_type", "type-submit")
    with fake_engine(select, press, typed) as server:
        assert (
            await browser.browser_act({"action": "select", "ref": "f3e18", "value": "b"}, ctx)
        ).startswith('Selected "b" in label "Pick one".')
        assert (await browser.browser_act({"action": "press", "value": "Tab"}, ctx)).startswith(
            "Pressed Tab."
        )
        await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "sent words", "submit": True}, ctx
        )
    assert _called(server) == [
        ("browser_select_option", {"target": "f3e18", "values": ["b"]}),
        ("browser_press_key", {"key": "Tab"}),
        ("browser_type", {"target": "f3e17", "text": "sent words", "submit": True}),
    ]


async def test_no_query_reaches_a_result_or_a_fact(world):
    ctx, _, _, facts = world
    with fake_engine(engine_tool("browser_type", "type-submit")):
        result = await browser.browser_act(
            {"action": "type", "ref": "f3e17", "value": "sent words", "submit": True}, ctx
        )
    assert 'The page is now http://site:8000/page2.html?… — "Page two".' in result.splitlines()
    assert "sent+words" not in result and "sent+words" not in repr(facts)
    assert facts[-1]["url"] == "http://site:8000/page2.html"


async def test_a_dialog_is_named_with_how_to_answer_it(world):
    ctx = world[0]
    alert = engine_tool("browser_click", "click-alert")
    answer = engine_tool("browser_handle_dialog", "handle-dialog")
    with fake_engine(alert, answer) as server:
        clicked = await browser.browser_act({"action": "click", "ref": "f3e22"}, ctx)
        accepted = await browser.browser_act({"action": "accept"}, ctx)
    assert clicked.splitlines() == [
        'Clicked button "Show alert".',
        "The page is now http://site:8000/index.html.",
        'The page opened an alert dialog: "Hello from the page" — answer it with '
        'browser_act(action="accept") or browser_act(action="dismiss").',
    ]
    assert accepted.splitlines() == [
        "Accepted the dialog.",
        'The page is now http://site:8000/index.html — "Capture index".',
    ]
    assert _called(server)[-1] == ("browser_handle_dialog", {"accept": True})


async def test_a_stale_ref_says_to_read_the_page_again(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-stale-ref")):
        with pytest.raises(ToolFailure, match="e9999 is no longer on the page"):
            await browser.browser_act({"action": "click", "ref": "e9999"}, ctx)


@pytest.mark.parametrize(
    "args,said",
    [
        ({"action": "wave"}, "action must be one of"),
        ({"action": "click"}, "needs the ref of an element"),
        ({"action": "type", "ref": "e1"}, "needs a value"),
        ({"action": "press"}, "needs a value"),
    ],
)
async def test_an_incomplete_action_is_refused_before_the_engine(world, args, said):
    with pytest.raises(ToolFailure, match=said):
        await browser.browser_act(args, world[0])


# ── downloads and screenshots ───────────────────────────────────────────────


async def test_a_download_lands_in_the_workspace_and_leaves_the_engine(world):
    ctx, output, workspace, facts = world
    (output / "report.txt").write_bytes(REPORT)
    with fake_engine(engine_tool("browser_click", "click-download")):
        result = await browser.browser_act({"action": "click", "ref": "f3e21"}, ctx)
    assert result.splitlines() == [
        'Clicked link "Download the report".',
        "Downloaded downloads/report.txt (42 bytes).",
    ]
    assert (workspace / "downloads" / "report.txt").read_bytes() == REPORT
    assert not (output / "report.txt").exists()
    assert facts[-1] == {"browser": "download", "path": "downloads/report.txt", "bytes": 42}


async def test_a_download_that_did_not_arrive_is_said(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-download")):
        result = await browser.browser_act({"action": "click", "ref": "f3e21"}, ctx)
    assert result.splitlines()[-1] == (
        "A download did not reach the workspace: the engine reported /output/report.txt, "
        "and it is not there."
    )


async def test_a_screenshot_lands_in_screenshots(world):
    ctx, output, workspace, facts = world
    (output / "page-2026-09-30T20-25-33-996Z.png").write_bytes(b"\x89PNG" + b"0" * 2044)
    with fake_engine(engine_tool("browser_take_screenshot", "screenshot")) as server:
        result = await browser.browser_screenshot({}, ctx)
    saved = facts[-1]["path"]
    assert saved.startswith("screenshots/") and saved.endswith(".png")
    assert (workspace / saved).stat().st_size == 2048
    assert result == (
        f"Saved a screenshot of the page to {saved} (2 KB). The image is in the workspace; "
        "it is not read into this conversation."
    )
    assert _called(server) == [("browser_take_screenshot", {"type": "png", "scale": "css"})]


# ── back, and the engine down ───────────────────────────────────────────────


async def test_back_names_the_page_it_landed_on(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_navigate_back", "back")):
        assert await browser.browser_back({}, ctx) == (
            'Back on http://site:8000/index.html — "Capture index".'
        )


async def test_every_tool_states_the_clients_own_reason_with_no_added_claim(world):
    """Fix round 1, m3: the first version composed "is not answering at
    {origin} — {reason}" even though `reason` (the CLIENT's own words) already
    names that same origin — doubling it — and even when "not answering" is a
    narrower, wrong claim than what the client actually determined (here: it
    never sent anything at all). `_call` now shows `exc.reason` exactly,
    scrubbed, with nothing of its own added, and it is the SAME sentence for
    all five tools, since they all hit the same unreachable transport."""
    ctx = world[0]
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        for name, args in [
            ("browser_open", {"url": INDEX}),
            ("browser_read", {}),
            ("browser_act", {"action": "click", "ref": "e1"}),
            ("browser_back", {}),
            ("browser_screenshot", {}),
        ]:
            result, ok = await tools.dispatch(name, args, ctx)
            assert not ok, name
            assert result == (
                "Error: could not reach browser at http://browser:8931 — ConnectError"
            ), (name, result)
            assert result.count("http://browser:8931") == 1, (name, result)
    finally:
        client.unplant(handle)


# ── the registry's entries ──────────────────────────────────────────────────


def test_the_five_tools_are_registered_with_what_they_change():
    names = {name for name in tools.REGISTRY if name.startswith("browser_")}
    assert names == {
        "browser_open",
        "browser_read",
        "browser_act",
        "browser_back",
        "browser_screenshot",
    }
    reads = {name for name in names if tools.REGISTRY[name].reads_only}
    assert reads == {"browser_open", "browser_read", "browser_back"}
    stale = {name for name in names if tools.REGISTRY[name].ephemeral}
    assert stale == {"browser_open", "browser_read", "browser_back"}


async def test_dispatch_runs_browser_open_through_the_one_funnel(world):
    ctx = world[0]
    navigate = engine_tool("browser_navigate", "navigate-index")
    snapshot = engine_tool("browser_snapshot", "snapshot-index")
    with fake_engine(navigate, snapshot):
        result, ok = await tools.dispatch("browser_open", {"url": INDEX}, ctx)
    assert ok and result.startswith('Opened http://site:8000/index.html — "Capture index".')


# ── ruling G6: no token in a result, a fact, or the engine's own prose ──────
#
# `address`/`_shown` already scrub a URL WE hold (`args["url"]`, `answer.url`).
# The gap this covers is the engine's own free text: a navigation error or a
# dialog's message is the PAGE's or the engine's words, and either can repeat
# the address a call was trying to reach — a reset or sign-in link carries
# its token in the query. These two fixtures are built directly (not loaded
# from a frozen capture) because no existing capture happens to echo a
# token-bearing URL back; the shape (`"<description> at <url>"`) is the real
# engine's own, measured in 22-navigate-dns-failure.json.

_SECRET_URL = "https://x.invalid/reset?token=abc123"

_leaking_navigate = fake.FakeTool(
    "browser_navigate",
    results=(
        {
            "text": (
                "### Error\n"
                f"Error: browserBackend.callTool: net::ERR_NAME_NOT_RESOLVED at {_SECRET_URL}\n"
                "Call log:\n"
                f'  - navigating to "{_SECRET_URL}", waiting until "domcontentloaded"\n'
            ),
            "is_error": True,
        },
    ),
)

_leaking_click = fake.FakeTool(
    "browser_click",
    results=(
        {
            "text": (
                f"### Error\nError: could not act: the target {_SECRET_URL} refused the click\n"
            ),
            "is_error": True,
        },
    ),
)


async def test_the_token_in_a_failed_opens_address_never_reaches_the_failure(world):
    ctx, _, _, facts = world
    with fake_engine(_leaking_navigate):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": _SECRET_URL}, ctx)
    assert "abc123" not in str(caught.value)
    assert "abc123" not in repr(facts)
    assert "net::ERR_NAME_NOT_RESOLVED at https://x.invalid/reset" in str(caught.value)


async def test_the_token_in_an_acts_refusal_never_reaches_the_result(world):
    ctx, _, _, facts = world
    with fake_engine(_leaking_click):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_act({"action": "click", "ref": "e1"}, ctx)
    assert "abc123" not in str(caught.value)
    assert "abc123" not in repr(facts)
    assert "the target https://x.invalid/reset refused the click" in str(caught.value)


# ── ruling G31: reachability is a fact, never parsed out of the prose ──────


async def test_an_unreachable_engine_files_its_reachability_as_a_fact(world):
    ctx, _, _, facts = world
    handle = client.plant({ORIGIN: fake.Unreachable()})
    try:
        result, ok = await tools.dispatch("browser_open", {"url": INDEX}, ctx)
    finally:
        client.unplant(handle)
    assert not ok
    assert facts == [{"browser": "engine", "reachable": False}]


# ── the Task 2 carry: bring downloads from EVERY answer ─────────────────────

_LATE_DOWNLOAD_EVENTS = '\n### Events\n- Downloaded file late.zip to "/output/late.zip"\n'


async def test_a_download_finishing_after_an_act_is_brought_in_on_the_next_read(world):
    ctx, output, workspace, facts = world
    (output / "late.zip").write_bytes(b"zip bytes")
    late_snapshot = fake.FakeTool(
        "browser_snapshot",
        results=(
            {"text": answer_text("snapshot-index") + _LATE_DOWNLOAD_EVENTS, "is_error": False},
        ),
    )
    with fake_engine(engine_tool("browser_click", "click-link"), late_snapshot):
        clicked = await browser.browser_act({"action": "click", "ref": "f3e4"}, ctx)
        read = await browser.browser_read({}, ctx)
    assert "Downloaded" not in clicked
    # m12: the download note is one of HER lines, before the page text.
    assert read.splitlines()[1] == "Downloaded downloads/late.zip (9 bytes)."
    assert (workspace / "downloads" / "late.zip").read_bytes() == b"zip bytes"
    assert {"browser": "download", "path": "downloads/late.zip", "bytes": 9} in facts


# ── the Task 3 carry: a copy still in the engine is said ───────────────────


async def test_the_engines_copy_still_there_is_said_after_the_download_line(world, monkeypatch):
    ctx, output, workspace, facts = world

    def stuck_bring_in(engine_path, **kwargs):
        return files.Brought(
            path="downloads/report.txt", bytes=42, left_in_engine="Permission denied"
        )

    monkeypatch.setattr(files, "bring_in", stuck_bring_in)
    with fake_engine(engine_tool("browser_click", "click-download")):
        result = await browser.browser_act({"action": "click", "ref": "f3e21"}, ctx)
    assert result.splitlines() == [
        'Clicked link "Download the report".',
        "Downloaded downloads/report.txt (42 bytes); the engine's copy could not be removed: "
        "Permission denied.",
    ]
    assert facts[-1] == {"browser": "download", "path": "downloads/report.txt", "bytes": 42}


async def test_a_screenshot_still_in_the_engine_is_said(world, monkeypatch):
    ctx, output, workspace, facts = world
    (output / "page-2026-09-30T20-25-33-996Z.png").write_bytes(b"\x89PNG" + b"0" * 2044)
    real_bring_in = files.bring_in

    def stuck_bring_in(engine_path, **kwargs):
        brought = real_bring_in(engine_path, **kwargs)
        return files.Brought(
            path=brought.path, bytes=brought.bytes, left_in_engine="disk is read-only"
        )

    monkeypatch.setattr(files, "bring_in", stuck_bring_in)
    with fake_engine(engine_tool("browser_take_screenshot", "screenshot")):
        result = await browser.browser_screenshot({}, ctx)
    saved = facts[-1]["path"]
    assert result == (
        f"Saved a screenshot of the page to {saved} (2 KB). The image is in the workspace; "
        "it is not read into this conversation. The engine's copy could not be removed: "
        "disk is read-only."
    )


# ── ruling G10: the file copy never runs inside the engine lock ────────────


async def test_a_slow_copy_in_browser_open_never_holds_the_engine_lock(world, monkeypatch):
    """A download that finishes with `browser_navigate` itself (rare, but the
    carry above says every answer is checked) must not hold `engine.session()`
    while its copy runs: a 1 GiB file must not stall every other call to her
    one shared browser (ruling G10).

    Proven, not just read off the diff: the copy is driven to the middle of a
    (monkeypatched) slow `files.bring_in`, on a background task, while this
    test tries to take the SAME lock directly. Before G10 (the copy awaited
    inside `async with engine.session():`) that second acquisition would
    block until the copy finished and this test would time out — it is the
    `release.set()` that lets the background task's copy, and so the lock
    it would otherwise still be holding, finish."""
    ctx, output, workspace, facts = world
    (output / "slow.zip").write_bytes(b"slow bytes")
    started = threading.Event()
    release = threading.Event()
    real_bring_in = files.bring_in

    def slow_bring_in(engine_path, **kwargs):
        started.set()
        release.wait(timeout=5)
        return real_bring_in(engine_path, **kwargs)

    monkeypatch.setattr(files, "bring_in", slow_bring_in)
    navigate_with_download = fake.FakeTool(
        "browser_navigate",
        results=(
            {
                "text": (
                    "### Page\n"
                    "- Page URL: http://site:8000/index.html\n"
                    "- Page Title: Capture index\n"
                    "### Events\n"
                    '- Downloaded file slow.zip to "/output/slow.zip"\n'
                ),
                "is_error": False,
            },
        ),
    )
    with fake_engine(navigate_with_download, engine_tool("browser_snapshot", "snapshot-index")):
        task = asyncio.create_task(browser.browser_open({"url": INDEX}, ctx))
        try:
            await asyncio.get_running_loop().run_in_executor(None, started.wait, 5)
            assert started.is_set(), "the copy never started"
            async with asyncio.timeout(2):
                async with engine.session():
                    pass  # reached at all only when the lock was free
        finally:
            release.set()
        await task
    assert {"browser": "download", "path": "downloads/slow.zip", "bytes": 10} in facts


# ── fix round 1, I1: the free-text scrub is linear ──────────────────────────


def test_addresses_scrub_stays_linear_on_a_4mib_url_dense_text():
    """A text built ENTIRELY of one scheme's URLs used to make the search
    for the OTHER, absent scheme rescan the whole remaining string on every
    one of them (quadratic — 3.5-4.6s measured at just 288 KB). Measured on
    this tree after the fix: ~0.7-0.8s at ~4.5 MB, http-only or https-only —
    budgeted at 5x that for a slower machine, still far below the 3.5s the
    OLD code took at 288 KB alone."""
    for unit in ("http://a ", "https://a "):
        text = unit * 500_000  # ~4.5-5 MB, the size an answer may carry
        started = time.perf_counter()
        addresses.scrub(text)
        elapsed = time.perf_counter() - started
        assert elapsed < 4.0, (unit, elapsed)


async def test_a_huge_dialog_message_no_longer_stalls_the_event_loop(world):
    """The end-to-end shape (fix round 1, p2): a page's alert() full of
    URLs, through browser_act's real path. Clipped (m8) well before the
    scrub ever sees 288 KB of it, and linear (I1) either way."""
    ctx = world[0]
    message = "http://a " * 32_000  # 288 KB, the size that cost 3.5-4.6s before
    click = fake.FakeTool(
        "browser_click",
        results=(
            {
                "text": (
                    "### Page\n- Page URL: http://site:8000/index.html\n"
                    f'### Modal state\n- ["alert" dialog with message "{message}"]: '
                    "can be handled by browser_handle_dialog"
                ),
                "is_error": False,
            },
        ),
    )
    with fake_engine(click):
        started = time.perf_counter()
        result = await browser.browser_act({"action": "click", "ref": "e1"}, ctx)
        elapsed = time.perf_counter() - started
    assert elapsed < 1.0, elapsed
    assert len(result) < 2_500, len(result)


# ── fix round 1, I2: every tool names an open dialog, never the engine's ───


def _dialog_refusal(engine_tool_name: str) -> fake.FakeTool:
    """Capture 14's refusal shape, with the tool name swapped (as the engine
    itself names whichever tool it just refused)."""
    captured = answer_text("snapshot-during-dialog").replace("browser_snapshot", engine_tool_name)
    return fake.FakeTool(engine_tool_name, results=({"text": captured, "is_error": True},))


@pytest.mark.parametrize(
    "mine,engine_tool_name,args",
    [
        ("browser_open", "browser_navigate", {"url": INDEX}),
        ("browser_read", "browser_snapshot", {}),
        ("browser_act", "browser_click", {"action": "click", "ref": "e3"}),
        ("browser_act", "browser_type", {"action": "type", "ref": "e3", "value": "x"}),
        ("browser_back", "browser_navigate_back", {}),
        ("browser_screenshot", "browser_take_screenshot", {}),
    ],
)
async def test_every_tool_names_an_open_dialog_instead_of_the_engines_refusal(
    world, mine, engine_tool_name, args
):
    ctx = world[0]
    with fake_engine(_dialog_refusal(engine_tool_name)):
        with pytest.raises(ToolFailure) as caught:
            await getattr(browser, mine)(args, ctx)
    said = str(caught.value)
    assert 'action="accept"' in said or 'action="dismiss"' in said, (mine, said)
    assert "does not handle the modal state" not in said, (mine, said)
    assert engine_tool_name not in said, (mine, said)


# ── fix round 1, I3: a ref is a ref, or it is refused before anything sends ─


@pytest.mark.parametrize("raw,expected_target", [("[e12]", "e12"), ("f1e3", "f1e3"), ("e9", "e9")])
async def test_a_ref_reaches_the_engine_in_its_canonical_form(world, raw, expected_target):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-link")) as server:
        await browser.browser_act({"action": "click", "ref": raw}, ctx)
    assert _called(server) == [("browser_click", {"target": expected_target})]


@pytest.mark.parametrize(
    "bad_ref",
    ["button", "#pay", "text=Delete account", "e12 ", " e12", "f12", "e", "ee1", "f1e", "[e12"],
)
async def test_a_ref_not_shaped_like_one_is_refused_before_anything_is_sent(world, bad_ref):
    ctx = world[0]
    with fake_engine(engine_tool("browser_click", "click-link")) as server:
        with pytest.raises(ToolFailure, match="not shaped like a ref"):
            await browser.browser_act({"action": "click", "ref": bad_ref}, ctx)
        assert _called(server) == []


# ── fix round 1, I4: a download already brought in is always said ──────────


async def test_an_out_of_range_part_still_says_the_download_it_already_brought_in(world):
    """p5's shape: the download is brought in, filed and removed from the
    engine's volume BEFORE the out-of-range check raises — so the failure
    must still say so; the engine reports a finished download once."""
    ctx, output, workspace, facts = world
    (output / "late.zip").write_bytes(b"zip bytes")
    snap_late = fake.FakeTool(
        "browser_snapshot",
        results=(
            {"text": answer_text("snapshot-long") + _LATE_DOWNLOAD_EVENTS, "is_error": False},
        ),
    )
    with fake_engine(snap_late):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_read({"part": 9}, ctx)
    said = str(caught.value)
    assert "late.zip" in said
    assert "there is no part 9" in said
    assert (workspace / "downloads" / "late.zip").read_bytes() == b"zip bytes"
    assert not (output / "late.zip").exists()
    assert {"browser": "download", "path": "downloads/late.zip", "bytes": 9} in facts


async def test_an_out_of_range_part_still_says_a_failed_handoff(world):
    ctx = world[0]
    # No file written at all: the engine reported late.zip, and it is not there.
    snap_late = fake.FakeTool(
        "browser_snapshot",
        results=(
            {"text": answer_text("snapshot-long") + _LATE_DOWNLOAD_EVENTS, "is_error": False},
        ),
    )
    with fake_engine(snap_late):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_read({"part": 9}, ctx)
    said = str(caught.value)
    assert "did not reach the workspace" in said
    assert "there is no part 9" in said


async def test_a_download_on_a_failed_open_is_still_said(world):
    ctx, output, workspace, facts = world
    (output / "late.zip").write_bytes(b"zip bytes")
    nav404_text = answer_text("navigate-404").replace(
        "### Events\n", '### Events\n- Downloaded file late.zip to "/output/late.zip"\n'
    )
    nav404 = fake.FakeTool("browser_navigate", results=({"text": nav404_text, "is_error": False},))
    with fake_engine(nav404):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_open({"url": "http://site:8000/missing.html"}, ctx)
    said = str(caught.value)
    assert "late.zip" in said
    assert "answered 404" in said
    assert (workspace / "downloads" / "late.zip").read_bytes() == b"zip bytes"


async def test_a_download_on_a_nameless_screenshot_is_still_said(world):
    ctx, output, workspace, facts = world
    (output / "late.zip").write_bytes(b"zip bytes")
    shot_text = "### Page\n- Page URL: http://site:8000/index.html" + _LATE_DOWNLOAD_EVENTS
    shot = fake.FakeTool(
        "browser_take_screenshot", results=({"text": shot_text, "is_error": False},)
    )
    with fake_engine(shot):
        with pytest.raises(ToolFailure) as caught:
            await browser.browser_screenshot({}, ctx)
    said = str(caught.value)
    assert "late.zip" in said
    assert "no screenshot file it could name" in said


# ── fix round 1, m1 + m2: acted_on is scrubbed, span and all ────────────────


async def test_a_links_own_token_url_name_never_reaches_the_result_or_the_span(world):
    """p6's second case: `acted_on` — what the engine's own code says it
    targeted — is the PAGE's accessible name for the element, exactly like a
    dialog's message. End to end through chat._run_tool (the S37a pattern,
    test_mcp_tools.py's test_no_token_bytes_reach_turn_spans): no abc123 in
    the result, the span meta, or the recorded facts."""
    ctx, _, _, facts = world
    secret = "https://x.invalid/reset?token=abc123"
    click = fake.FakeTool(
        "browser_click",
        results=(
            {
                "text": (
                    "### Ran Playwright code\n```js\n"
                    f"await page.getByRole('link', {{ name: '{secret}' }}).click();\n```\n"
                    "### Page\n- Page URL: https://x.invalid/reset?token=abc123\n"
                    "- Page Title: Reset your password"
                ),
                "is_error": False,
            },
        ),
    )
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    call = chat.ToolCall(
        id="c1", name="browser_act", arguments=json.dumps({"action": "click", "ref": "e40"})
    )
    with fake_engine(click):
        result, ok = await chat._run_tool(turn, ctx, call)
    written = json.dumps([span.meta for span in turn.spans], default=str) + result
    assert ok, result
    assert "abc123" not in written, written
    assert "abc123" not in repr(facts)


# ── fix round 1, m3 is covered by the renamed test above ("not answering") ──
# ── fix round 1, m4: a file chooser can only be dismissed ───────────────────


async def test_a_file_chooser_can_only_be_dismissed(world):
    ctx = world[0]
    click_opens = (
        "### Page\n- Page URL: http://site:8000/upload.html\n- Page Title: Upload\n"
        "### Modal state\n- [File chooser]: can be handled by browser_file_upload"
    )
    refused = (
        '### Error\nError: Tool "browser_handle_dialog" does not handle the modal state.\n'
        "### Modal state\n- [File chooser]: can be handled by browser_file_upload"
    )
    upload_ok = "### Page\n- Page URL: http://site:8000/upload.html\n- Page Title: Upload"
    click = fake.FakeTool("browser_click", results=({"text": click_opens, "is_error": False},))
    with fake_engine(click):
        opened = await browser.browser_act({"action": "click", "ref": "e5"}, ctx)
    assert 'dismiss it with browser_act(action="dismiss")' in opened
    assert "accept" not in opened.lower()

    handle = fake.FakeTool("browser_handle_dialog", results=({"text": refused, "is_error": True},))
    upload = fake.FakeTool("browser_file_upload", results=({"text": upload_ok, "is_error": False},))
    with fake_engine(handle, upload) as server:
        with pytest.raises(ToolFailure, match=r'dismiss it with browser_act\(action="dismiss"\)'):
            await browser.browser_act({"action": "accept"}, ctx)
        assert _called(server) == [("browser_handle_dialog", {"accept": True})]

    with fake_engine(handle, upload) as server:
        result = await browser.browser_act({"action": "dismiss"}, ctx)
        assert result.splitlines() == [
            "Dismissed the dialog.",
            'The page is now http://site:8000/upload.html — "Upload".',
        ]
        assert _called(server) == [
            ("browser_handle_dialog", {"accept": False}),
            ("browser_file_upload", {}),
        ]


# ── fix round 1, m6: outline and search run off the event loop ─────────────


async def test_outline_runs_off_the_event_loop_thread(world, monkeypatch):
    ctx = world[0]
    main_thread = threading.current_thread()
    seen: list[threading.Thread] = []
    real_outline = reader.outline

    def spy(page):
        seen.append(threading.current_thread())
        return real_outline(page)

    monkeypatch.setattr(reader, "outline", spy)
    with fake_engine(
        engine_tool("browser_navigate", "navigate-index"),
        engine_tool("browser_snapshot", "snapshot-index"),
    ):
        await browser.browser_open({"url": INDEX}, ctx)
    assert seen and seen[0] is not main_thread


async def test_search_runs_off_the_event_loop_thread(world, monkeypatch):
    ctx = world[0]
    main_thread = threading.current_thread()
    seen: list[threading.Thread] = []
    real_search = reader.search

    def spy(page, query):
        seen.append(threading.current_thread())
        return real_search(page, query)

    monkeypatch.setattr(reader, "search", spy)
    with fake_engine(engine_tool("browser_snapshot", "snapshot-long")):
        await browser.browser_read({"query": "paragraph"}, ctx)
    assert seen and seen[0] is not main_thread


# ── fix round 1, m9: the page fact backs the address she is shown ──────────


async def test_the_page_fact_matches_the_address_she_is_shown_after_a_redirect(world):
    ctx, _, _, facts = world
    navigate = engine_tool("browser_navigate", "navigate-index")
    redirected_snapshot = fake.FakeTool(
        "browser_snapshot",
        results=(
            {
                "text": (
                    "### Page\n- Page URL: http://site:8000/redirected.html\n"
                    "- Page Title: Redirected\n"
                    '### Snapshot\n```yaml\n- generic [ref=e1]: "hi"\n```'
                ),
                "is_error": False,
            },
        ),
    )
    with fake_engine(navigate, redirected_snapshot):
        result = await browser.browser_open({"url": INDEX}, ctx)
    assert "http://site:8000/redirected.html" in result
    assert "http://site:8000/index.html" not in result
    assert facts[-1] == {
        "browser": "page",
        "url": "http://site:8000/redirected.html",
        "title": "Redirected",
        "status": None,
    }


# ── fix round 1, m10: a missing snapshot is a stated failure ───────────────


_NO_SNAPSHOT = fake.FakeTool(
    "browser_snapshot",
    results=(
        {
            "text": "### Page\n- Page URL: http://site:8000/index.html\n- Page Title: X",
            "is_error": False,
        },
    ),
)


async def test_read_states_a_missing_snapshot_not_an_empty_page(world):
    ctx = world[0]
    with fake_engine(_NO_SNAPSHOT):
        with pytest.raises(ToolFailure, match="returned no snapshot"):
            await browser.browser_read({}, ctx)


async def test_open_also_states_a_missing_snapshot(world):
    ctx = world[0]
    with fake_engine(engine_tool("browser_navigate", "navigate-index"), _NO_SNAPSHOT):
        with pytest.raises(ToolFailure, match="returned no snapshot"):
            await browser.browser_open({"url": INDEX}, ctx)


# ── fix round 1, m11: an unparseable URL is a stated refusal ───────────────


async def test_an_unparseable_url_is_a_stated_refusal_not_a_crash(world):
    ctx = world[0]
    bad = "http://[::1/reset?token=abc123"
    with pytest.raises(ToolFailure, match="does not parse as a web address"):
        await browser.browser_open({"url": bad}, ctx)
    result, ok = await tools.dispatch("browser_open", {"url": bad}, ctx)
    assert not ok
    assert "failed unexpectedly" not in result
    assert "does not parse as a web address" in result


# ── fix round 2, A: the unparseable-URL refusal never echoes the raw url ───


async def test_an_unparseable_urls_token_never_reaches_the_failure(world):
    ctx = world[0]
    with pytest.raises(ToolFailure) as caught:
        await browser.browser_open({"url": "http://[::1/reset?token=abc123"}, ctx)
    assert "abc123" not in str(caught.value)


async def test_an_unparseable_urls_token_never_reaches_the_result_or_the_span(world):
    """Fix round 2, A: `{url!r}` in the refusal's message put the raw url —
    token and all — into the tool result AND, through `chat._span_arguments`
    re-reading that same raw `url` argument (ruling G34, B), into the
    stored span's `args_redacted`, `result_head` and `error` too. All four
    checked end to end through `chat._run_tool`, the real path a span is
    written on (the S37a pattern, test_mcp_tools.py's
    test_no_token_bytes_reach_turn_spans)."""
    ctx = world[0]
    secret = "http://[::1/reset?token=abc123"
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    call = chat.ToolCall(id="c1", name="browser_open", arguments=json.dumps({"url": secret}))
    result, ok = await chat._run_tool(turn, ctx, call)
    assert not ok
    assert "abc123" not in result, result
    meta = json.dumps([span.meta for span in turn.spans], default=str)
    assert "abc123" not in meta, meta
