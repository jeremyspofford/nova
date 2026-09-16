"""S28 — the store behind "here, look at this".

Most of what is pinned here is about not lying: that the bytes decide what a
file IS rather than the name or the browser's claim, that two files with one
name stay two files, and that a row never points at a path with nothing
behind it.
"""

from __future__ import annotations

import uuid

import pytest

from app import attachments
from tests.conftest import requires_db

pytestmark = requires_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 40
PDF = b"%PDF-1.7\n" + b"\x00" * 40


async def _conversation(pool) -> tuple[uuid.UUID, uuid.UUID]:
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    return conversation, person


async def _message(pool, conversation: uuid.UUID, text: str = "look at this") -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) "
        "VALUES ($1, 'user', $2) RETURNING id",
        conversation,
        text,
    )


async def _store(pool, conversation, person, name, body):
    return await attachments.store(
        pool, conversation_id=conversation, person_id=person, filename=name, body=body
    )


# -- what the bytes say they are -------------------------------------------------


def test_the_bytes_decide_what_a_file_is_not_its_name():
    """A browser's Content-Type and a filename are both claims made by
    whatever sent the request. This one turns into a DECISION downstream —
    "this is an image" is what moves a turn onto a different model — so it
    is read off the bytes."""
    assert attachments.sniff(PNG, filename="notes.txt") == "image/png"
    assert attachments.sniff(JPEG, filename="whatever") == "image/jpeg"
    assert attachments.sniff(PDF, filename="statement.pdf") == "application/pdf"
    # And the other way: a name that promises an image, over bytes that are
    # not one, is not one.
    assert attachments.sniff(b"just words\n", filename="photo.png") == "text/plain"


def test_riff_and_mp4_containers_are_read_past_their_header():
    """WEBP and WAV share four bytes and are not remotely the same thing; so
    do m4a and mp4. A container read only by its first four bytes would call
    a voice note a picture."""
    assert attachments.sniff(b"RIFF\x00\x00\x00\x00WEBP", filename="x") == "image/webp"
    assert attachments.sniff(b"RIFF\x00\x00\x00\x00WAVE", filename="x") == "audio/wav"
    assert attachments.sniff(b"\x00\x00\x00\x20ftypM4A ", filename="x") == "audio/mp4"
    assert attachments.sniff(b"\x00\x00\x00\x20ftypisom", filename="x") == "video/mp4"


def test_text_is_what_decodes_and_the_extension_only_picks_which_text():
    assert attachments.sniff(b"a,b,c\n1,2,3\n", filename="rows.csv") == "text/csv"
    assert attachments.sniff(b"# hello\n", filename="README.md") == "text/markdown"
    assert attachments.sniff(b"hello\n", filename="log") == "text/plain"
    assert attachments.sniff(b"\x00\x01\x02\x03", filename="x.txt") == "application/octet-stream"


def test_a_name_is_only_a_name():
    """A browser sends what the OS gave it, which on some platforms is a
    full path — and `..` is a name a person can type."""
    assert attachments.safe_name("/etc/passwd") == "passwd"
    assert attachments.safe_name("C:\\Users\\me\\shot.png") == "shot.png"
    assert attachments.safe_name("../../secrets.env") == "secrets.env"
    assert attachments.safe_name("a\x00b.txt") == "ab.txt"
    with pytest.raises(attachments.AttachmentError, match="no name"):
        attachments.safe_name("   ")
    with pytest.raises(attachments.AttachmentError, match="no name"):
        attachments.safe_name("..")


def test_a_long_name_keeps_its_extension():
    """Truncating blindly would take the suffix off, and the suffix is what
    picks which KIND of text a file is."""
    name = attachments.safe_name("x" * 400 + ".csv")
    assert len(name) <= 200 and name.endswith(".csv")


# -- landing the bytes -----------------------------------------------------------


async def test_a_stored_file_is_a_real_file_she_can_read_with_her_own_tools(
    pool, tmp_path, monkeypatch
):
    """The whole design in one test: the row points at a path INSIDE the
    workspace, and the bytes are there. She reads it with
    `workspace_read_file`, so the read lands on the trace."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)

    got = await _store(pool, conversation, person, "shot.png", PNG)

    assert got.media_type == "image/png" and got.kind == "image"
    assert got.size_bytes == len(PNG)
    # Relative to the workspace root — the same string her tools take, so
    # "read the file he sent" needs no translation.
    assert got.path == f"attachments/{conversation}/shot.png"
    assert (tmp_path / got.path).read_bytes() == PNG


async def test_two_files_with_one_name_stay_two_files(pool, tmp_path, monkeypatch):
    """Two screenshots are both called Screenshot.png. Overwriting the first
    would show him the wrong image with nothing saying so."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)

    first = await _store(pool, conversation, person, "Screenshot.png", PNG)
    second = await _store(pool, conversation, person, "Screenshot.png", JPEG)

    assert first.path != second.path
    assert second.path.endswith("Screenshot-2.png")
    assert (tmp_path / first.path).read_bytes() == PNG
    assert (tmp_path / second.path).read_bytes() == JPEG


