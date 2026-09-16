"""S28 — what the model is actually sent when he attaches something.

End to end through the real route, against the fake gateway, reading the
REQUEST BODY the gateway saw. That is the only place these properties are
checkable: everything before it is intent, and the failure this guards
against is an image that never reached the model while the reply talked
about it anyway.
"""

from __future__ import annotations

import json

from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import _say, _set_model

pytestmark = requires_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


def _catalog(*rows: dict) -> dict:
    return {"models": list(rows)}


def _row(model: str, *caps: str) -> dict:
    return {
        "id": f"ollama:{model}",
        "installed": True,
        "capabilities": {c: {"value": True} for c in caps},
    }


async def _conversation(client) -> str:
    resp = await client.get("/api/v1/conversations/active")
    return resp.json()["id"]


async def _upload(client, conversation: str, name: str, body: bytes) -> str:
    resp = await client.post(
        "/api/v1/attachments",
        data={"conversation_id": conversation},
        files={"file": (name, body, "application/octet-stream")},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["attachment"]["id"]


def _sent(gateway: FakeGateway) -> dict:
    """The completion body the gateway actually received."""
    for path, body in reversed(gateway.seen):
        if "chat/completions" in path and body:
            return body
    raise AssertionError("the gateway was never asked for a completion")


def _user_content(gateway: FakeGateway):
    return _sent(gateway)["messages"][-1]["content"]


async def test_a_text_file_reaches_the_turn_as_facts_with_the_path_she_reads_it_by(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The path is the whole point: it is the same string
    `workspace_read_file` takes, so reading what he sent leaves a span
    instead of being guessed at."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "notes.txt", b"the disk is full\n")

    status, _ = await _say(
        owner_client,
        "what does this say?",
        attachment_ids=[attachment],
        conversation_id=conversation,
    )

    assert status == 200
    content = _user_content(gateway)
    assert "what does this say?" in content
    assert "He attached 1 file" in content
    assert f"attachments/{conversation}/notes.txt" in content
    # The text itself is not inlined for a plain file — she READS it, and the
    # read is what lands on the trace.
    assert "the disk is full" not in content


async def test_an_image_goes_to_a_model_that_can_see_and_the_swap_is_said(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The owner's ruling: an image he sent is a thing he wants read, so the
    turn runs on a model that can read it and says which."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",),
        catalog_body=_catalog(
            _row("qwen3:8b", "completion", "tools"),
            _row("gemma4:12b", "completion", "tools", "vision"),
        ),
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)

    status, _ = await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    body = _sent(gateway)
    # It ran on the model that can SEE, not the one he had selected.
    assert "gemma4:12b" in body["model"]
    content = body["messages"][-1]["content"]
    # Content parts: the text, then the image as a data URL.
    assert isinstance(content, list)
    assert content[0]["type"] == "text"
    assert "cannot see images" in content[0]["text"], "the swap must be stated in the turn"
    images = [part for part in content if part["type"] == "image_url"]
    assert len(images) == 1
    assert images[0]["image_url"]["url"].startswith("data:image/png;base64,")


async def test_a_box_where_nothing_can_see_says_so_instead_of_describing_it(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The quiet failure this prevents: the image absent from the turn, and a
    reply written from the filename."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",), catalog_body=_catalog(_row("qwen3:8b", "completion", "tools"))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)

    status, _ = await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    body = _sent(gateway)
    assert "qwen3:8b" in body["model"], "nothing could see it, so nothing was swapped"
    content = body["messages"][-1]["content"]
    # A string, not parts: no image was sent, because no model here can read
    # one — and the turn says exactly that.
    assert isinstance(content, str)
    assert "NO model installed here can see images" in content
    assert "do not describe it" in content.lower() or "Say that rather" in content


async def test_a_file_that_has_gone_missing_is_named_not_skipped(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """A row pointing at nothing is a thing she must SAY, not a thing she
    must answer around."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "notes.txt", b"hello\n")
    (tmp_path / "attachments" / conversation / "notes.txt").unlink()

    status, _ = await _say(
        owner_client, "read it", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    content = _user_content(gateway)
    assert "no longer in the workspace" in content
    assert "notes.txt" in content


async def test_a_message_with_no_attachments_is_byte_identical_to_before(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The whole feature must be invisible when it is not used: an ordinary
    turn carries no block, no swap and no parts."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())

    status, _ = await _say(owner_client, "just a question")

    assert status == 200
    content = _user_content(gateway)
    assert content == "just a question"


async def test_an_unreadable_catalogue_does_not_become_a_claim_about_his_box(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """FOUND BY THE WALK, 2026-09-16.

    The gateway publishes its catalogue under `rows` and this read `models`,
    so every turn decided it could not be read — and then said "no model
    installed here can see images", which is a statement about his machine
    that nobody had checked. One of those is a fact about a failed request;
    the other is a fact about the world.
    """
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    # A gateway whose catalogue answers something unreadable.
    gateway = FakeGateway(deltas=("ok",), catalog_body={"fetched_at": "now"})
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)

    status, _ = await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    content = _sent(gateway)["messages"][-1]["content"]
    assert "could not be read" in content
    assert "NO model installed here can see images" not in content


async def test_the_gateways_own_catalogue_key_is_the_one_read(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The other half: `rows` is what the gateway actually sends, and reading
    it is what makes the swap happen at all."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",),
        catalog_body={
            "rows": [
                _row("qwen3:8b", "completion", "tools"),
                _row("gemma4:12b", "completion", "vision"),
            ]
        },
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)

    status, _ = await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    assert "gemma4:12b" in _sent(gateway)["model"]


async def test_the_vision_model_he_chose_is_the_one_that_answers(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """Owner, 2026-09-16: "I should be able to select a vision model, but
    nova should select one on her own if I don't have one." This is the
    first half — the automatic pick is what happens when he has not chosen,
    and it is covered by the swap test above."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",),
        catalog_body={
            "rows": [
                _row("qwen3:8b", "completion", "tools"),
                _row("gemma4:31b", "completion", "vision"),
                _row("qwen3.8:27b", "completion", "vision"),
            ]
        },
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:qwen3:8b")
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.vision_model", "value": "qwen3.8:27b"}
    )
    assert resp.status_code == 200, resp.text
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)

    status, _ = await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    body = _sent(gateway)
    # Not gemma4:31b, which is what she would have picked herself.
    assert "qwen3.8:27b" in body["model"]
    assert "qwen3.8:27b" in body["messages"][-1]["content"][0]["text"]


