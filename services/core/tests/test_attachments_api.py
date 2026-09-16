"""S28 — /api/v1/attachments, the route that takes a file he gave her.

The test that matters most is the last one: it reads nginx's ceiling out of
the deployed config and asserts core states the same number. That pair
disagreeing IS the v3 attachments bug — the dev server accepted what the
one-origin build rejected, so it worked everywhere except the phone.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from app import attachments
from tests.conftest import requires_db

pytestmark = requires_db

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


async def _conversation(client) -> str:
    resp = await client.get("/api/v1/conversations/active")
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


async def _upload(client, conversation: str, name: str, body: bytes):
    return await client.post(
        "/api/v1/attachments",
        data={"conversation_id": conversation},
        files={"file": (name, body, "application/octet-stream")},
    )


async def test_a_file_he_sends_lands_in_the_workspace_and_answers_with_the_row(
    owner_client, tmp_path, monkeypatch
):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation = await _conversation(owner_client)

    resp = await _upload(owner_client, conversation, "shot.png", PNG)

    assert resp.status_code == 200, resp.text
    got = resp.json()["attachment"]
    # Sniffed from the BYTES — the multipart part above declared
    # application/octet-stream, and that claim is not consulted.
    assert got["media_type"] == "image/png" and got["kind"] == "image"
    assert got["filename"] == "shot.png"
    assert got["size_bytes"] == len(PNG)
    assert got["path"] == f"attachments/{conversation}/shot.png"
    # The bytes are really there, under the path the row names.
    assert (tmp_path / got["path"]).read_bytes() == PNG


async def test_an_empty_file_is_refused_with_the_reason(owner_client, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation = await _conversation(owner_client)

    resp = await _upload(owner_client, conversation, "nothing.txt", b"")

    assert resp.status_code == 400, resp.text
    assert "nothing in it" in resp.json()["error"]


async def test_too_big_is_a_413_that_states_the_ceiling(owner_client, tmp_path, monkeypatch):
    """nginx refuses the same request at the same ceiling with a bare 413 and
    no sentence. "The upload failed" with no number is how someone tries the
    same photo three times."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(attachments, "MAX_BYTES", 64)
    conversation = await _conversation(owner_client)

    resp = await _upload(owner_client, conversation, "big.bin", b"x" * 65)

    assert resp.status_code == 413, resp.text
    assert "the limit is" in resp.json()["error"]


async def test_a_conversation_that_is_not_his_is_not_found(owner_client, tmp_path, monkeypatch):
    """Not forbidden — the same answer every conversation route gives, so
    nothing here tells a stranger which conversations exist."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))

    resp = await _upload(owner_client, str(uuid.uuid4()), "shot.png", PNG)

    assert resp.status_code == 404, resp.text


async def test_an_upload_needs_a_session(client, tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))

    resp = await _upload(client, str(uuid.uuid4()), "shot.png", PNG)

    assert resp.status_code == 401, resp.text


async def test_the_page_can_ask_the_limit_rather_than_carrying_a_copy(owner_client):
    resp = await owner_client.get("/api/v1/attachments/limits")

    assert resp.status_code == 200, resp.text
    assert resp.json()["max_bytes"] == attachments.MAX_BYTES


def test_nginx_and_core_agree_on_the_ceiling():
    """THE v3 BUG, as a line of code that refuses.

    nginx's default body limit is 1 MiB. In v3 that default was the whole
    defect: the dev server accepted a photo the one-origin build rejected
    with a bare 413, so attachments worked on the laptop and failed on the
    phone — the only device he sends photos from.

    If these two ever disagree the SMALLER one wins silently, and the message
    he gets is nginx's, which says nothing useful.
    """
    conf = Path(__file__).resolve().parents[3] / "apps/web/nginx.conf.template"
    assert conf.exists(), f"{conf} moved — this rule is now vacuous"
    found = re.search(r"client_max_body_size\s+(\d+)([kKmMgG]?)", conf.read_text())
    assert found, "nginx declares no client_max_body_size, so its default of 1 MiB applies"
    size = (
        int(found.group(1)) * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[found.group(2).lower()]
    )
    assert size == attachments.MAX_BYTES, (
        f"nginx allows {size} bytes and core states {attachments.MAX_BYTES} — "
        "the smaller wins silently, and only one of them can explain itself"
    )
