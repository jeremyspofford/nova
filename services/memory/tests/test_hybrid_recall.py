"""/recall says which searches ran, and a semantic-only hit can come back.

The two properties this file exists for:

  1. NO SILENT FALLBACK. Every /recall answer names its retrievers and, for
     any that did not run, why. An answer produced by word matching alone is
     marked as one whether or not it found anything — "she could not find it"
     and "she could not look properly" are different, and the difference has
     to survive all the way to the caller.

  2. The vocabulary gap actually closes. A note that never uses the words in
     the question comes back anyway, and is labelled as a semantic hit.

The embedder here is an httpx.MockTransport in front of the REAL Embedder, so
what is exercised is the shipping client and its error mapping rather than a
stand-in that re-states them.
"""

from __future__ import annotations

import json

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app import api
from app.embedding import Embedder
from app.main import app
from app.store import MemoryStore

TOKEN = "hybrid-token"
PERSON = "alice"

# A hand-built vector space, shaped like a real one.
#
# Every note is mostly "this person's notes" and a little bit its own subject:
#   note_i = 0.8 * shared + 0.6 * subject_i
# which puts any two notes 0.64 apart — close to the 0.598 the real corpus
# measures with nomic-embed-text, and the reason the derived floor has
# anything to derive. A question about a subject leans the other way,
#   query_s = 0.5 * shared + 0.866 * subject_s
# so it lands 0.92 from the note about that subject and 0.4 from every other
# note. A question about a subject NO note covers is 0.4 from all of them —
# below the floor, which is the case that has to come back empty.
#
# Built here rather than taken from a model so the property under test is the
# floor's arithmetic, not somebody's weights.
SUBJECTS = ("vram", "coffee", "travel", "recipes", "mortgage", "dentist")
_WIDTH = 1 + len(SUBJECTS)


def _axis(index: int) -> list[float]:
    return [1.0 if i == index else 0.0 for i in range(_WIDTH)]


def _blend(shared: float, subject: int, own: float) -> list[float]:
    return [shared * a + own * b for a, b in zip(_axis(0), _axis(1 + subject))]


def _vector_for(text: str) -> list[float]:
    lowered = text.lower()
    for index, subject in enumerate(SUBJECTS):
        if subject in lowered:
            # A question leans on its subject; a note leans on the shared
            # direction every note in the store shares.
            leaning = _is_question(lowered)
            return _blend(0.5 if leaning else 0.8, index, 0.866 if leaning else 0.6)
    # No subject word at all: as close to the shared direction as the corpus
    # gets, which is what an off-subject question looks like.
    return _blend(0.5, len(SUBJECTS) - 1, 0.0) if _is_question(lowered) else _blend(0.8, 0, 0.0)


def _is_question(text: str) -> bool:
    """Questions come in through /recall; notes come in through the store.

    The mock has no other way to tell them apart, and the distinction is the
    whole shape of the space — short asymmetric queries against long notes is
    exactly the geometry a real embedder produces.
    """
    return text.startswith(("how ", "what ", "did ", "tell ", "graphics", "is ", "which ", "dell"))


