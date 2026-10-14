"""S38b T3: when a round nears the served window, the oldest tool results are
summarized IN WHAT IS SENT, by the link serving the turn.

Every test drives the real chat route through a scripted gateway that states
its window (test_chat_context_window's WindowGateway). The summary call is a
gateway call like any other, so it takes its own scripted round, in order:
the read rounds, then one summary round per picked result (or piece), then
the round that answers. Running past the script is a loud 500, so a summary
call the test did not expect fails the turn — and the call count is pinned.

Assertions are on what the gateway RECEIVED and what the trace recorded.
"""

from __future__ import annotations

import math

import pytest

from app import context_fit, context_summary, peers, tools
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal
from tests.test_chat_context_window import (  # noqa: F401 - _forget_served_links is autouse
    ASK,
    WindowGateway,
    _forget_served_links,
    _link,
    _say,
    text,
    whole_call,
)

pytestmark = requires_db

READ = "workspace_read_file"
FILE_CHARS = 28_000
# Two reads' worth of tokens beyond the first request (each result plus its
# call), at the default ratio — what the answer round adds to the prompt.
TWO_READS_TOKENS = 2 * (math.ceil(FILE_CHARS / context_fit.DEFAULT_CHARS_PER_TOKEN) + 30)
SUMMARY = "Summary: the first file says ALPHA-1234 at line 1."
FIRST_FACT = "ALPHA-1234 the first fact"


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


