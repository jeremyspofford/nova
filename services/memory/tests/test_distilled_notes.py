"""S14-1 — the distilled note shape: dated by its exchange, cited, superseded.

Nova's memory is 99% raw transcript. A later sub-slice writes short factual
notes distilled out of that transcript; this suite is the line of code that
refuses when such a note claims more than it can show. Four claims, and one
test each for the way each of them goes wrong:

  * a fact replaced by a newer one must not come back from /recall, and must
    still be on disk with its own date (superseding by SUBJECT, mechanical);
  * a fact distilled today out of a conversation twelve days ago is twelve
    days old — to the recency ranker and to the age the prompt prints;
  * a citation carries the ROLE of the row it cites, because a fact standing
    only on an assistant row is supported by something the model produced;
  * a fact a tool can answer right now is HISTORY, and says so.

And the property that makes all four safe to ship: a note written before any
of these fields existed still loads, still indexes and still recalls.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from app import api
from app.main import app
from app.store import MemoryStore, normalize_live_source, normalize_source

BASE_URL = "http://test"
TOKEN = "test-token"
PERSON = "alice"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL)


def _auth(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path / "root"))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    # Every test builds its index from an empty root, so nothing survives
    # between them — the same cold build a restart does.
    api._contexts.clear()


def _headers() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


async def _save(client, **body):
    return await client.post("/save", headers=_headers(), json=body)


async def _recall(client, query, person_id=PERSON, k=5):
    resp = await client.post(
        "/recall", headers=_headers(), json={"query": query, "person_id": person_id, "k": k}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _read(tmp_path, rel_path: str) -> str:
    return (tmp_path / "root" / rel_path).read_text(encoding="utf-8")


# -- superseding by subject ------------------------------------------------


async def test_two_facts_on_one_subject_leave_one_live_note_and_a_dated_predecessor(
    monkeypatch, tmp_path
):
    """THE GATE. Both notes stay on disk; only the newer one is recallable.

    This is the shape the store could not express at all before S14-1: /save
    was create-only, so "24GB" and "48GB" became two files, both indexed, both
    returned, with nothing anywhere carrying the idea that one replaced the
    other.
    """
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        first = await _save(
            client,
            person_id=PERSON,
            title="Graphics memory",
            content="The graphics card in the desktop holds 24GB of vram.",
            subject="hardware.vram",
            said_at="2026-08-20",
        )
        second = await _save(
            client,
            person_id=PERSON,
            title="Graphics memory now",
            content="The graphics card in the desktop holds 48GB of vram.",
            subject="hardware.vram",
            said_at="2026-09-08",
        )
        found = await _recall(client, "how much vram does the graphics card hold")

    assert first.status_code == 200 and second.status_code == 200
    old_path = first.json()["path"]
    new_path = second.json()["path"]
    assert old_path != new_path
    # The newer save says what it retired, rather than leaving the caller to
    # infer it from a silence.
    assert first.json()["superseded"] == []
    assert second.json()["superseded"] == [old_path]

    # NOTHING IS DELETED. The predecessor is on disk, with its own date and
    # its own body, and it names what replaced it — "what did I have before"
    # stays answerable.
    old_text = _read(tmp_path, old_path)
    assert "24GB" in old_text
    assert "created: 2026-08-20" in old_text
    assert f"superseded_by: {new_path}" in old_text
    # And the live note was not touched by the stamping pass.
    assert "superseded_by" not in _read(tmp_path, new_path)

    # RECALL RETURNS ONLY THE LIVE ONE.
    assert [hit["path"] for hit in found["hits"]] == [new_path]


async def test_a_superseded_note_does_not_come_back_after_a_restart(monkeypatch, tmp_path):
    """The skip is a property of what is on disk, not of this process.

    Dropping the old note from the in-process index at the moment it is
    superseded would look identical to this in one test and be gone at the
    next boot, when the whole store is rescanned from the files.
    """
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        old = await _save(
            client,
            person_id=PERSON,
            title="Coffee",
            content="The coffee is a light roast from Ethiopia.",
            subject="prefs.coffee",
        )
        new = await _save(
            client,
            person_id=PERSON,
            title="Coffee now",
            content="The coffee is a dark roast from Sumatra.",
            subject="prefs.coffee",
        )

    # The restart: throw the whole in-process context away and rebuild it by
    # rescanning the files, exactly as warm_context does at boot.
    api._contexts.clear()
    async with _client() as client:
        found = await _recall(client, "coffee roast")

    assert [hit["path"] for hit in found["hits"]] == [new.json()["path"]]
    assert (tmp_path / "root" / old.json()["path"]).is_file()


async def test_superseding_is_by_subject_and_never_by_the_words(monkeypatch, tmp_path):
    """Two notes that plainly contradict each other, with no subject between
    them, are two notes. Nothing here reads sentences and decides."""
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(client, person_id=PERSON, title="Vram", content="The card holds 24GB of vram.")
        await _save(client, person_id=PERSON, title="Vram 2", content="The card holds 48GB vram.")
        found = await _recall(client, "how much vram does the card hold")
    assert len(found["hits"]) == 2


async def test_a_subject_matches_across_capitalisation(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        first = await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="The card holds 24GB of vram.",
            subject="Hardware.VRAM",
        )
        second = await _save(
            client,
            person_id=PERSON,
            title="Vram now",
            content="The card holds 48GB of vram.",
            subject="  hardware.vram  ",
        )
    assert second.json()["superseded"] == [first.json()["path"]]


async def test_superseding_never_crosses_between_people(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        mine = await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="The card holds 24GB of vram.",
            subject="hardware.vram",
        )
        theirs = await _save(
            client,
            person_id="bob",
            title="Vram",
            content="The card holds 12GB of vram.",
            subject="hardware.vram",
        )
    assert theirs.json()["superseded"] == []
    assert "superseded_by" not in _read(tmp_path, mine.json()["path"])


async def test_a_save_that_cannot_retire_the_older_note_is_a_500_not_a_success(
    monkeypatch, tmp_path
):
    """The stamp did not land, so the old note is still live and recallable.

    A 200 here would be the exact defect superseding exists to remove — two
    contradicting notes, both returned — reported as a clean save. The
    endpoint asks the INDEX whether the old units are actually gone rather
    than trusting the write it just made.
    """
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="The card holds 24GB of vram.",
            subject="hardware.vram",
        )

        def silently_do_nothing(self, abs_path, superseded_by):
            """os.replace returning without raising is not proof the key is in
            the file — here it never even tried."""

        monkeypatch.setattr(MemoryStore, "mark_superseded", silently_do_nothing)
        resp = await _save(
            client,
            person_id=PERSON,
            title="Vram now",
            content="The card holds 48GB of vram.",
            subject="hardware.vram",
        )
    assert resp.status_code == 500
    assert "still in the index" in resp.json()["error"]


async def test_a_stamp_that_raises_names_the_note_that_was_written(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="The card holds 24GB of vram.",
            subject="hardware.vram",
        )

        def refuse(self, abs_path, superseded_by):
            raise OSError("read-only file system")

        monkeypatch.setattr(MemoryStore, "mark_superseded", refuse)
        resp = await _save(
            client,
            person_id=PERSON,
            title="Vram now",
            content="The card holds 48GB of vram.",
            subject="hardware.vram",
        )
    assert resp.status_code == 500
    error = resp.json()["error"]
    # The path it DID write is in the message: a 500 that hides the file it
    # created leaves an operator hunting for it.
    assert "topics/vram-now.md" in error and "read-only file system" in error


def test_a_superseded_note_is_not_in_the_index_at_all(tmp_path):
    """Not filtered out of the results — never counted.

    A superseded unit left in the corpus with a flag would still move document
    frequency, the average length and the semantic floor for the notes that
    replaced it: ranking live notes against a note nothing may return.
    """
    store = MemoryStore(tmp_path)
    store.write_topic(PERSON, "old", "Vram", "The card holds 24GB of vram.", subject="hw.vram")
    store.write_topic(PERSON, "new", "Vram", "The card holds 48GB of vram.", subject="hw.vram")
    old = store.resolve_in_person(PERSON, f"people/{PERSON}/topics/old.md")
    store.mark_superseded(old, f"people/{PERSON}/topics/new.md")

    index = api.BM25Index()
    for stored in store.iter_all():
        api._index_document(index, stored)
    assert index.units_for(f"people/{PERSON}/topics/old.md") == []
    assert index.units_for(f"people/{PERSON}/topics/new.md") == [f"people/{PERSON}/topics/new.md"]


def test_indexing_a_superseded_file_reports_that_nothing_landed(tmp_path):
    """_index_document returns what it INDEXED. Handing back unit ids for a
    file it deliberately dropped would be a step reporting work it did not
    do."""
    store = MemoryStore(tmp_path)
    path = store.write_topic(PERSON, "old", "Vram", "24GB of vram.", subject="hw.vram")
    store.mark_superseded(path, "people/alice/topics/new.md")
    index = api.BM25Index()
    assert api._index_document(index, store.read(path)) == []


# -- dated by the exchange, not by the write -------------------------------


async def test_a_note_keeps_its_exchange_date_rather_than_the_write_date(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    said = date.today() - timedelta(days=12)
    async with _client() as client:
        saved = await _save(
            client,
            person_id=PERSON,
            title="Kettle",
            content="The kettle in the kitchen is a new one.",
            said_at=said.isoformat(),
        )
        found = await _recall(client, "what kettle is in the kitchen")

    assert f"created: {said.isoformat()}" in _read(tmp_path, saved.json()["path"])
    assert f"said_at: {said.isoformat()}" in _read(tmp_path, saved.json()["path"])
    # The date that reaches the caller — and therefore the age the prompt
    # prints — is the exchange's, not this morning's.
    assert found["hits"][0]["created"] == said.isoformat()


async def test_an_explicit_created_wins_over_said_at(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        saved = await _save(
            client,
            person_id=PERSON,
            title="Kettle",
            content="The kettle is new.",
            said_at="2026-08-01",
            created="2026-08-15",
        )
    text = _read(tmp_path, saved.json()["path"])
    assert "created: 2026-08-15" in text and "said_at: 2026-08-01" in text


async def test_a_save_with_no_dates_is_dated_today_exactly_as_before(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        saved = await _save(client, person_id=PERSON, title="Kettle", content="The kettle is new.")
    text = _read(tmp_path, saved.json()["path"])
    assert f"created: {date.today().isoformat()}" in text
    assert "said_at" not in text


async def test_the_recency_ranking_follows_the_exchange_and_not_the_write(monkeypatch, tmp_path):
    """Both notes are written in the same second; one was SAID a year ago.

    This is what a backfill of twelve days of history would get wrong if
    `created` were the write date: every distilled fact stamped as this
    morning's and ranked above the transcript it came from.
    """
    _auth(monkeypatch, tmp_path)
    text = "Alice likes pour-over coffee brewed slowly."
    async with _client() as client:
        old = await _save(
            client,
            person_id=PERSON,
            title="Coffee then",
            content=text,
            said_at=(date.today() - timedelta(days=365)).isoformat(),
        )
        new = await _save(
            client,
            person_id=PERSON,
            title="Coffee now",
            content=text,
            said_at=date.today().isoformat(),
        )
        found = await _recall(client, "pour-over coffee")
    assert [hit["path"] for hit in found["hits"]] == [new.json()["path"], old.json()["path"]]


# -- the citation, and whose words it stands on ----------------------------


async def test_a_citation_reaches_the_caller_with_the_role_of_the_row(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Coffee",
            content="Alice drinks pour-over coffee.",
            source={"message_id": "msg-17", "role": "assistant"},
        )
        found = await _recall(client, "pour-over coffee")
    # A fact standing only on an assistant row is standing on something the
    # model itself produced. The role is what says so, and it survives.
    assert found["hits"][0]["source"] == {"message_id": "msg-17", "role": "assistant"}


async def test_a_citation_is_not_in_the_indexed_text(monkeypatch, tmp_path):
    """The whole reason provenance is a frontmatter FIELD.

    A citation written into the body would put its own words into the index:
    every distilled note would carry them, so they would match every question
    that contained one and discriminate between nothing.
    """
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Coffee",
            content="Alice drinks pour-over coffee.",
            source={"message_id": "distinctivemessageid", "role": "user"},
        )
        found = await _recall(client, "distinctivemessageid")
    assert found["found"] is False


@pytest.mark.parametrize(
    "source",
    [
        {"message_id": "msg-17"},
        {"message_id": "msg-17", "role": "system"},
        {"role": "user"},
        {"message_id": "  ", "role": "user"},
    ],
)
async def test_a_citation_that_cannot_say_whose_row_it_is_is_refused(monkeypatch, tmp_path, source):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(
            client, person_id=PERSON, title="Coffee", content="pour-over", source=source
        )
    assert resp.status_code in (400, 422)
    assert not (tmp_path / "root" / "people" / PERSON).exists()


def test_the_store_refuses_a_half_citation_too(tmp_path):
    """Not only the HTTP edge: a caller inside the process gets the same
    refusal, naming what is missing."""
    with pytest.raises(ValueError, match="role"):
        normalize_source({"message_id": "msg-1", "role": "narrator"})
    with pytest.raises(ValueError, match="message id"):
        normalize_source({"role": "user"})
    assert normalize_source({"message_id": " msg-1 ", "role": "user"}) == {
        "message_id": "msg-1",
        "role": "user",
    }


# -- the fact a tool can answer right now ----------------------------------


async def test_a_live_source_reaches_the_caller_so_the_note_reads_as_history(monkeypatch, tmp_path):
    """Owner ruling 2026-09-10: a spec a command can read is found ad hoc, and
    the note about it is history worth keeping for comparison."""
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Graphics memory",
            content="The card in the desktop holds 24GB of vram.",
            subject="hardware.vram",
            live_source={"tool": "device_info", "args": {"device": "desktop"}},
        )
        found = await _recall(client, "how much vram does the card hold")
    assert found["hits"][0]["live_source"] == {
        "tool": "device_info",
        "args": {"device": "desktop"},
    }


async def test_a_told_once_fact_says_nothing_can_check_it(monkeypatch, tmp_path):
    """The other half of the distinction, and it has to be stated rather than
    absent: a preference has no live source, and None is the answer "these
    notes are the source" rather than "this service did not say"."""
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client,
            person_id=PERSON,
            title="Coffee",
            content="Alice drinks pour-over coffee, never filter.",
            subject="prefs.coffee",
        )
        found = await _recall(client, "pour-over coffee")
    assert found["hits"][0]["live_source"] is None


