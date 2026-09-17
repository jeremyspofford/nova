"""End-to-end HTTP tests for /ingest, /recall, /forget, /export — the 7
scenarios in the Task 5 brief. Every test gets its own tmp-dir
MEMORY_ROOT (via pytest's tmp_path) so the module-level context cache in
app.api never leaks state between tests."""

from __future__ import annotations

import io
import tarfile
from datetime import UTC, date, datetime, timedelta

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
    body = resp.json()
    # S13: the answer is an envelope, not a bare list. A bare list could only
    # ever say "no hits", and this route has to be able to say WHICH nothing it
    # is holding — see the /recall docstring.
    assert body["found"] is True
    assert "matched" in body["statement"]
    results = body["hits"]
    assert results
    assert results[0]["path"] == "people/alice/topics/coffee.md"
    assert set(results[0].keys()) == {
        "path",
        "document",
        "fragment",
        "title",
        "kind",
        "created",
        "snippet",
        "score",
        # S13-5: which retrievers put this unit forward. A recall answered by
        # word matching alone must not look like one the embedder also ranked.
        "retrievers",
        # PIN MOVED 2026-09-10 (S14-1). A hit now carries the note's citation
        # — the message id it was distilled from and the ROLE of that row —
        # or None when it cites nothing. It is on every hit, not only on the
        # ones that have one, precisely so a caller cannot read the ABSENCE
        # of the key as "this service is too old to say": a note supported
        # only by an assistant row and a note supported by the person's own
        # message must be tellable apart downstream, and None is the third
        # answer that says neither is claimed.
        "source",
        # PIN MOVED 2026-09-10 (S14-1). And the read-only call that answers
        # this fact NOW, when the note names one. Owner ruling the same day:
        # a fact a tool can look up ad hoc should be looked up ad hoc, and the
        # note is history. Also always present, also None when there is none —
        # and None here is the substantive answer "nothing else can check
        # this", which is the whole difference between a preference and a spec.
        "live_source",
    }
    # This fixture note cites nothing and nothing else can check it, and it
    # says both rather than being silent about either.
    assert results[0]["source"] is None
    assert results[0]["live_source"] is None
    assert results[0]["retrievers"] == ["lexical"]
    # A topic note has no "## HH:MM" entries, so it is one unit and its id is
    # the file's own path — chunking is a journal's shape, not every file's.
    assert results[0]["document"] == results[0]["path"] and results[0]["fragment"] is None


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
    results = resp.json()["hits"]
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
    body = resp.json()
    assert all(not r["path"].startswith("people/alice/") for r in body["hits"])
    assert body["hits"] == []
    assert body["found"] is False


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
        assert recall_before.json()["hits"]

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
    after = recall_after.json()
    assert after["hits"] == [] and after["found"] is False
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
    results = resp.json()["hits"]
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
    results = resp.json()["hits"]
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
    results = resp.json()["hits"]
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


async def test_an_ingest_that_was_not_chunked_is_a_stated_failure(monkeypatch, tmp_path):
    """append_journal writes "## HH:MM"; split_entries reads it. If those two
    stop agreeing the file is indexed whole, chunking is off, recall gets worse
    and nothing says why — so /ingest checks it rather than trusting it."""
    _auth(monkeypatch, tmp_path)
    monkeypatch.setattr(api, "split_entries", lambda body: [])

    async with _client() as client:
        resp = await client.post(
            "/ingest",
            headers=_headers(),
            json={
                "person_id": "alice",
                "conversation_id": "11111111-1111-1111-1111-111111111111",
                "exchange": {"user": "hello", "assistant": "hi"},
            },
        )
    assert resp.status_code == 500
    assert "not indexed as exchanges" in resp.json()["error"]


async def test_a_journal_recalls_as_the_exchange_that_matched(monkeypatch, tmp_path):
    """The whole point of chunking, end to end: a day holding two unrelated
    exchanges answers with the ONE that matched, under a citable id, and the
    excerpt is that exchange rather than a window centred on filler words."""
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    when = datetime(2026, 9, 9, 16, 32, tzinfo=UTC)
    store.append_journal(
        "alice", "User: how much RAM?\n\nAssistant: 64GB of system RAM.", when=when
    )
    store.append_journal(
        "alice",
        "User: what about the espresso machine?\n\nAssistant: it needs descaling.",
        when=when.replace(minute=45),
    )

    async with _client() as client:
        resp = await client.post(
            "/recall", headers=_headers(), json={"query": "espresso", "person_id": "alice", "k": 5}
        )
    body = resp.json()
    assert body["found"] is True
    (hit,) = body["hits"]
    assert hit["path"] == "people/alice/journals/2026-09-09.md#16:45"
    assert hit["document"] == "people/alice/journals/2026-09-09.md"
    assert hit["fragment"] == "16:45"
    assert hit["kind"] == "journal" and hit["created"] == "2026-09-09"
    assert "descaling" in hit["snippet"] and "64GB" not in hit["snippet"]


async def test_a_question_the_notes_have_no_answer_to_comes_back_saying_so(monkeypatch, tmp_path):
    """Jeremy's decision, 2026-09-09: recall may return nothing, and says so."""
    _auth(monkeypatch, tmp_path)
    store = _fixture_store(tmp_path)
    store.write_topic("alice", "coffee", "Coffee", "Alice mentioned pour-over coffee once.")

    async with _client() as client:
        resp = await client.post(
            "/recall",
            headers=_headers(),
            json={"query": "did I ever mention my cat?", "person_id": "alice", "k": 5},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["hits"] == [] and body["found"] is False
    assert "hold no answer" in body["statement"]
    # The reason names WHY, so the sentence Nova repeats is not a guess.
    assert "never contained" in body["statement"]
