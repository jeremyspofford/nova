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

import pytest

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


# -- the bytes, so a picture can be drawn (S28) -----------------------------------


async def test_the_content_route_serves_the_bytes_with_the_sniffed_type(
    owner_client, tmp_path, monkeypatch
):
    """The media type is the row's — the same value the TURN routed on — so
    what the browser renders and what she was sent cannot be two opinions
    about one file."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation = await _conversation(owner_client)
    # Declared as octet-stream by the upload; the bytes say PNG.
    got = (await _upload(owner_client, conversation, "shot.png", PNG)).json()["attachment"]

    resp = await owner_client.get(f"/api/v1/attachments/{got['id']}/content")

    assert resp.status_code == 200, resp.text
    assert resp.content == PNG
    assert resp.headers["content-type"].startswith("image/png")
    # Inline, so it renders in place rather than downloading.
    assert "inline" in resp.headers["content-disposition"]
    assert "shot.png" in resp.headers["content-disposition"]


async def test_a_file_whose_bytes_are_gone_is_a_410_not_a_404(owner_client, tmp_path, monkeypatch):
    """ "This never existed" and "this existed and the bytes are gone" are
    different facts, and only the second means the workspace was swept or
    edited underneath it."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation = await _conversation(owner_client)
    got = (await _upload(owner_client, conversation, "shot.png", PNG)).json()["attachment"]
    (tmp_path / got["path"]).unlink()

    resp = await owner_client.get(f"/api/v1/attachments/{got['id']}/content")

    assert resp.status_code == 410, resp.text
    assert "no longer in the workspace" in resp.json()["error"]


async def test_content_needs_a_session(client):
    assert (await client.get(f"/api/v1/attachments/{uuid.uuid4()}/content")).status_code == 401


async def test_an_attachment_that_is_not_his_is_not_found(owner_client):
    resp = await owner_client.get(f"/api/v1/attachments/{uuid.uuid4()}/content")

    assert resp.status_code == 404, resp.text


# -- markup never runs on Nova's origin (verification fix 3, T2) -------------------
#
# An uploaded .html was served `inline` as text/html with no nosniff and no
# CSP: a page he attached ran on Nova's origin, with his session cookie. Only
# the kinds a browser shows without running anything — images and PDF — are
# inline; everything else downloads, with nosniff and a sandboxing CSP, the
# same shape workspace_api.py's /raw already uses.


PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n"
MP3_BYTES = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 32
BIN_BYTES = b"\x00\x01\x02\x03binary\x00"

TEXT_KINDS = [
    ("page.html", b"<html><body><script>alert(document.cookie)</script></body></html>"),
    ("feed.xml", b"<?xml version='1.0'?><x><script>alert(1)</script></x>"),
    ("notes.txt", b"plain words\n"),
    ("rows.csv", b"a,b\n1,2\n"),
    ("data.json", b'{"a": 1}'),
    ("readme.md", b"# heading\n"),
]
NOT_INLINE = [*TEXT_KINDS, ("song.mp3", MP3_BYTES), ("blob.bin", BIN_BYTES)]


async def _content(client, tmp_path, monkeypatch, name: str, body: bytes):
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path))
    conversation = await _conversation(client)
    up = await _upload(client, conversation, name, body)
    assert up.status_code == 200, up.text
    got = up.json()["attachment"]
    resp = await client.get(f"/api/v1/attachments/{got['id']}/content")
    assert resp.status_code == 200, resp.text
    return resp


def _disposition_type(resp) -> str:
    return resp.headers.get("content-disposition", "").split(";", 1)[0].strip().lower()


async def test_an_uploaded_html_page_downloads_and_never_renders(
    owner_client, tmp_path, monkeypatch
):
    """C1: the defect itself — markup he attached must not run as a page."""
    name, body = TEXT_KINDS[0]
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    assert _disposition_type(resp) == "attachment", resp.headers.get("content-disposition")
    assert "page.html" in resp.headers["content-disposition"]
    assert resp.content == body


@pytest.mark.parametrize(("name", "body"), TEXT_KINDS[1:], ids=[n for n, _ in TEXT_KINDS[1:]])
async def test_every_text_kind_is_served_as_an_attachment(
    owner_client, tmp_path, monkeypatch, name, body
):
    """C2: xml is markup too, and text/plain sniffed by an old browser can
    become html — no text kind is inline."""
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    assert _disposition_type(resp) == "attachment", resp.headers.get("content-disposition")
    assert name in resp.headers["content-disposition"]


@pytest.mark.parametrize(
    ("name", "body"),
    [("shot.png", PNG), ("doc.pdf", PDF_BYTES), *NOT_INLINE],
    ids=["shot.png", "doc.pdf", *[n for n, _ in NOT_INLINE]],
)
async def test_every_content_response_carries_nosniff(
    owner_client, tmp_path, monkeypatch, name, body
):
    """C3: the declared type is the one the browser uses, never its guess —
    the inline image included."""
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    assert resp.headers.get("x-content-type-options", "").lower() == "nosniff"


@pytest.mark.parametrize(("name", "body"), NOT_INLINE, ids=[n for n, _ in NOT_INLINE])
async def test_every_non_inline_response_is_sandboxed_by_csp(
    owner_client, tmp_path, monkeypatch, name, body
):
    """C4: if a browser renders it anyway (opened from the downloads bar, a
    browser that ignores the disposition), the CSP sandbox gives it an opaque
    origin and no script."""
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    csp = resp.headers.get("content-security-policy", "")
    assert "sandbox" in [d.strip().split(" ", 1)[0] for d in csp.split(";")], csp


@pytest.mark.parametrize(
    ("name", "body", "media"),
    [("shot.png", PNG, "image/png"), ("doc.pdf", PDF_BYTES, "application/pdf")],
    ids=["png", "pdf"],
)
async def test_images_and_pdf_stay_inline(owner_client, tmp_path, monkeypatch, name, body, media):
    """C5: the transcript still draws the picture he sent, and a PDF still
    opens in a tab — the fix narrows inline, it does not remove it."""
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    assert _disposition_type(resp) == "inline", resp.headers.get("content-disposition")
    assert resp.headers["content-type"].startswith(media)


@pytest.mark.parametrize(
    ("name", "body"), [("song.mp3", MP3_BYTES), ("blob.bin", BIN_BYTES)], ids=["mp3", "bin"]
)
async def test_binary_kinds_that_are_not_images_or_pdf_download(
    owner_client, tmp_path, monkeypatch, name, body
):
    """C6: inline is an allow-list of what a browser shows without running
    anything, not a deny-list of html — audio and unknown bytes download."""
    resp = await _content(owner_client, tmp_path, monkeypatch, name, body)

    assert _disposition_type(resp) == "attachment", resp.headers.get("content-disposition")


@pytest.mark.parametrize(
    ("media", "inline"),
    [
        ("image/png", True),
        ("image/jpeg", True),
        ("application/pdf", True),
        ("IMAGE/PNG; charset=binary", True),
        ("image/svg+xml", False),
        ("text/html", False),
        ("text/xml", False),
        ("text/plain", False),
        ("audio/mpeg", False),
        ("application/octet-stream", False),
    ],
)
def test_the_inline_rule_is_an_allow_list_that_excludes_svg(media, inline):
    """C5/C6 at the rule itself: SVG is image/* but IS markup that can carry
    <script>; the sniffer never names it today, so no upload can reach this
    case — the rule must hold without relying on that."""
    from app.attachments_api import served_inline

    assert served_inline(media) is inline