class HeaderGateway(WindowGateway):
    """WindowGateway that also keeps each request's headers, in call order."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.headers: list[dict] = []

    async def _completions(self, request):
        self.headers.append(dict(request.headers))
        return await super()._completions(request)


def _file(workspace, name: str, tag: str, chars: int = FILE_CHARS) -> str:
    # Distinct bodies: identical results would end the turn as circling.
    line = f"/var/log/{tag}/entry-with-a-long-name\n"
    body = (FIRST_FACT + "\n" + line * (chars // len(line) + 1))[:chars]
    (workspace / name).write_text(body, encoding="utf-8")
    return body


def _tools_chars() -> int:
    """The tools array an owner chat round sends (verification-2-7 T24: it
    counts against the window, in the fit and in the 70% mark alike)."""
    return context_fit.tools_chars(tools.advertised_tools())


def _window_at(fraction_of_budget: float, extra_tokens: int = TWO_READS_TOKENS):
    """A window whose budget puts the first request, with the tools array it
    carries, plus `extra_tokens` at `fraction_of_budget` — sized to the real
    prompt, never a pinned length."""

    def size(messages: list[dict]) -> int:
        est = context_fit.estimate_tokens(
            messages, context_fit.DEFAULT_CHARS_PER_TOKEN, _tools_chars()
        )
        return math.ceil((est + extra_tokens) / fraction_of_budget / 0.875)

    return size


def _reads(*names: str) -> tuple:
    return tuple((whole_call(f"c{i + 1}", READ, {"path": name}),) for i, name in enumerate(names))


async def _llm_metas(pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at, id"
    )
    return [row["meta"] for row in rows]


async def _kept(pool) -> dict[str, str]:
    rows = await pool.fetch("SELECT ref, content FROM tool_results ORDER BY ref")
    return {row["ref"]: row["content"] for row in rows}


async def _turn_status(pool) -> str:
    return await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1")


def _tool(messages: list[dict], call_id: str) -> str:
    (content,) = [
        m["content"] for m in messages if m["role"] == "tool" and m["tool_call_id"] == call_id
    ]
    return content


def _no_marker(payloads: list[dict]) -> bool:
    return not any(
        "[summary of " in (m.get("content") or "")
        for p in payloads
        for m in p["messages"]
        if m["role"] == "tool"
    )


# -- C1 + C2: over 70% the oldest result is summarized by the served link ----


async def test_over_70_percent_the_oldest_result_is_summarized_and_sent_marked(
    owner_client, pool, mount_peers, workspace
):
    first = _file(workspace, "a.log", "alpha")
    second = _file(workspace, "b.log", "beta")
    link = _link()
    gateway = HeaderGateway(
        rounds=_reads("a.log", "b.log") + ((text(SUMMARY),), (text("both found."),)),
        served_by=link,
        window=_window_at(0.80),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 4
    window = int(gateway._window_value)
    summary_call, answer = gateway.payloads[2], gateway.payloads[3]
    # The summary call: the served link, no tools, its own capped reply, his
    # latest message and the WHOLE result in front of it.
    assert summary_call["model"] == link
    assert "tools" not in summary_call
    assert summary_call["max_tokens"] == context_summary.summary_max_tokens(window)
    asked = "\n".join(m["content"] for m in summary_call["messages"])
    assert ASK in asked and first in asked and second not in asked
    # It walks the turn's own chain (chat's), metered as a summary.
    sent_headers = gateway.headers[2]
    assert sent_headers[peers.HEADER_ROLE.lower()] == "chat"
    assert sent_headers[peers.HEADER_PURPOSE.lower()] == "summary"

    # The answer round sends r1 as marker + summary; the latest read whole.
    sent = _tool(answer["messages"], "c1")
    assert sent == context_summary.marker("r1", READ, len(first)) + "\n" + SUMMARY
    assert _tool(answer["messages"], "c2") == second
    # What is kept is the full text, never the summary.
    kept = await _kept(pool)
    assert kept["r1"] == first and kept["r2"] == second

    metas = await _llm_metas(pool)
    assert [m["purpose"] for m in metas] == ["chat", "chat", "summary", "chat"]
    assert metas[2]["model"] == link
    assert metas[3]["context_summarized"] == [
        {"ref": "r1", "tool": READ, "chars": len(first), "summary_chars": len(SUMMARY)}
    ]
    assert "summary_failed" not in metas[3]
    assert "context_trimmed" not in metas[3]
    assert not any("context_summarized" in m for m in metas[:3])
    assert await _turn_status(pool) == "ok"


async def test_a_summary_longer_than_its_cap_is_cut_to_the_cap(
    owner_client, pool, mount_peers, workspace
):
    """The selection counted an unwritten summary at summary_max_tokens; a
    link that writes past it is cut there, so the 50% stop holds."""
    _file(workspace, "a.log", "alpha")
    _file(workspace, "b.log", "beta")
    rambling = "the log says many things. " * 1_000
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log") + ((text(rambling),), (text("done."),)),
        served_by=_link(),
        window=_window_at(0.80),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    window = int(gateway._window_value)
    cap = int(context_summary.summary_max_tokens(window) * context_fit.DEFAULT_CHARS_PER_TOKEN)
    assert cap < len(rambling.strip())
    sent = _tool(gateway.payloads[3]["messages"], "c1")
    assert sent.endswith("\n" + rambling.strip()[:cap])
    metas = await _llm_metas(pool)
    assert metas[3]["context_summarized"][0]["summary_chars"] == cap


# -- C3: once per turn ------------------------------------------------------


async def test_a_later_round_reuses_the_summary_without_a_second_call(
    owner_client, pool, mount_peers, workspace
):
    first = _file(workspace, "a.log", "alpha")
    _file(workspace, "b.log", "beta")
    _file(workspace, "c.log", "gamma", chars=400)
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log")
        + ((text(SUMMARY),),)
        + ((whole_call("c3", READ, {"path": "c.log"}),), (text("done."),)),
        served_by=_link(),
        window=_window_at(0.80),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 5
    marked = context_summary.marker("r1", READ, len(first)) + "\n" + SUMMARY
    assert _tool(gateway.payloads[3]["messages"], "c1") == marked
    assert _tool(gateway.payloads[4]["messages"], "c1") == marked
    metas = await _llm_metas(pool)
    assert [m["purpose"] for m in metas].count("summary") == 1
    assert metas[-1]["summaries_reused"] == ["r1"]
    assert "context_summarized" not in metas[-1]
    assert await _turn_status(pool) == "ok"


# -- C4: a failed summary falls back to trimming, never a marker -------------


async def test_a_refused_summary_states_why_and_the_round_is_trimmed_as_today(
    owner_client, pool, mount_peers, workspace
):
    _file(workspace, "a.log", "alpha")
    _file(workspace, "b.log", "beta")
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log")
        + (Refusal(503, {"error": {"message": "the link is walled"}}), (text("done."),)),
        served_by=_link(),
        # Over the whole budget: today's fit has to trim.
        window=_window_at(1.10),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 4
    assert _no_marker(gateway.payloads)
    assert "[trimmed " in _tool(gateway.payloads[3]["messages"], "c1")
    metas = await _llm_metas(pool)
    assert metas[2]["purpose"] == "summary" and "error" in metas[2]
    round_meta = metas[3]
    assert round_meta["summary_failed"].startswith("r1: ")
    assert "503" in round_meta["summary_failed"]
    assert "context_summarized" not in round_meta
    assert round_meta["context_trimmed"]["tool_results"] >= 1
    assert await _turn_status(pool) == "ok"


async def test_an_empty_summary_is_a_failure_and_is_not_retried_next_round(
    owner_client, pool, mount_peers, workspace
):
    _file(workspace, "a.log", "alpha")
    second = _file(workspace, "b.log", "beta")
    _file(workspace, "c.log", "gamma", chars=400)
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log")
        + ((text("   "),),)
        + ((whole_call("c3", READ, {"path": "c.log"}),),)
        # After c3, r2 is no longer the latest round's: it is summarized.
        # r1, whose summary failed, is not asked again.
        + ((text(SUMMARY),), (text("done."),)),
        served_by=_link(),
        window=_window_at(0.80),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 6
    retry = "\n".join(m["content"] for m in gateway.payloads[4]["messages"])
    assert " result r2 " in retry and second in retry and " result r1 " not in retry
    final = gateway.payloads[5]["messages"]
    assert "[summary of " not in _tool(final, "c1")
    assert _tool(final, "c2").startswith(context_summary.marker("r2", READ, len(second)))
    metas = await _llm_metas(pool)
    assert [m["purpose"] for m in metas].count("summary") == 2
    assert metas[3]["summary_failed"].startswith("r1: ")
    assert "empty" in metas[3]["summary_failed"]
    assert "context_summarized" not in metas[3]
    assert "summary_failed" not in metas[5]
    assert [s["ref"] for s in metas[5]["context_summarized"]] == ["r2"]
    assert await _turn_status(pool) == "ok"


# -- C5: nothing below the mark, nothing without a window --------------------


async def test_under_70_percent_no_summary_call_is_made(owner_client, pool, mount_peers, workspace):
    first = _file(workspace, "a.log", "alpha")
    _file(workspace, "b.log", "beta")
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log") + ((text("done."),),),
        served_by=_link(),
        window=_window_at(0.65),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    assert _tool(gateway.payloads[2]["messages"], "c1") == first
    metas = await _llm_metas(pool)
    assert "summary" not in [m["purpose"] for m in metas]
    assert not any("context_summarized" in m or "summary_failed" in m for m in metas)


async def test_no_stated_window_means_no_summary_call(owner_client, pool, mount_peers, workspace):
    first = _file(workspace, "a.log", "alpha")
    _file(workspace, "b.log", "beta")
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log") + ((text("done."),),),
        served_by=_link(),
        window=None,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 3
    assert _tool(gateway.payloads[2]["messages"], "c1") == first
    assert "summary" not in [m["purpose"] for m in await _llm_metas(pool)]


# -- C6: a result bigger than the summarizer's room goes in pieces -----------


async def test_a_result_bigger_than_the_window_is_summarized_in_pieces_into_one(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    # verification-2-7 T24: the tools array counts against the window, and a
    # summary piece's room (no tools sent) is at least that array's chars —
    # more than one workspace read can return. So the turn advertises the
    # read tool alone: a result bigger than the summarizer's room, beside a
    # tools array a window this size can still hold.
    real = tools.advertised_tools
    monkeypatch.setattr(tools, "advertised_tools", lambda names=None: real([READ]))
    first = _file(workspace, "a.log", "alpha")
    # A small latest read, so the answer round fits once r1 is summarized.
    _file(workspace, "b.log", "beta", chars=400)
    window = 8_000  # budget 7,000 tokens: under one 28,000-char result
    gateway = WindowGateway(
        rounds=_reads("a.log", "b.log")
        + ((text("part one: ALPHA-1234."),), (text("part two: nothing."),), (text("done."),)),
        served_by=_link(),
        window=window,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, ASK)

    assert gateway.calls == 5
    pieces = gateway.payloads[2:4]
    budget = context_fit.budget_for(window)
    for piece in pieces:
        assert "tools" not in piece
        # The one summary's cap, shared between its pieces.
        assert piece["max_tokens"] == context_summary.summary_max_tokens(window) // 2
        # Each piece fits the budget as sent: nothing the fit had to trim.
        assert context_fit.estimate_tokens(piece["messages"], 3.5) <= budget
        assert not any("[trimmed " in m["content"] for m in piece["messages"])
    # Between them the two pieces carry the whole result, in order, each
    # stated as its part.
    carried = [
        next(m["content"] for m in piece["messages"] if m["role"] == "user") for piece in pieces
    ]
    assert "(part 1 of 2):\n" in carried[0] and "(part 2 of 2):\n" in carried[1]
    bodies = [c.split(" of 2):\n", 1)[1] for c in carried]
    assert bodies[0] + bodies[1] == first

    joined = "part one: ALPHA-1234.\npart two: nothing."
    assert _tool(gateway.payloads[4]["messages"], "c1") == (
        context_summary.marker("r1", READ, len(first)) + "\n" + joined
    )
    metas = await _llm_metas(pool)
    assert [m["purpose"] for m in metas].count("summary") == 2
    assert metas[-1]["context_summarized"] == [
        {"ref": "r1", "tool": READ, "chars": len(first), "summary_chars": len(joined)}
    ]
    assert await _turn_status(pool) == "ok"
