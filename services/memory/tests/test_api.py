"""End-to-end HTTP tests for /ingest, /recall, /forget, /export — the 7
scenarios in the Task 5 brief. Every test gets its own tmp-dir
MEMORY_ROOT (via pytest's tmp_path) so the module-level context cache in
app.api never leaks state between tests."""
from __future__ import annotations

import io
import tarfile
from datetime import date, timedelta

from httpx import ASGITransport, AsyncClient

from app import api
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


def _fixture_store(tmp_path) -> MemoryStore:
    """A second MemoryStore bound to the same root, used only to seed
    fixture files directly on disk (bypassing the HTTP API) before the
    API's context cache ever touches that root."""
    return MemoryStore(tmp_path / "root")


def _write_bad_topic_missing_created(tmp_path, person_id: str, slug: str) -> str:
    """A file with structurally-valid YAML frontmatter (parses fine as a
    mapping) but no `created` field at all -- reproduces a hand-edited
    or corrupted file that a naive rescan would previously choke on.
    Returns its rel_path."""
    topics_dir = tmp_path / "root" / "people" / person_id / "topics"
    topics_dir.mkdir(parents=True, exist_ok=True)
    (topics_dir / f"{slug}.md").write_text(
        "---\n"
        "id: bad-1\n"
        f"owner: {person_id}\n"
        "kind: topic\n"
        "title: Bad note\n"
        "tags: []\n"
        "---\n"
        "a stray note missing its created field\n",
        encoding="utf-8",
    )
    return f"people/{person_id}/topics/{slug}.md"


# -- 1. ingest -------------------------------------------------------------


async def test_ingest_creates_journal_with_valid_frontmatter(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "11111111-1111-1111-1111-111111111111",
                "exchange": {"user": "what's the capital of france", "assistant": "Paris"},
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["appended"] is True
    path = tmp_path / "root" / body["path"]
    assert path.is_file()
    text = path.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "capital of france" in text
    assert "Paris" in text


async def test_second_ingest_same_day_appends_one_file_two_entries(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        first = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "11111111-1111-1111-1111-111111111111",
                "exchange": {"user": "first message", "assistant": "first reply"},
            },
        )
        second = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "22222222-2222-2222-2222-222222222222",
                "exchange": {"user": "second message", "assistant": "second reply"},
            },
        )
    assert first.json()["path"] == second.json()["path"]
    path = tmp_path / "root" / first.json()["path"]
    text = path.read_text(encoding="utf-8")
    assert "first message" in text and "first reply" in text
    assert "second message" in text and "second reply" in text
    journals_dir = path.parent
    assert len(list(journals_dir.iterdir())) == 1


# -- 2. recall ---------------------------------------------------------------


async def test_recall_finds_seeded_topic_and_ranks_exact_term_first(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "coffee", "Coffee preferences", "Alice drinks pour-over coffee.")
    store.write_topic("alice", "weather", "Weather", "It rained in Seattle all week.")

    async with _client() as client:
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "coffee", "person_id": "alice", "k": 5}
        )
    assert resp.status_code == 200
    results = resp.json()
    assert isinstance(results, list)
    assert results
    assert results[0]["path"] == "people/alice/topics/coffee.md"
    assert set(results[0].keys()) == {"path", "title", "kind", "snippet", "score"}


async def test_recall_recency_boost_new_created_wins(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    text = "Alice likes pour-over coffee brewed slowly."
    store.write_topic("alice", "old", "Coffee", text, created=date.today() - timedelta(days=365))
    store.write_topic("alice", "new", "Coffee", text, created=date.today())

    async with _client() as client:
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "pour-over coffee", "person_id": "alice"}
        )
    results = resp.json()
    assert [r["path"] for r in results] == [
        "people/alice/topics/new.md",
        "people/alice/topics/old.md",
    ]
    assert results[0]["score"] > results[1]["score"]


# -- 3. scope isolation --------------------------------------------------


async def test_recall_never_returns_other_persons_files(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "secret", "Launch codes", "the secret launch codes are alpha nine")
    store.write_topic("bob", "unrelated", "Groceries", "buy milk and eggs")

    async with _client() as client:
        resp = await client.post(
            "/recall",
            headers=_headers(),
            json={"query": "secret launch codes alpha nine", "person_id": "bob", "k": 5},
        )
    results = resp.json()
    assert all(not r["path"].startswith("people/alice/") for r in results)
    assert results == []


# -- 4. forget -----------------------------------------------------------


async def test_forget_rejects_relative_traversal(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/forget",
            headers=_headers(),
            json={"person_id": "alice", "path": "people/alice/../bob/topics/x.md"},
        )
    assert resp.status_code == 400
    # S2 seam-hygiene (slice-01-carries.md): memory used to be the one service
    # answering refusals as FastAPI's default {"detail": ...} while core and
    # gateway both carry a {"error": ...} exception handler — an inconsistency
    # across the three otherwise-identical services with no reason behind it.
    # Deliberately updated to the shared convention.
    assert "resolve" in resp.json()["error"] or "escape" in resp.json()["error"]


async def test_forget_rejects_absolute_path(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/forget", headers=_headers(), json={"person_id": "alice", "path": "/etc/passwd"}
        )
    assert resp.status_code == 400