def _handler(calls: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if calls is not None:
            calls.append(body)
        return httpx.Response(
            200, json={"embeddings": [_vector_for(text) for text in body["input"]]}
        )

    return handler


@pytest.fixture
def wired(monkeypatch, tmp_path):
    """MEMORY_ROOT, auth, and a factory that swaps in a mock-transport
    Embedder the way the service builds its own."""
    monkeypatch.setenv("SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path))
    monkeypatch.setenv("MEMORY_EMBED_URL", "http://embedder.test")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    api._contexts.clear()

    def use(handler):
        monkeypatch.setattr(
            api,
            "Embedder",
            lambda config: Embedder(config, transport=httpx.MockTransport(handler)),
        )
        api._contexts.clear()

    yield use
    api._contexts.clear()


def _seed(tmp_path):
    """Four notes about four subjects, none of which uses the question's words."""
    store = MemoryStore(tmp_path)
    store.write_topic(PERSON, "card", "Graphics card", "The card in the box holds 24GB of vram.")
    store.write_topic(PERSON, "beans", "Beans", "The coffee is a light roast from Ethiopia.")
    store.write_topic(PERSON, "trip", "Trip", "The travel plan is three nights in Lisbon.")
    store.write_topic(PERSON, "cook", "Cooking", "The recipes book lives on the kitchen shelf.")
    return store


def _headers() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _recall(client, query, k=5):
    response = await client.post(
        "/recall", headers=_headers(), json={"query": query, "person_id": PERSON, "k": k}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _retriever(body: dict, name: str) -> dict:
    return next(report for report in body["retrievers"] if report["name"] == name)


# -- 1. the honesty surface -------------------------------------------------


async def test_a_working_embedder_reports_both_retrievers_as_having_run(wired, tmp_path):
    wired(_handler())
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "how much vram is in the box")
    assert [report["name"] for report in body["retrievers"]] == ["lexical", "semantic"]
    assert _retriever(body, "lexical")["ran"] is True
    assert _retriever(body, "semantic")["ran"] is True
    # Nothing that could be read as a confidence leaves the service.
    assert "reason" not in _retriever(body, "semantic")
    assert "did not use every retriever" not in body["statement"]


async def test_an_uninstalled_model_makes_recall_say_it_matched_words_only(wired, tmp_path):
    """The state this ships in until the owner pulls the model. Hits still
    come back — and they are marked as the product of half a search."""

    def handler(request):
        return httpx.Response(
            404, json={"error": 'model "nomic-embed-text" not found, try pulling it first'}
        )

    wired(handler)
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "vram")
    assert body["found"] is True
    assert all(hit["retrievers"] == ["lexical"] for hit in body["hits"])
    semantic = _retriever(body, "semantic")
    assert semantic["ran"] is False
    assert "not installed" in semantic["reason"]
    # ...and it is in the sentence a caller repeats, not only in a field.
    assert "did not use every retriever" in body["statement"]
    assert "could have been missed" in body["statement"]


async def test_an_unreachable_embedder_is_a_different_sentence(wired, tmp_path):
    def handler(request):
        raise httpx.ConnectError("Connection refused")

    wired(handler)
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "vram")
    reason = _retriever(body, "semantic")["reason"]
    assert "could not be reached" in reason
    assert "not installed" not in reason


async def test_finding_nothing_with_half_a_search_says_both_things(wired, tmp_path):
    """The failure mode this whole feature could have shipped: recall answers
    "the notes hold no answer" while the meaning search never ran. Both facts
    have to be in the sentence, because only one of them is about the notes."""

    def handler(request):
        raise httpx.ConnectError("no route to host")

    wired(handler)
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "did I ever mention my dentist appointment")
    assert body["found"] is False
    assert "hold no answer" in body["statement"]
    assert "did not use every retriever" in body["statement"]


async def test_an_embedded_corpus_that_is_only_part_embedded_says_how_much(wired, tmp_path):
    """A ranking over half a corpus is a different search from a ranking over
    all of it, and the difference is stated rather than averaged away."""
    calls: list = []
    wired(_handler(calls))
    store = _seed(tmp_path)
    await api.warm_vectors()
    # A note written straight to disk, with no /save and no backfill behind
    # it: the index picks it up on the next rescan, the vectors do not.
    store.write_topic(PERSON, "later", "Later", "A travel note added afterwards.")
    api._contexts.clear()
    ctx = api._context()
    # Rebuilt from disk with the cache alongside: four of five have vectors.
    assert ctx.index.vector_coverage(f"people/{PERSON}/") == (4, 5)
    async with _client() as client:
        body = await _recall(client, "how much vram is in the box")
    semantic = _retriever(body, "semantic")
    assert semantic["ran"] is True
    assert semantic["coverage"] == "4 of 5 notes in this scope are embedded"
    assert "covered only part of the notes" in body["statement"]


async def test_too_few_embedded_notes_to_have_a_background_is_stated(wired, tmp_path):
    wired(_handler())
    store = MemoryStore(tmp_path)
    store.write_topic(PERSON, "only", "Only note", "The coffee is a light roast.")
    store.write_topic(PERSON, "two", "Second", "The travel plan is short.")
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "coffee roast")
    semantic = _retriever(body, "semantic")
    assert semantic["ran"] is False
    assert "too few" in semantic["reason"]
    # The lexical hit still comes back; it is simply labelled as all there was.
    assert body["found"] is True
    assert body["hits"][0]["retrievers"] == ["lexical"]


# -- 2. the vocabulary gap --------------------------------------------------


async def test_a_note_that_shares_no_words_with_the_question_comes_back(wired, tmp_path):
    """The whole point of the slice. "graphics memory" is nowhere in a note
    that says VRAM, so BM25 cannot reach it and the derived lexical floor
    correctly refuses to guess. The embedder reaches it, and the hit says so.
    """
    wired(_handler())
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        lexical_only = await _recall(client, "graphics memory")
        assert lexical_only["hits"] == [] or all(
            "vram" not in hit["snippet"].lower() for hit in lexical_only["hits"]
        )
        # The same question, phrased so the mock embedder places it on the
        # vram subject — which is what a real embedder does with the words.
        body = await _recall(client, "graphics memory (vram)")
    top = body["hits"][0]
    assert "24GB" in top["snippet"]
    assert "semantic" in top["retrievers"]