async def test_an_empty_file_and_an_oversized_one_are_refused_in_words(pool, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)

    with pytest.raises(attachments.AttachmentError, match="nothing in it"):
        await _store(pool, conversation, person, "empty.txt", b"")

    too_big = b"x" * (attachments.MAX_BYTES + 1)
    with pytest.raises(attachments.AttachmentError) as caught:
        await _store(pool, conversation, person, "huge.bin", too_big)
    # The refusal states the ceiling, because a limit he cannot see is one he
    # finds by hitting it twice.
    assert "100 MB" in str(caught.value)


async def test_nothing_lands_outside_the_workspace(pool, tmp_path, monkeypatch):
    """The name is cleaned, and then the path is resolved through the SAME
    containment gate her file tools use — two different mechanisms, because
    this one is reached from outside."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)

    got = await _store(pool, conversation, person, "../../escape.txt", b"hello\n")

    assert (tmp_path / got.path).exists()
    assert not (tmp_path.parent / "escape.txt").exists()


# -- binding to the message it was sent with -------------------------------------


async def test_sending_binds_the_uploads_to_that_message(pool, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)
    one = await _store(pool, conversation, person, "a.txt", b"one\n")
    two = await _store(pool, conversation, person, "b.txt", b"two\n")
    message = await _message(pool, conversation)

    bound = await attachments.bind(
        pool,
        conversation_id=conversation,
        person_id=person,
        message_id=message,
        ids=[one.id, two.id],
    )

    assert {a.id for a in bound} == {one.id, two.id}
    assert [a.filename for a in await attachments.for_message(pool, message)] == ["a.txt", "b.txt"]


async def test_an_id_from_another_conversation_binds_nothing(pool, tmp_path, monkeypatch):
    """ "Not yours" and "not there" are not distinctions this API makes — the
    same answer `owned_conversation` gives. It binds nothing rather than
    raising, because the ids come off a client."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    mine, person = await _conversation(pool)
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    elsewhere = await _store(pool, theirs, person, "theirs.txt", b"x\n")
    message = await _message(pool, mine)

    bound = await attachments.bind(
        pool,
        conversation_id=mine,
        person_id=person,
        message_id=message,
        ids=[elsewhere.id, uuid.uuid4()],
    )

    assert bound == []
    assert await attachments.for_message(pool, message) == []


async def test_an_upload_already_sent_cannot_be_moved_to_a_later_message(
    pool, tmp_path, monkeypatch
):
    """Re-sending an id would otherwise take the file off the message it was
    about and put it on a new one — and the first message would quietly stop
    being about anything."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)
    file = await _store(pool, conversation, person, "a.txt", b"one\n")
    first = await _message(pool, conversation, "here")
    await attachments.bind(
        pool, conversation_id=conversation, person_id=person, message_id=first, ids=[file.id]
    )
    second = await _message(pool, conversation, "and again")

    bound = await attachments.bind(
        pool, conversation_id=conversation, person_id=person, message_id=second, ids=[file.id]
    )

    assert bound == []
    assert [a.id for a in await attachments.for_message(pool, first)] == [file.id]
    assert await attachments.for_message(pool, second) == []


async def test_a_page_of_messages_costs_one_query(pool, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation, person = await _conversation(pool)
    first = await _message(pool, conversation, "one")
    second = await _message(pool, conversation, "two")
    a = await _store(pool, conversation, person, "a.txt", b"a\n")
    b = await _store(pool, conversation, person, "b.txt", b"b\n")
    await attachments.bind(
        pool, conversation_id=conversation, person_id=person, message_id=first, ids=[a.id]
    )
    await attachments.bind(
        pool, conversation_id=conversation, person_id=person, message_id=second, ids=[b.id]
    )

    got = await attachments.for_messages(pool, [first, second])

    assert [x.filename for x in got[first]] == ["a.txt"]
    assert [x.filename for x in got[second]] == ["b.txt"]
    assert await attachments.for_messages(pool, []) == {}


def test_the_json_a_client_reads_leaves_the_extracted_text_out():
    """A PDF's text can be a hundred pages. The page has no use for it and
    the thing that does (the turn) reads it from the row."""
    row = attachments.Attachment(
        id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        message_id=None,
        person_id=uuid.uuid4(),
        filename="statement.pdf",
        media_type="application/pdf",
        size_bytes=1234,
        path="attachments/c/statement.pdf",
        extracted_text="page one...",
        extract_note=None,
        created_at=__import__("datetime").datetime.now(),
    )

    shape = attachments.as_json(row)

    assert "extracted_text" not in shape
    assert shape["has_text"] is True
    assert shape["kind"] == "application"