@pytest.mark.parametrize(
    "live_source",
    [
        {"args": {"device": "desktop"}},
        {"tool": "   ", "args": {}},
        {"tool": "device_info", "args": "desktop"},
        "device_info",
    ],
)
async def test_a_live_source_that_is_not_a_call_is_refused(monkeypatch, tmp_path, live_source):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="24GB",
            live_source=live_source,
        )
    assert resp.status_code in (400, 422)
    assert not (tmp_path / "root" / "people" / PERSON).exists()


def test_the_store_checks_the_shape_of_a_live_source_and_says_so(tmp_path):
    """SHAPE ONLY, deliberately. Whether `device_info` is a registered tool and
    whether those args satisfy its schema are facts about core's live
    registry, which this service does not import — a copy of the tool names
    here would be a hand-maintained list, wrong the day a tool is added and
    wrong silently. The name check lives in the caller
    (core: app/tools/memory_tools.validate_live_source)."""
    assert normalize_live_source({"tool": " device_info ", "args": {"device": "desktop"}}) == {
        "tool": "device_info",
        "args": {"device": "desktop"},
    }
    # No args at all is a call with no arguments, not a malformed one.
    assert normalize_live_source({"tool": "get_time"}) == {"tool": "get_time", "args": {}}
    with pytest.raises(ValueError, match="name the tool"):
        normalize_live_source({"args": {}})
    with pytest.raises(ValueError, match="args"):
        normalize_live_source({"tool": "device_info", "args": ["desktop"]})
    # A shape check may not pretend to be a registry check: a tool that does
    # not exist passes HERE, and is refused by the caller that has the list.
    assert normalize_live_source({"tool": "no_such_tool_anywhere"})["tool"] == (
        "no_such_tool_anywhere"
    )