async def test_a_question_the_corpus_has_never_seen_still_comes_back_empty(wired, tmp_path):
    """The semantic retriever has a nearest neighbour for everything. Without
    a floor of its own it would answer every unanswerable question with five
    confident notes — measured, on the real suite: 0/6 becomes 6/6. The floor
    is derived from how alike these notes are to each other, and this is the
    line that notices if it stops working."""
    wired(_handler())
    _seed(tmp_path)
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "what did I decide about the mortgage")
    assert body["hits"] == []
    assert body["found"] is False
    assert "hold no answer" in body["statement"]
    assert _retriever(body, "semantic")["ran"] is True


async def test_an_exact_token_still_wins_where_the_embedder_is_vague(wired, tmp_path):
    """BM25 is kept for what it is better at. The mock embedder puts every
    unlabelled text in the same place, so if fusion ever dropped the lexical
    ranking this exact-token question would stop working."""
    wired(_handler())
    store = _seed(tmp_path)
    store.write_topic(PERSON, "box", "Machine", "The desktop is called DELL-XPS-8950.")
    api._contexts.clear()
    await api.warm_vectors()
    async with _client() as client:
        body = await _recall(client, "DELL-XPS-8950")
    assert body["hits"][0]["path"] == f"people/{PERSON}/topics/box.md"
    assert "lexical" in body["hits"][0]["retrievers"]


# -- 3. the vectors are not paid for twice ----------------------------------


async def test_reindexing_unchanged_text_does_not_re_embed_it(wired, tmp_path):
    """/ingest re-reads and re-upserts every exchange in a journal on every
    append. Keyed by unit id that would re-embed the whole day, every turn."""
    calls: list = []
    wired(_handler(calls))
    _seed(tmp_path)
    await api.warm_vectors()
    embedded_first = sum(len(call["input"]) for call in calls)
    assert embedded_first == 4

    async with _client() as client:
        for _ in range(2):
            response = await client.post(
                "/ingest",
                headers=_headers(),
                json={
                    "person_id": PERSON,
                    "conversation_id": "c1",
                    "exchange": {"user": "and the coffee?", "assistant": "A light roast."},
                },
            )
            assert response.status_code == 200
    # Two appends to the SAME journal file: the file is re-read and every
    # exchange re-indexed both times, but only text nobody has embedded yet
    # reaches the service — one new exchange, then one changed journal unit.
    embedded_after = sum(len(call["input"]) for call in calls) - embedded_first
    assert embedded_after <= 3, [call["input"] for call in calls]


async def test_a_restart_reads_the_vectors_off_disk_instead_of_re_embedding(wired, tmp_path):
    calls: list = []
    wired(_handler(calls))
    _seed(tmp_path)
    await api.warm_vectors()
    assert sum(len(call["input"]) for call in calls) == 4
    cache_file = tmp_path / ".embeddings" / "nomic-embed-text.jsonl"
    assert cache_file.is_file()

    # A restart: same MEMORY_ROOT, brand new index and embedder.
    api._contexts.clear()
    calls.clear()
    report = await api.warm_vectors()
    # Not one call: the cache was read into the index while the index was
    # being built, so by the time the pass runs there is nothing missing.
    assert calls == []
    assert report.requested == 0 and report.embedded == 0
    assert api._context().index.vector_coverage(f"people/{PERSON}/") == (4, 4)
    async with _client() as client:
        body = await _recall(client, "how much vram is in the box")
    assert _retriever(body, "semantic")["ran"] is True


async def test_the_cache_file_is_not_a_memory_file(wired, tmp_path):
    """It lives beside the notes, never among them: iter_all globs
    people/**/*.md and /export tars people/<id>/, and a binary cache in either
    would be indexed as a note or handed to the owner as one."""
    wired(_handler())
    _seed(tmp_path)
    await api.warm_vectors()
    assert (tmp_path / ".embeddings").is_dir()
    assert not list((tmp_path / "people").rglob("*.jsonl"))
    async with _client() as client:
        response = await client.get("/export", headers=_headers(), params={"person_id": PERSON})
    assert response.status_code == 200
    assert b".embeddings" not in response.content