async def test_a_reloaded_conversation_still_shows_what_was_attached(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """The transcript is the record. A file that vanishes from the message on
    reload leaves him reading "what does this say?" with no way to see what
    "this" was."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=FakeMemory())
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "shot.png", PNG)
    await _say(
        owner_client, "what is this?", attachment_ids=[attachment], conversation_id=conversation
    )

    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")

    assert resp.status_code == 200, resp.text
    rows = resp.json()["messages"]
    mine = [row for row in rows if row["role"] == "user"][-1]
    assert [file["filename"] for file in mine["attachments"]] == ["shot.png"]
    assert mine["attachments"][0]["kind"] == "image"
    # Every row carries the key, empty where nothing was attached — a client
    # should not have to tell "no files" from "this server does not say".
    assert all("attachments" in row for row in rows)
    assert [] in [row["attachments"] for row in rows if row["role"] == "assistant"]


async def test_a_pdfs_text_rides_INTO_the_turn(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """A PDF is not useful as a path alone — she would have to read it with a
    tool that cannot parse it. The text goes in the turn; the file stays in
    the workspace for anything else."""
    from tests.test_attachments import _pdf

    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    conversation = await _conversation(owner_client)
    attachment = await _upload(
        owner_client, conversation, "report.pdf", _pdf(["the roof is leaking"])
    )

    status, _ = await _say(
        owner_client, "summarise this", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    content = _user_content(gateway)
    assert "the roof is leaking" in content
    # WHO read it, said explicitly. Without this she explained the text to
    # herself on the live stack — "no tool here can read PDFs, possibly a
    # text file mislabeled as PDF" — a false claim about this system
    # appended to an otherwise correct answer.
    assert "the text core extracted from report.pdf" in content
    assert "core extracted its text when it was uploaded" in content


async def test_a_scanned_pdf_tells_her_there_is_nothing_to_read(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """So she says that, instead of describing a document from its
    filename."""
    from tests.test_attachments import _pdf

    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(deltas=("ok",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "scan.pdf", _pdf([]))

    status, _ = await _say(
        owner_client, "what is in this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    content = _user_content(gateway)
    assert "no text layer" in content


WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 40


async def test_audio_is_named_and_NEVER_sent_to_the_model(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """MEASURED on this box, 2026-09-16, not assumed.

    gemma4:12b advertises an `audio` capability and ollama 0.33.1 does not
    carry it. Native /api/chat ignores an audio field outright — the model
    answers "please provide the audio file". The OpenAI /v1 path ACCEPTS an
    `input_audio` part and is far worse: given a 0.4s 440Hz sine tone the
    model reported "a single, short word... sounds like 'Whoa'", 0.8 seconds
    long. The control with no audio says "please provide the audio file", so
    this is not caution — the part makes it believe it heard something.

    A capability the MODEL declares is not one the SERVER carries, and
    confident fabrication with no signal is the worst failure this project
    has. So the file lands in the workspace, is named, and the turn says
    nothing here can listen to it.
    """
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",),
        catalog_body={"rows": [_row("gemma4:12b", "completion", "vision", "audio")]},
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:gemma4:12b")
    conversation = await _conversation(owner_client)
    attachment = await _upload(owner_client, conversation, "note.wav", WAV)

    status, _ = await _say(
        owner_client, "what is in this?", attachment_ids=[attachment], conversation_id=conversation
    )

    assert status == 200
    body = _sent(gateway)
    content = body["messages"][-1]["content"]
    # A string, not parts: nothing was attached to the model call.
    assert isinstance(content, str)
    assert "NOTHING on this machine can listen to audio" in content
    assert "Say that you cannot hear it" in content
    # And the whole request carries no audio anywhere, whatever the model
    # says it can do.
    assert "input_audio" not in json.dumps(body)


async def test_an_image_beside_audio_still_reaches_a_model_that_can_see(
    owner_client, pool, mount_peers, tmp_path, monkeypatch
):
    """Audio being unsendable must not cost him the picture in the same
    message."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    gateway = FakeGateway(
        deltas=("ok",), catalog_body={"rows": [_row("gemma4:12b", "completion", "vision")]}
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client, "ollama:gemma4:12b")
    conversation = await _conversation(owner_client)
    picture = await _upload(owner_client, conversation, "shot.png", PNG)
    sound = await _upload(owner_client, conversation, "note.wav", WAV)

    status, _ = await _say(
        owner_client,
        "what is this?",
        attachment_ids=[picture, sound],
        conversation_id=conversation,
    )

    assert status == 200
    content = _sent(gateway)["messages"][-1]["content"]
    assert isinstance(content, list)
    assert len([p for p in content if p["type"] == "image_url"]) == 1
    assert "cannot hear it" in content[0]["text"]