# -- every note written before any of this existed -------------------------


async def test_a_note_with_none_of_the_new_fields_loads_indexes_and_recalls_unchanged(
    monkeypatch, tmp_path
):
    """The corpus as it stands is 47 units and not one of them has a subject,
    a citation or a live source. All five fields are optional, and absence is
    read as "nothing is claimed" rather than as a default."""
    _auth(monkeypatch, tmp_path)
    store = MemoryStore(tmp_path / "root")
    path = store.write_topic(PERSON, "coffee", "Coffee", "Alice drinks pour-over coffee.")
    text = path.read_text(encoding="utf-8")
    for key in ("subject:", "said_at:", "source:", "live_source:", "superseded_by:"):
        assert key not in text

    async with _client() as client:
        found = await _recall(client, "pour-over coffee")
    hit = found["hits"][0]
    assert hit["path"] == f"people/{PERSON}/topics/coffee.md"
    assert hit["source"] is None and hit["live_source"] is None
    assert hit["created"] == date.today().isoformat()


async def test_a_save_with_no_new_fields_writes_the_same_file_it_always_did(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id=PERSON, title="Note", content="body")
    assert resp.json() == {
        "path": f"people/{PERSON}/topics/note.md",
        "saved": True,
        # Nothing was retired, and the route says so with an empty list rather
        # than by omitting the key: "nothing was superseded" is an answer.
        "superseded": [],
    }
    text = _read(tmp_path, resp.json()["path"])
    for key in ("subject:", "said_at:", "source:", "live_source:", "superseded_by:"):
        assert key not in text


async def test_the_content_check_still_refuses_a_save_it_cannot_confirm(monkeypatch, tmp_path):
    """The mechanical verification /save has always run, with the new fields
    threaded through it: the content must be in the file it claims to have
    written."""
    _auth(monkeypatch, tmp_path)

    real_write = MemoryStore.create_topic

    def write_something_else(self, person_id, title, body, **kwargs):
        return real_write(self, person_id, title, "not what was asked for", **kwargs)

    monkeypatch.setattr(MemoryStore, "create_topic", write_something_else)
    async with _client() as client:
        resp = await _save(
            client,
            person_id=PERSON,
            title="Vram",
            content="The card holds 48GB of vram.",
            subject="hardware.vram",
            said_at="2026-09-01",
            source={"message_id": "msg-3", "role": "user"},
            live_source={"tool": "device_info", "args": {"device": "desktop"}},
        )
    assert resp.status_code == 500
    assert "verify" in resp.json()["error"]
