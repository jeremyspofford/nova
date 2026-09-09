"""The memory tools and get_time.

The memory fake refuses any request without core's memory bearer, so
"the tool authenticates" is proved by these tests passing at all rather
than by reading the code.
"""
from __future__ import annotations

import re
import time
import uuid

import pytest

from app import tools
from app.identity import Person
from app.main import app
from app.tools.base import ToolContext
from tests import fakes

# dispatch() consults no table and no grant (no approvals, 2026-09-03 —
# tests/test_no_approvals.py pins it), so none of this needs a database: the
# memory link is a local ASGI fake and get_time reads a clock. A test here that
# starts needing the pool is a dispatch that reaches for a row again.

PERSON = Person(id=uuid.uuid4(), name="jeremy", role="owner")


@pytest.fixture
def memory_ctx(monkeypatch, tmp_path):
    """A ToolContext whose memory link points at a local ASGI fake."""

    def _mount(memory: fakes.FakeMemory | None = None) -> ToolContext:
        if memory is not None:
            monkeypatch.setenv("MEMORY_URL", fakes.MEMORY_URL)
            monkeypatch.setenv("CORE_MEMORY_TOKEN", fakes.MEMORY_TOKEN)
            app.state.peer_transports = {
                fakes.MEMORY_URL: fakes.StreamingASGITransport(memory.app)
            }
        else:
            monkeypatch.delenv("MEMORY_URL", raising=False)
            monkeypatch.delenv("CORE_MEMORY_TOKEN", raising=False)
            app.state.peer_transports = {}
        return ToolContext(app=app, person=PERSON, workspace_root=tmp_path)

    yield _mount
    app.state.peer_transports = {}


# -- memory_search ---------------------------------------------------------


async def test_search_scopes_to_the_turns_person_and_formats_hits(memory_ctx):
    memory = fakes.FakeMemory(
        results=(
            {"title": "Coffee", "kind": "topic", "snippet": "pour-over, no sugar", "score": 2.0},
            {"title": "Journal - 2026-08-01", "kind": "journal", "snippet": "we talked about it"},
        )
    )
    ctx = memory_ctx(memory)

    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, ctx)
    assert ok is True
    assert "Coffee (topic): pour-over, no sugar" in result
    assert "Journal - 2026-08-01 (journal)" in result
    assert memory.recalls == [{"query": "coffee", "person_id": str(PERSON.id), "k": 5}]


async def test_search_passes_an_explicit_k(memory_ctx):
    memory = fakes.FakeMemory()
    ctx = memory_ctx(memory)
    await tools.dispatch("memory_search", {"query": "coffee", "k": 2}, ctx)
    assert memory.recalls[0]["k"] == 2


async def test_zero_hits_are_stated_plainly(memory_ctx):
    ctx = memory_ctx(fakes.FakeMemory(results=()))
    result, ok = await tools.dispatch("memory_search", {"query": "unicorns"}, ctx)
    assert ok is True
    assert "No saved notes matched" in result
    assert "unicorns" in result


# S13-5: memory searches twice — by word and by meaning — and the meaning half
# needs an embedding model the owner pulls. When it did not run, /recall says so
# in its own words, and this tool is the path she reaches for deliberately when
# somebody asks what she remembers. "No saved notes matched" out of half a
# search is a claim about the notes that the search never established.

REDUCED = (
    {"name": "lexical", "ran": True, "ranked": 2},
    {
        "name": "semantic",
        "ran": False,
        "reason": (
            "the embedding model 'nomic-embed-text' is not installed on the embedding "
            "service at http://ollama:11434"
        ),
    },
)
FULL = (
    {"name": "lexical", "ran": True, "ranked": 2},
    {"name": "semantic", "ran": True, "ranked": 3},
)
NO_ANSWER = (
    "These notes hold no answer to that — nothing in these notes contains any of the words "
    "that were asked about. This search did not use every retriever it has: semantic (the "
    "embedding model 'nomic-embed-text' is not installed on the embedding service at "
    "http://ollama:11434). A note that says the same thing in different words could have "
    "been missed."
)
MATCHED = (
    "1 note(s) matched and cleared the relevance floor, best match first. This search did "
    "not use every retriever it has: semantic (the embedding model 'nomic-embed-text' is "
    "not installed on the embedding service at http://ollama:11434). A note that says the "
    "same thing in different words could have been missed."
)