async def test_forget_rejects_symlink_pointing_outside(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.append_journal("alice", "seed entry")
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    person_root = store.person_root("alice")
    (person_root / "topics").mkdir(parents=True, exist_ok=True)
    (person_root / "topics" / "escape.md").symlink_to(outside)

    async with _client() as client:
        resp = await client.post(
            "/forget",
            headers=_headers(),
            json={"person_id": "alice", "path": "people/alice/topics/escape.md"},
        )
    assert resp.status_code == 400
    assert outside.exists()  # the real target must never be touched


async def test_forget_deletes_and_recall_stops_returning_it(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "coffee", "Coffee", "pour-over coffee notes")

    async with _client() as client:
        recall_before = await client.post(
            "/recall", headers=_headers(), json={"query": "coffee", "person_id": "alice"}
        )
        assert recall_before.json()

        forget_resp = await client.post(
            "/forget",
            headers=_headers(),
            json={"person_id": "alice", "path": "people/alice/topics/coffee.md"},
        )
        assert forget_resp.status_code == 200
        assert forget_resp.json()["deleted"] is True

        recall_after = await client.post(
            "/recall", headers=_headers(), json={"query": "coffee", "person_id": "alice"}
        )
    assert recall_after.json() == []
    assert not (tmp_path / "root" / "people" / "alice" / "topics" / "coffee.md").exists()


async def test_forget_missing_file_404(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/forget",
            headers=_headers(),
            json={"person_id": "alice", "path": "people/alice/topics/nonexistent.md"},
        )
    assert resp.status_code == 404


# -- 5. export -------------------------------------------------------------


async def test_export_round_trips(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.append_journal("alice", "alice's journal entry")
    store.write_topic("alice", "coffee", "Coffee", "pour-over notes")

    async with _client() as client:
        resp = await client.get("/export", headers=_headers(), params={"person_id": "alice"})
    assert resp.status_code == 200
    assert "gzip" in resp.headers["content-type"]
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
        names = sorted(tar.getnames())
        assert any(n.endswith("coffee.md") for n in names)
        member = tar.extractfile("topics/coffee.md")
        assert "pour-over notes" in member.read().decode("utf-8")


async def test_export_empty_person_is_valid_empty_archive(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.get("/export", headers=_headers(), params={"person_id": "nobody"})
    assert resp.status_code == 200
    with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
        assert tar.getnames() == []


# -- 6. restart rescan -----------------------------------------------------


async def test_restart_rescan_serves_recall_without_any_ingest_call(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    # Seed directly on disk -- simulates files left behind by a previous
    # process. The API's context cache for this root has never been
    # touched, so its first request must do a full rescan to find this.
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "coffee", "Coffee", "pour-over coffee notes from a prior run")

    async with _client() as client:
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "pour-over coffee", "person_id": "alice"}
        )
    assert resp.status_code == 200
    results = resp.json()
    assert results
    assert results[0]["path"] == "people/alice/topics/coffee.md"


# -- one bad file must not take down the rescan (review finding) -----------
#
# A file with valid frontmatter *structure* but a missing/unparseable
# `created` field used to sail through store.iter_all() (which only
# guards YAML-structure failures) and then blow up inside
# index.upsert()'s date coercion, uncaught, inside _build_context()'s
# loop -- crashing the eager rescan (main.py's warm_context() at
# startup) and, separately, the very first request to touch a fresh
# root (the lazy path in _context()). Both trigger points share the
# same _build_context() loop, so one fix (a try/except around the
# upsert call, logging the file by name and skipping it) covers both.


async def test_warm_context_boots_over_one_bad_file_and_serves_recall(
    monkeypatch, tmp_path, caplog
):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "good", "Good note", "pour-over coffee notes")
    bad_rel_path = _write_bad_topic_missing_created(tmp_path, "alice", "bad")

    with caplog.at_level("WARNING"):
        api.warm_context()  # must not raise

    assert any(bad_rel_path in record.message for record in caplog.records)

    async with _client() as client:
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "coffee", "person_id": "alice"}
        )
    assert resp.status_code == 200
    results = resp.json()
    assert results
    assert results[0]["path"] == "people/alice/topics/good.md"


async def test_lazy_first_request_boots_over_one_bad_file_and_serves_recall(
    monkeypatch, tmp_path, caplog
):
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "good", "Good note", "pour-over coffee notes")
    bad_rel_path = _write_bad_topic_missing_created(tmp_path, "alice", "bad")

    # No warm_context() call -- this /recall is the first thing to touch
    # this root, so it drives the lazy _context() build path.
    with caplog.at_level("WARNING"):
        async with _client() as client:
            resp = await client.post(
                "/recall", headers=_headers(), json={"query": "coffee", "person_id": "alice"}
            )
    assert resp.status_code == 200
    results = resp.json()
    assert results
    assert results[0]["path"] == "people/alice/topics/good.md"
    assert any(bad_rel_path in record.message for record in caplog.records)


# -- 7. atomicity (end-to-end) -----------------------------------------------


async def test_no_tmp_artifacts_visible_after_a_completed_ingest(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        resp = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "11111111-1111-1111-1111-111111111111",
                "exchange": {"user": "hi", "assistant": "hello"},
            },
        )
    path = tmp_path / "root" / resp.json()["path"]
    siblings = list(path.parent.iterdir())
    assert not any(p.name.endswith(".tmp") for p in siblings)


async def test_simulated_failure_during_ingest_leaves_original_intact(monkeypatch, tmp_path):
    _auth(monkeypatch, tmp_path)
    async with _client() as client:
        first = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "11111111-1111-1111-1111-111111111111",
                "exchange": {"user": "first", "assistant": "reply one"},
            },
        )
        path = tmp_path / "root" / first.json()["path"]
        original = path.read_text(encoding="utf-8")

        def _boom(*args, **kwargs):
            raise OSError("simulated crash between tmp-write and rename")

        monkeypatch.setattr("app.store.os.replace", _boom)
        try:
            await client.post(
                "/ingest",
                headers=_headers(),
                json={
                    "person_id": "alice",
                    "conversation_id": "22222222-2222-2222-2222-222222222222",
                    "exchange": {"user": "must not land", "assistant": "must not land either"},
                },
            )
        except OSError:
            pass
    assert path.read_text(encoding="utf-8") == original
