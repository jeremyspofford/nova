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
from app.tools import memory_tools
from app.tools.base import ToolContext, ToolFailure
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
            app.state.peer_transports = {fakes.MEMORY_URL: fakes.StreamingASGITransport(memory.app)}
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


PARTIAL = (
    {"name": "lexical", "ran": True, "ranked": 2},
    {
        "name": "semantic",
        "ran": True,
        "ranked": 1,
        "coverage": "12 of 47 notes in this scope are embedded",
    },
)
PART_MATCHED = (
    "1 note(s) matched and cleared the relevance floor, best match first. The semantic "
    "search covered only part of the notes — 12 of 47 notes in this scope are embedded."
)


async def test_hits_from_a_search_over_part_of_the_notes_carry_the_caveat(memory_ctx):
    """MAJOR 2 of the adversarial review, 2026-09-10.

    Both retrievers ran; the meaning half reached twelve notes of forty-seven.
    `_reduced` selected on `ran is False` alone, so this read as a whole search
    and memory's sentence was withheld — the tool she reaches for deliberately
    answered "1 note(s) matched" about a quarter of her notes.
    """
    memory = fakes.FakeMemory(
        results=({"title": "Coffee", "kind": "topic", "snippet": "pour-over, no sugar"},),
        recall_statement=PART_MATCHED,
        recall_retrievers=PARTIAL,
    )
    result, ok = await tools.dispatch("memory_search", {"query": "coffee"}, memory_ctx(memory))
    assert ok is True
    assert "Coffee (topic): pour-over, no sugar" in result
    assert "12 of 47 notes in this scope are embedded" in result


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


# -- a note's live source, checked against the LIVE registry (S14-1) -------
#
# Owner ruling 2026-09-10: a fact a tool can look up ad hoc — a machine's
# memory, the models installed, the time — should be looked up ad hoc, and the
# note about it is history. A distilled note may therefore carry the call that
# answers it now, and a call that could never dispatch must not be written
# down. The memory service checks the SHAPE (it does not and must not import
# this registry); these are the checks only this process can make.


def test_a_live_source_naming_a_tool_that_does_not_exist_is_refused():
    with pytest.raises(ToolFailure, match="no tool called"):
        memory_tools.validate_live_source({"tool": "read_the_owners_mind", "args": {}})


def test_a_live_source_whose_arguments_that_tool_would_refuse_is_refused():
    """Checked against the tool's OWN advertised schema, so a tool registered
    tomorrow is validated with no edit here."""
    with pytest.raises(ToolFailure, match="would refuse those arguments"):
        memory_tools.validate_live_source({"tool": "memory_search", "args": {"query": 7}})
    with pytest.raises(ToolFailure, match="would refuse those arguments"):
        memory_tools.validate_live_source({"tool": "memory_search", "args": {}})


def test_a_live_source_that_can_actually_dispatch_comes_back_normalised():
    assert memory_tools.validate_live_source(
        {"tool": " memory_search ", "args": {"query": "vram"}}
    ) == {"tool": "memory_search", "args": {"query": "vram"}}
    # A call with no arguments is a call, not a malformed one.
    assert memory_tools.validate_live_source({"tool": "get_time"}) == {
        "tool": "get_time",
        "args": {},
    }


def test_no_registered_tool_is_rejected_as_an_unknown_name():
    """Derived, never hardcoded: nothing here holds a list of which tools may
    answer a fact. Every tool in the live registry is a name this accepts, so
    the day a read tool is registered it is usable as a live source with no
    edit here — and the day one is renamed, this is what notices."""
    for name in tools.REGISTRY:
        try:
            memory_tools.validate_live_source({"tool": name, "args": {}})
        except ToolFailure as exc:
            # Missing required arguments is a fact about these ARGS. An
            # unknown name would be a fact about the registry, and there is
            # no tool in the registry this may call unknown.
            assert "no tool called" not in str(exc), name


async def test_the_call_path_itself_refuses_an_unusable_live_source(memory_ctx):
    """The single door. A caller inside this process that posts a live_source
    to /save is checked before the request leaves, so writing a note naming a
    call that can never run is a property of the path rather than a habit of
    whoever remembered to validate."""
    memory = fakes.FakeMemory()
    ctx = memory_ctx(memory)
    with pytest.raises(ToolFailure, match="no tool called"):
        await memory_tools._call_memory(
            ctx,
            "/save",
            {
                "person_id": str(PERSON.id),
                "title": "Vram",
                "content": "24GB",
                "live_source": {"tool": "nope", "args": {}},
            },
        )
    # Nothing was posted: the note does not exist anywhere.
    assert memory.saves == []


# -- get_time --------------------------------------------------------------


async def test_get_time_says_utc_and_gives_a_usable_epoch(tmp_path):
    ctx = ToolContext(app=None, person=PERSON, workspace_root=tmp_path)
    result, ok = await tools.dispatch("get_time", "", ctx)
    assert ok is True
    assert "UTC" in result
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", result)
    epoch = int(re.search(r"unix epoch (\d+)", result).group(1))
    assert abs(epoch - time.time()) < 60