async def test_finding_nothing_with_half_a_search_repeats_memorys_sentence(memory_ctx):
    ctx = memory_ctx(
        fakes.FakeMemory(results=(), recall_statement=NO_ANSWER, recall_retrievers=REDUCED)
    )
    result, ok = await tools.dispatch("memory_search", {"query": "my haiku"}, ctx)
    assert ok is True
    # Memory's words, not this service's claim about the notes.
    assert "did not use every retriever" in result
    assert "not installed" in result
    assert "No saved notes matched" not in result


async def test_hits_from_half_a_search_carry_the_caveat_too(memory_ctx):
    memory = fakes.FakeMemory(
        results=({"title": "Coffee", "kind": "topic", "snippet": "pour-over, no sugar"},),
        recall_statement=MATCHED,
        recall_retrievers=REDUCED,
    )
    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, memory_ctx(memory))
    assert ok is True
    assert "Coffee (topic): pour-over, no sugar" in result
    # "here is one note" reads as "and there was only one" without this.
    assert "could have been missed" in result


async def test_a_full_search_adds_nothing_about_how_it_was_done(memory_ctx):
    memory = fakes.FakeMemory(
        results=({"title": "Coffee", "kind": "topic", "snippet": "pour-over"},),
        recall_statement="1 note(s) matched and cleared the relevance floor, best match first.",
        recall_retrievers=FULL,
    )
    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, memory_ctx(memory))
    assert ok is True
    assert "Coffee (topic): pour-over" in result
    assert "relevance floor" not in result


async def test_a_tool_cannot_choose_whose_memory_it_reads(memory_ctx):
    memory = fakes.FakeMemory()
    ctx = memory_ctx(memory)
    result, ok = await tools.dispatch(
        "memory_search", {"query": "secrets", "person_id": "somebody-else"}, ctx
    )
    assert ok is False
    assert "person_id" in result
    assert memory.recalls == []  # nothing was asked of the memory service at all


async def test_a_memory_service_that_refuses_is_a_stated_error(memory_ctx):
    ctx = memory_ctx(fakes.FakeMemory(recall_status=500))
    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, ctx)
    assert ok is False
    assert result.startswith("Error: ")
    assert "500" in result


async def test_an_unconfigured_memory_link_is_a_stated_error(memory_ctx):
    ctx = memory_ctx(None)
    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, ctx)
    assert ok is False
    assert "MEMORY_URL" in result


# -- memory_save -----------------------------------------------------------


async def test_save_posts_the_note_and_reports_where_it_landed(memory_ctx):
    memory = fakes.FakeMemory()
    ctx = memory_ctx(memory)

    result, ok = await tools.dispatch(
        "memory_save", {"title": "Coffee order", "content": "flat white"}, ctx
    )
    assert ok is True
    assert "people/x/topics/coffee-order.md" in result
    assert memory.saves == [
        {"person_id": str(PERSON.id), "title": "Coffee order", "content": "flat white"}
    ]


async def test_a_save_the_service_did_not_confirm_is_a_failure(memory_ctx):
    """A 200 is not a save — the endpoint has to say it verified one."""
    ctx = memory_ctx(fakes.FakeMemory(save_body={"path": "people/x/topics/a.md"}))
    result, ok = await tools.dispatch("memory_save", {"title": "A", "content": "b"}, ctx)
    assert ok is False
    assert "without confirming" in result


async def test_a_failed_save_is_a_stated_error(memory_ctx):
    ctx = memory_ctx(fakes.FakeMemory(save_status=500))
    result, ok = await tools.dispatch("memory_save", {"title": "A", "content": "b"}, ctx)
    assert ok is False
    assert "500" in result


# -- get_time --------------------------------------------------------------


async def test_get_time_says_utc_and_gives_a_usable_epoch(tmp_path):
    ctx = ToolContext(app=None, person=PERSON, workspace_root=tmp_path)
    result, ok = await tools.dispatch("get_time", "", ctx)
    assert ok is True
    assert "UTC" in result
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", result)
    epoch = int(re.search(r"unix epoch (\d+)", result).group(1))
    assert abs(epoch - time.time()) < 60
