"""POST /save — the topic-write endpoint core's `memory_save` tool calls.

Mirrors /ingest's tests: frontmatter on disk, verification before the
route reports success, containment, no tmp artifacts, and the index
picking the note up so /recall can find it in the same process. The one
behaviour /ingest does not have is collision: two notes with the same
title must become two files, never one overwritten one.
"""

from __future__ import annotations

import os

from httpx import ASGITransport, AsyncClient

from app.main import app
from app.store import MemoryStore

BASE_URL = "http://test"
TOKEN = "test-token"


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url=BASE_URL)


def _auth(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path / "root"))
    monkeypatch.delenv("DATABASE_URL", raising=False)


def _headers() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


async def _save(client, **body):
    return await client.post("/save", headers=_headers(), json=body)


# -- the happy path --------------------------------------------------------


async def test_save_writes_a_topic_with_frontmatter_and_verifies_it(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(
            client, person_id="alice", title="Coffee preferences", content="Pour-over, no sugar."
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["saved"] is True
    assert body["path"] == "people/alice/topics/coffee-preferences.md"

    path = tmp_path / "root" / body["path"]
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "title: Coffee preferences" in text
    assert "kind: topic" in text
    assert "owner: alice" in text
    assert "Pour-over, no sugar." in text


async def test_a_saved_note_is_immediately_recallable(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(
            client, person_id="alice", title="Coffee", content="Alice drinks pour-over coffee."
        )
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "pour-over coffee", "person_id": "alice"}
        )
    results = resp.json()["hits"]
    assert [r["path"] for r in results] == ["people/alice/topics/coffee.md"]


async def test_a_saved_note_belongs_to_its_person_only(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        await _save(client, person_id="alice", title="Secret", content="the codes are alpha nine")
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "alpha nine codes", "person_id": "bob"}
        )
    assert resp.json()["hits"] == [] and resp.json()["found"] is False


async def test_no_tmp_artifacts_are_left_behind(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id="alice", title="Note", content="body")
    path = tmp_path / "root" / resp.json()["path"]
    assert [p.name for p in path.parent.iterdir()] == ["note.md"]


# -- collisions ------------------------------------------------------------


async def test_a_repeated_title_never_overwrites_the_first_note(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        first = await _save(client, person_id="alice", title="Groceries", content="milk")
        second = await _save(client, person_id="alice", title="Groceries", content="eggs")
        third = await _save(client, person_id="alice", title="groceries!", content="bread")

    assert first.json()["path"] == "people/alice/topics/groceries.md"
    assert second.json()["path"] == "people/alice/topics/groceries-2.md"
    assert third.json()["path"] == "people/alice/topics/groceries-3.md"

    topics = tmp_path / "root" / "people" / "alice" / "topics"
    bodies = {p.name: p.read_text(encoding="utf-8") for p in topics.iterdir()}
    assert "milk" in bodies["groceries.md"]
    assert "eggs" in bodies["groceries-2.md"]
    assert "bread" in bodies["groceries-3.md"]


async def test_a_pre_existing_file_on_disk_is_not_overwritten(monkeypatch, tmp_path):
    """The note may have been written by a previous process, so the check
    is against the filesystem, never against anything held in memory."""
    _auth(monkeypatch, tmp_path)
    store = MemoryStore(tmp_path / "root")
    store.write_topic("alice", "groceries", "Groceries", "written before this process started")

    async with _client() as client:
        resp = await _save(client, person_id="alice", title="Groceries", content="new list")

    assert resp.json()["path"] == "people/alice/topics/groceries-2.md"
    original = tmp_path / "root" / "people" / "alice" / "topics" / "groceries.md"
    assert "written before this process started" in original.read_text(encoding="utf-8")


# -- containment -----------------------------------------------------------


async def test_a_person_id_that_tries_to_traverse_is_refused(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id="../bob", title="Note", content="body")
    assert resp.status_code == 400
    assert "error" in resp.json()
    assert not (tmp_path / "bob").exists()


async def test_a_title_full_of_path_separators_cannot_escape_the_topics_directory(
    monkeypatch, tmp_path
):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id="alice", title="../../etc/passwd", content="nope")
    assert resp.status_code == 200
    path = resp.json()["path"]
    assert path.startswith("people/alice/topics/")
    assert ".." not in path
    assert (tmp_path / "root" / path).is_file()


# -- refusals --------------------------------------------------------------


async def test_an_empty_title_is_refused_by_name(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id="alice", title="   ", content="body")
    assert resp.status_code == 400
    assert "title" in resp.json()["error"]


async def test_empty_content_is_refused_rather_than_saved_unverifiable(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await _save(client, person_id="alice", title="Empty", content="  \n ")
    assert resp.status_code == 400
    assert "content" in resp.json()["error"]
    assert not (tmp_path / "root" / "people" / "alice").exists()


async def test_a_write_that_does_not_land_is_a_500_not_a_success(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)

    real_link = os.link

    def vanishing_link(src, dst):
        """The link lands and then the file goes away — os.link returning
        without raising is not proof the note is on disk."""
        real_link(src, dst)
        os.unlink(dst)

    monkeypatch.setattr("app.store.os.link", vanishing_link)
    async with _client() as client:
        resp = await _save(client, person_id="alice", title="Ghost", content="body")
    assert resp.status_code == 500
    assert "verify" in resp.json()["error"]


async def test_save_needs_the_bearer(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/save", json={"person_id": "alice", "title": "Note", "content": "body"}
        )
    assert resp.status_code == 401
